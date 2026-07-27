// Tests for src/features/file-delete-guard.js.
//
// The markup below is a project's Context panel as captured from claude.ai,
// trimmed to the attributes the feature keys off, plus a selection toolbar of
// the shape one appears in once files are ticked. What's worth pinning down is
// which clicks the guard swallows and which it lets straight through: it sits
// in the capture phase on every click in the document, so a false positive
// would break an unrelated button, and a false negative would delete a file
// without asking. The confirm path is asserted end to end — the delete must go
// out through claude's own control, not through anything we do ourselves.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "features", "file-delete-guard.js"),
  "utf8"
);

const PAGE = `
<div class="w-full px-[1.375rem] py-4 flex flex-col gap-2 mb-1" id="panel">
  <div class="h-6 w-full flex flex-row items-center justify-between gap-4">
    <h3>Context</h3>
    <div class="flex flex-row items-center gap-2" id="bar">
      <button type="button" data-cds="Button" id="search" aria-label="Search files"></button>
      <button type="button" data-cds="Button" id="add" aria-label="Add files"
        data-testid="project-doc-uploader-dropdown-trigger"></button>
    </div>
  </div>
  <div class="flex flex-col mb-1">
    <div id="toolbar"></div>
    <ul class="grid gap-3 mt-3" id="grid">
      <div class="group/thumbnail relative">
        <div data-testid="alpha.pdf">
          <button id="open-0"><img alt="alpha.pdf" src="/api/o/files/f0/thumbnail"></button>
          <div class="absolute bottom-2">
            <label><input id="check-0" class="sr-only peer" type="checkbox"></label>
          </div>
        </div>
        <button id="remove-0" aria-label="Remove alpha.pdf"></button>
      </div>
      <div class="group/thumbnail relative">
        <div data-testid="notes.txt">
          <button id="open-1"></button>
          <div class="absolute bottom-2">
            <label><input id="check-1" class="sr-only peer" type="checkbox"></label>
          </div>
        </div>
        <button id="remove-1" aria-label="Remove notes.txt"></button>
      </div>
    </ul>
  </div>
</div>
<button id="outsider" aria-label="Delete conversation"></button>
`;

// A fresh document, feature instance and recorder per test. `reached` records
// the clicks that made it past the capture-phase guard to a listener on the
// bubble phase — i.e. the ones claude's own code would have seen.
function harness() {
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: "https://claude.ai/cowork/project/42028720-ea8b-49d9-8881-9a33822f6a71",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const reached = [];
  document.addEventListener("click", (e) => {
    if (e.target.closest(".cpp-confirm")) return; // the dialog's own buttons
    const el = e.target.closest("button, [role='button']");
    if (el) reached.push(el.id);
  });

  window.CPP = {
    util: {
      // Mirrors core.js.
      plainText: (el) =>
        (el ? (el.innerText != null ? el.innerText : el.textContent || "") : "")
          .replace(/​/g, "")
          .trim()
    },
    registerFeature(f) {
      this.feature = f;
    }
  };

  new window.Function(SOURCE).call(window);
  const feature = window.CPP.feature;
  feature.onInit(window.CPP);

  const $ = (id) => document.getElementById(id);
  const click = (el) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const press = (key) =>
    document.querySelector(".cpp-confirm-backdrop").dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  const dialog = () => document.querySelector(".cpp-confirm");
  const body = () => document.querySelector(".cpp-confirm-body").textContent;
  const titleText = () => document.querySelector(".cpp-confirm-title").textContent;

  // Put a selection toolbar in place, the way claude does once files are ticked.
  const selectFiles = (...ids) => {
    ids.forEach((id) => { $(id).checked = true; });
    $("toolbar").innerHTML =
      '<button id="bulk-delete" aria-label="Delete"></button>' +
      '<button id="bulk-cancel" aria-label="Cancel"></button>';
    $("toolbar")
      .querySelectorAll("button")
      .forEach((b) => b.addEventListener("click", () => reached.push("bubbled:" + b.id)));
  };

  return { window, document, feature, reached, $, click, press, dialog, body, titleText, selectFiles };
}

test("the tile × is stopped before it deletes anything", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  assert.ok(h.dialog(), "a confirmation opens");
  assert.deepEqual(h.reached, [], "the click never reaches claude's handler");
  assert.equal(h.titleText(), "Delete this file?");
  assert.match(h.body(), /alpha\.pdf/, "the file is named");
  assert.match(h.body(), /can't be undone/);
});

test("confirming re-issues the click on claude's own control", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  h.click(h.document.querySelector(".cpp-confirm-go"));
  assert.deepEqual(h.reached, ["remove-0"], "the delete goes out through the tile's ×");
  assert.equal(h.dialog(), null, "and the dialog closes");
});

test("cancelling deletes nothing", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  h.click(h.document.querySelector(".cpp-confirm-cancel"));
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.reached, []);
});

test("Escape cancels", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  h.press("Escape");
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.reached, []);
});

test("Cancel holds focus, so a stray Enter is the harmless answer", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  assert.equal(h.document.activeElement, h.document.querySelector(".cpp-confirm-cancel"));
});

test("a bulk delete is stopped and names the whole selection", () => {
  const h = harness();
  h.selectFiles("check-0", "check-1");
  h.click(h.$("bulk-delete"));
  assert.ok(h.dialog());
  assert.deepEqual(h.reached, []);
  assert.equal(h.titleText(), "Delete 2 files?");
  assert.match(h.body(), /alpha\.pdf/);
  assert.match(h.body(), /notes\.txt/);
});

test("confirming a bulk delete re-issues that one click", () => {
  const h = harness();
  h.selectFiles("check-0", "check-1");
  h.click(h.$("bulk-delete"));
  h.click(h.document.querySelector(".cpp-confirm-go"));
  // The toolbar's own handler first (it's on the button), then the document's.
  assert.deepEqual(h.reached, ["bubbled:bulk-delete", "bulk-delete"]);
  assert.equal(h.dialog(), null);
});

test("a delete-labelled button with nothing selected is left alone", () => {
  const h = harness();
  // The toolbar only exists while files are ticked; untick them and the same
  // button must stop being treated as a delete.
  h.selectFiles("check-0");
  h.$("check-0").checked = false;
  h.click(h.$("bulk-delete"));
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.reached, ["bubbled:bulk-delete", "bulk-delete"]);
});

test("opening a file, ticking it, and the header buttons all pass through", () => {
  const h = harness();
  for (const id of ["open-0", "open-1", "search", "add"]) {
    h.click(h.$(id));
    assert.equal(h.dialog(), null, `${id} is not a delete`);
  }
  h.click(h.$("check-0"));
  assert.equal(h.dialog(), null, "selecting a file is not a delete");
});

test("a delete elsewhere on the page is none of our business", () => {
  const h = harness();
  h.selectFiles("check-0");
  h.click(h.$("outsider"));
  assert.equal(h.dialog(), null, "outside the Context panel, even while files are selected");
  assert.deepEqual(h.reached, ["outsider"]);
});

test("the list view's own × is skipped so it can't double-prompt", () => {
  // It deletes nothing itself — it forwards to the tile's ×, which is the click
  // the guard is meant to catch.
  const h = harness();
  const list = h.document.createElement("ul");
  list.className = "cpp-files-list";
  list.innerHTML = '<li><button id="row-x" aria-label="Remove alpha.pdf"></button></li>';
  h.$("grid").insertAdjacentElement("afterend", list);
  h.$("row-x").addEventListener("click", () => h.click(h.$("remove-0")));

  h.click(h.$("row-x"));
  assert.equal(h.document.querySelectorAll(".cpp-confirm").length, 1, "exactly one dialog");
  h.click(h.document.querySelector(".cpp-confirm-go"));
  assert.deepEqual(h.reached, ["row-x", "remove-0"]);
});

test("a re-render between asking and confirming doesn't lose the delete", () => {
  // The dialog holds a file name, not a node, and finds the × again on confirm.
  const h = harness();
  h.click(h.$("remove-0"));
  const grid = h.$("grid");
  const fresh = grid.children[0].cloneNode(true);
  grid.replaceChild(fresh, grid.children[0]);
  h.click(h.document.querySelector(".cpp-confirm-go"));
  assert.deepEqual(h.reached, ["remove-0"], "the replacement tile's × is the one clicked");
});

test("teardown stops intercepting and closes an open dialog", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  h.feature.onTeardown();
  assert.equal(h.dialog(), null);
  h.click(h.$("remove-0"));
  assert.equal(h.dialog(), null, "no confirmation once the feature is off");
  assert.deepEqual(h.reached, ["remove-0"], "and the delete goes straight through");
});
