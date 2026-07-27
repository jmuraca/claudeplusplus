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

const PROJECT_FILES = fs.readFileSync(
  path.join(__dirname, "..", "src", "project-files.js"),
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
    <div class="ml-1 -mr-2.5" id="toolbar"></div>
    <ul class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 mt-3" id="grid">
      <div class="group/thumbnail relative">
        <div data-testid="alpha.pdf">
          <button id="open-0"><img alt="alpha.pdf" src="/api/o/files/f0/thumbnail"></button>
          <div class="absolute bottom-2 left-0 right-0 px-2.5">
            <label class="relative select-none">
              <input id="check-0" class="sr-only peer" type="checkbox">
              <div class="bg-bg-000 border-border-200"></div>
              <span class="leading-none sr-only">Select: alpha.pdf</span>
            </label>
          </div>
        </div>
        <button id="remove-0" aria-label="Remove alpha.pdf"></button>
      </div>
      <div class="group/thumbnail relative">
        <div data-testid="notes.txt">
          <button id="open-1"></button>
          <div class="absolute bottom-2 left-0 right-0 px-2.5">
            <label class="relative select-none">
              <input id="check-1" class="sr-only peer" type="checkbox">
              <div class="bg-bg-000 border-border-200"></div>
              <span class="leading-none sr-only">Select: notes.txt</span>
            </label>
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
      currentProjectId: () => "42028720-ea8b-49d9-8881-9a33822f6a71",
      // Mirrors core.js.
      labelOf: (el) =>
        (
          (el.getAttribute("aria-label") || "") + " " +
          (el.getAttribute("title") || "") + " " +
          (el.textContent || "")
        ).toLowerCase(),
      OUR_UI: "[data-cpp]",
      plainText: (el) =>
        (el ? (el.innerText != null ? el.innerText : el.textContent || "") : "")
          .replace(/​/g, "")
          .trim()
    },
    registerFeature(f) {
      this.feature = f;
    }
  };

  new window.Function(PROJECT_FILES).call(window);
  new window.Function(SOURCE).call(window);
  const feature = window.CPP.feature;
  feature.onInit(window.CPP);

  const $ = (id) => document.getElementById(id);
  const click = (el) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const press = (key) =>
    document.querySelector(".cpp-modal-overlay").dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  const dialog = () => document.querySelector(".cpp-confirm");
  const body = () => document.querySelector(".cpp-confirm-body").textContent;
  // The ⚠️ line, sharing the project-delete dialog's own warning class.
  const warning = () => document.querySelector(".cpp-confirm .cpp-del-warning").textContent;
  const lead = () => document.querySelector(".cpp-confirm-lead").textContent;
  const listed = () =>
    Array.from(document.querySelectorAll(".cpp-confirm-files li"), (li) => li.textContent);
  const titleText = () => document.querySelector(".cpp-modal-title").textContent;

  // Tick files the way claude really does: it keeps the selection in its own
  // state, restyles the box and draws the checkmark, and leaves the input's
  // `checked` property alone — which is exactly the case that used to slip past
  // the guard. `native` opts into also setting the property, the way a click
  // the input survives would.
  const selectFiles = (ids, native) => {
    ids.forEach((id) => {
      const box = $(id);
      if (native) box.checked = true;
      const label = box.closest("label");
      label.querySelector("div").className = "bg-accent-100 border-accent-100";
      label.querySelector("div").innerHTML =
        '<svg class="text-oncolor-100" viewBox="0 0 12 12"><path d="M2 6.5L4.5 9L10.5 3"></path></svg>';
    });
    $("toolbar").innerHTML =
      '<div class="group/menu flex items-center">' +
      '<div class="font-base text-text-400 ml-3"><span class="tabular-nums">' +
      ids.length + '</span> selected</div>' +
      '<div class="w-fit" data-state="closed"><button id="bulk-delete" type="button" ' +
      'aria-label="Delete ' + ids.length + ' selected item' + (ids.length === 1 ? '' : 's') +
      '"><svg viewBox="0 0 20 20"><path d="M11 1.5"></path></svg></button></div>' +
      '<div class="w-fit" data-state="closed"><button id="bulk-cancel" type="button" ' +
      'aria-label="Cancel"></button></div></div>';
    $("toolbar")
      .querySelectorAll("button")
      .forEach((b) => b.addEventListener("click", () => reached.push("bubbled:" + b.id)));
  };

  return { window, document, feature, reached, $, click, press, dialog, body, warning, lead, listed, titleText, selectFiles };
}

test("the tile × is stopped before it deletes anything", () => {
  const h = harness();
  h.click(h.$("remove-0"));
  assert.ok(h.dialog(), "a confirmation opens");
  assert.deepEqual(h.reached, [], "the click never reaches claude's handler");
  // One file and many are the same dialog at different sizes: a count in the
  // heading and the question, the names in the list below.
  assert.equal(h.titleText(), "Delete 1 file");
  assert.equal(h.body(), "Are you sure you want to delete 1 file from this project?");
  assert.match(h.lead(), /^⚠️ /, "the warning leads with the emoji");
  assert.equal(h.lead(), "⚠️ This will permanently remove");
  assert.deepEqual(h.listed(), ["alpha.pdf"], "a lone file is listed too");
  assert.equal(
    h.document.querySelector(".cpp-confirm-final").textContent,
    "This can't be undone.",
    "set apart on its own line"
  );
  assert.equal(h.document.querySelector(".cpp-confirm input"), null, "and no name to type");
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
  h.click(h.document.querySelector(".cpp-modal-cancel"));
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
  assert.equal(h.document.activeElement, h.document.querySelector(".cpp-modal-cancel"));
});

test("a bulk delete is stopped and names the whole selection", () => {
  const h = harness();
  h.selectFiles(["check-0", "check-1"]);
  h.click(h.$("bulk-delete"));
  assert.ok(h.dialog());
  assert.deepEqual(h.reached, []);
  assert.equal(h.titleText(), "Delete 2 files");
  assert.equal(h.body(), "Are you sure you want to delete 2 files from this project?");
  assert.equal(h.lead(), "⚠️ This will permanently remove");
  assert.deepEqual(h.listed(), ["alpha.pdf", "notes.txt"], "one bullet per file");
  assert.match(h.warning(), /can't be undone/);
});

test("confirming a bulk delete re-issues that one click", () => {
  const h = harness();
  h.selectFiles(["check-0", "check-1"]);
  h.click(h.$("bulk-delete"));
  h.click(h.document.querySelector(".cpp-confirm-go"));
  // The toolbar's own handler first (it's on the button), then the document's.
  assert.deepEqual(h.reached, ["bubbled:bulk-delete", "bulk-delete"]);
  assert.equal(h.dialog(), null);
});

test("a bulk delete is guarded even when the tiles look unchecked", () => {
  // The regression this feature shipped with. claude leaves the tile input's
  // `checked` property alone and draws the tick from its own state, so reading
  // the property was returning "nothing is selected" and the first bulk delete
  // of a session went straight through unguarded.
  const h = harness();
  h.selectFiles(["check-0", "check-1"]);
  assert.equal(h.$("check-0").checked, false, "the fixture reproduces that state");
  h.click(h.$("bulk-delete"));
  assert.ok(h.dialog(), "and the delete is still stopped");
  assert.deepEqual(h.reached, []);
});

test("the count is taken from claude's own label when no tile can be read", () => {
  const h = harness();
  h.selectFiles(["check-0", "check-1"]);
  // A pass where the tiles can't be matched up at all — the button still says
  // how many, so the dialog is still accurate about what's at stake.
  h.$("grid").remove();
  h.click(h.$("bulk-delete"));
  assert.equal(h.titleText(), "Delete 2 files");
  assert.equal(h.lead(), "⚠️ This will permanently remove 2 selected files.");
  assert.deepEqual(h.listed(), [], "nothing to bullet when the names are unknown");
});

test("a delete-labelled button with nothing selected is left alone", () => {
  const h = harness();
  // The toolbar only exists while files are ticked; clear the selection and the
  // same button must stop being treated as a delete.
  h.selectFiles(["check-0"], true);
  h.$("check-0").checked = false;
  h.$("check-0").closest("label").querySelector("svg").remove();
  h.$("bulk-delete").setAttribute("aria-label", "Delete");
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
  h.selectFiles(["check-0"]);
  h.click(h.$("outsider"));
  assert.equal(h.dialog(), null, "outside the Context panel, even while files are selected");
  assert.deepEqual(h.reached, ["outsider"]);
});

test("the list view's own × is skipped so it can't double-prompt", () => {
  // It deletes nothing itself — it forwards to the tile's ×, which is the click
  // the guard is meant to catch. Recognised by the data-cpp stamp every
  // Claude++ surface carries (CPP.util.OUR_UI), not by naming that feature's
  // classes here, so the two features aren't coupled through a string.
  const h = harness();
  const list = h.document.createElement("ul");
  list.className = "cpp-files-list";
  list.dataset.cpp = "file-list";
  list.innerHTML = '<li><button id="row-x" aria-label="Remove alpha.pdf"></button></li>';
  h.$("grid").insertAdjacentElement("afterend", list);
  h.$("row-x").addEventListener("click", () => h.click(h.$("remove-0")));

  // Select a file first, so a delete-labelled button outside a tile WOULD
  // otherwise classify — without that the row × is ignored for the wrong reason
  // and the skip isn't really under test.
  h.selectFiles(["check-0"]);
  h.click(h.$("row-x"));
  assert.equal(h.document.querySelectorAll(".cpp-confirm").length, 1, "exactly one dialog");
  assert.equal(h.titleText(), "Delete 1 file", "the tile's × is what got classified");
  h.click(h.document.querySelector(".cpp-confirm-go"));
  assert.deepEqual(h.reached, ["row-x", "remove-0"]);
});

test("the dialog's own Delete button doesn't re-enter the guard", () => {
  // It is a delete-labelled button sitting inside the panel's page while files
  // are selected — exactly the shape the bulk branch looks for. The data-cpp
  // stamp on the dialog is what keeps confirming from re-opening a confirmation.
  const h = harness();
  h.selectFiles(["check-0", "check-1"]);
  h.click(h.$("bulk-delete"));
  const go = h.document.querySelector(".cpp-confirm-go");
  assert.ok(go.closest("[data-cpp]"), "the dialog is stamped as ours");
  h.click(go);
  assert.equal(h.dialog(), null, "it closed rather than prompting again");
  assert.deepEqual(h.reached, ["bubbled:bulk-delete", "bulk-delete"]);
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
