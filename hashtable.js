function HashTableArrays() {
  this.hashes = {};
}

HashTableArrays.prototype = {
  constructor: HashTableArrays,

  add: function(key, value) {
    this.hashes[JSON.stringify(key)].push(value);
  },

  //initialize if needed and retrieve the array stored for the key
  ret: function(key) {
    if (!(JSON.stringify(key) in this.hashes)) {
      this.hashes[JSON.stringify(key)] = [];
    }
    return this.hashes[JSON.stringify(key)];
  },

  //initialize if needed
  init: function(key) {
    if (!(JSON.stringify(key) in this.hashes)) {
      this.hashes[JSON.stringify(key)] = [];
    }
  },

};

module.exports = HashTableArrays;
