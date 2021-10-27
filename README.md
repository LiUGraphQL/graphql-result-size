# GraphQL Result Size Calculator (AndreasLundquist branch)
*Note: The code in the master branch of this repo is currently under development, and the following description will have to be updated. If you are here to find the implementation that Tim Andersson has used for his Bachelor thesis ([Result size calculation for Facebook's GraphQL query language](http://urn.kb.se/resolve?urn=urn:nbn:se:liu:diva-150026)), switch to the [TimAndersson branch](https://github.com/LiUGraphQL/graphql-result-size/tree/TimAndersson).*

This is a [Node.js](https://nodejs.org/en/) module that provides a prototypical implementation of an algorithm that calculates the *exact* size of GraphQL response objects. Hence, this module can be used to check whether the size of the response to a GraphQL query exceeds a given threshold. In this sense, the module should be used as a dependency in GraphQL server frameworks that execute the server-side runtime process of GraphQL.

The result-size calculation algorithm implemented in this module has been introduced in the following research paper.

* Olaf Hartig and Jorge Pérez: Semantics and Complexity of GraphQL. In Proceedings of The Web Conference 2018. (download [preprint of the paper](http://olafhartig.de/files/HartigPerez_WWW2018_Preprint.pdf))

Since this research paper is pretty dense and math-heavy, you may first want to read a more [lightweight, high-level summary of the paper](http://blog.liu.se/olafhartig/2018/08/08/lightweight-summary-of-our-paper-semantics-and-complexity-of-graphql/). This summary also contains an example that demonstrates the motivation for checking the size of GraphQL response objects before starting to produce them, as well as an example-based description of our result-size calculation algorithm.

The prototypical implementation in this repo was developed in the context of the following thesis projects.

* Tim Andersson: [Result size calculation for Facebook's GraphQL query language](http://urn.kb.se/resolve?urn=urn:nbn:se:liu:diva-150026).
* Andreas Lundquist: [Combining Result Size Estimation and Query Execution for the GraphQL Query Language](http://urn.kb.se/resolve?urn=urn%3Anbn%3Ase%3Aliu%3Adiva-167086).

## Installation

This Node.js module is *not* published at the [npm registry](https://www.npmjs.com/). Therefore, the module can be installed either by cloning and installing locally or by using npm with the github remote url.

```sh
$ npm install github:LiUGraphQL/graphql-result-size
```

## API

To employ the module it needs to be included in the Javascript source code first:

```js
var sizeCalculator = require("graphql-result-size")
```

The functionality of the module can now be envoked as **sizeCalculator(db, threshold, validationContext)** with the following three arguments:

* **db** is a context object for querying the database back-end (this can be the same context object as passed to the server when started);
* **threshold** is a value for the size of response objects that are considered to be too big;
* **validationContext** is an instance of the GraphQL [`validationContext`](https://github.com/graphql/graphql-js/blob/master/src/validation/ValidationContext.js) class.

The idea is to envoke the function between the ordinary GraphQL validation step and the GraphQL execution step. Then, the function calculates the size of the response object of the query in the `validationContext` object. This size is printed to the server console. If this size is above the given `threshold` value, then the function adds a GraphQL error to the given `validationContext` object. Finally, the function returns the `validationContext` object (with or without the additional error).

The recommended use is to put the GraphQL execution function in the callback of the result size calculation (as illustrated in the following code snippet). In this way, the GraphQL server continues with the execution step only if no error is raised.

```js
  return sizeCalculator(context, 10000000, validationContext).then(valcontext => {
            if(valcontext.getErrors().length){
                return Promise.resolve({ errors: format(valcontext.getErrors()) });
            }
            return Promise.resolve(graphql.execute(...)
            ...
```

## Configuration

The file `functions.js` is assumed to provide the functionality that is specific to the database back-end being used. In the given form, the file contains some example code that works for [the SQLite-based GraphQL server that we have used for experiments](https://github.com/LiUGraphQL/graphql-result-size-experiment).

Hence, to use this module for other GraphQL servers, this example code has to be adapted/replaced. What the functions in the file are supposed to do and what they are expected to return is specified in the file.

## Todo

* [ ] Support for a field returning a sequence of scalars
* [ ] Move the calculate function out of the wrapper
* [ ] Back-end specific functions as argument to `sizeCalculator`
* [ ] Test suite
