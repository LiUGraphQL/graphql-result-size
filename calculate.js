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
function queryCalculator(db, threshold, validationContext, options) {
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
      resultsMap : new Map()
    };

    /* Parse query to remove location properties */
    const query = deleteKey(documentAST.definitions[0].selectionSet.selections, 'loc');
    const rootNode = getRootNode(db, calculationContext.queryType);

    return populateDataStructures(structures, rootNode, query, calculationContext, undefined ,threshold)
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
          results : structures.resultsMap,
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
 * A recursive function that populates the given data structures to determine the result size of a GraphQL query
 * and to produce that query result later.
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
 * @param  {number} sizethreshold       threshold for the result size; the recursive process gets terminated if the threshold is exceeded
 * @return {promise}
 * @private
 */
function populateDataStructures(structures, u, query, calculationContext, path, sizethreshold) {
  // The following three strings are used as keys in the data structures
  // that are populated by the algorithm (labels, sizeMap, and resultsMap)
  let curnodeAndQueryAsString = JSON.stringify([u, query]);
  let subqueryAsString = JSON.stringify(query);
  let curnodeAsString = JSON.stringify(u);
  // Check whether the given (sub)query has already been considered for the
  // given data node, which is recorded in the 'labels' data structure
  // (this corresponds to line 1 in the pseudo code of the algorithm)
  if (!queryAlreadyConsideredForNode(structures.labels, curnodeAsString, subqueryAsString)) {
    // Record that the given (sub)query has been considered for the given data node
    // (this corresponds to line 2 in the pseudo code of the algorithm)
    markQueryAsConsideredForNode(structures.labels, curnodeAsString, subqueryAsString);
    // ...and initialize the other two data structures
    // (this is not explicitly captured in the pseudo code)
    initializeDataStructures(structures.sizeMap, structures.resultsMap, curnodeAndQueryAsString);
    // Now continue depending on the form of the given (sub)query.
    if (query.length > 1) {
      // The (sub)query is a concatenation of multiple (sub)queries
      // (this corresponds to line 46 in the pseudo code of the algorithm)
      return updateDataStructuresForAllSubqueries(structures, query, curnodeAndQueryAsString, u, calculationContext, path, sizethreshold);
    }
    else if (!(query[0].selectionSet)) {
      // The (sub)query requests a single, scalar-typed field
      // (this corresponds to line 3 in the pseudo code of the algorithm)
      return updateDataStructuresForScalarField(structures, curnodeAndQueryAsString, query[0], calculationContext, path);
    }
    else if (query[0].kind === 'Field') {
      // The (sub)query requests a single field with a subselection
      // (this corresponds to line 10 in the pseudo code of the algorithm)
      let fieldName = query[0].name.value;
      let fieldDef = calculationContext.queryType.getFields()[fieldName];
      path = extendPath(path, fieldName);
      return resolveField(query[0], fieldDef, calculationContext, path)
      .then(src => {
        structures.resultsMap.get(curnodeAndQueryAsString).push("\"" + fieldName + "\"" + ":");
        /* Add to sizeMap depending on the type of the field [15-21] */
        if (fieldDef.astNode.type.kind === 'ListType') {
          structures.sizeMap.get(curnodeAndQueryAsString).push(4);
        } else if (src != null) {
          structures.sizeMap.get(curnodeAndQueryAsString).push(2);
        } else {
          structures.sizeMap.get(curnodeAndQueryAsString).push(3);
        }
        /* Recursively run the calculate function for every resulting edge [11-14] */
        return calculateRelatedNodes(structures, src, curnodeAndQueryAsString, query, fieldDef, calculationContext, path, sizethreshold);
      });
    }
    else if (query[0].kind === 'InlineFragment') {
      // The (sub)query is an inline fragment
      // (this corresponds to line 40 in the pseudo code of the algorithm)
      return calculateInlineFragment(structures, curnodeAndQueryAsString, u, query, calculationContext, path, sizethreshold);
    }
  } else {
    /* The query already exists in labels for this node */
    return Promise.resolve();
  }
}

function queryAlreadyConsideredForNode(labels, curnodeAsString, subqueryAsString){
  return (_.some(labels.get(curnodeAsString), function(o) {
    return o === subqueryAsString;
  }));
}

function markQueryAsConsideredForNode(labels, curnodeAsString, subqueryAsString){
  if (!labels.has(curnodeAsString)) {
    labels.set(curnodeAsString, [subqueryAsString]);
  } else {
    labels.get(curnodeAsString).push(subqueryAsString);
  }
}

/* Initializes the data structures sizeMap and resultsMap if they have not been initialized before */
function initializeDataStructures(sizeMap, resultsMap, curnodeAndQueryAsString){
  if (!sizeMap.has(curnodeAndQueryAsString)) {
    sizeMap.set(curnodeAndQueryAsString, []);
  }
  
  if (!resultsMap.has(curnodeAndQueryAsString)) {
    resultsMap.set(curnodeAndQueryAsString, []);
  }
}

/*
 * Updates the given data structures for all subqueries of the given (sub)query.
 * This corresponds to lines 47-55 in the pseudo code of the algorithm.
 */
function updateDataStructuresForAllSubqueries(structures, query, curnodeAndQueryAsString, u, calculationContext, path, sizethreshold){
  return Promise.all(query.map(function(subquery, index) {
    if (index !== 0) {
      structures.sizeMap.get(curnodeAndQueryAsString).push(1);
      structures.resultsMap.get(curnodeAndQueryAsString).push(",");
    }
    let curnodeAndSubqueryAsString = JSON.stringify([u, [subquery]]);
    structures.resultsMap.get(curnodeAndQueryAsString).push([curnodeAndSubqueryAsString]);
	 // get into the recursion for each subquery
    return populateDataStructures(structures, u, [subquery], calculationContext, path, sizethreshold)
    .then(x => {
		let queryResultSize=arrSum(structures.sizeMap.get(curnodeAndQueryAsString));
		if(queryResultSize>=sizethreshold){
        return false;
      }else{
      structures.sizeMap.get(curnodeAndQueryAsString).push(structures.sizeMap.get(curnodeAndSubqueryAsString));
      //structures.sizeMap.get(curnodeAndQueryAsString).push(arrSum(structures.sizeMap.get(curnodeAndSubqueryAsString)));
      return x;
	  }
    });
  }));
}

/*
 * Updates the given data structures for a scalar-typed field.
 * This corresponds to lines 3-9 in the pseudo code of the algorithm.
 */
function updateDataStructuresForScalarField(structures, curnodeAndQueryAsString, subquery, calculationContext, path){
  let fieldName = subquery.name.value;
  let fieldDef = calculationContext.queryType.getFields()[fieldName];
  path = extendPath(path, fieldName);
  return resolveField(subquery, fieldDef, calculationContext, path)
  .then(result => {
    let value = formatResultOfScalarTypedField(result, fieldName);
    structures.resultsMap.get(curnodeAndQueryAsString).push("\"" + fieldName + "\"" + ":");
    structures.resultsMap.get(curnodeAndQueryAsString).push(value);
    structures.sizeMap.get(curnodeAndQueryAsString).push(3);
    return Promise.resolve();
  });
}

/**
 * Builds the resolver info and args, then executes the corresponding resolver function.
 */ 
function resolveField(subquery, fieldDef, calculationContext, path){
  let resolveFn = fieldDef.resolve || calculationContext.exeContext.fieldResolver;
  let info = _execution.buildResolveInfo(calculationContext.exeContext, fieldDef, calculationContext.fieldNodes, calculationContext.queryType, path);
  let args = (0, _execution.getArgumentValues(fieldDef, subquery, calculationContext.exeContext.variableValues));
  return Promise.resolve(resolveFn(calculationContext.source, args, calculationContext.exeContext.contextValue, info));
}

function formatResultOfScalarTypedField(result, fieldName){
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

function calculateRelatedNodes(structures, src, curnodeAndQueryAsString, query, fieldDef, calculationContext, path, sizethreshold){
  calculationContext.queryType = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;;
  /* If multiple related nodes exist */
  if (Array.isArray(src)){
    structures.resultsMap.get(curnodeAndQueryAsString).push("[");
    return Promise.all(src.map(function(srcItem, index) {
      if (index !== 0) {
        structures.resultsMap.get(curnodeAndQueryAsString).push(",");
      }
      calculationContext.source = srcItem;
      return calculateSingleNode(structures, query, fieldDef, curnodeAndQueryAsString, calculationContext, path, sizethreshold);
    }))
    .then(x => {
      structures.resultsMap.get(curnodeAndQueryAsString).push("]");
      return x;
    });
  /* If no related nodes exist */
  } else if (src == null){ 
    structures.sizeMap.get(curnodeAndQueryAsString).push(2);
    structures.resultsMap.get(curnodeAndQueryAsString).push("null");
    return Promise.resolve();
  /* If only a single related node exists */
  } else { 
    calculationContext.source = src;
    return calculateSingleNode(structures, query, fieldDef, curnodeAndQueryAsString, calculationContext, path, sizethreshold);
  }
}

function calculateSingleNode(structures, query, fieldDef, curnodeAndQueryAsString, calculationContext, path, sizethreshold){
  structures.sizeMap.get(curnodeAndQueryAsString).push(2);
  let relatedNode = createNode(calculationContext.source, fieldDef);
  let stringRelatedNodeSubquery = JSON.stringify([relatedNode, query[0].selectionSet.selections]);
  structures.resultsMap.get(curnodeAndQueryAsString).push("{");
  structures.resultsMap.get(curnodeAndQueryAsString).push([stringRelatedNodeSubquery]);
  structures.resultsMap.get(curnodeAndQueryAsString).push("}");
  return populateDataStructures(structures, relatedNode, query[0].selectionSet.selections, calculationContext, path, sizethreshold)
  .then(x => {
	let queryResultSize=arrSum(structures.sizeMap.get(curnodeAndQueryAsString));
    if(queryResultSize>=sizethreshold){
        return false;
    }else{
    structures.sizeMap.get(curnodeAndQueryAsString).push(structures.sizeMap.get(stringRelatedNodeSubquery));
    return x;  
	}	
  });
}

function calculateInlineFragment(structures, curnodeAndQueryAsString, u, query, calculationContext, path, sizethreshold){
  let onType = query[0].typeCondition.name.value;
  if (nodeType(u) === onType) {
    let stringNodeSubquery = JSON.stringify([u, query[0].selectionSet.selections]);
    structures.resultsMap.get(curnodeAndQueryAsString).push([stringNodeSubquery]);
    calculationContext.queryType = fieldInfo.exeContext.schema.getType(onType);
    return populateDataStructures(structures, u, query[0].selectionSet.selections, calculationContext, path, sizethreshold)
    .then (x => {
		let queryResultSize=arrSum(structures.sizeMap.get(curnodeAndQueryAsString));
		if(queryResultSize>=sizethreshold){
			return false;
		}else{
      structures.sizeMap.get(curnodeAndQueryAsString).push(structures.sizeMap.get(stringNodeSubquery));
      return x;
		}
    });
  } else {
    return Promise.resolve();
  }
}

function extendPath(prev, key) {
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

/** Produces the result from the resultsMap structure into a string.
 * index is a combination of a node and a query
 * each element in resultsMap is either a string or another index
 * if the element is a string it is just added to the response
 * else it is another index, in which case the function is run recursively
 */
function produceResult(resultsMap, index){
  if (resultsMap == null){
    return "";
  }
  let response = "";
  resultsMap.get(index).forEach(element => {
    if (Array.isArray(element) && element.length > 1) {
      _.forEach(element, function(subElement) {
        response += subElement;
      });
    } else if (typeof element === "object" && element !== null){
      response += produceResult(resultsMap, element[0]);
    } else {
      response += element;
    }
  });
  return response;
}