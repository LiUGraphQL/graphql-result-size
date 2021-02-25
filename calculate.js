/*!
 * graphql-result-size
 * Copyright(c) 2018 Tim Andersson
 */

'use strict'

/**
 * Module exports.
 * @public
 */

module.exports = {queryCalculator, produceResult};

/**
 * Module dependencies.
 * @private
 */

const _ = require('lodash');
const deleteKey = require('key-del');
const {
  GraphQLError
} = require('graphql');
const {
  createNode,
  getRootNode,
  nodeType
} = require('./functions');
const _execution = require('graphql/execution');

/**
 * queryCalculator - calling function for the recursive calculation algorithm.
 *
 * Initializes the labels, sizeMap, and results maps, runs the calculate function
 * with the top level query and root node. Compares the threshold to the calculated
 * value and adds an error to the validationContext object if above this threshold.
 *
 * @param  {object} db                context object for querying the back-end
 * @param  {number} threshold         to compare the resulting size with
 * @param  {object} validationContext contains query and GraphQL schema
 * @param  {object} options           
 * @return {object}                   returns the query result in JSON format
 */
 let myThreshold;
function queryCalculator(db, threshold, validationContext, options) {
  myThreshold=threshold;
  try {
    /* Only run for single queries */
    if (_.size(validationContext.getDocument().definitions) > 1) {
      let data = {
        results : null,
        validationContext : validationContext
      };
      return data;
    }

    const documentAST = validationContext.getDocument();

    /* Set the execution context used for the resolver functions */
    const exeContext = _execution.buildExecutionContext(options.schema, documentAST, options.rootValue, db, options.variables, options.operationName, options.fieldResolver);
    const fieldNodes = documentAST.definitions[0].selectionSet.selections;

    /* Additional parameters needed for the calculation */
    let calculationContext = {
      exeContext : exeContext,
      fieldNodes : fieldNodes,
      queryType : validationContext.getSchema().getQueryType(),
      source : options.rootValue,
      path : null
    };

    let structures = {
      labels : new Map(),
      sizeMap : new Map(),
      results : new Map()
    };

    /* Parse query to remove location properties */
    const query = deleteKey(documentAST.definitions[0].selectionSet.selections, 'loc');
    const rootNode = getRootNode(db, calculationContext.queryType);

    return calculate(structures, rootNode, query, calculationContext)
      .then(() => {
        let stringNodeQuery = JSON.stringify([rootNode, query]);
        const querySize = arrSum(structures.sizeMap.get(stringNodeQuery));
        console.log('Size of result: ' + querySize);
        if (querySize > threshold) {
          validationContext.reportError(
            new GraphQLError(
              `Calculation: Size of query result is ${querySize}, which exceeds maximum size of ${threshold}`)
          );
        }
        let data = {
          results : structures.results,
          validationContext : validationContext,
          index : stringNodeQuery
        };
        return data;
      });
  } catch (err) {
    {
      console.error(err);
      throw err;
    }
  }
}

/**
 * calculate - A recursive function that calculates the size of a GraphQL query
 * and stores the result of every subquery in a structure called results.
 *
 * Based on an extended version of Algorithm 2 in the research paper "Semantics and Complexity of GraphQL"
 * by Olaf Hartig and Jorge Pérez. The extended version combines the calculation algorithm from the original
 * paper with gathering additional data that can be used to produce the query results without accessing the 
 * underlying data source again. A detailed explanation of this algorithm can be found in the Master's thesis 
 * "Combining Result Size Estimation and Query Execution for the GraphQL Query Language" by Andreas Lundquist.
 *
 * @param  {object} structures          contains three map structures: labels, sizeMap and results
 * @param  {object} u                   node
 * @param  {object} query               (sub)query to be calculated
 * @param  {object} calculationContext  contains additional information needed for the calculation
 * @param  {object} path                contains the path from the root node to the current node
 * @return {promise}
 * @private
 */
function calculate(structures, u, query, calculationContext, path) {
  /* These three strings are used the data structures labels, sizeMap and results */
  let stringNodeQuery = JSON.stringify([u, query]);
  let stringQuery = JSON.stringify(query);
  let stringNode = JSON.stringify(u);
  /* Check if query is already in labels for this node [1] */
  if (!doQueryExistOnNode(structures.labels, stringNode, stringQuery)) {
    /* Add query to labels [2] and initialize data structures if needed */
    addQueryToLabels(structures.labels, stringNode, stringQuery);
    initializeDataStructures(structures.sizeMap, structures.results, stringNodeQuery);
    if (query.length > 1) {
      /* The query consists of multiple subqueries [27] */
      return calculateAllSubqueries(structures, query, stringNodeQuery, u, calculationContext, path);
    } else if (!(query[0].selectionSet)) {
      /* The query consists of a single field [3] */
      structures.sizeMap.get(stringNodeQuery).push(3);
      return getScalarField(structures.results, stringNodeQuery, query, calculationContext, path);
      //return Promise.resolve();
    } else if (query[0].kind === 'Field') {
      /* The query consists of a field with a subselection [9] */
      let fieldName = query[0].name.value;
      let fieldDef = calculationContext.queryType.getFields()[fieldName];
      path = addPath(path, fieldName);
      return getField(query, fieldDef, calculationContext, path)
      .then(src => {
        structures.results.get(stringNodeQuery).push("\"" + fieldName + "\"" + ":");
        /* Add to sizeMap depending on the type of the field [15-21] */
        if (fieldDef.astNode.type.kind === 'ListType') {
          structures.sizeMap.get(stringNodeQuery).push(4);
        } else if (src != null) {
          structures.sizeMap.get(stringNodeQuery).push(2);
        } else {
          structures.sizeMap.get(stringNodeQuery).push(3);
        }
        /* Recursively run the calculate function for every resulting edge [11-14] */
        return calculateRelatedNodes(structures, src, stringNodeQuery, query, fieldDef, calculationContext, path);
      });
    } else if (query[0].kind === 'InlineFragment') {
      /* The query consists of an inline fragment [22] */
      return calculateInlineFragment(structures, stringNodeQuery, u, query, calculationContext, path);
    }
  } else {
    /* The query already exists in labels for this node */
    return Promise.resolve();
  }
}

function doQueryExistOnNode(labels, stringNode, stringQuery){
  return (_.some(labels.get(stringNode), function(o) {
    return o === stringQuery;
  }));
}

function addQueryToLabels(labels, stringNode, stringQuery){
  if (!labels.has(stringNode)) {
    labels.set(stringNode, [stringQuery]);
  } else {
    labels.get(stringNode).push(stringQuery);
  }
}

/* Initializes the data structures sizeMap and results if they have not been initialized before */
function initializeDataStructures(sizeMap, results, stringNodeQuery){
  if (!sizeMap.has(stringNodeQuery)) {
    sizeMap.set(stringNodeQuery, []);
  }
  
  if (!results.has(stringNodeQuery)) {
    results.set(stringNodeQuery, []);
  }
}

function calculateAllSubqueries(structures, query, stringNodeQuery, u, calculationContext, path){
  return Promise.all(query.map(function(subquery, index) {
    if (index !== 0) {
      structures.sizeMap.get(stringNodeQuery).push(1);
      structures.results.get(stringNodeQuery).push(",");
    }
    let stringNodeSubquery = JSON.stringify([u, [subquery]]);
    structures.results.get(stringNodeQuery).push([stringNodeSubquery]);
    return calculate(structures, u, [subquery], calculationContext, path)
    .then(x => {
		let queryResultSize=arrSum(structures.sizeMap.get(stringNodeQuery));
		if(queryResultSize>=myThreshold){
        return false;
      }else{
      structures.sizeMap.get(stringNodeQuery).push(structures.sizeMap.get(stringNodeSubquery));
      return x;
	  }
    });
  }));
}

/* Adds a field with a scalar value (leaf node) to the results structure */
function getScalarField(results, stringNodeQuery, query, calculationContext, path){
  let fieldName = query[0].name.value;
  let fieldDef = calculationContext.queryType.getFields()[fieldName];
  path = addPath(path, fieldName);
  return getField(query, fieldDef, calculationContext, path)
  .then(result => {
    let value = formatScalarResult(result, fieldName);
    results.get(stringNodeQuery).push("\"" + fieldName + "\"" + ":");
    results.get(stringNodeQuery).push(value);
    return Promise.resolve();
  });
}

/**
 * Builds the resolver info and args, then executes the corresponding resolver function.
 */ 
function getField(query, fieldDef, calculationContext, path){
  let resolveFn = fieldDef.resolve || calculationContext.exeContext.fieldResolver;
  let info = _execution.buildResolveInfo(calculationContext.exeContext, fieldDef, calculationContext.fieldNodes, calculationContext.queryType, path);
  let args = (0, _execution.getArgumentValues(fieldDef, query[0], calculationContext.exeContext.variableValues));
  return Promise.resolve(resolveFn(calculationContext.source, args, calculationContext.exeContext.contextValue, info));
}

function formatScalarResult(result, fieldName){
  let value;
  if (Array.isArray(result)) {
    if (result.length <= 1) {
      result = result[0];
    } else {
      _.forEach(result, function(element, index){
        if (typeof element === "string"){
          result[index] = "\"" + element + "\"";
        }
      });
    }
  }
  if (typeof result === "object" && result !== null && !Array.isArray(result)){
    value = result[fieldName];
  } else if (Array.isArray(result)) {
    value = [];
    value.push("[");
    _.forEach(result, function(element, index) {
      if (index !== 0) {
        value.push(",");
      }
      value.push(element);
    });
    value.push("]");
  } else {
    value = result;
  }
  if (typeof value === "string"){
    value = "\"" + value + "\"";
  }
  return value;
}

function calculateRelatedNodes(structures, src, stringNodeQuery, query, fieldDef, calculationContext, path){
  calculationContext.queryType = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;;
  /* If multiple related nodes exist */
  if (Array.isArray(src)){
    structures.results.get(stringNodeQuery).push("[");
    return Promise.all(src.map(function(srcItem, index) {
      if (index !== 0) {
        structures.results.get(stringNodeQuery).push(",");
      }
      calculationContext.source = srcItem;
      return calculateSingleNode(structures, query, fieldDef, stringNodeQuery, calculationContext, path);
    }))
    .then(x => {
      structures.results.get(stringNodeQuery).push("]");
      return x;
    });
  /* If no related nodes exist */
  } else if (src == null){ 
    structures.sizeMap.get(stringNodeQuery).push(2);
    structures.results.get(stringNodeQuery).push("null");
    return Promise.resolve();
  /* If only a single related node exists */
  } else { 
    calculationContext.source = src;
    return calculateSingleNode(structures, query, fieldDef, stringNodeQuery, calculationContext, path);
  }
}

function calculateSingleNode(structures, query, fieldDef, stringNodeQuery, calculationContext, path){
  structures.sizeMap.get(stringNodeQuery).push(2);
  let relatedNode = createNode(calculationContext.source, fieldDef);
  let stringRelatedNodeSubquery = JSON.stringify([relatedNode, query[0].selectionSet.selections]);
  structures.results.get(stringNodeQuery).push("{");
  structures.results.get(stringNodeQuery).push([stringRelatedNodeSubquery]);
  structures.results.get(stringNodeQuery).push("}");
  return calculate(structures, relatedNode, query[0].selectionSet.selections, calculationContext, path)
  .then(x => {
	let queryResultSize=arrSum(structures.sizeMap.get(stringNodeQuery));
    if(queryResultSize>=myThreshold){
        return false;
    }else{
    structures.sizeMap.get(stringNodeQuery).push(structures.sizeMap.get(stringRelatedNodeSubquery));
    return x;  
	}	
  });
}

function calculateInlineFragment(structures, stringNodeQuery, u, query, calculationContext, path){
  let onType = query[0].typeCondition.name.value;
  if (nodeType(u) === onType) {
    let stringNodeSubquery = JSON.stringify([u, query[0].selectionSet.selections]);
    structures.results.get(stringNodeQuery).push([stringNodeSubquery]);
    calculationContext.queryType = fieldInfo.exeContext.schema.getType(onType);
    return calculate(structures, u, query[0].selectionSet.selections, calculationContext, path)
    .then (x => {
		let queryResultSize=arrSum(structures.sizeMap.get(stringNodeQuery));
		if(queryResultSize>=myThreshold){
			return false;
		}else{
      structures.sizeMap.get(stringNodeQuery).push(structures.sizeMap.get(stringNodeSubquery));
      return x;
		}
    });
  } else {
    return Promise.resolve();
  }
}

function addPath(prev, key) {
  return { prev: prev, key: key };
}

/**
 * arrSum - summarize values of a nested array
 *
 * @param  {array} arr
 * @return {number}
 * @private
 */
function arrSum(arr) {
  return arr.reduce(function fn(a, b) {
    if (Array.isArray(b)) {
      return b.reduce(fn, a);
    } else if (b === Math.round(b)) {
      return a + b;
    }
    return a;
  }, 0);
}

/** Produces the result from the results structure into a string.
 * index is a combination of a node and a query
 * each element in results is either a string or another index
 * if the element is a string it is just added to the response
 * else it is another index, in which case the function is run recursively
 */
function produceResult(results, index){
  if (results == null){
    return "";
  }
  let response = "";
  results.get(index).forEach(element => {
    if (Array.isArray(element) && element.length > 1) {
      _.forEach(element, function(subElement) {
        response += subElement;
      });
    } else if (typeof element === "object" && element !== null){
      response += produceResult(results, element[0]);
    } else {
      response += element;
    }
  });
  return response;
}