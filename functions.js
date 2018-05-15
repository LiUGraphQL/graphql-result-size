function Node(x, y) {
  this.id = x;
  this.table = y;
}

Node.prototype.equals = function(obj) {
  return (obj instanceof Node) &&
    (obj.id === this.id) &&
    (obj.table === this.table);
};

var getEdges = (graph, query, u, fieldDef) => {
  const directives = fieldDef.astNode.directives[0];
  let table = directives.name.value;
  let u_id;
  if (query.arguments.length > 0) {
    u_id = query.arguments[0].value.value;
  } else {
    u_id = u.id;
  }
  let id = directives.arguments[0].value.value;
  let relation = directives.arguments[1].value.value;
  let type = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType : fieldDef.type;

  return graph.db.all('SELECT ' + id + ' as id FROM ' + table + ' WHERE ' + relation + ' = ?', u_id).then((result) => {
    return result.map(item => {
      return new Node(item.id, type);
    });
  });
};

var getRootNode = (graph, queryType) => {
  return new Node(0, queryType);
};

module.exports = {
  Node,
  getEdges,
  getRootNode
};
