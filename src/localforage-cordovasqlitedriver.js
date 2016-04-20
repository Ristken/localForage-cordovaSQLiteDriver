/*
 * Includes code from:
 *
 * localForage - websql driver
 * https://github.com/mozilla/localforage
 *
 * Copyright (c) 2015 Mozilla
 * Licensed under Apache 2.0 license.
 *
 * ======================================
 *
 * base64-arraybuffer
 * https://github.com/niklasvh/base64-arraybuffer
 *
 * Copyright (c) 2012 Niklas von Hertzen
 * Licensed under the MIT license.
 */
(function() {
    'use strict';

    function constant(x) {
        return function () {
            return x;
        };
    }

    function ifNotNull(fn) {
        return function (x) {
            if (x !== null) {
                return fn(x);
            }
            return x;
        };
    }

    function withCallback(callback, promise) {
        if (callback) {
            promise.then(function (result) {
                    callback(null, result);
                })
                .catch(function (error) {
                    callback(error);
                });
        }
        return promise;
    }

    var serializer = window.localforage.getSerializer();

    var deviceReady = new Promise(function (resolve, reject) {
        if (!window.cordova) {
            reject(new Error('Cordova is required'));
        } else {
            document.addEventListener('deviceready', function () {
                if (window.sqlitePlugin) {
                    resolve();
                } else {
                    reject(new Error('Cordova-sqlite-plugin is required'));
                }
            }, false);
        }
    });

    var dbOptions = {
        name: 'lf',
        location: 'default',
        storeName: 'keyvaluepairs',
        inited: false
    };

    function _initStorage(options) {
        if (options.name) {
            dbOptions.name = options.name;
        }
        if (options.location) {
            dbOptions.location = options.location;
        }
        if (options.storeName) {
            dbOptions.storeName = options.storeName;
        }
        dbOptions.inited = true;
    }

    function _support () {
        return deviceReady()
            .then(function () {
                return true;
            })
            .catch(function () {
                return false;
            });
    }

    function openDatabaseImpl() {
        deviceReady.then(function () {
                return new Promise(function (resolve, reject) {
                    openDatabase({name: dbOptions.name, location: dbOptions.location}, resolve, reject);
                });
            })
            .then(function (db) {
                return transact('CREATE TABLE IF NOT EXISTS ' + dbOptions.storeName +
                                    ' (id INTEGER PRIMARY KEY, key unique, value)', [])(db)
                    .then(constant(db));
            });
    }

    var cachedOpenPromise = null;
    function openDatabase () {
        if (cachedOpenPromise) {
            return cachedOpenPromise;
        } else {
            if (!dbOptions.inited) {
                return (cachedOpenPromise = Promise.reject(new Error('Options not yet initialized')));
            } else {
                return (cachedOpenPromise = openDatabaseImpl());
            }
        }
    }

    // Given sql and replacements, execute against the provided database
    function transact(sql, replacements) {
        return function (db) {
            return new Promise(function (resolve, reject) {
                db.transaction(function(t) {
                        t.executeSql(sql, replacements || [],
                            function (t, results) {
                                resolve(results);
                            },
                            function (t, error) {
                                reject(error);
                            });
                    },
                    function (error) {
                        reject(error);
                    });
            });
        };
    }

    function ensureString(key) {
        if (typeof key !== 'string') {
            window.console.warn(key + ' used as a key, but it is not a string.');
            return String(key);
        }
        return key;
    }

    function getItem(key, callback) {
        key = ensureString(key);
        return withCallback(callback, serializer
            .then(function (serializer) {
                return openDatabase()
                    // ? doesn't work for things like tablename in the query, hopefully, clients won't sql inject themselves
                    .then(transact('SELECT * FROM ' + dbOptions.storeName + ' WHERE key = ? LIMIT 1', [key]))
                    .then(function (results) {
                        return results.rows.length > 0 ?
                            results.rows.item(0).value :
                            null;
                    })
                    .then(ifNotNull(serializer.deserialize));
            }));
    }

    function iterate(iterator, callback) {
        return withCallback(callback, serializer
            .then(function (serializer) {
                return openDatabase()
                    .then(transact('SELECT * FROM ' + dbOptions.storeName, []))
                    .then(function (results) {
                        var rows = results.rows;
                        var length = rows.length;
                        for (var i = 0; i < length; i++) {
                            var item = rows.item(i);
                            var value = item.value;
                            var response = null;
                            if (value) {
                                response = iterator(serializer.deserialize(value), item.key, i);
                            } else {
                                response = iterator(null, item.key, i + 1);
                            }
                            if (response !== void(0)) {
                                return;
                            }
                        }
                    });
            }));
    }

    function setItem(key, value, callback) {
        key = ensureString(key);
        return withCallback(callback, serializer
            .then(function (serializer) {
                return openDatabase()
                    .then(transact('INSERT OR REPLACE INTO ' + dbOptions.storeName + ' (key, value) VALUES (?, ?)', [key, serializer.serialize(value)]))
                    .then(constant(value));
            }));
    }

    function removeItem(key, callback) {
        key = ensureString(key);
        return withCallback(callback, openDatabase()
            .then(transact('DELETE FROM ' + dbOptions.storeName + ' WHERE key = ?', [key])));
    }

    function clear(callback) {
        return withCallback(callback, openDatabase()
            .then(transact('DELETE FROM ' + dbOptions.storeName)));
    }

    function length(callback) {
        return withCallback(callback, openDatabase()
            .then(transact('SELECT COUNT(key) as c FROM ' + dbOptions.storeName))
            .then(function (results) {
                return results.rows.item(0).c;
            }));
    }

    function key(n, callback) {
        return withCallback(callback, openDatabase()
            .then(transact('SELECT key FROM ' + dbOptions.storeName + ' WHERE id = ? LIMIT 1', [n + 1]))
            .then(function (results) {
                return results.rows.length > 0 ?
                    results.rows.item(0).key : null;
            }));
    }

    function keys(callback) {
        return withCallback(callback, openDatabase()
            .then(transact('SELECT key FROM ' + dbOptions.storeName))
            .then(function (results) {
                var keys = [];
                for (var i = 0; i < results.rows.length; i++) {
                    keys.push(results.rows.item(i).key);
                }
                return keys;
            }));
    }

    window.cordovaSQLiteDriver = {
        _driver: 'cordovaSQLiteDriver',
        _initStorage: _initStorage,
        _support: _support,
        getItem: getItem,
        iterate: iterate,
        setItem: setItem,
        removeItem: removeItem,
        clear: clear,
        length: length,
        key: key,
        keys: keys
    };
})();
