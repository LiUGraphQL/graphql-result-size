import _ from 'lodash';

//Representation of a node, unique to the back-end
function Node(x, y) {
  this.id = x;
  this.table = y;
}

//Function for determining equality between nodes
Node.prototype.equals = (obj) => {
  return (obj instanceof Node) &&
    (obj.id === this.id) &&
    (obj.table === this.table);
};

//Return a new instance of a Node object, unique representation of the root node
const getRootNode = (queryType) => {
  return new Node(0, queryType.name);
};

//Return the type of the given node, output should be a GraphQLType object
const nodeType = (node) => {
  return node.table;
};

// Create a new node
const createNode = (item, fieldDef) => {
  let id = item;
  let fieldTypes = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType._fields : fieldDef.type._fields;
  _.forOwn(fieldTypes, type => {
    if (type.type.name === 'ID') {
      id = item[type.name];
    }
  });
  let type = fieldDef.astNode.type.kind === 'ListType' ? fieldDef.type.ofType.name : fieldDef.type.name;
  return new Node(id, type);
};

export {
  Node,
  createNode,
  getRootNode,
  nodeType
};
