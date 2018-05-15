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

    const calculate = (u, query, parent) => {

      if (!(_.some(labels.get(u), function(o) {
          return _.isEqual(o, query);
        }))) {
        if (!labels.containsKey(u)) {
          labels.put(u, [query]);
        } else {
          labels.get(u).push(query);
        }

        if (query.length > 1) {
          //  console.log("MultiQuery:C4");
          return Promise.all(query.map(item => {
            sizeMap.add([u, query], sizeMap.ret([u, [item]]));
            return calculate(u, [item], parent);
          }));

        } else if (!(query[0].selectionSet)) {
          //  console.log("FieldQuery:C1");
          sizeMap.add([u, query], 3);
          return Promise.resolve();

        } else if (query[0].kind === 'Field') {
          //  console.log('ListQuery:C2');
          let fieldDef = parent.getFields()[query[0].name.value];
          let currParent = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;
          const directives = fieldDef.astNode.directives[0];
          return getEdges(g, query[0], u, directives)
            .then(result => {
              if (fieldDef.astNode.type.kind === 'ListType') {
                sizeMap.add([u, query], 4);
              } else if (result.length > 0) {
                sizeMap.add([u, query], 2);
              } else {
                sizeMap.add([u, query], 3);
              }
              return Promise.all(result.map(item => {
                let v = new Node(item.id, currParent);
                sizeMap.add([u, query], 2);
                sizeMap.add([u, query], sizeMap.ret([v, query[0].selectionSet.selections]));
                return calculate(v, query[0].selectionSet.selections, currParent);
              }));
            });
        }
      } else {
        //  console.log('query exists in labels');
        return Promise.resolve();
      }
    };

    // eslint-disable-next-line no-inner-declarations
    function Node(x, y) {
      this.id = x;
      this.table = y;
    }

    Node.prototype.equals = function(obj) {
      return (obj instanceof Node) &&
        (obj.id === this.id) &&
        (obj.table === this.table);
    };

    var labels = new Hashtable();
    var sizeMap = new HashTable2();
    let query = parse(validationContext.getDocument().definitions[0].selectionSet.selections);
    const rootNode = new Node(0, 'Query'); //getRootNode(g);


    return calculate(rootNode, query, validationContext.getSchema().getQueryType())
      .then(() => {
        const querySize = arrSum(sizeMap.ret([rootNode, query]));
        console.log('Size of result: ' + querySize);
        //console.log(sizeMap.arrs);
        //console.log(labels.keys());
        if (querySize > maxSize) {
          validationContext.reportError(
            new GraphQLError(
              `Validation: Size of query result is ${querySize}, which exceeds maximum size of ${maxSize}`)
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

module.exports = queryCalculator;
