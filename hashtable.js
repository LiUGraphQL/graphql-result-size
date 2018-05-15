function HashTableArrays() {
  this.hashes = {};
}

HashTableArrays.prototype = {
  constructor: HashTableArrays,

  add: function(key, value) {
    if (!(JSON.stringify(key) in this.hashes)) {
      this.hashes[JSON.stringify(key)] = [];
    }
    this.hashes[JSON.stringify(key)].push(value);
  },

  ret: function(key) {
    if (!(JSON.stringify(key) in this.hashes)) {
      this.hashes[JSON.stringify(key)] = [];
    }
    return this.hashes[JSON.stringify(key)];
  }

};

module.exports = HashTableArrays;
