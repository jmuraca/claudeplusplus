// Tests for src/features/search-new-tab.js.
//
// The markup below is the command palette's results list as captured from
// claude.ai, trimmed to the attributes the feature keys off: the listbox id, the
// per-row option id that carries the item id, and data-item-type. That's what is
// worth pinning down, since the feature reads someone else's markup to rebuild a
// URL the row never states.
//
// The tab itself is opened by clicking a throwaway anchor, so each test cancels
// that click and reads the anchor instead — jsdom cannot navigate, and the
// anchor's href/target/modifiers are exactly what a browser would act on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadFeature } = require("./cpp");

const CHAT_ID = "cb09feaf-e5ce-40fb-aaf7-24c706e9c23e";
const SESSION_ID = "session_01YLTznKURuSxY437sYYKfXT";
const PINNED_ID = "76e28500-de8e-4aa0-a3da-b13562d4d230";

const PAGE = `
<nav class="sidebar">
  <a href="/chat/${PINNED_ID}">Weather hedging for business risk</a>
</nav>
<div id="command-palette-results" role="listbox" aria-label="Search results">
  <div role="group" aria-label="Search results">
    <button role="option" aria-selected="true" tabindex="-1"
            id="command-palette-item-${SESSION_ID}" data-item-type="code_session">
      <span class="truncate">Add prompt injection protection to vision system</span>
    </button>
    <button role="option" aria-selected="false" tabindex="-1"
            id="command-palette-item-${CHAT_ID}" data-item-type="conversation">
      <span class="truncate">Enersmart and Goodleap comparison</span>
    </button>
    <button role="option" aria-selected="false" tabindex="-1"
            id="command-palette-item-${PINNED_ID}" data-item-type="conversation">
      <span class="truncate">Weather hedging for business risk</span>
    </button>
    <button role="option" aria-selected="false" tabindex="-1"
            id="command-palette-item-new-chat" data-item-type="action">
      <span class="truncate">New chat</span>
    </button>
  </div>
</div>
`;

// A fresh document and feature instance per test, so nothing leaks between them.
// `mac` picks which platform's modifier conventions the feature sees — the two
// differ in more than the label, since Ctrl+click is the secondary click there.
function harness(opts) {
  const mac = !!(opts && opts.mac);
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: "https://claude.ai/chat/x",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  // Every anchor click the feature makes, recorded and cancelled before jsdom
  // tries to navigate. Capture phase: the feature dispatches with bubbles:false.
  const opened = [];
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest && e.target.closest("a[data-cpp]");
      if (!a) return;
      opened.push({
        href: a.href,
        target: a.target,
        rel: a.rel,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey
      });
      e.preventDefault();
    },
    true
  );

  // What claude's own handler would do with the row: navigate this tab. Recorded
  // so "the palette also navigated" is a visible failure, not a silent one.
  const navigated = [];
  document.addEventListener("click", (e) => {
    const row = e.target.closest && e.target.closest('[role="option"]');
    if (row) navigated.push(row.id);
  });

  // The one thing a jsdom window can't be asked: which keyboard it has. Core
  // reads the platform once at load, and CPP.util.accel — the predicate the
  // feature calls — reads IS_MAC off util each time, so overriding it here is
  // enough to test both platforms against the real accelerator rule.
  const feature = loadFeature(window, "features/search-new-tab.js", { IS_MAC: mac });
  feature.onInit();

  const row = (id) => document.getElementById("command-palette-item-" + id);
  const mouse = (el, type, init) => {
    const ev = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init
    });
    el.dispatchEvent(ev);
    return ev;
  };
  const press = (key, init) => {
    const ev = new window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init
    });
    document.body.dispatchEvent(ev);
    return ev;
  };

  return { window, document, feature, opened, navigated, row, mouse, press };
}

test("Ctrl+click opens the chat in a new tab and not in this one", () => {
  const h = harness();
  const ev = h.mouse(h.row(CHAT_ID).querySelector("span"), "click", { ctrlKey: true });
  assert.deepEqual(h.opened.map((o) => o.href), [`https://claude.ai/chat/${CHAT_ID}`]);
  assert.equal(h.opened[0].target, "_blank");
  assert.equal(h.opened[0].rel, "noopener");
  assert.equal(h.opened[0].ctrlKey, true, "the browser still picks the disposition");
  assert.deepEqual(h.navigated, [], "the palette's own handler never sees the click");
  assert.equal(ev.defaultPrevented, true);
});

test("Ctrl+Shift+click asks for a foreground tab", () => {
  const h = harness();
  h.mouse(h.row(CHAT_ID), "click", { ctrlKey: true, shiftKey: true });
  assert.equal(h.opened[0].ctrlKey, true);
  assert.equal(h.opened[0].shiftKey, true, "Shift rides along to the browser");
});

test("⌘+click is the gesture on macOS", () => {
  const h = harness({ mac: true });
  h.mouse(h.row(CHAT_ID), "click", { metaKey: true });
  assert.deepEqual(h.opened.map((o) => o.href), [`https://claude.ai/chat/${CHAT_ID}`]);
  assert.equal(h.opened[0].metaKey, true, "and ⌘, not Ctrl, is what the browser is told");
  assert.equal(h.opened[0].ctrlKey, false);
});

test("Ctrl+click on macOS is the context menu and is left alone", () => {
  // Reading it as an accelerator would hand back a tab the user never asked for.
  const h = harness({ mac: true });
  const ev = h.mouse(h.row(CHAT_ID), "click", { ctrlKey: true });
  assert.deepEqual(h.opened, []);
  assert.equal(ev.defaultPrevented, false);
});

test("⌘+click off macOS is not the gesture either", () => {
  const h = harness();
  const ev = h.mouse(h.row(CHAT_ID), "click", { metaKey: true });
  assert.deepEqual(h.opened, []);
  assert.equal(ev.defaultPrevented, false);
});

test("middle-click opens a background tab on either platform", () => {
  for (const mac of [false, true]) {
    const h = harness({ mac });
    h.mouse(h.row(CHAT_ID), "auxclick", { button: 1 });
    assert.deepEqual(h.opened.map((o) => o.href), [`https://claude.ai/chat/${CHAT_ID}`]);
    assert.equal(
      mac ? h.opened[0].metaKey : h.opened[0].ctrlKey,
      true,
      "borrows the platform accelerator for the background tab"
    );
    assert.equal(h.opened[0].shiftKey, false, "and never promotes it to the foreground");
  }
});

test("the middle button's mousedown is swallowed but opens nothing on its own", () => {
  // Otherwise the row acts early, or Chrome leaves the autoscroll cursor behind.
  const h = harness();
  const ev = h.mouse(h.row(CHAT_ID), "mousedown", { button: 1 });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.opened, [], "the tab waits for the click");
});

test("a code session gets its own path, not /chat/", () => {
  const h = harness();
  h.mouse(h.row(SESSION_ID), "click", { ctrlKey: true });
  assert.deepEqual(h.opened.map((o) => o.href), [`https://claude.ai/code/${SESSION_ID}`]);
});

test("the same chat linked in the sidebar rebuilds to that link's URL", () => {
  // The two paths are derived independently — claude's anchor and our PATHS map
  // — so this is what catches the map drifting away from where chats live.
  const h = harness();
  h.mouse(h.row(PINNED_ID), "click", { ctrlKey: true });
  assert.deepEqual(
    h.opened.map((o) => o.href),
    [h.document.querySelector(".sidebar a").href]
  );
});

test("a plain click is left to claude", () => {
  const h = harness();
  const ev = h.mouse(h.row(CHAT_ID), "click", {});
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.navigated, ["command-palette-item-" + CHAT_ID]);
  assert.equal(ev.defaultPrevented, false);
});

test("a kind with no known page is left to claude rather than guessed at", () => {
  const h = harness();
  const ev = h.mouse(h.row("new-chat"), "click", { ctrlKey: true });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.navigated, ["command-palette-item-new-chat"]);
  assert.equal(ev.defaultPrevented, false);
});

test("Ctrl+click elsewhere on the page is untouched", () => {
  const h = harness();
  const ev = h.mouse(h.document.querySelector(".sidebar a"), "click", { ctrlKey: true });
  assert.deepEqual(h.opened, []);
  assert.equal(ev.defaultPrevented, false);
});

test("Ctrl+Enter opens the highlighted row", () => {
  const h = harness();
  const ev = h.press("Enter", { ctrlKey: true });
  assert.deepEqual(h.opened.map((o) => o.href), [`https://claude.ai/code/${SESSION_ID}`]);
  assert.equal(ev.defaultPrevented, true, "and does not also open it in this tab");
});

test("a bare Enter is still the palette's", () => {
  const h = harness();
  const ev = h.press("Enter", {});
  assert.deepEqual(h.opened, []);
  assert.equal(ev.defaultPrevented, false);
});

test("teardown gives every gesture back", () => {
  const h = harness();
  h.feature.onTeardown();
  const ev = h.mouse(h.row(CHAT_ID), "click", { ctrlKey: true });
  h.press("Enter", { ctrlKey: true });
  assert.deepEqual(h.opened, []);
  assert.equal(ev.defaultPrevented, false);
});
