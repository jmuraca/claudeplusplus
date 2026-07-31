// Tests for src/features/queue-edit.js.
//
// The markup below is the queued-message DOM as captured from claude.ai, trimmed
// to the attributes the feature actually keys off. That's the point of these
// tests: the feature reaches into someone else's markup, so what's worth pinning
// down is which node a click resolves to, which of the two identically-labelled
// Discard buttons in a row gets pressed, and that a sent message in the
// transcript — same bubble attribute, different place — is never touched.
//
// CPP is the real one (see test/cpp.js), with the composer reads and writes
// overridden to record what the feature asked for — the order of operations
// matters here, since the composer has to be written before the queue is
// touched, and a recorder is the only way to see it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadFeature } = require("./cpp");

const PAGE = `
<div class="relative flex flex-col items-end" data-testid="pending-queue-row">
  <div role="status" class="sr-only">2 messages queued.</div>
  <div class="group/row">
    <div class="relative">
      <div data-user-message-bubble="true">
        <div class="text-muted" data-testid="user-message">why does it matter?</div>
      </div>
      <div class="absolute -right-8 top-0">
        <button type="button" id="x-0" aria-label="Discard queued message"><span data-cds="Icon"></span></button>
      </div>
      <button type="button" id="overlay-0" aria-label="Discard queued message" class="absolute inset-0 hidden"></button>
    </div>
  </div>
  <div class="group/row">
    <div class="relative">
      <div data-user-message-bubble="true">
        <div class="text-muted" data-testid="user-message">what else is being tested?</div>
      </div>
      <div class="absolute -right-8 top-0">
        <button type="button" id="x-1" aria-label="Discard queued message"><span data-cds="Icon"></span></button>
      </div>
      <button type="button" id="overlay-1" aria-label="Discard queued message" class="absolute inset-0 hidden"></button>
    </div>
  </div>
</div>
<div class="transcript">
  <div data-user-message-bubble="true">
    <div data-testid="user-message">a message already sent</div>
  </div>
</div>
<div data-chat-input-container><div contenteditable="true" data-testid="chat-input"></div></div>
`;

// A fresh document, feature instance and recorder per test, so nothing leaks
// between them.
function harness() {
  // runScripts gives the window its own Function, so the content script below
  // runs inside this document's realm and its bare `window`/`document`/`CPP`
  // resolve to this page's — not to node's globals. "outside-only" is enough:
  // nothing in the fixture markup is a <script> we want executed.
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: "https://claude.ai/chat/x",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const editor = document.querySelector('[contenteditable="true"]');
  const log = { composer: "", writes: [], discarded: [] };

  document
    .querySelectorAll("button[aria-label]")
    .forEach((b) => b.addEventListener("click", () => log.discarded.push(b.id)));

  // Only the composer is stubbed: real writes go through a paste event into a
  // ProseMirror that isn't here. Note plainText is core's own, and in jsdom it
  // takes the textContent branch \u2014 innerText exists only in a browser.
  const feature = loadFeature(window, "features/queue-edit.js", {
    composerEditor: () => editor,
    composerText: () => log.composer,
    setComposerText: (text) => {
      log.composer = text;
      log.writes.push(text);
    }
  });
  feature.onInit();
  feature.onApply();

  const queued = () =>
    document.querySelectorAll('[data-testid="pending-queue-row"] [data-user-message-bubble]');
  const click = (el) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const press = (el, key) =>
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  return { window, document, feature, log, queued, click, press };
}

test("decorates the queued messages and nothing else", () => {
  const h = harness();
  assert.equal(h.document.querySelectorAll(".cpp-qedit").length, 2);
  assert.equal(
    h.document.querySelector(".transcript [data-user-message-bubble]").classList.contains("cpp-qedit"),
    false,
    "a sent message in the transcript is not editable"
  );
});

test("exposes each queued message as a labelled button", () => {
  const h = harness();
  const first = h.queued()[0];
  assert.equal(first.getAttribute("role"), "button");
  assert.equal(first.getAttribute("tabindex"), "0");
  assert.equal(first.getAttribute("aria-label"), "Edit queued message: why does it matter?");
  assert.equal(first.title, "", "the hint is a CSS label, not a native tooltip");
});

test("clicking one puts its text in an empty composer and discards that row", () => {
  const h = harness();
  h.click(h.queued()[0].querySelector('[data-testid="user-message"]'));
  assert.equal(h.log.composer, "why does it matter?");
  assert.deepEqual(h.log.discarded, ["x-0"], "the row's own × , not a neighbour's");
});

test("the composer is written before the queue is touched", () => {
  // The other order would drop the message if the write ever failed.
  const h = harness();
  const order = [];
  const write = h.window.CPP.util.setComposerText;
  h.window.CPP.util.setComposerText = (t) => {
    order.push("write");
    write(t);
  };
  h.document.getElementById("x-0").addEventListener("click", () => order.push("discard"));
  h.click(h.queued()[0]);
  assert.deepEqual(order, ["write", "discard"]);
});

test("appends after a blank line when something is already typed", () => {
  const h = harness();
  h.log.composer = "explain more";
  h.click(h.queued()[1]);
  assert.equal(h.log.composer, "explain more\n\nwhat else is being tested?");
  assert.deepEqual(h.log.discarded, ["x-1"]);
});

test("Enter and Space activate a focused queued message", () => {
  for (const key of ["Enter", " "]) {
    const h = harness();
    const ev = new h.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    h.queued()[0].dispatchEvent(ev);
    assert.equal(h.log.composer, "why does it matter?", `${key} pulls the message back`);
    assert.deepEqual(h.log.discarded, ["x-0"]);
    assert.equal(ev.defaultPrevented, true, `${key} does not also scroll or submit`);
  }
});

test("other keys are left alone", () => {
  const h = harness();
  h.press(h.queued()[0], "a");
  h.press(h.queued()[0], "Tab");
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.discarded, []);
});

test("the × still discards without editing", () => {
  const h = harness();
  h.click(h.document.getElementById("x-0"));
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.discarded, ["x-0"]);
});

test("selecting text inside a message to copy it is not an edit", () => {
  const h = harness();
  const bubble = h.queued()[0];
  const range = h.document.createRange();
  range.selectNodeContents(bubble.querySelector('[data-testid="user-message"]'));
  h.window.getSelection().addRange(range);
  h.click(bubble);
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.discarded, []);
});

test("teardown undoes every mark and stops intercepting", () => {
  const h = harness();
  h.feature.onTeardown();

  const bubble = h.queued()[0];
  assert.equal(h.document.querySelectorAll(".cpp-qedit").length, 0);
  for (const attr of ["role", "tabindex", "aria-label"]) {
    assert.equal(bubble.hasAttribute(attr), false, `${attr} is removed`);
  }

  h.click(bubble);
  h.press(bubble, "Enter");
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.discarded, []);
});
