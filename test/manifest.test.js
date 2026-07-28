// Tests for the extension's wiring — manifest.json, the feature registry, and
// the popup — rather than for any one feature's behaviour.
//
// Adding a feature means touching four places that have no compile step to hold
// them together: the module under src/features, the manifest's content-script
// list, the registry entry the popup renders a toggle from, and (for anything
// with chrome of its own) a stylesheet. Miss one and there is no error anywhere:
// the feature is simply absent, or present with no way to turn it off. These
// tests are the missing compiler.
//
// Load order is checked too, because two of the orderings are load-bearing and
// invisible. core.js reads the registry when a module registers, so the registry
// has to be first; and features race each other for keys they capture at window,
// where the listener registered first wins — see the emoji/draft-mode pair
// below.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const content = manifest.content_scripts.find((s) => s.world === "ISOLATED");
const scripts = content.js;
const styles = content.css;

// The registry is a plain IIFE that hangs CPP_FEATURES off whatever it's given
// as `root` — with no window in node, that's the object we call it on.
function loadRegistry() {
  const root = {};
  new Function(read("src", "features", "registry.js")).call(root);
  return root.CPP_FEATURES;
}

const FEATURES = loadRegistry();

// Every module under src/features except the registry itself, mapped to the id
// it registers. The id is read out of the source rather than by running the
// module, which would want a live CPP and a DOM.
function moduleIds() {
  const ids = {};
  for (const file of fs.readdirSync(path.join(ROOT, "src", "features"))) {
    if (!file.endsWith(".js") || file === "registry.js") continue;
    const src = read("src", "features", file);
    const m = /registerFeature\(\{\s*id:\s*"([^"]+)"/.exec(src);
    assert.ok(m, `${file} registers a feature with a literal id`);
    ids[file] = m[1];
  }
  return ids;
}

const MODULE_IDS = moduleIds();

test("every feature module is loaded by the manifest", () => {
  for (const file of Object.keys(MODULE_IDS)) {
    assert.ok(
      scripts.includes("src/features/" + file),
      `${file} is in the content-script list — a module the manifest doesn't load is dead code`
    );
  }
});

test("every feature module has a registry entry, and every entry a module", () => {
  const registered = FEATURES.map((f) => f.id);
  const built = Object.values(MODULE_IDS);

  for (const [file, id] of Object.entries(MODULE_IDS)) {
    assert.ok(
      registered.includes(id),
      `${file} registers "${id}", which the registry names — without it the popup has no toggle`
    );
  }
  for (const id of registered) {
    assert.ok(built.includes(id), `the registry's "${id}" has a module under src/features`);
  }
});

test("every registry entry is complete enough to render a toggle", () => {
  for (const f of FEATURES) {
    assert.match(f.id, /^[a-z0-9-]+$/, `${f.id} is a kebab-case id`);
    assert.ok(f.name && f.name.length < 60, `${f.id} has a short name`);
    assert.ok(f.description && f.description.length > 40, `${f.id} says what it does`);
    assert.equal(typeof f.defaultEnabled, "boolean", `${f.id} states its default`);
  }
});

test("every stylesheet ships, and every shipped stylesheet exists", () => {
  const onDisk = fs.readdirSync(path.join(ROOT, "styles")).map((f) => "styles/" + f);
  assert.deepEqual(
    [...styles].sort(),
    onDisk.sort(),
    "a stylesheet the manifest doesn't list is invisible, and one it lists that isn't there fails to load"
  );
});

test("the registry loads before core, and core before the features", () => {
  const at = (p) => scripts.indexOf(p);
  assert.ok(at("src/features/registry.js") >= 0, "the registry is a content script too");

  // core.js reads a feature's defaultEnabled out of the registry at the moment
  // the module registers, so both have to be in place first.
  assert.ok(at("src/features/registry.js") < at("src/core.js"), "registry before core");
  assert.ok(at("src/storage-sync.js") < at("src/core.js"), "storage routing before core");

  for (const file of Object.keys(MODULE_IDS)) {
    assert.ok(
      at("src/core.js") < at("src/features/" + file),
      `core before ${file} — it calls CPP.registerFeature at load`
    );
  }
});

test("emoji autocomplete loads before draft mode, so it wins Enter", () => {
  // Both capture Enter at window, where the listener added first runs first, and
  // features are initialised in load order. Emoji autocomplete has to be that
  // one: while its picker is open Enter picks an emoji, and draft mode would
  // otherwise drop the key as a submit before the picker ever saw it.
  assert.ok(
    scripts.indexOf("src/features/emoji-autocomplete.js") <
      scripts.indexOf("src/features/draft-mode.js"),
    "reordering these silently breaks emoji selection while drafting"
  );
});

test("the emoji data loads before the feature that reads it", () => {
  assert.ok(
    scripts.indexOf("src/data/emoji.js") < scripts.indexOf("src/features/emoji-autocomplete.js")
  );
});

test("the popup loads the same registry the content scripts do", () => {
  // The popup renders one toggle per registry entry, so a popup that doesn't
  // load it shows an empty settings panel rather than an error.
  const popup = read("src", "popup.html");
  assert.match(popup, /<script src="features\/registry\.js"><\/script>/);
  assert.ok(
    popup.indexOf("features/registry.js") < popup.indexOf("popup.js"),
    "and loads it first"
  );
});
