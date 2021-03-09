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
      queryType : validationContext.getSchema().getQueryType(),
      source : options.rootValue,
      path : null
    };

    let structures = {
      labels : new Map(),
      sizeMap : new Map(),
      resultsMap : new Map(),
      hits : 0
    };

    /* Parse query to remove location properties */
    const query = deleteKey(documentAST.definitions[0].selectionSet.selections, 'loc');
    const rootNode = getRootNode(db, calculationContext.queryType);

    return populateDataStructures(structures, rootNode, query, calculationContext, undefined ,threshold)
      .then(() => {
        let curKey = getSizeMapKey(rootNode, query);
        const querySize = structures.sizeMap.get(curKey);
        console.log('Size of result: ' + querySize + ' \t Number of hits: ' + structures.hits);
        if (querySize > threshold) {
          validationContext.reportError(
            new GraphQLError(
              `Calculation: Size of query result is ${querySize}, which exceeds maximum size of ${threshold}`)
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
    // ...and initialize the other two data structures
    // (this is not explicitly captured in the pseudo code)
    initializeDataStructures(structures.sizeMap, structures.resultsMap, sizeMapKey);
    // Now continue depending on the form of the given (sub)query.
    if (query.length > 1) {
      // The (sub)query is a concatenation of multiple (sub)queries
      // (this corresponds to line 46 in the pseudo code of the algorithm)
      return updateDataStructuresForAllSubqueries(structures, query, sizeMapKey, u, calculationContext, path, sizethreshold);
    }
    else if (!(query[0].selectionSet)) {
      // The (sub)query requests a single, scalar-typed field
      // (this corresponds to line 3 in the pseudo code of the algorithm)
      return updateDataStructuresForScalarField(structures, sizeMapKey, query[0], calculationContext, path);
    }
    else if (query[0].kind === 'Field') {
      // The (sub)query requests a single field with a subselection
      // (this corresponds to line 10 in the pseudo code of the algorithm)
      return updateDataStructuresForObjectField(structures, sizeMapKey, query[0], calculationContext, path, sizethreshold);
    }
    else if (query[0].kind === 'InlineFragment') {
      // The (sub)query is an inline fragment
      // (this corresponds to line 40 in the pseudo code of the algorithm)
      return updateDataStructuresForInlineFragment(structures, sizeMapKey, u, query[0], calculationContext, path, sizethreshold);
    }
  } else {
    /* The query already exists in labels for this node */
	 structures.hits += 1;
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
function initializeDataStructures(sizeMap, resultsMap, sizeMapKey){
  if (!sizeMap.has(sizeMapKey)) {
    sizeMap.set(sizeMapKey, 0);
  }
  
  if (!resultsMap.has(sizeMapKey)) {
    resultsMap.set(sizeMapKey, []);
  }
}

/*
 * Updates the given data structures for all subqueries of the given (sub)query.
 * This corresponds to lines 47-55 in the pseudo code of the algorithm.
 */
function updateDataStructuresForAllSubqueries(structures, query, sizeMapKey, u, calculationContext, path, sizethreshold){
  return Promise.all(query.map(function(subquery, index) {
    if (index !== 0) {
      structures.sizeMap.set(sizeMapKey, structures.sizeMap.get(sizeMapKey)+1);
      structures.resultsMap.get(sizeMapKey).push(",");
    }
    let sizeMapKeyForSubquery = getSizeMapKey(u, [subquery]);
    structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForSubquery]);
	 // get into the recursion for each subquery
    return populateDataStructures(structures, u, [subquery], calculationContext, path, sizethreshold)
    .then(x => {
      let increasedSize = structures.sizeMap.get(sizeMapKey) + structures.sizeMap.get(sizeMapKeyForSubquery);
		structures.sizeMap.set(sizeMapKey, increasedSize);
      if (increasedSize >= sizethreshold) {
        return false;
      } else {
        return x;
	   }
    });
  }));
}

/*
 * Updates the given data structures for a scalar-typed field.
 * This corresponds to lines 3-9 in the pseudo code of the algorithm.
 */
function updateDataStructuresForScalarField(structures, sizeMapKey, subquery, calculationContext, path){
  let fieldName = subquery.name.value;
  let fieldDef = calculationContext.queryType.getFields()[fieldName];
  path = extendPath(path, fieldName);
  return resolveField(subquery, fieldDef, calculationContext, path)
  .then(result => {
    updateDataStructuresForScalarFieldValue(structures, sizeMapKey, result, fieldName);
    return Promise.resolve();
  });
}

/**
 * Used by updateDataStructuresForScalarField.
 */
function updateDataStructuresForScalarFieldValue(structures, sizeMapKey, result, fieldName){
  let value;
  let increasedSize = structures.sizeMap.get(sizeMapKey);
  if (Array.isArray(result)) {
    increasedSize += 2 + result.length;
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
    increasedSize += 3;
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
  structures.resultsMap.get(sizeMapKey).push("\"" + fieldName + "\"" + ":");
  structures.resultsMap.get(sizeMapKey).push(value);
  structures.sizeMap.set(sizeMapKey, increasedSize);
  return increasedSize;
}

/*
 * Updates the given data structures for a object-typed fields (i.e., fields that have a selection set).
 * This corresponds to lines 11-39 in the pseudo code of the algorithm.
 */
function updateDataStructuresForObjectField(structures, sizeMapKey, subquery, calculationContext, path, sizethreshold){
  let fieldName = subquery.name.value;
  let fieldDef = calculationContext.queryType.getFields()[fieldName];
  path = extendPath(path, fieldName);
  return resolveField(subquery, fieldDef, calculationContext, path)
  .then(result => {
    // extend data structures to capture field name and colon
    let curSize = structures.sizeMap.get(sizeMapKey);
    structures.sizeMap.set(sizeMapKey, curSize + 2);
    structures.resultsMap.get(sizeMapKey).push("\"" + fieldName + "\"" + ":");
    // extend data structures to capture the given result fetched for the object field
    return updateDataStructuresForObjectFieldResult(result, structures, sizeMapKey, subquery, fieldDef, calculationContext, path, sizethreshold);
  });
}

/**
 * Used by updateDataStructuresForObjectField.
 */
function updateDataStructuresForObjectFieldResult(result, structures, sizeMapKey, subquery, fieldDef, calculationContext, path, sizethreshold){
  // update queryType of the calculationContext for the following recursion
  if (fieldDef.astNode.type.kind === 'ListType') {
    calculationContext.queryType = fieldDef.type.ofType;
  } else {
    calculationContext.queryType = fieldDef.type;
  }
  // proceed depending on the given result fetched for the object field
  if (result == null) { // empty/no sub-result
    let curSize = structures.sizeMap.get(sizeMapKey);
    structures.sizeMap.set(sizeMapKey, curSize + 1); // for 'null'
    structures.resultsMap.get(sizeMapKey).push("null");
    return Promise.resolve();
  }
  else if (Array.isArray(result)) {
    let increasedSize = structures.sizeMap.get(sizeMapKey);
    increasedSize += 2;                 // for '[' and ']'
    increasedSize += result.length - 1; // for the commas
    structures.sizeMap.set(sizeMapKey, increasedSize);
    structures.resultsMap.get(sizeMapKey).push("[");
    // get into the recursion for each element of the result
    return Promise.all(result.map(function(resultItem, index) {
      if (index !== 0) {
        structures.resultsMap.get(sizeMapKey).push(",");
      }
      calculationContext.source = resultItem;
      return updateDataStructuresForObjectFieldResultItem(structures, subquery, fieldDef, sizeMapKey, calculationContext, path, sizethreshold);
    }))
    .then(x => {
      structures.resultsMap.get(sizeMapKey).push("]");
      return x;
    });
  }
  else { // sub-result is a single object
    calculationContext.source = result;
    return updateDataStructuresForObjectFieldResultItem(structures, subquery, fieldDef, sizeMapKey, calculationContext, path, sizethreshold);
  }
}

/**
 * Used by updateDataStructuresForObjectFieldResult.
 */
function updateDataStructuresForObjectFieldResultItem(structures, subquery, fieldDef, sizeMapKey, calculationContext, path, sizethreshold){
  let relatedNode = createNode(calculationContext.source, fieldDef);
  let sizeMapKeyForRelatedNode = getSizeMapKey(relatedNode, subquery.selectionSet.selections);
  // The following block should better be inside the 'then' block below, but it doesn't work correctly with the referencing in resultsMap.
      // extend the corresponding resultsMap entry
      structures.resultsMap.get(sizeMapKey).push("{");
      structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForRelatedNode]);
      structures.resultsMap.get(sizeMapKey).push("}");
  // get into the recursion for the given result item
  return populateDataStructures(structures, relatedNode, subquery.selectionSet.selections, calculationContext, path, sizethreshold)
  .then(x => {
//     // extend the corresponding resultsMap entry
//     structures.resultsMap.get(sizeMapKey).push("{");
//     structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForRelatedNode]);
//     structures.resultsMap.get(sizeMapKey).push("}");
    // ...and increase the corresponding sizeMap entry accordingly
    let increasedSize = structures.sizeMap.get(sizeMapKey);
	 increasedSize += 2; // for '{' and '}'
	 increasedSize += structures.sizeMap.get(sizeMapKeyForRelatedNode);
    structures.sizeMap.set(sizeMapKey, increasedSize);
    // check whether the algorithm can be terminated
    if (increasedSize >= sizethreshold) {
      return false; // terminate
    } else {
      return x;
    }
  });
}

/*
 * Updates the given data structures for inline fragments.
 * This corresponds to lines 41-45 in the pseudo code of the algorithm.
 */
function updateDataStructuresForInlineFragment(structures, sizeMapKey, u, query, calculationContext, path, sizethreshold){
  let onType = query.typeCondition.name.value;
  if (nodeType(u) === onType) {
    let subquery = query.selectionSet.selections;
    let sizeMapKeyForSubquery = getSizeMapKey(u, subquery);
    structures.resultsMap.get(sizeMapKey).push([sizeMapKeyForSubquery]);
    calculationContext.queryType = fieldInfo.exeContext.schema.getType(onType);
    return populateDataStructures(structures, u, subquery, calculationContext, path, sizethreshold)
    .then (x => {
      let increasedSize = structures.sizeMap.get(sizeMapKey) + structures.sizeMap.get(sizeMapKeyForSubquery);
      structures.sizeMap.set(sizeMapKey, increasedSize);
      if (increasedSize >= sizethreshold) {
        return false;
      } else {
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
 * Builds the resolver info and args, then executes the corresponding resolver function.
 */
function resolveField(subquery, fieldDef, calculationContext, path){
  let resolveFn = fieldDef.resolve || calculationContext.exeContext.fieldResolver;
  let info = _execution.buildResolveInfo(calculationContext.exeContext, fieldDef, calculationContext.fieldNodes, calculationContext.queryType, path);
  let args = (0, _execution.getArgumentValues(fieldDef, subquery, calculationContext.exeContext.variableValues));
  return Promise.resolve(resolveFn(calculationContext.source, args, calculationContext.exeContext.contextValue, info));
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