function parse(queries) {
  queries.map(function(item) {
    remove(item);
  });
  return queries;
}

function remove(node) {
  if (node.name) {
    remove(node.name);
  }
  if (node.selectionSet) {
    remove(node.selectionSet);
  }
  if (node.selections) {
    parse(node.selections);
  }
  if (node.arguments) {
    parse(node.arguments);
  }
  if (node.value) {
    remove(node.value);
  }
  if (node.typeCondition) {
    remove(node.typeCondition);
  }
  if (node.alias) {
    remove(node.alias);
  }

  delete node.loc;
  return node;
}

module.exports = parse;
