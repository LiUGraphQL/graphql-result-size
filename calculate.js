var _ = require('lodash');
var Hashtable = require('jshashtable');
var HashTable2 = require('./hashtable');
var parse = require('./queryParser');
var {
  GraphQLError
} = require('graphql');
var {
  getEdges
} = require('./functions');


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

const queryCalculator = (g, maxSize, validationContext) => {
  try {
    if (_.size(validationContext.getDocument().definitions) > 1) {
      return Promise.resolve(validationContext);
    }

    return Promise.resolve().then(() => {
      return validationContext;
    });

  } catch (err) {
    {
      console.error(err);
      throw err;
    }
  }
};

module.exports = queryCalculator;
