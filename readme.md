# GraphQL Query Calculator
Calculate the size of GraphQL response objects

This module should be used as a dependency to GraphQL server frameworks executing the server-side runtime process of GraphQL.

## Installation



This [Node.js](https://nodejs.org/en/) module is not published to the [npm registry](https://www.npmjs.com/). Installation must be done by either cloning and installing locally, or installing with npm using the git remote url.

```sh
$ npm install github:LiUGraphQL/graphql-query-calculator
```

## API

```js
var queryCalculator = require("graphql-query-calculator")
```

### queryCalculator(db, threshold, validationContext)

Call the function between the GraphQL validation and execution steps to calculate the size of the response object from the query, this size is printed to the server console. If the calculated size is above the threshold value passed to the function, a GraphQL error will be added to the `validationContext` object, returned from the function.

Recommended use is to put the GraphQL execution function in the callback, to only continue if no error is raised.

```js
  return queryCalculator(context, 10000000, validationContext).then(valcontext => {
            if(valcontext.getErrors().length){
                return Promise.resolve({ errors: format(valcontext.getErrors()) });
            }
            return Promise.resolve(graphql.execute(...)
            ...
```

#### db

Context object for querying the back-end. Can be the same object passed to the server when started.

#### validationContext
Instance of a GraphQL [`validationContext`](https://github.com/graphql/graphql-js/blob/master/src/validation/ValidationContext.js) class object.

## Configuration

The file `functions.js` contains back-end specific functionality which needs to be edited before use. The example code for this, present in the file, should be removed. What the functions do and are supposed to return are specified in the file.

## Todo

* [ ] Support for a field returning a sequence of scalars
* [ ] Move the calculate function out of the wrapper
* [ ] Back-end specific functions as argument to `queryCalculator`
* [ ] Test suite
