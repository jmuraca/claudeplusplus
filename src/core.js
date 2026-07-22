// Claude++ core (isolated-world content script).
//
// Provides a tiny feature framework so each UI improvement lives in its own
// module. Core owns the shared lifecycle: it loads settings, watches the DOM
// and SPA navigation, relays network data from inject-main.js, and calls each
// enabled feature's hooks.
//
// A feature registers via CPP.registerFeature({ id, name, description,
//   defaultEnabled, onInit, onApply, onNetworkMap, onTeardown }).
(function () {
  "use strict";

  var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  var util = {
    UUID_G: new RegExp(UUID, "gi"),
    PROJECT_RE: new RegExp("/project/(" + UUID + ")", "i"),
    CHAT_RE: new RegExp("chat(?:_conversations)?/(" + UUID + ")", "i"),

    currentProjectId: function () {
      var m = location.pathname.match(util.PROJECT_RE);
      return m ? m[1].toLowerCase() : null;
    },

    convFromHref: function (href) {
      if (!href) return null;
      var m = href.match(util.CHAT_RE);
      if (m) return m[1].toLowerCase();
      var all = href.match(util.UUID_G);
      return all ? all[all.length - 1].toLowerCase() : null;
    },

    // True while our extension context is alive. After the unpacked extension
    // is reloaded/updated, an already-injected content script keeps running but
    // every chrome.* call throws "Extension context invalidated"; chrome.runtime
    // (and its .id) goes away, which we use to detect it.
    contextAlive: function () {
      try {
        return !!(chrome.runtime && chrome.runtime.id);
      } catch (e) {
        return false;
      }
    },

    // Convenience wrappers around chrome.storage.local. They resolve to a safe
    // empty value (rather than throwing) once the context is gone.
    get: function (keys) {
      return new Promise(function (resolve) {
        if (!util.contextAlive()) return resolve({});
        try {
          chrome.storage.local.get(keys, function (d) {
            void (chrome.runtime && chrome.runtime.lastError);
            resolve(d || {});
          });
        } catch (e) {
          resolve({});
        }
      });
    },
    set: function (obj) {
      return new Promise(function (resolve) {
        if (!util.contextAlive()) return resolve();
        try {
          chrome.storage.local.set(obj, function () {
            void (chrome.runtime && chrome.runtime.lastError);
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    }
  };

  var features = [];
  var enabled = {}; // id -> bool
  var started = false;
  var ctx = { util: util };

  var CPP = {
    util: util,
    registerFeature: function (feature) {
      features.push(feature);
    },
    // Used by the popup via chrome.storage; exposed here for completeness.
    listFeatures: function () {
      return features.map(function (f) {
        return {
          id: f.id,
          name: f.name || f.id,
          description: f.description || "",
          enabled: isEnabled(f)
        };
      });
    }
  };
  window.CPP = CPP;

  function isEnabled(f) {
    if (Object.prototype.hasOwnProperty.call(enabled, f.id)) return !!enabled[f.id];
    return f.defaultEnabled !== false;
  }

  function eachEnabled(fn) {
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (isEnabled(f)) {
        try {
          fn(f);
        } catch (e) {
          /* keep one feature's failure from breaking the rest */
        }
      }
    }
  }

  // ---- lifecycle ----------------------------------------------------------
  var observer = null;
  var deadCtx = false;

  // Called once the extension context is gone (unpacked reload/update). Stop
  // observing and let features remove whatever UI they added, so the stale
  // script goes quiet instead of throwing on every mutation.
  function shutdown() {
    if (deadCtx) return;
    deadCtx = true;
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
      observer = null;
    }
    features.forEach(function (f) {
      if (f.onTeardown) {
        try { f.onTeardown(ctx); } catch (e) {}
      }
    });
  }

  var applyTimer = null;
  function scheduleApply() {
    if (deadCtx) return;
    if (applyTimer) return;
    applyTimer = setTimeout(function () {
      applyTimer = null;
      if (!util.contextAlive()) return shutdown();
      eachEnabled(function (f) {
        if (f.onApply) f.onApply(ctx);
      });
    }, 150);
  }
  CPP.scheduleApply = scheduleApply;

  // Network data relayed from inject-main.js (MAIN world).
  window.addEventListener("message", function (ev) {
    if (deadCtx) return;
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__cpp !== true) return;
    if (d.type === "map" && Array.isArray(d.pairs)) {
      eachEnabled(function (f) {
        if (f.onNetworkMap) f.onNetworkMap(d.pairs, ctx);
      });
    } else if (d.type === "location") {
      scheduleApply();
    }
  });

  // React to settings changes made from the popup.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.cppFeatures) {
      var prev = {};
      for (var id in enabled) prev[id] = enabled[id];
      enabled = changes.cppFeatures.newValue || {};
      // Tear down anything newly disabled; re-init anything newly enabled.
      features.forEach(function (f) {
        var wasOn = Object.prototype.hasOwnProperty.call(prev, f.id)
          ? !!prev[f.id]
          : f.defaultEnabled !== false;
        var nowOn = isEnabled(f);
        if (wasOn && !nowOn && f.onTeardown) {
          try { f.onTeardown(ctx); } catch (e) {}
        } else if (!wasOn && nowOn && f.onInit) {
          try { f.onInit(ctx); } catch (e) {}
        }
      });
      scheduleApply();
    }
  });

  function start() {
    if (started) return;
    started = true;
    util.get(["cppFeatures"]).then(function (d) {
      enabled = d.cppFeatures || {};
      eachEnabled(function (f) {
        if (f.onInit) f.onInit(ctx);
      });
      scheduleApply();
      observer = new MutationObserver(scheduleApply);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
