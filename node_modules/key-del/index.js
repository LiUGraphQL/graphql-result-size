// Copyright 2015 Andrei Karpushonak

"use strict";

var DOT_SEPARATOR = ".";
var _ = require('lodash');

var deleteKeysFromObject = function (object, keys, options) {
  var keysToDelete;

  // deep copy by default
  var isDeep = true;

  // to preserve backwards compatibility, assume that only explicit options means shallow copy
  if (_.isUndefined(options) == false) {
    if (_.isBoolean(options.copy)) {
      isDeep = options.copy;
    }
  }

  // do not modify original object if copy is true (default)
  var finalObject;
  if (isDeep) {
    finalObject = _.clone(object, isDeep);
  } else {
    finalObject = object;
  }

  if (typeof finalObject === 'undefined') {
    throw new Error('undefined is not a valid object.');
  }
  if (arguments.length < 2) {
    throw new Error("provide at least two parameters: object and list of keys");
  }

  // collect keys
  if (Array.isArray(keys)) {
    keysToDelete = keys;
  } else {
    keysToDelete = [keys];
  }

  keysToDelete.forEach(function(elem) {
    for(var prop in finalObject) {
      if(finalObject.hasOwnProperty(prop)) {
        if (elem === prop) {
          // simple key to delete
          delete finalObject[prop];
        } else if (elem.indexOf(DOT_SEPARATOR) != -1) {
          var parts = elem.split(DOT_SEPARATOR);
          var pathWithoutLastEl;

          var lastAttribute;

          if (parts && parts.length === 2) {

            lastAttribute = parts[1];
            pathWithoutLastEl = parts[0];
            var nestedObjectRef = finalObject[pathWithoutLastEl];
            if (nestedObjectRef) {
              delete nestedObjectRef[lastAttribute];
            }
          } else if (parts && parts.length === 3) {
            // last attribute is the last part of the parts
            lastAttribute = parts[2];
            var deepestRef = (finalObject[parts[0]])[parts[1]];
            delete deepestRef[lastAttribute];
          } else {
            throw new Error("Nested level " + parts.length + " is not supported yet");
          }

        } else {
          if (_.isObject(finalObject[prop])) {
            if(_.isArray(finalObject[prop])) {
              finalObject[prop] = _.map(finalObject[prop], function(obj) {
                return deleteKeysFromObject(obj, keysToDelete, options);
              });
            } else {
              finalObject[prop] = deleteKeysFromObject(finalObject[prop], keysToDelete, options);
            }
          }
        }
      }

    }
  });

  return finalObject;

};

module.exports = deleteKeysFromObject;
