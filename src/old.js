var globalObject = this;
var serializer = null;

// // If cordova is not present, we can stop now.
// if (!globalObject.cordova) {
//     return;
// }

var ModuleType = {
    DEFINE: 1,
    EXPORT: 2,
    WINDOW: 3
};

// Attaching to window (i.e. no module loader) is the assumed,
// simple default.
var moduleType = ModuleType.WINDOW;

// Find out what kind of module setup we have; if none, we'll just attach
// localForage to the main window.
if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    moduleType = ModuleType.EXPORT;
} else if (typeof define === 'function' && define.amd) {
    moduleType = ModuleType.DEFINE;
}

// Promises!
var Promise = (moduleType === ModuleType.EXPORT) ?
              require('promise') : this.Promise;

var deviceReady = new Promise(function(resolve, reject) {
    if (globalObject.sqlitePlugin) {
        resolve();
    } else if (!globalObject.cordova) {
        reject();
    } else {
        // Wait for Cordova to load
        document.addEventListener("deviceready", resolve, false);
    }
});

var openDatabasePromise = deviceReady.catch(Promise.resolve).then(function() {
    return new Promise(function(resolve, reject) {
        var sqlitePlugin = sqlitePlugin || globalObject.sqlitePlugin;
        var openDatabase = sqlitePlugin && sqlitePlugin.openDatabase;

        if (typeof openDatabase === 'function') {
            resolve(openDatabase);
        } else {
            reject('SQLite plugin is not present.');
        }
    });
});

// Open the cordova sqlite plugin database (automatically creates one if one didn't
// previously exist), using any options set in the config.
function _initStorage(options) {
    var self = this;
    var dbInfo = {
        db: null
    };

    if (options) {
        for (var i in options) {
            dbInfo[i] = typeof(options[i]) !== 'string' ?
                        options[i].toString() : options[i];
        }
    }

    var serializerPromise = new Promise(function(resolve, reject) {

        // add support for localforage v1.3.x
        if (typeof self.getSerializer === 'function') {
            self.getSerializer().then(resolve, reject);
            return;
        }

        // We allow localForage to be declared as a module or as a
        // library available without AMD/require.js.
        if (moduleType === ModuleType.DEFINE) {
            require(['localforageSerializer'], resolve);
        } else if (moduleType === ModuleType.EXPORT) {
            // I guess bower installed localforage next to this plugin.
            // Making it browserify friendly
            resolve(require('./../../localforage/src/utils/serializer'));
        } else {
            resolve(globalObject.localforageSerializer);
        }
    });

    var dbInfoPromise = openDatabasePromise.then(function(openDatabase){
        return new Promise(function(resolve, reject) {
            // Open the database; the openDatabase API will automatically
            // create it for us if it doesn't exist.
            try {
                dbInfo.db = openDatabase({name: dbInfo.name || 'lf', location: 'default'});
            } catch (e) {
                reject(e);
            }

            // Create our key/value table if it doesn't exist.
            dbInfo.db.transaction(function(t) {
                t.executeSql('CREATE TABLE IF NOT EXISTS ' + dbInfo.storeName +
                             ' (id INTEGER PRIMARY KEY, key unique, value)', [],
                             function() {
                    self._dbInfo = dbInfo;
                    resolve();
                }, function(t, error) {
                    reject(error);
                });
            });
        });
    });

    return serializerPromise.then(function(lib) {
        serializer = lib;
        return dbInfoPromise;
    });
}

function getItem(key, callback) {
    var self = this;

    // Cast the key to a string, as that's all we can set as a key.
    if (typeof key !== 'string') {
        window.console.warn(key +
                            ' used as a key, but it is not a string.');
        key = String(key);
    }

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                t.executeSql('SELECT * FROM ' + dbInfo.storeName +
                             ' WHERE key = ? LIMIT 1', [key],
                             function(t, results) {
                    var result = results.rows.length ?
                                 results.rows.item(0).value : null;

                    // Check to see if this is serialized content we need to
                    // unpack.
                    if (result) {
                        result = serializer.deserialize(result);
                    }

                    resolve(result);
                }, function(t, error) {

                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

function iterate(iterator, callback) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;

            dbInfo.db.transaction(function(t) {
                t.executeSql('SELECT * FROM ' + dbInfo.storeName, [],
                    function(t, results) {
                        var rows = results.rows;
                        var length = rows.length;

                        for (var i = 0; i < length; i++) {
                            var item = rows.item(i);
                            var result = item.value;

                            // Check to see if this is serialized content
                            // we need to unpack.
                            if (result) {
                                result = serializer.deserialize(result);
                            }

                            result = iterator(result, item.key, i + 1);

                            // void(0) prevents problems with redefinition
                            // of `undefined`.
                            if (result !== void(0)) {
                                resolve(result);
                                return;
                            }
                        }

                        resolve();
                    }, function(t, error) {
                        reject(error);
                    });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

function setItem(key, value, callback) {
    var self = this;

    // Cast the key to a string, as that's all we can set as a key.
    if (typeof key !== 'string') {
        window.console.warn(key +
                            ' used as a key, but it is not a string.');
        key = String(key);
    }

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            // The localStorage API doesn't return undefined values in an
            // "expected" way, so undefined is always cast to null in all
            // drivers. See: https://github.com/mozilla/localForage/pull/42
            if (value === undefined) {
                value = null;
            }

            // Save the original value to pass to the callback.
            var originalValue = value;

            serializer.serialize(value, function(value, error) {
                if (error) {
                    reject(error);
                } else {
                    var dbInfo = self._dbInfo;
                    dbInfo.db.transaction(function(t) {
                        t.executeSql('INSERT OR REPLACE INTO ' +
                                     dbInfo.storeName +
                                     ' (key, value) VALUES (?, ?)',
                                     [key, value], function() {
                            resolve(originalValue);
                        }, function(t, error) {
                            reject(error);
                        });
                    }, function(sqlError) {
                        // The transaction failed; check
                        // to see if it's a quota error.
                        if (sqlError.code === sqlError.QUOTA_ERR) {
                            // We reject the callback outright for now, but
                            // it's worth trying to re-run the transaction.
                            // Even if the user accepts the prompt to use
                            // more storage on Safari, this error will
                            // be called.
                            //
                            // TODO: Try to re-run the transaction.
                            reject(sqlError);
                        }
                    });
                }
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

function removeItem(key, callback) {
    var self = this;

    // Cast the key to a string, as that's all we can set as a key.
    if (typeof key !== 'string') {
        window.console.warn(key +
                            ' used as a key, but it is not a string.');
        key = String(key);
    }

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                t.executeSql('DELETE FROM ' + dbInfo.storeName +
                             ' WHERE key = ?', [key],
                             function() {
                    resolve();
                }, function(t, error) {

                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

// Deletes every item in the table.
// TODO: Find out if this resets the AUTO_INCREMENT number.
function clear(callback) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                t.executeSql('DELETE FROM ' + dbInfo.storeName, [],
                             function() {
                    resolve();
                }, function(t, error) {
                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

// Does a simple `COUNT(key)` to get the number of items stored in
// localForage.
function length(callback) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                // Ahhh, SQL makes this one soooooo easy.
                t.executeSql('SELECT COUNT(key) as c FROM ' +
                             dbInfo.storeName, [], function(t, results) {
                    var result = results.rows.item(0).c;

                    resolve(result);
                }, function(t, error) {

                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

// Return the key located at key index X; essentially gets the key from a
// `WHERE id = ?`. This is the most efficient way I can think to implement
// this rarely-used (in my experience) part of the API, but it can seem
// inconsistent, because we do `INSERT OR REPLACE INTO` on `setItem()`, so
// the ID of each key will change every time it's updated. Perhaps a stored
// procedure for the `setItem()` SQL would solve this problem?
// TODO: Don't change ID on `setItem()`.
function key(n, callback) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                t.executeSql('SELECT key FROM ' + dbInfo.storeName +
                             ' WHERE id = ? LIMIT 1', [n + 1],
                             function(t, results) {
                    var result = results.rows.length ?
                                 results.rows.item(0).key : null;
                    resolve(result);
                }, function(t, error) {
                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

function keys(callback) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {
        self.ready().then(function() {
            var dbInfo = self._dbInfo;
            dbInfo.db.transaction(function(t) {
                t.executeSql('SELECT key FROM ' + dbInfo.storeName, [],
                             function(t, results) {
                    var keys = [];

                    for (var i = 0; i < results.rows.length; i++) {
                        keys.push(results.rows.item(i).key);
                    }

                    resolve(keys);
                }, function(t, error) {

                    reject(error);
                });
            });
        }).catch(reject);
    });

    executeCallback(promise, callback);
    return promise;
}

function executeCallback(promise, callback) {
    if (callback) {
        promise.then(function(result) {
            callback(null, result);
        }, function(error) {
            callback(error);
        });
    }
}

var cordovaSQLiteDriver = {
    _driver: 'cordovaSQLiteDriver',
    _initStorage: _initStorage,
    _support: function() {
        return openDatabasePromise.then(function(openDatabase) {
            return !!openDatabase;
        }).catch(function(){ return false; });
    },
    iterate: iterate,
    getItem: getItem,
    setItem: setItem,
    removeItem: removeItem,
    clear: clear,
    length: length,
    key: key,
    keys: keys
};

if (moduleType === ModuleType.DEFINE) {
    define('cordovaSQLiteDriver', function() {
        return cordovaSQLiteDriver;
    });
} else if (moduleType === ModuleType.EXPORT) {
    module.exports = cordovaSQLiteDriver;
} else {
    this.cordovaSQLiteDriver = cordovaSQLiteDriver;
}
