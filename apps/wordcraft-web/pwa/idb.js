// WriterPad settings store on IndexedDB. Loaded before the app starts; the app waits for
// `wpStore.ready`, then reads settings and installed fonts synchronously from memory and writes
// changes back here. Fonts imported by the user live only in this browser's IndexedDB.
(function () {
  var DB = "writerpad", KV = "kv", FONTS = "fonts";
  var cache = new Map();
  var fonts = new Map();
  var dbp;
  try {
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(KV);
        req.result.createObjectStore(FONTS);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  } catch (e) {
    dbp = Promise.reject(e);
  }
  function all(db, store) {
    return new Promise(function (resolve, reject) {
      var out = [];
      var cur = db.transaction(store, "readonly").objectStore(store).openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (c) { out.push([c.key, c.value]); c.continue(); } else { resolve(out); }
      };
      cur.onerror = function () { reject(cur.error); };
    });
  }
  function put(store, key, value) {
    return dbp.then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }
  var ready = dbp.then(function (db) {
    return Promise.all([all(db, KV), all(db, FONTS)]).then(function (r) {
      r[0].forEach(function (kv) { cache.set(kv[0], kv[1]); });
      r[1].forEach(function (kv) { fonts.set(kv[0], kv[1]); });
      // Ask the browser not to evict this data under storage pressure.
      if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }
    });
  }).catch(function () {});
  window.wpStore = {
    ready: ready,
    getItem: function (k) { return cache.has(k) ? cache.get(k) : null; },
    setItem: function (k, v) { cache.set(k, v); put(KV, k, v); },
    putFont: function (name, bytes) {
      var copy = bytes.slice().buffer; // copy: the wasm heap can move
      fonts.set(name, copy);
      put(FONTS, name, copy);
    },
    fonts: function () {
      return Array.from(fonts.values()).map(function (b) { return new Uint8Array(b); });
    }
  };
})();
