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

var _ = require('lodash');
var deleteKey = require('key-del');
var {
  GraphQLError
} = require('graphql');
var {
  createNode,
  getRootNode,
  nodeType
} = require('./functions');
var _execution = require('graphql/execution');

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
function queryCalculator(db, threshold, validationContext, options, format) {
  try {
    /* Only run for single queries */
    if (_.size(validationContext.getDocument().definitions) > 1) {
      let data = {
        results : null,
        validationContext : validationContext
      };
      return data;
    }

    /* Create the three data structures */
    var labels = new Map();
    var sizeMap = new Map();
    var results = new Map();

    var documentAST = validationContext.getDocument();
    /* Parse query to remove location properties */
    var query = deleteKey(documentAST.definitions[0].selectionSet.selections, 'loc');
    var queryType = validationContext.getSchema().getQueryType();
    var rootNode = getRootNode(db, queryType);
    /* Set the execution context used for the resolver functions */
    var exeContext = _execution.buildExecutionContext(options.schema, documentAST, options.rootValue, db, options.variables, options.operationName, options.fieldResolver);
    var fieldNodes = documentAST.definitions[0].selectionSet.selections;
    /* Contains the path from the root field to the current field during calculation */
    var path;

    var fieldInfo = {
        exeContext : exeContext,
        fieldNodes : fieldNodes,
        queryType : queryType
    };

    return calculate(labels, sizeMap, results, rootNode, query, queryType, options.rootValue, path, fieldInfo, validationContext)
      .then(() => {
        let stringNodeQuery = JSON.stringify([rootNode, query]);
        const querySize = arrSum(sizeMap.get(stringNodeQuery));
        console.log('Size of result: ' + querySize);
        if (querySize > threshold) {
          validationContext.reportError(
            new GraphQLError(
              `Calculation: Size of query result is ${querySize}, which exceeds maximum size of ${threshold}`)
          );
        }
        if(validationContext.getErrors().length){
          return Promise.resolve({ errors: format(validationContext.getErrors()) });
        }
        let data = {
          results : results,
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
 * @param  {object} labels     the labels Map
 * @param  {object} sizeMap    the sizeMap Map
 * @param  {object} results    the results Map
 * @param  {object} u          node
 * @param  {object} query      (sub)query to be calculated
 * @param  {object} parentType type of the parent node
 * @param  {object} source     
 * @param  {object} current_path     
 * @return {promise}
 * @private
 */
function calculate(labels, sizeMap, results, u, query, parentType, source, current_path, fieldInfo, validationContext) {
  /* These three strings are used the data structures labels, sizeMap and results */
  let stringNodeQuery = JSON.stringify([u, query]);
  let stringQuery = JSON.stringify(query);
  let stringNode = JSON.stringify(u);
  /* Check if query is already in labels for this node [1] */
  if (!doQueryExistOnNode(labels, stringNode, stringQuery)) {
    /* Add query to labels [2] and initialize data structures if needed */
    addQueryToLabels(labels, stringNode, stringQuery);
    initializeDataStructures(sizeMap, results, stringNodeQuery);
    if (query.length > 1) {
      /* The query consists of multiple subqueries [27] */
      return calculateAllSubqueries(labels, sizeMap, results, query, stringNodeQuery, u, parentType, source, current_path, fieldInfo, validationContext);
    } else if (!(query[0].selectionSet)) {
      /* The query consists of a single field [3] */
      sizeMap.get(stringNodeQuery).push(3);
      return getScalarField(results, stringNodeQuery, query, source, parentType, current_path, fieldInfo);
      //return Promise.resolve();
    } else if (query[0].kind === 'Field') {
      /* The query consists of a field with a subselection [9] */
      let fieldName = query[0].name.value;
      let fieldDef = parentType.getFields()[fieldName];
      current_path = addPath(current_path, fieldName);
      return getField(query, fieldDef, source, current_path, fieldInfo)
      .then(src => {
        results.get(stringNodeQuery).push("\"" + fieldName + "\"" + ":");
        /* Add to sizeMap depending on the type of the field [15-21] */
        if (fieldDef.astNode.type.kind === 'ListType') {
          sizeMap.get(stringNodeQuery).push(4);
        } else if (src != null) {
          sizeMap.get(stringNodeQuery).push(2);
        } else {
          sizeMap.get(stringNodeQuery).push(3);
        }
        /* Recursively run the calculate function for every resulting edge [11-14] */
        return calculateRelatedNodes(labels, sizeMap, results, src, stringNodeQuery, query, fieldDef, current_path, fieldInfo, validationContext);
      });
    } else if (query[0].kind === 'InlineFragment') {
      /* The query consists of an inline fragment [22] */
      return calculateInlineFragment(labels, sizeMap, results, stringNodeQuery, u, query, source, current_path, fieldInfo, validationContext);
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

function calculateAllSubqueries(labels, sizeMap, results, query, stringNodeQuery, u, parentType, source, current_path, fieldInfo, validationContext){
  return Promise.all(query.map(function(subquery, index) {
    if (index !== 0) {
      results.get(stringNodeQuery).push(",");
    }
    let stringNodeSubquery = JSON.stringify([u, [subquery]]);
    results.get(stringNodeQuery).push([stringNodeSubquery]);
    return calculate(labels, sizeMap, results, u, [subquery], parentType, source, current_path, fieldInfo, validationContext)
    .then(x => {
      sizeMap.get(stringNodeQuery).push(sizeMap.get(stringNodeSubquery));
      return x;
    });
  }));
}

/* Adds a field with a scalar value (leaf node) to the results structure */
function getScalarField(results, stringNodeQuery, query, source, parentType, current_path, fieldInfo){
  let fieldName = query[0].name.value;
  let fieldDef = parentType.getFields()[fieldName];
  current_path = addPath(current_path, fieldName);
  return getField(query, fieldDef, source, current_path, fieldInfo)
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
function getField(query, fieldDef, source, current_path, fieldInfo){
  let resolveFn = fieldDef.resolve || fieldInfo.exeContext.fieldResolver;
  let info = _execution.buildResolveInfo(fieldInfo.exeContext, fieldDef, fieldInfo.fieldNodes, fieldInfo.queryType, current_path);
  let args = (0, _execution.getArgumentValues(fieldDef, query[0], fieldInfo.exeContext.variableValues));
  return Promise.resolve(resolveFn(source, args, fieldInfo.exeContext.contextValue, info));
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

function calculateRelatedNodes(labels, sizeMap, results, src, stringNodeQuery, query, fieldDef, current_path, fieldInfo, validationContext){
  let currentType = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;
  /* If multiple related nodes exist */
  if (Array.isArray(src)){
    results.get(stringNodeQuery).push("[");
    return Promise.all(src.map(function(srcItem, index) {
      if (index !== 0) {
        results.get(stringNodeQuery).push(",");
      }
      return calculateSingleNode(labels, sizeMap, results, query, srcItem, fieldDef, currentType, stringNodeQuery, current_path, fieldInfo, validationContext);
    }))
    .then(x => {
      results.get(stringNodeQuery).push("]");
      return x;
    });
  /* If no related nodes exist */
  } else if (src == null){ 
    sizeMap.get(stringNodeQuery).push(2);
    results.get(stringNodeQuery).push("null");
    return Promise.resolve();
  /* If only a single related node exists */
  } else { 
    return calculateSingleNode(labels, sizeMap, results, query, src, fieldDef, currentType, stringNodeQuery, current_path, fieldInfo, validationContext);
  }
}

function calculateSingleNode(labels, sizeMap, results, query, source, fieldDef, currentType, stringNodeQuery, current_path, fieldInfo, validationContext){
  sizeMap.get(stringNodeQuery).push(2);
  let relatedNode = createNode(source, fieldDef);
  let stringRelatedNodeSubquery = JSON.stringify([relatedNode, query[0].selectionSet.selections]);
  results.get(stringNodeQuery).push("{");
  results.get(stringNodeQuery).push([stringRelatedNodeSubquery]);
  results.get(stringNodeQuery).push("}");
  return calculate(labels, sizeMap, results, relatedNode, query[0].selectionSet.selections, currentType, source, current_path, fieldInfo, validationContext)
  .then(x => {
    sizeMap.get(stringNodeQuery).push(sizeMap.get(stringRelatedNodeSubquery));
    return x;               
  });
}

function calculateInlineFragment(labels, sizeMap, results, stringNodeQuery, u, query, source, current_path, fieldInfo, validationContext){
  let onType = query[0].typeCondition.name.value;
  if (nodeType(u) === onType) {
    let stringNodeSubquery = JSON.stringify([u, query[0].selectionSet.selections]);
    results.get(stringNodeQuery).push([stringNodeSubquery]);
    return calculate(labels, sizeMap, results, u, query[0].selectionSet.selections, validationContext.getSchema().getType(onType), source, current_path, fieldInfo, validationContext)
    .then (x => {
      sizeMap.get(stringNodeQuery).push(sizeMap.get(stringNodeSubquery));
      return x;
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