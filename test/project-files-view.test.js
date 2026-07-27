// Tests for src/features/project-files-view.js.
//
// The markup below is a project's Context panel as captured from claude.ai,
// trimmed to the attributes the feature actually keys off. That's the point of
// these tests: the list is a mirror of someone else's grid, so what's worth
// pinning down is that each row forwards to the *right* control on the *right*
// tile — the tile's own open button, its own checkbox, its own × — and that the
// real grid is only ever hidden, never unmounted, since a control React has
// dropped can't be clicked.
//
// CPP is stubbed rather than loaded: core.js wants chrome.* and the storage-sync
// module, and none of that is under test here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "features", "project-files-view.js"),
  "utf8"
);

const PROJECT = "42028720-ea8b-49d9-8881-9a33822f6a71";
const ALPHA_ID = "1ad752ce-36bd-4836-9015-f50d300c870b";

// Two files: one with a thumbnail (so a row can be tied back to its tile by
// uuid) and one without (so only its name can carry the match) — both shapes
// really occur.
const PAGE = `
<div class="w-full px-[1.375rem] py-4 flex flex-col gap-2 mb-1">
  <div class="h-6 w-full flex flex-row items-center justify-between gap-4">
    <h3 class="text-text-300 font-base-bold">Context</h3>
    <div class="flex flex-row items-center gap-2" id="bar">
      <button type="button" data-cds="Button" id="search"
        class="cds-reset group/btn text-primary aria-pressed:text-accent aspect-square w-control px-0"
        aria-label="Search files"></button>
      <input data-testid="project-doc-upload" class="hidden" type="file" multiple>
      <button type="button" data-cds="Button" id="add"
        class="cds-reset group/btn text-primary aria-pressed:text-accent aspect-square w-control px-0 -mr-2"
        aria-label="Add files" data-testid="project-doc-uploader-dropdown-trigger"></button>
    </div>
  </div>
  <div class="flex flex-col mb-1">
    <ul class="grid gap-3 mt-3" id="grid">
      <div class="group/thumbnail relative">
        <div data-testid="alpha.pdf" class="rounded-lg overflow-hidden">
          <button id="open-0" class="relative bg-bg-000">
            <img alt="alpha.pdf" src="/api/${PROJECT}/files/${ALPHA_ID}/thumbnail">
          </button>
          <div class="absolute bottom-2 left-0 right-0">
            <div class="min-w-0"><p class="uppercase truncate">pdf</p></div>
            <label class="relative select-none">
              <input id="check-0" class="sr-only peer" type="checkbox">
              <span class="leading-none sr-only">Select: alpha.pdf</span>
            </label>
          </div>
        </div>
        <button id="remove-0" aria-label="Remove alpha.pdf"></button>
      </div>
      <div class="group/thumbnail relative">
        <div data-testid="notes.txt" class="rounded-lg overflow-hidden">
          <button id="open-1" class="relative bg-bg-000"></button>
          <div class="absolute bottom-2 left-0 right-0">
            <label class="relative select-none">
              <input id="check-1" class="sr-only peer" type="checkbox">
              <span class="leading-none sr-only">Select: notes.txt</span>
            </label>
          </div>
        </div>
        <button id="remove-1" aria-label="Remove notes.txt"></button>
      </div>
    </ul>
  </div>
</div>
`;

// A fresh document, feature instance and recorder per test, so nothing leaks
// between them. `stored` seeds the saved view preference.
async function harness(opts) {
  opts = opts || {};
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: "https://claude.ai/cowork/project/" + PROJECT,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const log = { saved: [], clicked: [], applies: 0 };

  document.querySelectorAll("#grid button, #grid input").forEach((el) => {
    el.addEventListener("click", () => log.clicked.push(el.id));
  });

  window.CPP = {
    util: {
      currentProjectId: () => PROJECT,
      // Mirrors core.js.
      plainText: (el) =>
        (el ? (el.innerText != null ? el.innerText : el.textContent || "") : "")
          .replace(/​/g, "")
          .trim(),
      get: () =>
        Promise.resolve(
          opts.stored ? { cppProjectFilesView: opts.stored } : {}
        ),
      set: (obj) => {
        log.saved.push(obj);
        return Promise.resolve();
      }
    },
    scheduleApply() {
      log.applies++;
    },
    registerFeature(f) {
      this.feature = f;
    }
  };

  // Run the content script the way the manifest does: as a script in the page,
  // so its bare `window`/`document`/`CPP` resolve to this document's.
  new window.Function(SOURCE).call(window);
  const feature = window.CPP.feature;
  feature.onInit(window.CPP);

  const settle = async () => {
    // Let the storage read resolve, then run the pass core would have run when
    // it called scheduleApply.
    for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
    feature.onApply();
  };
  await settle();

  const click = (el) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

  const rows = () => document.querySelectorAll(".cpp-file-row");
  const cell = (i, sel) => rows()[i].querySelector(sel);
  const viewBtn = (mode) => document.querySelector(`.cpp-view-btn[data-cpp-view="${mode}"]`);

  return { window, document, feature, log, settle, click, rows, cell, viewBtn };
}

// Switch to list view.
async function listing(opts) {
  const h = await harness(opts);
  h.click(h.viewBtn("list"));
  return h;
}

test("adds a grid/list switch to the Context header, grid selected", async () => {
  const h = await harness();
  const toggle = h.document.querySelector("#bar .cpp-view-toggle");
  assert.ok(toggle, "the toggle lands in claude's own button row");
  assert.equal(toggle.getAttribute("role"), "group");
  assert.equal(h.viewBtn("grid").getAttribute("aria-pressed"), "true");
  assert.equal(h.viewBtn("list").getAttribute("aria-pressed"), "false");
});

test("the buttons borrow claude's button classes but not its edge nudge", async () => {
  const h = await harness();
  const cls = h.viewBtn("grid").className;
  assert.match(cls, /aspect-square/, "sizing comes from the neighbouring button");
  assert.match(cls, /aria-pressed:text-accent/, "so does the selected-state accent");
  assert.equal(/(^|\s)-mr-2(\s|$)/.test(cls), false, "the row-edge margin is not copied");
});

test("grid view leaves claude's grid exactly as it found it", async () => {
  const h = await harness();
  assert.equal(h.document.querySelector(".cpp-files-list"), null);
  assert.equal(h.document.getElementById("grid").className.includes("cpp-files-source"), false);
});

test("a stored preference of list is honoured without a click", async () => {
  const h = await harness({ stored: "list" });
  assert.equal(h.rows().length, 2);
  assert.equal(h.viewBtn("list").getAttribute("aria-pressed"), "true");
});

test("list view mirrors every file as a row and saves the choice", async () => {
  const h = await listing();
  // Compared field-wise: the saved object was built inside the page's realm, so
  // it isn't deepStrictEqual to one made here.
  assert.equal(h.log.saved.length, 1);
  assert.equal(h.log.saved[0].cppProjectFilesView, "list");
  assert.equal(h.rows().length, 2);
  assert.equal(h.cell(0, ".cpp-file-name").textContent, "alpha.pdf");
  assert.equal(h.cell(1, ".cpp-file-name").textContent, "notes.txt");
  // The kind chip comes off the thumbnail's own badge when there is one, and
  // off the extension when there isn't.
  assert.equal(h.cell(0, ".cpp-file-kind").textContent, "pdf");
  assert.equal(h.cell(1, ".cpp-file-kind").textContent, "txt");
});

test("the real grid is hidden, not unmounted — its controls must stay clickable", async () => {
  const h = await listing();
  const grid = h.document.getElementById("grid");
  assert.equal(grid.classList.contains("cpp-files-source"), true);
  assert.ok(grid.querySelector("#open-0"), "the tiles are still in the document");
});

test("clicking a name opens that file's own preview", async () => {
  const h = await listing();
  h.click(h.cell(1, ".cpp-file-name"));
  assert.deepEqual(h.log.clicked, ["open-1"], "the second tile's button, not the first's");
});

test("a row's checkbox drives claude's own checkbox, so multi-select still works", async () => {
  const h = await listing();
  h.click(h.cell(0, ".cpp-file-check"));
  assert.deepEqual(h.log.clicked, ["check-0"]);
  assert.equal(h.document.getElementById("check-0").checked, true);
});

test("selection made in claude's UI is reflected back into the rows", async () => {
  const h = await listing();
  h.document.getElementById("check-1").checked = true;
  h.feature.onApply();
  assert.equal(h.cell(0, ".cpp-file-check").checked, false);
  assert.equal(h.cell(1, ".cpp-file-check").checked, true);
});

test("a row's × removes that file", async () => {
  const h = await listing();
  h.click(h.cell(0, ".cpp-file-remove"));
  assert.deepEqual(h.log.clicked, ["remove-0"]);
});

test("a row still works after React has replaced the tile it mirrors", async () => {
  // Rows hold ids, not node references — a re-render between building a row and
  // clicking it would otherwise leave the click pointing at a detached node.
  const h = await listing();
  const grid = h.document.getElementById("grid");
  const fresh = grid.children[0].cloneNode(true);
  grid.replaceChild(fresh, grid.children[0]);
  fresh.querySelectorAll("button, input").forEach((el) => {
    el.addEventListener("click", () => h.log.clicked.push(el.id));
  });
  h.feature.onApply();
  h.click(h.cell(0, ".cpp-file-name"));
  assert.deepEqual(h.log.clicked, ["open-0"]);
});

test("an unchanged pass rebuilds nothing", async () => {
  // Our own DOM writes come back as mutations, so a pass that rebuilt
  // regardless would loop apply forever.
  const h = await listing();
  const before = h.rows()[0];
  h.feature.onApply();
  h.feature.onApply();
  assert.equal(h.rows()[0], before, "the same row node survives repeated passes");
});

test("a new upload gets a row", async () => {
  const h = await listing();
  const grid = h.document.getElementById("grid");
  const added = grid.children[1].cloneNode(true);
  added.querySelector("[data-testid]").setAttribute("data-testid", "later.md");
  grid.appendChild(added);
  h.feature.onApply();
  assert.equal(h.rows().length, 3);
  assert.equal(h.cell(2, ".cpp-file-name").textContent, "later.md");
});

test("switching back to grid puts everything back", async () => {
  const h = await listing();
  h.click(h.viewBtn("grid"));
  assert.equal(h.document.querySelector(".cpp-files-list"), null);
  assert.equal(h.document.getElementById("grid").classList.contains("cpp-files-source"), false);
  assert.equal(h.viewBtn("grid").getAttribute("aria-pressed"), "true");
  assert.equal(h.log.saved.at(-1).cppProjectFilesView, "grid");
});

test("teardown removes the toggle and the list and unhides the grid", async () => {
  const h = await listing();
  h.feature.onTeardown();
  assert.equal(h.document.querySelector(".cpp-view-toggle"), null);
  assert.equal(h.document.querySelector(".cpp-files-list"), null);
  assert.equal(h.document.getElementById("grid").classList.contains("cpp-files-source"), false);
});

test("nothing is added when the page has no file grid", async () => {
  const h = await harness();
  h.document.getElementById("grid").remove();
  h.feature.onApply();
  assert.equal(h.document.querySelector(".cpp-view-toggle"), null, "the switch goes with it");
});
