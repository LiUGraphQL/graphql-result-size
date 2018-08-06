/*!
 * graphql-result-size
 * Copyright(c) 2018 Tim Andersson
 */

'use strict'

/**
 * Module exports.
 * @public
 */

module.exports = queryCalculator;

/**
 * Module dependencies.
 * @private
 */

var _ = require('lodash');
var Hashtable = require('jshashtable');
var HashTableArrays = require('./hashtable');
var deleteKey = require('key-del');
var {
  GraphQLError
} = require('graphql');
var {
  getEdges,
  getRootNode,
  nodeType
} = require('./functions');

/**
 * queryCalculator - wrapper function for for the recursive calculation algorithm.
 *
 * Initializes the labels and sizeMap hashmaps, runs the calculate function
 * with the top level query and root node. Compares the threshold to the calculated
 * value and adds an error to the validationContext object if above this threshold.
 *
 * @param  {object} db                context object for querying the back-end
 * @param  {number} threshold         to compare the resulting size with
 * @param  {object} validationContext contains query and GraphQL schema
 * @return {object}                   returns the validationContext object
 */
function queryCalculator(db, threshold, validationContext) {
  try {

    //Only run for single queries
    if (_.size(validationContext.getDocument().definitions) > 1) {
      return Promise.resolve(validationContext);
    }

    /**
     * calculate - recursive calculation function for GraphQL queries
     *
     * Based on Algorithm 2 of the research paper "Semantics and Complexity of GraphQL"
     * by Olaf Hartig and Jorge Pérez, corresponding lines of the pseudo-code
     * in brackets for commented lines.
     *
     * @param  {object} u          node
     * @param  {object} query      (sub)query to be calculated
     * @param  {object} parentType type of the parent node
     * @return {promise}
     * @private
     */
    function calculate(u, query, parentType) {

      //Check if query is already in labels for this node [1]
      if (!(_.some(labels.get(u), function(o) {
          return _.isEqual(o, query);
        }))) {

        //Add query to labels [2] and initialize sizeMap if needed
        if (!labels.containsKey(u)) {
          labels.put(u, [query]);
        } else {
          labels.get(u).push(query);
        }
        sizeMap.init([u, query]);

        if (query.length > 1) {
          //The query consists of multiple subqueries [27]
          return Promise.all(query.map(item => {
            sizeMap.add([u, query], sizeMap.ret([u, [item]]));
            return calculate(u, [item], parentType);
          }));

        } else if (!(query[0].selectionSet)) {
          //The query consists of a single field [3]
          sizeMap.add([u, query], 3);
          return Promise.resolve();

        } else if (query[0].kind === 'Field') {
          //The query consists of a field with a subselection [9]
          let fieldDef = parentType.getFields()[query[0].name.value];
          let currentType = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;
          return getEdges(db, query[0], u, fieldDef)
            .then(result => {
              //Add to sizeMap depending on the type of the field [15-21]
              if (fieldDef.astNode.type.kind === 'ListType') {
                sizeMap.add([u, query], 4);
              } else if (result.length > 0) {
                sizeMap.add([u, query], 2);
              } else {
                sizeMap.add([u, query], 3);
              }
              //Recursively run the calculate function for every resulting edge [11-14]
              return Promise.all(result.map(item => {
                sizeMap.add([u, query], 2);
                sizeMap.add([u, query], sizeMap.ret([item, query[0].selectionSet.selections]));
                return calculate(item, query[0].selectionSet.selections, currentType);
              }));
            });

        } else if (query[0].kind === 'InlineFragment') {
          //The query consists of an inline fragment [22]
          let onType = query[0].typeCondition.name.value;
          if (nodeType(db, u) === onType) {
            sizeMap.add([u, query], sizeMap.ret([u, query[0].selectionSet.selections]));
            return calculate(u, query[0].selectionSet.selections, validationContext.getSchema().getType(onType));
          } else {
            return Promise.resolve();
          }
        }

      } else {
        //The query already exists in labels for this node
        return Promise.resolve();
      }
    };

    var labels = new Hashtable();
    var sizeMap = new HashTableArrays();

    //parse query to remove location properties
    let query = deleteKey(validationContext.getDocument().definitions[0].selectionSet.selections, 'loc');
    //Retrieve the GraphQLType object representing the Query type
    let queryType = validationContext.getSchema().getQueryType();
    let rootNode = getRootNode(db, queryType);

    return calculate(rootNode, query, queryType)
      .then(() => {
        const querySize = arrSum(sizeMap.ret([rootNode, query]));
        console.log('Size of result: ' + querySize);
        if (querySize > threshold) {
          validationContext.reportError(
            new GraphQLError(
              `Calculation: Size of query result is ${querySize}, which exceeds maximum size of ${threshold}`)
          );
        }
        return validationContext;
      });

  } catch (err) {
    {
      console.error(err);
      throw err;
    }
  }
};

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
