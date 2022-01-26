import _ from 'lodash';
import deleteKey from 'key-del';
import { print } from 'graphql';
import pLimit from 'p-limit';
const limit = pLimit(10);
import {
    createNode,
    getRootNode,
    nodeType
} from './functions.js';
import {
    buildExecutionContext,
    buildResolveInfo,
    getFieldDef
} from 'graphql/execution/execute.js';
import { getArgumentValues } from 'graphql/execution/values.js';
import { ApolloError } from 'apollo-server-errors';

/**
 * Initializes the label, size, and result maps, and runs the calculate function
 * with the top level query and root node.
 * 
 * Throws an error if the resulting size is above the given threshold.
 * 
 * @param  {object} requestContext contains query and GraphQL schema
 * @return {object}                returns the query result in JSON format
 */
function queryCalculator(requestContext) {
    // Start time
    const startTime = performance.now();

    // Build execution context 
    const { request, document } = requestContext;
    const variableValues = request.variables;
    const operationName = request.operationName;
    const contextValue = requestContext.context;
    const schema = contextValue.schema;
    const rootValue = contextValue.rootValue;
    const fieldResolver = contextValue.fieldResolver;
    const typeResolver = contextValue.undeftypeResolver;
    const exeContext = buildExecutionContext(schema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver);
    const fieldNodes = document.definitions[0].selectionSet.selections;

    // Additional parameters needed for the calculation
    const calculationContext = {
        exeContext,
        fieldNodes,
        threshold: contextValue.threshold,
        errorCode: null,
        terminateEarly: contextValue.terminateEarly,
        earlyTerminationTimestamp: null
    };

    const structures = {
        labelMap: new Map(),
        sizeMap: new Map(),
        resultMap: new Map(),
        hits: 0,
        globalSize: 0
    };

    // set timer to abort calculation (if provided)
    let timer;
    if(contextValue.timeout && contextValue.timeout > 0){
        timer = setTimeout(() => {
            calculationContext.errorCode = 'MAX_QUERY_TIME_EXCEEDED';
        }, contextValue.timeout);
    }

    // Parse query to remove location properties
    const query = deleteKey(document.definitions[0].selectionSet.selections, 'loc');
    const rootNodeType = schema.getQueryType();
    const rootNode = getRootNode(rootNodeType);
    const parentForResolvers = contextValue.rootValue;

    return populateDataStructures(structures, rootNode, rootNodeType, query, parentForResolvers, calculationContext, undefined)
        .then(resultSize => {
            if(timer) {
                clearTimeout(timer);
            }

            let response = {
                resultSize,
                cacheHits: structures.hits,
                calculationTime: performance.now() - startTime,
                timeout: contextValue.timeout,
                threshold: calculationContext.threshold,
                terminateEarly: calculationContext.terminateEarly
            }
            
            if(calculationContext.errorCode){
                response.errorCode = calculationContext.errorCode;
            } else if (calculationContext.threshold != 0
                       && resultSize > calculationContext.threshold) {
                response.errorCode = 'RESULT_SIZE_LIMIT_EXCEEDED';
            }

            if(response.errorCode){
                response.resultTime = performance.now() - startTime;
                if(calculationContext.earlyTerminationTimestamp){
                    response.waitingOnPromises = performance.now() - calculationContext.earlyTerminationTimestamp;
                }
                throw new ApolloError(response.errorCode, response);
            }

            response.errorCode = 'OK';
            // Create result
            let curKey = getMapKey(rootNode, query);
            let data = JSON.parse(`{ ${ produceResult(structures.resultMap, curKey)} }`);
            response.resultTime = performance.now() - startTime;
            let result = {
                data,
                extensions: { response }
            };
            return result;
        })
}

/**
 * Creates a key for the given pair of data node and (sub)query to be used for
 * look ups.
 */
function getMapKey(u, query) {
    return JSON.stringify([u, print(query)]);
}

/**
 * Recursive function that populates the given data structures to determine the result size of a GraphQL query
 * and to produce the query result.
 *
 * Based on an extended version of Algorithm 2 in the research paper "Semantics and Complexity of GraphQL"
 * by Olaf Hartig and Jorge Pérez. The extended version combines the calculation algorithm from the original
 * paper with gathering additional data that can be used to produce the query results without accessing the 
 * underlying data source again. A detailed explanation of this algorithm can be found in the Master's thesis 
 * "Combining Result Size Estimation and Query Execution for the GraphQL Query Language" by Andreas Lundquist.
 *
 * @param  {object} structures          contains three map structures: labels, sizes and results
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
    // Create keys for data structures
    const mapKey = getMapKey(u, query);
    const subqueryAsString = JSON.stringify(query);
    const curnodeAsString = JSON.stringify(u);

    // Check whether the given (sub)query has already been considered for the
    // given data node, which is recorded in the 'labels' data structure
    // (this corresponds to line 1 in the pseudo code of the algorithm)
    if (!queryAlreadyConsideredForNode(structures.labelMap, curnodeAsString, subqueryAsString)) {
        // Record that the given (sub)query has been considered for the given data node
        // (this corresponds to line 2 in the pseudo code of the algorithm)
        markQueryAsConsideredForNode(structures.labelMap, curnodeAsString, subqueryAsString);
        // ...and initialize the 'results' data structure
        // (this is not explicitly captured in the pseudo code)
        initializeDataStructures(structures.resultMap, mapKey);

        // Continue depending on the form of the given (sub)query
        let sizePromise = null;

        if (query.length > 1) {
            // The (sub)query is a concatenation of multiple (sub)queries
            // (this corresponds to line 46 in the pseudo code of the algorithm)
            sizePromise = updateDataStructuresForAllSubqueries(structures, query, mapKey, u, uType, parentForResolvers, calculationContext, path);
        } else if (!(query[0].selectionSet)) {
            // The (sub)query requests a single, scalar-typed field
            // (this corresponds to line 3 in the pseudo code of the algorithm)
            sizePromise = updateDataStructuresForScalarField(structures, mapKey, uType, query[0], parentForResolvers, calculationContext, path);
        } else if (query[0].kind === 'Field') {
            // The (sub)query requests a single field with a subselection
            // (this corresponds to line 10 in the pseudo code of the algorithm)
            sizePromise = updateDataStructuresForObjectField(structures, mapKey, uType, query[0], parentForResolvers, calculationContext, path);
        } else if (query[0].kind === 'InlineFragment') {
            // The (sub)query is an inline fragment
            // (this corresponds to line 40 in the pseudo code of the algorithm)
            sizePromise = updateDataStructuresForInlineFragment(structures, mapKey, u, uType, query[0], parentForResolvers, calculationContext, path);
        }
        
        structures.sizeMap.set(mapKey, sizePromise);
        return sizePromise;
    }
    else {
        /* The query already exists in labels for this node */
        structures.hits += 1;
        structures.sizeMap.get(mapKey)
            .then(size => structures.globalSize += size);
        return structures.sizeMap.get(mapKey);
    }
}

function queryAlreadyConsideredForNode(labelMap, curnodeAsString, subqueryAsString) {
    return (_.some(labelMap.get(curnodeAsString), (o) => o === subqueryAsString));
}

function markQueryAsConsideredForNode(labelMap, curnodeAsString, subqueryAsString) {
    if (!labelMap.has(curnodeAsString)) {
        labelMap.set(curnodeAsString, [subqueryAsString]);
    } else {
        labelMap.get(curnodeAsString).push(subqueryAsString);
    }
}

/* Initializes the results data structure if it has not been initialized before */
function initializeDataStructures(resultMap, mapKey) {
    if (!resultMap.has(mapKey)) {
        resultMap.set(mapKey, []);
    }
}

/*
 * Updates the given data structures for all subqueries of the given (sub)query.
 * This corresponds to lines 47-55 in the pseudo code of the algorithm.
 */
async function updateDataStructuresForAllSubqueries(structures, query, mapKey, u, uType, parentForResolvers, calculationContext, path) {
    // add 1 for each comma
    structures.globalSize += query.length - 1;

    return Promise.all(query.map((subquery, index) => {
        // abort resolving array of queries
        if(checkTermination(structures, calculationContext)){
            return Promise.resolve(0);
        }

        if (index !== 0) {
            structures.resultMap.get(mapKey).push(",");
        }

        let mapKeyForSubquery = getMapKey(u, [subquery]);
        structures.resultMap.get(mapKey).push([mapKeyForSubquery]);
        // get into the recursion for each subquery
        return populateDataStructures(structures, u, uType, [subquery], parentForResolvers, calculationContext, path);
    }))
        .then(subquerySizes => {
            let size = subquerySizes.length - 1; // for the commas
            subquerySizes.forEach(subquerySize => {
                size += subquerySize;
            });
            return Promise.resolve(size);
        });
}

/*
 * Updates the given data structures for a scalar-typed field.
 * This corresponds to lines 3-9 in the pseudo code of the algorithm.
 */
function updateDataStructuresForScalarField(structures, mapKey, uType, subquery, parentForResolvers, calculationContext, path) {
    // add for field name and ':'
    let fieldName = subquery.name.value;
    let fieldDef = uType.getFields()[fieldName];
    if (fieldDef == undefined) {
        fieldDef = getFieldDef(calculationContext.schema, uType, fieldName);
    }
    path = extendPath(path, fieldName);
    return resolveField(subquery, uType, fieldDef, parentForResolvers, calculationContext, path, structures)
        .then(result => {
            return updateDataStructuresForScalarFieldValue(structures, mapKey, result, fieldName, calculationContext);
        });
}

/**
 * Used by updateDataStructuresForScalarField.
 */
function updateDataStructuresForScalarFieldValue(structures, mapKey, result, fieldName, calculationContext) {    
    // field name and ':'
    let size = 2;
    if (Array.isArray(result)) {
        // '[' and ']'
        size += 2;
        if(result.length == 1){
            // value
            size += 1;
        } else if(result.length > 1){
            // values and ','
            size += result.length * 2 - 1;
        }
    } else {
        // value
        size += 1;
    }
    structures.globalSize += size;
    const sizePromise = Promise.resolve(size);

    let value;
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        value = result[fieldName];
    } else if (Array.isArray(result)) {
        value = ["["];
        _.forEach(result, (element, index) => {
            if (index !== 0) {
                value.push(",");
            }
            if (typeof element === "string") {
                value.push("\"" + element + "\"");
            } else {
                value.push(element);
            }
        });
        value.push("]");
    } else {
        value = result;
    }
    
    if (typeof value === "string") {
        value = "\"" + value + "\"";
    }

    structures.resultMap.get(mapKey).push("\"" + fieldName + "\"" + ":");
    structures.resultMap.get(mapKey).push(value);
    return sizePromise;
}

/*
 * Updates the given data structures for a object-typed fields (i.e., fields that have a selection set).
 * This corresponds to lines 11-39 in the pseudo code of the algorithm.
 */
function updateDataStructuresForObjectField(structures, mapKey, uType, subquery, parentForResolvers, calculationContext, path) {
    // add for field name and ':'
    structures.globalSize += 2;
    
    let fieldName = subquery.name.value;
    let fieldDef = uType.getFields()[fieldName];
    path = extendPath(path, fieldName);
    if(checkTermination(structures, calculationContext)){
        return Promise.resolve(0);
    }
    return resolveField(subquery, uType, fieldDef, parentForResolvers, calculationContext, path, structures)
        .then(result => {
            // extend data structures to capture field name and colon
            structures.resultMap.get(mapKey).push("\"" + fieldName + "\"" + ":");

            // extend data structures to capture the given result fetched for the object field
            return updateDataStructuresForObjectFieldResult(result, structures, mapKey, subquery, fieldDef, parentForResolvers, calculationContext, path)
                .then(subquerySize => {
                    return Promise.resolve(subquerySize + 2);
                });
        });
}

/**
 * Used by updateDataStructuresForObjectField.
 */
async function updateDataStructuresForObjectFieldResult(result, structures, mapKey, subquery, fieldDef, parentForResolvers, calculationContext, path) {
    if (result == null) {
        // add 1 for null
        structures.globalSize += 1;
    } else if(Array.isArray(result)) {
        // add for '[' and ']' and for commas
        structures.globalSize += 2 + result.length - 1;
    }
    
    // update uType for the following recursion
    const relatedNodeType = (fieldDef.astNode.type.kind === 'ListType') ?
        fieldDef.type.ofType :
        fieldDef.type;
    // proceed depending on the given result fetched for the object field
    let resultPromise;
    if (result == null) { // empty/no sub-result
        structures.resultMap.get(mapKey).push("null");
        resultPromise = Promise.resolve(1); // for 'null'
    } else if (Array.isArray(result)) {
        structures.resultMap.get(mapKey).push("[");
        return Promise.all(result.map((resultItem, index) => {
            // abort resolving array of queries
            if(checkTermination(structures, calculationContext)){
                return Promise.resolve(0);
            }

            if (index !== 0) {
                structures.resultMap.get(mapKey).push(",");
            }
            const newParentForResolvers = resultItem;
            return updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, mapKey, newParentForResolvers, calculationContext, path);
        }))
            .then(resultItemSizes => {
                structures.resultMap.get(mapKey).push("]");
                let size = 2;                        // for '[' and ']'
                size += resultItemSizes.length - 1;  // for the commas
                resultItemSizes.forEach(resultItemSize => size += resultItemSize);
                return Promise.resolve(size);
            });
    } else { // sub-result is a single object
        const newParentForResolvers = result;
        resultPromise = updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, mapKey, newParentForResolvers, calculationContext, path);
    }
    return resultPromise;
}

/**
 * Used by updateDataStructuresForObjectFieldResult.
 */
function updateDataStructuresForObjectFieldResultItem(structures, subquery, relatedNodeType, fieldDef, mapKey, parentForResolvers, calculationContext, path) {
    // add 2 for '{' and '}'
    structures.globalSize += 2;

    let relatedNode = createNode(parentForResolvers, fieldDef);
    let mapKeyForRelatedNode = getMapKey(relatedNode, subquery.selectionSet.selections);
    // The following block should better be inside the 'then' block below, but it doesn't work correctly with the referencing in results.
    // extend the corresponding resultMap entry
    structures.resultMap.get(mapKey).push("{");
    structures.resultMap.get(mapKey).push([mapKeyForRelatedNode]);
    structures.resultMap.get(mapKey).push("}");
    
    // get into the recursion for the given result item
    return populateDataStructures(structures, relatedNode, relatedNodeType, subquery.selectionSet.selections, parentForResolvers, calculationContext, path)
        .then(subquerySize => {
            return Promise.resolve(subquerySize + 2); // +2 for '{' and '}'
        });
}

/*
 * Updates the given data structures for inline fragments.
 * This corresponds to lines 41-45 in the pseudo code of the algorithm.
 */
function updateDataStructuresForInlineFragment(structures, mapKey, u, uType, query, parentForResolvers, calculationContext, path) {
    let onType = query.typeCondition.name.value;
    if (nodeType(u) === onType) {
        let subquery = query.selectionSet.selections;
        let mapKeyForSubquery = getMapKey(u, subquery);
        structures.resultMap.get(mapKey).push([mapKeyForSubquery]);
        const uTypeNew = fieldInfo.exeContext.schema.getType(onType);
        return populateDataStructures(structures, u, uTypeNew, subquery, parentForResolvers, calculationContext, path);
    } else {
        return Promise.resolve(0); // the sub-result will be the empty string
    }
}

function extendPath(prev, key) {
    return { prev: prev, key: key };
}

function checkTermination(structures, calculationContext){
    // check for results size exception
    if(calculationContext.errorCode){
        return true;
    } else if(calculationContext.terminateEarly
              && calculationContext.threshold != 0
              && structures.globalSize > calculationContext.threshold) {
        calculationContext.errorCode = 'EARLY_TERMINATION_RESULT_SIZE_LIMIT_EXCEEDED';
        calculationContext.earlyTerminationTimestamp = performance.now();
        return true;
    }
    return false;
}

/**
 * Builds the resolver info and args, then executes the corresponding resolver function.
 */
function resolveField(subquery, nodeType, fieldDef, parentForResolvers, calculationContext, path, structures) {
    let resolveFn = fieldDef.resolve;
    let info = buildResolveInfo(calculationContext.exeContext, fieldDef, calculationContext.fieldNodes, nodeType, path);
    let args = (0, getArgumentValues(fieldDef, subquery, calculationContext.exeContext.variableValues));
    
    return limit(() => {
        if(checkTermination(structures, calculationContext)){
            return Promise.resolve(null);
        }
        return resolveFn(parentForResolvers, args, calculationContext.exeContext.contextValue, info);
    });
}

/** Produces the result from the results structure into a string.
 * index is a combination of a node and a query
 * each element in results is either a string or another index
 * if the element is a string it is just added to the response
 * else it is another index, in which case the function is run recursively
 */
function produceResult(resultMap, index) {
    if (resultMap == null) {
        return "";
    }
    let response = "";
    resultMap.get(index).forEach(element => {
        if (Array.isArray(element) && element.length > 1) {
            _.forEach(element, (subElement) => {
                response += subElement;q
            });
        } else if (typeof element === "object" && element !== null) {
            response += produceResult(resultMap, element[0]);
        } else if (element === undefined || element == null) {
            response += null;
        } else {
            response += element;
        }
    });
    return response;
}

export { queryCalculator };