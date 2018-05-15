function HashTable2() {
  //this.hashes = {};
  this.arrs = {};
}

HashTable2.prototype = {
  constructor: HashTable2,

  add: function(key, value) {
    if(!(JSON.stringify(key) in this.arrs)){
      this.arrs[JSON.stringify(key)] = [];
    }
    this.arrs[JSON.stringify(key)].push(value);
  },

  ret: function(key) {
    if(!(JSON.stringify(key) in this.arrs)){
      this.arrs[JSON.stringify(key)] = [];
    }
    return this.arrs[JSON.stringify(key)];
  }

};

module.exports = HashTable2;
