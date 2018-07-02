
/**
 * Example code in the functions should be replaced with code specific to the
 * back-end used.
 */

//Representation of a node, unique to the back-end
function Node(x, y) {
  this.id = x;
  this.table = y;
}

//Function for determining equality between nodes
Node.prototype.equals = function(obj) {
  return (obj instanceof Node) &&
    (obj.id === this.id) &&
    (obj.table === this.table);
};

/**
 * Given a context object for the back-end, query, node and definition
 * of the field queried from the GraphQL Schema, query the back-end to retrieve
 * the nodes sharing the relationship.
 * Output should be an array of nodes of the speficied Node Representation
 */
var getEdges = (db, query, u, fieldDef) => {
  const directives = fieldDef.astNode.directives[0];
  let table = directives.name.value;
  let u_id;
  let limit;
  let id = directives.arguments[0].value.value;
  let relation = directives.arguments[1].value.value;
  let type = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;

  if (query.arguments.length > 0) {
    if (query.arguments[0].name.value == 'limit') {
      limit = query.arguments[0].value.value;
      u_id = u.id;
    } else {
      u_id = query.arguments[0].value.value;
    }
  } else {
    u_id = u.id;
  }

  return db.db.all('SELECT ' + id + ' as id FROM ' + table + ' WHERE ' + relation + ' = ? ' + (limit ? ' LIMIT ' + limit : ''), u_id).then((result) => {
    return result.map(item => {
      return new Node(item.id, type);
    });
  });
};

//Return a new instance of a Node object, unique representation of the root node
var getRootNode = (db, queryType) => {
  return new Node(0, queryType);
};

//Return the type of the given node, output should be a GraphQLType object
var nodeType = (db, node) => {
  return node.table;
};

module.exports = {
  Node,
  getEdges,
  getRootNode,
  nodeType
};
