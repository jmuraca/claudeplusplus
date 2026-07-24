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

  // ---- storage routing ----------------------------------------------------
  // The sync allow-list and the one-time .local→.sync migration live in
  // storage-sync.js (window.CPP_SYNC), loaded before this script and shared with
  // the popup so there is one source of truth. The util.get/set/remove wrappers
  // below route each key to its home area, so feature code keeps calling
  // ctx.util unchanged.
  var isSyncKey = window.CPP_SYNC.isSyncKey;
  var migrateToSync = window.CPP_SYNC.migrateToSync;
  function areaFor(k) {
    return isSyncKey(k) ? chrome.storage.sync : chrome.storage.local;
  }
  function rawGet(area, query) {
    return new Promise(function (resolve) {
      try {
        area.get(query, function (d) {
          void (chrome.runtime && chrome.runtime.lastError);
          resolve(d || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }
  function rawSet(area, obj) {
    return new Promise(function (resolve) {
      try {
        area.set(obj, function () {
          void (chrome.runtime && chrome.runtime.lastError);
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }
  function rawRemove(area, keys) {
    return new Promise(function (resolve) {
      try {
        area.remove(keys, function () {
          void (chrome.runtime && chrome.runtime.lastError);
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

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

    // The chat id in the current URL, or null when not on a /chat/<uuid> page.
    currentChatId: function () {
      var m = util.CHAT_RE.exec(location.pathname);
      return m ? m[1].toLowerCase() : null;
    },

    // claude.ai's active org id, from the lastActiveOrg cookie. Needed for the
    // /api/organizations/<org>/... endpoints; null if the cookie is absent.
    getOrgId: function () {
      var m = /(?:^|;\s*)lastActiveOrg=([0-9a-f-]{8,})/i.exec(document.cookie);
      return m ? m[1] : null;
    },

    // Normalize claude's several conversation-list response shapes to an array.
    extractConversations: function (data) {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.conversations)) return data.conversations;
      if (data && Array.isArray(data.data)) return data.data;
      return [];
    },

    // ---- composer ---------------------------------------------------------
    // The message box is claude.ai's ProseMirror editor. Draft-mode, prompt-stash
    // and emoji-autocomplete all key off it, so the selectors and the "is this the
    // composer" test live here once rather than copied into each. COMPOSER_SEL
    // matches the composer wrapper or the editable — whichever an event's target
    // resolves to.
    COMPOSER_SEL: '[data-chat-input-container], [data-testid="chat-input"]',

    // True when `node` (or the element it sits in) is inside something matching
    // `sel`. Tolerates a text node or null, which a bare Element.closest won't.
    closest: function (node, sel) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      return !!(el && el.closest && el.closest(sel));
    },

    // The composer's contenteditable, or null when it isn't mounted. Candidates
    // are tried most-specific first.
    composerEditor: function () {
      var sels = [
        '[data-chat-input-container] [contenteditable="true"]',
        '[data-testid="chat-input"] [contenteditable="true"]',
        '[contenteditable="true"][data-testid="chat-input"]',
        'div.ProseMirror[contenteditable="true"]'
      ];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el) return el;
      }
      return null;
    },

    // True while the composer has focus or an event came from it. Both the passed
    // node and the active element are checked, since which one is the reliable
    // signal depends on where the key/input event was dispatched.
    inComposer: function (node) {
      return (
        util.closest(node, util.COMPOSER_SEL) ||
        util.closest(document.activeElement, util.COMPOSER_SEL)
      );
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

    // Convenience wrappers over chrome.storage. Each key is routed to its home
    // area (sync for the allow-list, local otherwise — see isSyncKey), then the
    // results are merged so callers see one flat store. They resolve to a safe
    // empty value (rather than throwing) once the context is gone.
    get: function (keys) {
      if (!util.contextAlive()) return Promise.resolve({});
      // Whole-store read (e.g. the bookmarks page): merge both areas, with sync
      // winning on any overlap so a migrated key never reads a stale local copy.
      if (keys == null) {
        return Promise.all([
          rawGet(chrome.storage.sync, null),
          rawGet(chrome.storage.local, null),
        ]).then(function (r) {
          return Object.assign({}, r[1], r[0]);
        });
      }
      // Single key → its home area.
      if (typeof keys === "string") {
        return rawGet(areaFor(keys), keys);
      }
      // Array of keys, or object of {key: default}: partition by home area,
      // preserving defaults, then merge. A key lives in exactly one area, so
      // defaults are never lost.
      var isArr = Array.isArray(keys);
      var syncQ = isArr ? [] : {};
      var localQ = isArr ? [] : {};
      var syncN = 0;
      var localN = 0;
      (isArr ? keys : Object.keys(keys)).forEach(function (k) {
        if (isSyncKey(k)) {
          if (isArr) syncQ.push(k);
          else syncQ[k] = keys[k];
          syncN++;
        } else {
          if (isArr) localQ.push(k);
          else localQ[k] = keys[k];
          localN++;
        }
      });
      return Promise.all([
        syncN ? rawGet(chrome.storage.sync, syncQ) : Promise.resolve({}),
        localN ? rawGet(chrome.storage.local, localQ) : Promise.resolve({}),
      ]).then(function (r) {
        return Object.assign({}, r[0], r[1]);
      });
    },
    set: function (obj) {
      if (!util.contextAlive()) return Promise.resolve();
      var syncObj = {};
      var localObj = {};
      var hasSync = false;
      var hasLocal = false;
      Object.keys(obj || {}).forEach(function (k) {
        if (isSyncKey(k)) {
          syncObj[k] = obj[k];
          hasSync = true;
        } else {
          localObj[k] = obj[k];
          hasLocal = true;
        }
      });
      return Promise.all([
        hasSync ? rawSet(chrome.storage.sync, syncObj) : Promise.resolve(),
        hasLocal ? rawSet(chrome.storage.local, localObj) : Promise.resolve(),
      ]).then(function () {});
    },
    remove: function (keys) {
      if (!util.contextAlive()) return Promise.resolve();
      var list = Array.isArray(keys) ? keys : [keys];
      var syncList = [];
      var localList = [];
      list.forEach(function (k) {
        (isSyncKey(k) ? syncList : localList).push(k);
      });
      return Promise.all([
        syncList.length ? rawRemove(chrome.storage.sync, syncList) : Promise.resolve(),
        localList.length ? rawRemove(chrome.storage.local, localList) : Promise.resolve(),
      ]).then(function () {});
    },

    // ---- Anthropicons -----------------------------------------------------
    // claude.ai ships its own icon font and declares it document-wide as
    //   @font-face { font-family: Anthropicons-Variable; ... }
    // with no unicode-range, so anything we add to the page can render its
    // glyphs. Drawing our chrome with the real artwork keeps it identical to
    // claude's own icons at every size, weight and optical size — which
    // hand-drawn SVG lookalikes never quite manage.
    //
    // Two things to know before adding to this map. The glyphs sit at
    // private-use codepoints, and the font carries no semantic glyph names —
    // every one is just "uniXXXX" — so these comments are the only record of
    // what each codepoint draws. And the set is not exhaustive: it has no
    // vertical "arrow to bar", which is why the two jump-to-end icons take a
    // horizontal glyph and rotate it upright.
    ICON: {
      ASK: 0xe037, // speech bubble, outline (same glyph as the sidebar chat icon)
      BOOKMARK: 0xe117, // bookmark ribbon, outline
      DOWNLOAD: 0xe063, // arrow pointing down into a tray
      CHEVRON_UP: 0xe02b,
      CHEVRON_DOWN: 0xe027,
      ARROW_BAR_LEFT: 0xe0de, // "|←" — rotate 90 for an arrow up into a bar
      ARROW_BAR_RIGHT: 0xe0df // "→|" — rotate 90 for an arrow down into a bar
    },

    /**
     * A span carrying one Anthropicons glyph, ready to drop into a button.
     * `rotate` is degrees clockwise.
     */
    icon: function (codepoint, rotate) {
      var el = document.createElement("span");
      el.className = "cpp-icon";
      el.setAttribute("aria-hidden", "true");
      el.textContent = String.fromCodePoint(codepoint);
      if (rotate) el.style.transform = "rotate(" + rotate + "deg)";
      return el;
    }
  };

  var features = [];
  var enabled = {}; // id -> bool
  var started = false;
  var ctx = { util: util };

  // Feature metadata (name/description/defaultEnabled) lives in the shared
  // registry (features/registry.js), loaded before this script. Index it by id
  // so a registering module only has to supply { id, ...hooks }.
  var META = {};
  (window.CPP_FEATURES || []).forEach(function (m) {
    if (m && m.id) META[m.id] = m;
  });

  var CPP = {
    util: util,
    registerFeature: function (feature) {
      var meta = META[feature.id];
      // Pull defaultEnabled from the registry unless the module overrode it.
      if (meta && feature.defaultEnabled === undefined) {
        feature.defaultEnabled = meta.defaultEnabled;
      }
      features.push(feature);
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

  // A deletion cascades. A chat delete is dispatched as-is; features reap
  // whatever they keyed under that chat id. A project delete is dispatched
  // first as a project — the feature that owns the conv->project mapping
  // (project-colors) returns the affected chat ids — and each of those is then
  // fanned out as its own chat delete, so features like asides that don't know
  // project membership still get told which chats to reap. Chat deletes don't
  // cascade further, so there's no recursion to bound.
  function dispatchDelete(info) {
    if (deadCtx) return;
    var cascade = [];
    eachEnabled(function (f) {
      if (!f.onDelete) return;
      var extra = f.onDelete(info, ctx);
      if (info.kind === "project" && Array.isArray(extra)) {
        for (var i = 0; i < extra.length; i++) cascade.push(extra[i]);
      }
    });
    if (info.kind !== "project" || !cascade.length) return;
    var seen = {};
    cascade.forEach(function (chatId) {
      var id = String(chatId).toLowerCase();
      if (!id || seen[id]) return;
      seen[id] = true;
      var child = { kind: "chat", id: id, viaProject: info.id };
      eachEnabled(function (f) {
        if (f.onDelete) f.onDelete(child, ctx);
      });
    });
  }

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
    } else if (d.type === "stream") {
      eachEnabled(function (f) {
        if (f.onStream) f.onStream(d, ctx);
      });
    } else if (d.type === "delete" && d.kind && d.id) {
      dispatchDelete({ kind: d.kind, id: String(d.id).toLowerCase() });
    } else if (d.type === "location") {
      scheduleApply();
    }
  });

  // React to settings changes made from the popup — or, since cppFeatures now
  // lives in chrome.storage.sync, from another machine on the same account.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" && area !== "sync") return;
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
    // Move any pre-sync config/bookmarks into chrome.storage.sync before the
    // first read, so a fresh profile picks them up rather than showing defaults.
    migrateToSync().then(function () {
      return util.get(["cppFeatures"]);
    }).then(function (d) {
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
