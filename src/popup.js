// Popup settings panel: toggle features and manage saved project colors.

// Feature metadata comes from the shared registry (features/registry.js),
// loaded before this script — the same list core.js uses, so there's nothing
// to keep in sync here.
var FEATURES = window.CPP_FEATURES || [];

// The popup only ever touches cppFeatures and projectColors, both of which now
// live in chrome.storage.sync so they follow the user across Chrome profiles.
function get(keys) {
  return new Promise(function (r) { chrome.storage.sync.get(keys, r); });
}
function set(obj) {
  return new Promise(function (r) { chrome.storage.sync.set(obj, r); });
}

// Mirror of core.js migrateToSync (see the note there): a one-time move of the
// synced allow-list from .local into .sync, guarded by a device-local flag. The
// popup runs it too so opening it before ever visiting claude.ai still shows the
// migrated config rather than defaults. Whichever runs first migrates; the other
// sees the flag and skips. Kept in step with core.js's SYNC_KEYS/SYNC_PREFIXES.
function migrateToSync() {
  function isSyncKey(k) {
    return k === "cppFeatures" || k === "projectColors" ||
      k.indexOf("cppBookmarks:") === 0;
  }
  return new Promise(function (resolve) {
    chrome.storage.local.get(["cppSyncMigrated"], function (flag) {
      if (flag && flag.cppSyncMigrated) return resolve();
      chrome.storage.local.get(null, function (all) {
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
          chrome.storage.local.set({ cppSyncMigrated: true }, function () { resolve(); });
        };
        if (!keys.length) return markDone();
        chrome.storage.sync.set(move, function () {
          if (chrome.runtime && chrome.runtime.lastError) return resolve();
          chrome.storage.local.remove(keys, function () { markDone(); });
        });
      });
    });
  });
}

function isEnabled(flags, f) {
  return Object.prototype.hasOwnProperty.call(flags, f.id)
    ? !!flags[f.id]
    : f.defaultEnabled !== false;
}

function renderFeatures(flags) {
  var host = document.getElementById("features");
  host.textContent = "";
  FEATURES.forEach(function (f) {
    var row = document.createElement("div");
    row.className = "feature";

    var label = document.createElement("label");
    label.className = "switch";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = isEnabled(flags, f);
    input.addEventListener("change", function () {
      get(["cppFeatures"]).then(function (d) {
        var next = d.cppFeatures || {};
        next[f.id] = input.checked;
        set({ cppFeatures: next });
      });
    });
    var slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(input);
    label.appendChild(slider);

    var meta = document.createElement("div");
    meta.className = "meta";
    var name = document.createElement("div");
    name.className = "name";
    name.textContent = f.name;
    var desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = f.description;
    meta.appendChild(name);
    meta.appendChild(desc);

    row.appendChild(meta);
    row.appendChild(label);
    host.appendChild(row);
  });
}

function renderColors(colors) {
  var host = document.getElementById("colors");
  host.textContent = "";
  var ids = Object.keys(colors);
  if (!ids.length) {
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No colors yet. Open a project and pick one.";
    host.appendChild(empty);
    return;
  }
  ids.forEach(function (pid) {
    var row = document.createElement("div");
    row.className = "color-row";

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colors[pid];

    var code = document.createElement("code");
    code.textContent = pid.slice(0, 8) + "…";
    code.title = pid;

    var del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Remove color";
    del.addEventListener("click", function () {
      get(["projectColors"]).then(function (d) {
        var next = d.projectColors || {};
        delete next[pid];
        set({ projectColors: next }).then(function () { renderColors(next); });
      });
    });

    row.appendChild(dot);
    row.appendChild(code);
    row.appendChild(del);
    host.appendChild(row);
  });
}

document.getElementById("clear-colors").addEventListener("click", function () {
  set({ projectColors: {} }).then(function () { renderColors({}); });
});

migrateToSync().then(function () {
  return get(["cppFeatures", "projectColors"]);
}).then(function (d) {
  renderFeatures(d.cppFeatures || {});
  renderColors(d.projectColors || {});
});
