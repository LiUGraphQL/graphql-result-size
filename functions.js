var getEdges = (graph, query, u, directives) => {

  let table = directives.name.value;
  let u_id;
  if (query.arguments.length > 0) {
    u_id = query.arguments[0].value.value;
  } else {
    u_id = u.id;
  }
  let id = directives.arguments[0].value.value;
  let relation = directives.arguments[1].value.value;

  return graph.db.all('SELECT '+id+' as id FROM '+table+' WHERE '+relation+' = ?', u_id);
};

var getRootNode = (db) => {

  var res = {id: 0, table: "Query"};
  return res;
};

module.exports = {
  getEdges,
  getRootNode
};
