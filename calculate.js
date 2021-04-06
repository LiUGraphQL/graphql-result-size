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
  GraphQLError,
  print
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
 * Initializes the labels, sizeMap, and resultsMap maps, runs the calculate function
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
      sizethreshold : threshold,
      terminateEarly : false
    };

    let structures = {
      labels : new Map(),
      sizeMap : new Map(),
      resultsMap : new Map(),
      hits : 0
    };

    /* Parse query to remove location properties */
    const query = deleteKey(documentAST.definitions[0].selectionSet.selections, 'loc');
    const rootNodeType = validationContext.getSchema().getQueryType();
    const rootNode = getRootNode(db, rootNodeType);
    const parentForResolvers = options.rootValue;

    return populateDataStructures(structures, rootNode, rootNodeType, query, parentForResolvers, calculationContext, undefined)
      .then(resultSize => {
        let curKey = getSizeMapKey(rootNode, query);
        console.log('Size of result: ' + resultSize + ' \t Number of hits: ' + structures.hits);
        if (resultSize > threshold) {
          validationContext.reportError(
            new GraphQLError(
              `Calculation: Size of query result is ${resultSize}, which exceeds maximum size of ${threshold}`)
          );
        }
        let data = {
          results : structures.resultsMap,
          validationContext : validationContext,
          index : curKey
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
 * Creates a key for the given pair of data node and (sub)query to be used for
 * look ups in the sizeMap and in the resultsMap.
 */
function getSizeMapKey( u, query ) {
  //return JSON.stringify([u, query]);
  return JSON.stringify([u, print(query)]);
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
 * @param  {object} structures          contains three map structures: labels, sizeMap and resultsMap
 * @param  {object} u                   node
 * @param  {object} uType               a GraphQL object representing the type of the given node
 * @param  {object} query               (sub)query to be calculated
 * @param  {object} parentForResolvers  current parent object to be passed to the resolver functions
 * @param  {object} calculationContext  contains additional information needed for the calculation
 * @param  {object} path                contains the path from the root node to the current node
 * @return {promise}
 * @private
 */
async function populateDataStructures(structures, u, uType, query, parentForResolvers, calculationContext, path) {
  // The following three strings are used as keys in the data structures
  // that are populated by the algorithm (labels, sizeMap, and resultsMap)
  let sizeMapKey = getSizeMapKey(u,query);
  let subqueryAsString = JSON.stringify(query);
  let curnodeAsString = JSON.stringify(u);
  // Check whether the given (sub)query has already been considered for the
  // given data node, which is recorded in the 'labels' data structure
  // (this corresponds to line 1 in the pseudo code of the algorithm)
  if (!queryAlreadyConsideredForNode(structures.labels, curnodeAsString, subqueryAsString)) {
    // Record that the given (sub)query has been considered for the given data node
    // (this corresponds to line 2 in the pseudo code of the algorithm)
    markQueryAsConsideredForNode(structures.labels, curnodeAsString, subqueryAsString);
    // ...and initialize the resultsMap data structure
    // (this is not explicitly captured in the pseudo code)
    initializeDataStructures(structures.resultsMap, sizeMapKey);
    // Now continue depending on the form of the given (sub)query.
	 let sizePromise = null;
    if (query.length > 1) {
      // The (sub)query is a concatenation of multiple (sub)queries
      // (this corresponds to line 46 in the pseudo code of the algorithm)
      sizePromise = updateDataStructuresForAllSubqueries(structures, query, sizeMapKey, u, uType, parentForResolvers, calculationContext, path);
    }
    else if (!(query[0].selectionSet)) {
      // The (sub)query requests a single, scalar-typed field
      // (this corresponds to line 3 in the pseudo code of the algorithm)
      sizePromise = updateDataStructuresForScalarField(structures, sizeMapKey, uType, query[0], parentForResolvers, calculationContext, path);
    }
    else if (query[0].kind === 'Field') {
      // The (sub)query requests a single field with a subselection
      // (this corresponds to line 10 in the pseudo code of the algorithm)
      sizePromise = updateDataStructuresForObjectField(structures, sizeMapKey, uType, query[0], parentForResolvers, calculationContext, path);
    }
    else if (query[0].kind === 'InlineFragment') {
      // The (sub)query is an inline fragment
      // (this corresponds to line 40 in the pseudo code of the algorithm)
      sizePromise = updateDataStructuresForInlineFragment(structures, sizeMapKey, u, uType, query[0], parentForResolvers, calculationContext, path);
    }
    structures.sizeMap.set(sizeMapKey, sizePromise);
    return sizePromise;
  }
  else {
    /* The query already exists in labels for this node */
	 structures.hits += 1;
	 return structures.sizeMap.get(sizeMapKey);
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

/* Initializes the resultsMap data structure if it has not been initialized before */
function initializeDataStructures(resultsMap, sizeMapKey){
  if (!resultsMap.has(sizeMapKey)) {
    resultsMap.set(sizeMapKey, []);
  }
}

/*
 * Updates the given data structures for all subqueries of the given (sub)query.
 * This corresponds to lines 47-55 in the pseudo code of the algorithm.
 */
async function updateDataStructuresForAllSubqueries(structures, query, sizeMapKey, u, uType, parentForResolvers, calculationContext, path){
  if (calculationContext.terminateEarly) {
    let size = 0;
    let isFirstSubquery = true;
    for (const subquery of query) {
      if ( isFirstSubquery ) {
        isFirstSubquery = false;
      } else {
        structures.resultsMap.get(sizeMapKey).push(",");
        size += 1; // for the comma
      }
      let sizeMapKeyForSubquery = getSizeMapKey(u, [subquery]);
      structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForSubquery]);
      const subquerySize = await populateDataStructures(structures, u, uType, [subquery], parentForResolvers, calculationContext, path);
      size += subquerySize;
      if (size > calculationContext.sizethreshold) {
        break; // terminate and ignore the rest of the subqueries
      }
    }
    return Promise.resolve(size);
  }
  else {
    return Promise.all(query.map(function(subquery, index) {
      if (index !== 0) {
        structures.resultsMap.get(sizeMapKey).push(",");
      }
      let sizeMapKeyForSubquery = getSizeMapKey(u, [subquery]);
      structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForSubquery]);
      // get into the recursion for each subquery
      return populateDataStructures(structures, u, uType, [subquery], parentForResolvers, calculationContext, path);
    }))
    .then(subquerySizes => {
      let size = subquerySizes.length -1; // for the commas
      subquerySizes.forEach( subquerySize => size += subquerySize );
      return Promise.resolve(size);
    });
  }
}

/*
 * Updates the given data structures for a scalar-typed field.
 * This corresponds to lines 3-9 in the pseudo code of the algorithm.
 */
function updateDataStructuresForScalarField(structures, sizeMapKey, uType, subquery, parentForResolvers, calculationContext, path){
  let fieldName = subquery.name.value;
  let fieldDef = uType.getFields()[fieldName];
  path = extendPath(path, fieldName);
  return resolveField(subquery, uType, fieldDef, parentForResolvers, calculationContext, path)
  .then(result => {
    return updateDataStructuresForScalarFieldValue(structures, sizeMapKey, result, fieldName);
  });
}

/**
 * Used by updateDataStructuresForScalarField.
 */
function updateDataStructuresForScalarFieldValue(structures, sizeMapKey, result, fieldName){
  let value;
  let size = 0;
  if (Array.isArray(result)) {
    size += 2 + result.length;
    if (result.length <= 1) {
      result = result[0];
    } else {
      _.forEach(result, function(element, index){
        if (typeof element === "string"){
          result[index] = "\"" + element + "\"";
        }
      });
    }
  } else {
    size += 3;
  }
  const sizePromise = Promise.resolve(size);
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
  structures.resultsMap.get(sizeMapKey).push("\"" + fieldName + "\"" + ":");
  structures.resultsMap.get(sizeMapKey).push(value);
  return sizePromise;
}

/*
 * Updates the given data structures for a object-typed fields (i.e., fields that have a selection set).
 * This corresponds to lines 11-39 in the pseudo code of the algorithm.
 */
function updateDataStructuresForObjectField(structures, sizeMapKey, uType, subquery, parentForResolvers, calculationContext, path){
  let fieldName = subquery.name.value;
  let fieldDef = uType.getFields()[fieldName];
  path = extendPath(path, fieldName);
  return resolveField(subquery, uType, fieldDef, parentForResolvers, calculationContext, path)
  .then(result => {
    // extend data structures to capture field name and colon
    structures.resultsMap.get(sizeMapKey).push("\"" + fieldName + "\"" + ":");
    // extend data structures to capture the given result fetched for the object field
	 return updateDataStructuresForObjectFieldResult(result, structures, sizeMapKey, subquery, fieldDef, parentForResolvers, calculationContext, path)
	 .then( subquerySize => Promise.resolve(subquerySize+2) ); // +2 for field name and colon
  });
}

/**
 * Used by updateDataStructuresForObjectField.
 */
async function updateDataStructuresForObjectFieldResult(result, structures, sizeMapKey, subquery, fieldDef, parentForResolvers, calculationContext, path){
  // update uType for the following recursion
  const relatedNodeType = (fieldDef.astNode.type.kind === 'ListType') ?
    fieldDef.type.ofType :
    fieldDef.type;
  // proceed depending on the given result fetched for the object field
  let resultPromise;
  if (result == null) { // empty/no sub-result
    structures.resultsMap.get(sizeMapKey).push("null");
    resultPromise = Promise.resolve(1); // for 'null'
  }
  else if (Array.isArray(result) && calculationContext.terminateEarly) {
    structures.resultsMap.get(sizeMapKey).push("[");
    let size = 1; // for '['
    let isFirstSubquery = true;
    // iterate over the elements of the result
    for (const resultItem of result) {
      if ( isFirstSubquery ) {
        isFirstSubquery = false;
      } else {
        structures.resultsMap.get(sizeMapKey).push(",");
        size += 1; // for the comma
      }
      const newParentForResolvers = resultItem;
      // get into the recursion for each element of the result
      const resultItemSize = await updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, sizeMapKey, newParentForResolvers, calculationContext, path);
      size += resultItemSize;
      if (size > calculationContext.sizethreshold) {
        break; // terminate and ignore the rest of the elements in the result
      }
    }
    structures.resultsMap.get(sizeMapKey).push("]");
    size += 1;  // for ']'
    resultPromise = Promise.resolve(size);
  }
  else if (Array.isArray(result)) {
    structures.resultsMap.get(sizeMapKey).push("[");
    return Promise.all(result.map(function(resultItem, index) {
      if (index !== 0) {
        structures.resultsMap.get(sizeMapKey).push(",");
      }
      const newParentForResolvers = resultItem;
      return updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, sizeMapKey, newParentForResolvers, calculationContext, path);
    }))
    .then(resultItemSizes => {
      structures.resultsMap.get(sizeMapKey).push("]");
      let size = 2;                        // for '[' and ']'
      size += resultItemSizes.length - 1;  // for the commas
      resultItemSizes.forEach( resultItemSize => size += resultItemSize );
      return Promise.resolve(size);
    });
  }
  else { // sub-result is a single object
    const newParentForResolvers = result;
    resultPromise = updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, sizeMapKey, newParentForResolvers, calculationContext, path);
  }
  return resultPromise;
}

/**
 * Used by updateDataStructuresForObjectFieldResult.
 */
function updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, sizeMapKey, parentForResolvers, calculationContext, path){
  let relatedNode = createNode(parentForResolvers, fieldDef);
  let sizeMapKeyForRelatedNode = getSizeMapKey(relatedNode, subquery.selectionSet.selections);
  // The following block should better be inside the 'then' block below, but it doesn't work correctly with the referencing in resultsMap.
      // extend the corresponding resultsMap entry
      structures.resultsMap.get(sizeMapKey).push("{");
      structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForRelatedNode]);
      structures.resultsMap.get(sizeMapKey).push("}");
  // get into the recursion for the given result item
  return populateDataStructures(structures, relatedNode, relatedNodeType, subquery.selectionSet.selections, parentForResolvers, calculationContext, path)
  .then(subquerySize => {
//     // extend the corresponding resultsMap entry
//     structures.resultsMap.get(sizeMapKey).push("{");
//     structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForRelatedNode]);
//     structures.resultsMap.get(sizeMapKey).push("}");
    // ...and return an increased result size promise
	 return Promise.resolve(subquerySize+2); // +2 for '{' and '}'
  });
}

/*
 * Updates the given data structures for inline fragments.
 * This corresponds to lines 41-45 in the pseudo code of the algorithm.
 */
function updateDataStructuresForInlineFragment(structures, sizeMapKey, u, uType, query, parentForResolvers, calculationContext, path){
  let onType = query.typeCondition.name.value;
  if (nodeType(u) === onType) {
    let subquery = query.selectionSet.selections;
    let sizeMapKeyForSubquery = getSizeMapKey(u, subquery);
    structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForSubquery]);
    const uTypeNew = fieldInfo.exeContext.schema.getType(onType);
    return populateDataStructures(structures, u, uTypeNew, subquery, parentForResolvers, calculationContext, path);
  } else {
    return Promise.resolve(0); // the sub-result will be the empty string
  }
}

function extendPath(prev, key) {
  return { prev: prev, key: key };
}

/**
 * Builds the resolver info and args, then executes the corresponding resolver function.
 */
function resolveField(subquery, nodeType, fieldDef, parentForResolvers, calculationContext, path){
  //let resolveFn = fieldDef.resolve || calculationContext.exeContext.fieldResolver;
  let resolveFn = fieldDef.resolve;
  let info = _execution.buildResolveInfo(calculationContext.exeContext, fieldDef, calculationContext.fieldNodes, nodeType, path);
  let args = (0, _execution.getArgumentValues(fieldDef, subquery, calculationContext.exeContext.variableValues));
  return Promise.resolve(resolveFn(parentForResolvers, args, calculationContext.exeContext.contextValue, info));
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