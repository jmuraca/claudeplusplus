// The shared test harness: a jsdom window with the real CPP in it.
//
// Every feature test needs CPP.util, and each one used to hand-copy the handful
// of util functions its feature touches, under a comment promising they mirrored
// core.js. Nothing enforced the promise: a stub could drift from core and the
// test would keep passing, which is the wrong way round — the test exists to
// notice exactly that. Loading core.js itself is the fix. A feature under test
// now sees the util it will actually run against, and a change to core that
// breaks a feature breaks that feature's test.
//
// Core is loaded the way the manifest loads it: storage-sync.js first (it owns
// window.CPP_SYNC, which core reads at load), then core.js, both as scripts in
// the page so their bare `window`/`document`/`chrome` resolve to this document's.
// Two things are held back:
//
//   • chrome.* is a stub that stores nothing. No feature test is about storage;
//     the ones that care about a stored value override util.get/set instead.
//   • migrateToSync never settles, which parks core's own start() before it
//     reads settings, initialises features or attaches a MutationObserver. Tests
//     drive the feature's hooks themselves — a core that had started would race
//     them, and would leave timers running past the end of the test.
//
// Feature metadata (registry.js) is deliberately absent: registerFeature is
// replaced below, so the module's registration is captured rather than routed
// through core's lifecycle. What the registry has to line up with is covered by
// manifest.test.js.
const fs = require("node:fs");
const path = require("node:path");

function source() {
  return fs.readFileSync(
    path.join.apply(path, [__dirname, ".."].concat(Array.prototype.slice.call(arguments))),
    "utf8"
  );
}

const STORAGE_SYNC = source("src", "storage-sync.js");
const CORE = source("src", "core.js");

// Run a content script the way the manifest does — in the page, not as a module.
function run(window, src) {
  new window.Function(src).call(window);
}

// Enough of the extension APIs for core to load and for its storage wrappers to
// resolve. Reads come back empty; writes go nowhere. Anything the test put on
// window.chrome wins — a feature that watches storage for changes made in
// another tab needs a real listener list, and that's the test's to own. Core is
// loaded against a stub of its own first (see loadCPP), so a test counting
// listeners counts its feature's, not core's settings watcher.
function chromeStub(existing) {
  const area = {
    get: (_query, cb) => cb({}),
    set: (_obj, cb) => cb && cb(),
    remove: (_keys, cb) => cb && cb()
  };
  const storage = {
    local: area,
    sync: area,
    onChanged: { addListener: () => {}, removeListener: () => {} }
  };
  return {
    runtime: (existing && existing.runtime) || { id: "test" },
    storage: Object.assign(storage, existing && existing.storage)
  };
}

/**
 * Load the real CPP into `window` and return it. `utilOverrides` are merged over
 * CPP.util, for the parts of the page a jsdom fixture can't be: which element is
 * the composer, what the platform is, what storage holds.
 *
 * The returned CPP captures the feature that registers next as `CPP.feature`.
 */
function loadCPP(window, utilOverrides) {
  const provided = window.chrome;
  window.chrome = chromeStub(); // core loads against its own, not the test's
  run(window, STORAGE_SYNC);
  window.CPP_SYNC.migrateToSync = () => new Promise(() => {}); // park core's start()
  run(window, CORE);
  if (provided) window.chrome = chromeStub(provided);

  const CPP = window.CPP;
  CPP.registerFeature = function (feature) {
    CPP.feature = feature;
  };
  if (utilOverrides) Object.assign(CPP.util, utilOverrides);
  return CPP;
}

/**
 * The common case: load CPP, then run one feature module and hand back its
 * registration. `file` is a path under src/, e.g. "features/draft-mode.js".
 */
function loadFeature(window, file, utilOverrides) {
  const CPP = loadCPP(window, utilOverrides);
  run(window, source.apply(null, ["src"].concat(file.split("/"))));
  return CPP.feature;
}

module.exports = { loadCPP, loadFeature, run, source };
