"use strict";

/*global describe, it, before, beforeEach, after, afterEach */

var assert = require('assert');
var should = require('should');
var delKey = require('../index');
var _      = require('lodash');

describe('del-key', function() {
  it('shall check parameters', function() {
    try {
      delKey();
      assert.fail('Empty parameter shall throw the error');
    } catch (ex) {
      ex.should.be.not.equal(null);
    }
  });

  it('shall provide two parameters', function() {
    var param = { a: 1};
    try {
      delKey(param);
      assert.fail('One parameter shall not be enough');
    } catch (ex) {
      ex.should.be.not.equal(null);
    }
  });

  it('shall accept single string as a key to delete', function() {
    var objectToDeleteKeyFrom = { a: 1, b: 2};
    var keyToDelete = 'a';
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.a, undefined, 'key shall be deleted');
  });

  it('shall not modify the original object', function() {
    var objectToDeleteKeyFrom = { a: 1, b: 2};
    var keyToDelete = 'a';
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.a, undefined, 'key shall be deleted');
    assert.equal(objectToDeleteKeyFrom.a, 1, 'original key shall not be deleted');
  });

  it('shall accept an array as a keys to delete', function() {
    var objectToDeleteKeyFrom = { key1: 1, key2: 2, key3: 3};
    var keyToDelete = ['key1', 'key2'];
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.key1, undefined, 'key shall be deleted');
    assert.equal(result.key2, undefined, 'key shall be deleted');
    assert.equal(result.key3, 3, 'key shall be kept');
  });

  it('shall delete nested keys', function() {
    var objectToDeleteKeyFrom = { b: 2, c: {d: 5, e: 6}};
    var keyToDelete = ['b', 'd'];
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.b, undefined, 'first level key shall be deleted');
    assert.equal(result.c.d, undefined, 'nested key shall be deleted');
    assert.equal(result.c.e, 6, 'key shall be kept');
  });

  it('shall delete deeply nested keys', function() {
    var objectToDeleteKeyFrom = { b: 2, c: {d: 5, e: {f: 6, g: 8}}};
    var keyToDelete = ['b', 'f'];
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.b, undefined, 'first level key shall be deleted');
    assert.equal(result.c.e.f, undefined, 'nested key shall be deleted');
    assert.equal(result.c.e.g, 8, 'key shall be kept');
  });

  it('shall handle deep copy', function() {

    var objectToDeleteKeyFrom = [{ "one": "first", "two": "second"}];
    var keyToDelete = ['does not exist'];
    var deep = delKey(objectToDeleteKeyFrom, keyToDelete, {copy:true});
    assert.equal(objectToDeleteKeyFrom[0] === deep[0], false, 'objects are cloned explicetely');
    var deepByDefault = delKey(objectToDeleteKeyFrom, keyToDelete);
    assert.equal(objectToDeleteKeyFrom[0] === deepByDefault[0], false, 'object are cloned by default');
  });

  it('shall handle shallow copy', function() {

    var objectToDeleteKeyFrom = { "one": "first", "two": "second"};
    var shallow = delKey(objectToDeleteKeyFrom, 'two', {copy:false});
    assert.equal(objectToDeleteKeyFrom === shallow, true, 'should be the same object');
  });

  it('shall delete nested keys by full path', function() {
    var objectToDeleteKeyFrom = { one: 1, two: 2, nested: {two: 2, three: 3}};
    var keyToDelete = 'nested.two';
    var result = delKey(objectToDeleteKeyFrom, keyToDelete);

    assert.equal(result.one, 1, 'attribute one should be untouched');
    assert.equal(result.two, 2, 'attribute three should be untouched');
    assert.equal(result.nested.two, undefined, 'nested three should be deleted');
    assert.equal(result.nested.three, 3, 'nested three should be untouched');
  });

  it('shall delete nested keys by full path, including multi levels (up to 3)', function() {
    var objectToDeleteKeyFrom = {
      "data": {
        "_id": "user1",
        "images_folder": "54f084eecdf6a09017ffcd7d",
        "local": true,
        "settings": {
          "moto": "Life is beautiful!",
          "description": "Searching for Freedom and peace of mind...",
          "display_name": "user1",
          "official_image_type": "jpg",
          "background_image_style": "cover",
          "profile_searchable": true,
          "background_image_type": "predefined",
          "background_image": "/backgrounds/bg.png",
          "profile_image_type": "predefined",
          "profile_image": "/avatars/icon.png"
        },
        "profile": {"user_id": "user1", "name": "User", "surname": "1", "role": "test"},
        "relationship": {"is_friend": false, "requested_by": "user2", "blocked_by_me": false, "blocked_by_other": false}
      }, "meta": {"code": 200}
    };

    var keyToDelete = 'data.communities';
    var keyToDelete2 = 'data.settings.official_image_type';
    var result = delKey(objectToDeleteKeyFrom, [keyToDelete, keyToDelete2]);

    assert.equal(result.data.communities, undefined, 'nested should be deleted');
    assert.equal(result.data.settings.official_image_type, undefined, 'nested should be deleted');
  });

  it('shall delete nested keys by full path using array and different levels', function() {
    var objectToDeleteKeyFrom = {
      "data": {
        "_id": "user1",
        "images_folder": "54f084eecdf6a09017ffcd7d",
        "local": true,
        "settings": {
          "moto": "Life is beautiful!",
          "description": "Searching for Freedom and peace of mind...",
          "display_name": "user1"
        }
      },
      "meta": {"code": 200}
    };

    var keyToDelete = 'meta';
    var keyToDelete2 = 'data.local';
    var result = delKey(objectToDeleteKeyFrom, [keyToDelete, keyToDelete2]);

    assert.equal(result.data.local, undefined, 'nested should be deleted');
    assert.equal(result.meta, undefined, 'nested should be deleted');
  });

  it('shall support nested arrays', function() {
    var objectToDeleteKeyFrom = {
      "keepThis": "abc",
      "deleteKey": "bye",
      "list": [{
        "keepThis": "def",
        "deleteNested": "bye",
        "nestedList": [{
          "shouldBeHere": "qwe",
          "deleteSuperNested": "bye",
        }]
      }]
    }

    var result = delKey(objectToDeleteKeyFrom, ["deleteKey", "deleteNested", "deleteSuperNested"]);

    // Check if nested attributes in arrays were deleted
    assert.equal(result.deleteKey, undefined, 'deleteKey should be deleted');
    assert.equal(result.list[0].deleteNested, undefined, 'list[0].deleteNested should be deleted');
    assert.equal(result.list[0].nestedList[0].deleteSuperNested, undefined, 'list[0].nestedList[0].deleteSuperNested should be deleted');

    // Check if anything else is still there
    should.exist(result.keepThis);
    result.keepThis.should.equal("abc");

    should.exist(result.list);
    result.list.should.instanceof(Array);

    should.exist(result.list[0].keepThis);
    result.list[0].keepThis.should.equal("def");

    should.exist(result.list[0].nestedList);
    result.list[0].nestedList.should.instanceof(Array);

    should.exist(result.list[0].nestedList[0].shouldBeHere);
    result.list[0].nestedList[0].shouldBeHere.should.equal("qwe");
  });

});
