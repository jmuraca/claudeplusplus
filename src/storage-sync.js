// Storage-sync policy — the single source of truth for which keys follow the
// user across their Chrome profiles via chrome.storage.sync, plus the one-time
// migration from the pre-sync days when everything lived in .local.
//
// Loaded in two contexts (before the scripts that use it):
//   • as a content script before core.js, so the page integration routes and
//     migrates storage, and
//   • in popup.html before popup.js, so the settings panel agrees on the
//     allow-list and can migrate when opened before claude.ai is ever visited.
//
// Keeping the allow-list here means adding a synced key is a one-line edit in
// one place — core.js and popup.js both read window.CPP_SYNC.
(function (root) {
  "use strict";

  // Config and bookmarks sync; bulky or device-scoped state (asides, prompt
  // stash, title caches, device ids) stays on .local to respect sync's
  // ~100KB / 8KB-per-item / 512-item quotas.
  var SYNC_KEYS = { cppFeatures: 1, projectColors: 1 };
  var SYNC_PREFIXES = ["cppBookmarks:"];

  function isSyncKey(k) {
    if (SYNC_KEYS[k]) return true;
    for (var i = 0; i < SYNC_PREFIXES.length; i++) {
      if (k.indexOf(SYNC_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  // One-time move of the synced allow-list from .local into chrome.storage.sync,
  // guarded by a device-local flag so it runs at most once per profile. If
  // sync.set fails (over quota / sync disabled) the local copies are left intact
  // and the flag is not set, so a later load retries — data is never removed
  // from local until sync has it.
  function migrateToSync() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(["cppSyncMigrated"], function (flag) {
          void (chrome.runtime && chrome.runtime.lastError);
          if (flag && flag.cppSyncMigrated) return resolve();
          chrome.storage.local.get(null, function (all) {
            void (chrome.runtime && chrome.runtime.lastError);
            all = all || {};
            var move = {};
            var keys = [];
            Object.keys(all).forEach(function (k) {
              if (k !== "cppSyncMigrated" && isSyncKey(k)) {
                move[k] = all[k];
                keys.push(k);
              }
            });
            var markDone = function () {
              chrome.storage.local.set({ cppSyncMigrated: true }, function () {
                void (chrome.runtime && chrome.runtime.lastError);
                resolve();
              });
            };
            if (!keys.length) return markDone();
            chrome.storage.sync.set(move, function () {
              if (chrome.runtime && chrome.runtime.lastError) return resolve();
              chrome.storage.local.remove(keys, function () {
                void (chrome.runtime && chrome.runtime.lastError);
                markDone();
              });
            });
          });
        });
      } catch (e) {
        resolve();
      }
    });
  }

  root.CPP_SYNC = {
    isSyncKey: isSyncKey,
    migrateToSync: migrateToSync
  };
})(typeof window !== "undefined" ? window : this);
