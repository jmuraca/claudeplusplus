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

    // Convenience wrappers around chrome.storage.local.
    get: function (keys) {
      return new Promise(function (resolve) {
        chrome.storage.local.get(keys, resolve);
      });
    },
    set: function (obj) {
      return new Promise(function (resolve) {
        chrome.storage.local.set(obj, resolve);
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
  var applyTimer = null;
  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = setTimeout(function () {
      applyTimer = null;
      eachEnabled(function (f) {
        if (f.onApply) f.onApply(ctx);
      });
    }, 150);
  }
  CPP.scheduleApply = scheduleApply;

  // Network data relayed from inject-main.js (MAIN world).
  window.addEventListener("message", function (ev) {
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
      var obs = new MutationObserver(scheduleApply);
      obs.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
