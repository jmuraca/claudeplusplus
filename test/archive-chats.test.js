// Tests for src/features/archive-chats.js.
//
// The fixture is the three places a chat shows up, trimmed to what the feature
// keys off: sidebar rows carrying data-row-key="chat:<uuid>", a recents-style
// table whose rows hold /chat/<uuid> links, and the ⋯ menu — a portal at the
// end of <body>, recognisable only by its delete-chat-trigger, with a
// separator fencing Delete off (captured from claude.ai). The menu carries no
// pointer back to its chat, which is why the feature records the pointerdown
// that opened it; these tests drive exactly that sequence.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadFeature } = require("./cpp");

const ARCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// The sidebar groups its chats under date labels (captured from claude.ai):
// each group is a section div holding a label row — data-row-key="label:…"
// wrapping a [data-sidebar-group-label] — followed by that day's chat rows.
// "Today" here holds only the archived chat, so its label should vanish with
// it; "Yesterday" holds a live chat and keeps its label.
const PAGE = `
<nav>
  <div class="group-section">
    <div data-row-key="label:day-0" id="label-today"><div data-sidebar-group-label=""><span>Today</span></div></div>
    <div class="contents">
      <div data-row-key="chat:${ARCH}" id="nav-arch"><a href="/chat/${ARCH}">Old research</a></div>
    </div>
  </div>
  <div class="group-section">
    <div data-row-key="label:day-1" id="label-yday"><div data-sidebar-group-label=""><span>Yesterday</span></div></div>
    <div class="contents">
      <div data-row-key="chat:${PLAIN}" id="nav-plain"><a href="/chat/${PLAIN}">Live work</a></div>
    </div>
  </div>
</nav>
<main>
  <table><tbody>
    <tr id="list-arch"><td><a href="/chat/${ARCH}">Old research</a></td><td><button id="dots-arch">⋯</button></td></tr>
    <tr id="list-plain"><td><a href="/chat/${PLAIN}">Live work</a></td><td><button id="dots-plain">⋯</button></td></tr>
  </tbody></table>
</main>
`;

const MENU = `
<div role="presentation" id="menu-portal">
  <div role="menu">
    <div>
      <div role="menuitem" data-testid="rename-chat-trigger"><span>Rename</span></div>
      <div role="separator"></div>
      <div role="menuitem" data-testid="delete-chat-trigger"><span>Delete</span></div>
    </div>
  </div>
</div>
`;

// A variant whose only separator fences an EARLIER section, with Delete sitting
// flush after another item — the shape that tempts "insert before the first
// separator" into landing the item nowhere near Delete.
const MENU_NO_FENCE = `
<div role="presentation" id="menu-portal">
  <div role="menu">
    <div>
      <div role="menuitem" data-testid="star-chat-trigger"><span>Unpin</span></div>
      <div role="separator"></div>
      <div role="menuitem" data-testid="rename-chat-trigger"><span>Rename</span></div>
      <div role="menuitem" data-testid="delete-chat-trigger"><span>Delete</span></div>
    </div>
  </div>
</div>
`;

// A fresh document, store and feature instance per test. `archived` seeds the
// stored map; `url` picks the page (list rules differ between /chats and a
// chat's own page); util.get/set are overridden to read and write `store`, the
// part of the browser a jsdom fixture can't be.
function harness(opts) {
  opts = opts || {};
  const store = {
    cppArchivedChats: opts.archived || {},
    cppShowArchived: !!opts.show
  };
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: opts.url || "https://claude.ai/chats",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const feature = loadFeature(window, "features/archive-chats.js", {
    get: (keys) => {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in store) out[k] = store[k];
      }
      return Promise.resolve(out);
    },
    set: (obj) => {
      Object.assign(store, JSON.parse(JSON.stringify(obj)));
      return Promise.resolve();
    }
  });

  const escapes = [];
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") escapes.push(e);
  });

  const el = (id) => document.getElementById(id);
  // The item's first child is an icon-font glyph at a private-use codepoint —
  // invisible in a diff but very much part of textContent, so read the label.
  const label = (item) => item.lastElementChild.textContent;
  const hidden = (id) => el(id).classList.contains("cpp-arch-hidden");
  const dimmed = (id) => el(id).classList.contains("cpp-arch-dim");
  const press = (target) =>
    target.dispatchEvent(
      new window.Event("pointerdown", { bubbles: true, cancelable: true })
    );
  // The user's sequence: press a row's ⋯, claude portals the menu in, the
  // MutationObserver's next pass (onApply here) injects our item.
  const openMenu = (dotsId, menuHtml) => {
    if (dotsId) press(el(dotsId));
    document.body.insertAdjacentHTML("beforeend", menuHtml || MENU);
    feature.onApply();
    return document.querySelector(".cpp-archive-item");
  };

  return { window, document, feature, store, escapes, el, label, hidden, dimmed, press, openMenu };
}

test("an archived chat is hidden in the sidebar and the list; others untouched", async () => {
  const h = harness({ archived: { [ARCH]: true } });
  await h.feature.onInit();
  assert.equal(h.hidden("nav-arch"), true);
  assert.equal(h.hidden("list-arch"), true);
  assert.equal(h.hidden("nav-plain"), false);
  assert.equal(h.hidden("list-plain"), false);
});

test("a date label whose every chat is archived vanishes with them", async () => {
  const h = harness({ archived: { [ARCH]: true } });
  await h.feature.onInit();
  assert.equal(h.hidden("label-today"), true, "no chats left under Today");
  assert.equal(h.hidden("label-yday"), false, "Yesterday still has a live chat");
});

test("unarchiving the last chat of a day brings its label back", async () => {
  const h = harness({ archived: { [ARCH]: true }, show: true });
  await h.feature.onInit();
  assert.equal(h.hidden("label-today"), true);

  const item = h.openMenu("dots-arch");
  h.press(item);
  assert.equal(h.hidden("label-today"), false);
  h.feature.onTeardown();
});

test("Archive in a row's ⋯ menu archives that row's chat", async () => {
  const h = harness();
  await h.feature.onInit();

  const item = h.openMenu("dots-plain");
  assert.ok(item, "the menu gained an item");
  assert.equal(h.label(item), "Archive");

  h.press(item);
  assert.deepEqual(h.store.cppArchivedChats, { [PLAIN]: true });
  assert.equal(h.hidden("list-plain"), true);
  assert.equal(h.hidden("nav-plain"), true);
  assert.equal(h.hidden("list-arch"), false, "the other chat is untouched");
  assert.equal(h.escapes.length, 1, "the menu is asked to close");
  assert.ok(h.document.querySelector(".cpp-toast"), "and the action is confirmed");
  h.feature.onTeardown(); // clears the toast timer
});

test("the same menu on an archived chat says Unarchive and brings it back", async () => {
  const h = harness({ archived: { [ARCH]: true }, show: true });
  await h.feature.onInit();

  const item = h.openMenu("dots-arch");
  assert.equal(h.label(item), "Unarchive");

  h.press(item);
  assert.deepEqual(h.store.cppArchivedChats, {});
  assert.equal(h.hidden("nav-arch"), false);
  assert.equal(h.hidden("list-arch"), false);
  assert.equal(h.dimmed("list-arch"), false);
  h.feature.onTeardown();
});

test("the item lands above the separator that fences off Delete", async () => {
  const h = harness();
  await h.feature.onInit();
  const item = h.openMenu("dots-plain");
  assert.equal(item.nextElementSibling.getAttribute("role"), "separator");
  assert.equal(
    item.nextElementSibling.nextElementSibling.getAttribute("data-testid"),
    "delete-chat-trigger"
  );
});

test("in a menu whose separator belongs to an earlier section, the item still sits right above Delete", async () => {
  const h = harness();
  await h.feature.onInit();
  const item = h.openMenu("dots-plain", MENU_NO_FENCE);
  assert.equal(
    item.nextElementSibling.getAttribute("data-testid"),
    "delete-chat-trigger",
    "anchored to Delete itself, not to the first separator in the menu"
  );
});

test("a menu with no recorded row falls back to the chat in the URL", async () => {
  const h = harness({ url: `https://claude.ai/chat/${PLAIN}` });
  await h.feature.onInit();
  const item = h.openMenu(null); // opened from the chat header — no row pressed
  assert.ok(item);
  h.press(item);
  assert.deepEqual(h.store.cppArchivedChats, { [PLAIN]: true });
  h.feature.onTeardown();
});

test("no chat to pin the menu to means no item rather than a guess", async () => {
  const h = harness(); // on /chats, and nothing was pressed
  await h.feature.onInit();
  assert.equal(h.openMenu(null), null);
});

test("the Show archived toggle appears only when the list holds archived chats", async () => {
  const empty = harness();
  await empty.feature.onInit();
  assert.equal(empty.el("cpp-arch-toggle"), null);

  const h = harness({ archived: { [ARCH]: true } });
  await h.feature.onInit();
  const toggle = h.el("cpp-arch-toggle");
  assert.ok(toggle);
  assert.equal(toggle.textContent, "Show archived (1)");
});

test("toggling shows list rows dimmed while the sidebar stays hidden", async () => {
  const h = harness({ archived: { [ARCH]: true } });
  await h.feature.onInit();

  h.el("cpp-arch-toggle").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true })
  );
  assert.equal(h.store.cppShowArchived, true, "the choice is remembered");
  assert.equal(h.hidden("list-arch"), false);
  assert.equal(h.dimmed("list-arch"), true);
  assert.equal(h.hidden("nav-arch"), true, "archiving still means a clean sidebar");
  assert.equal(h.el("cpp-arch-toggle").textContent, "Hide archived (1)");
});

test("on a chat's own page the toggle has no list to sit above", async () => {
  const h = harness({ archived: { [ARCH]: true }, url: `https://claude.ai/chat/${PLAIN}` });
  await h.feature.onInit();
  assert.equal(h.el("cpp-arch-toggle"), null);
  assert.equal(h.hidden("nav-arch"), true, "the sidebar still hides it");
});

test("deleting a chat for real drops its archived flag", async () => {
  const h = harness({ archived: { [ARCH]: true, [PLAIN]: true } });
  await h.feature.onInit();
  h.feature.onDelete({ kind: "chat", id: ARCH });
  assert.deepEqual(h.store.cppArchivedChats, { [PLAIN]: true });
});

test("teardown restores every row and removes injected chrome", async () => {
  const h = harness({ archived: { [ARCH]: true } });
  await h.feature.onInit();
  h.openMenu("dots-arch");

  h.feature.onTeardown();
  assert.equal(h.hidden("nav-arch"), false);
  assert.equal(h.hidden("label-today"), false, "the date label comes back too");
  assert.equal(h.hidden("list-arch"), false);
  assert.equal(h.el("cpp-arch-toggle"), null);
  assert.equal(h.document.querySelector(".cpp-archive-item"), null);

  // And the pointerdown recorder is gone: a fresh menu gets no item.
  h.document.getElementById("menu-portal").remove();
  assert.equal(h.openMenu("dots-plain"), null);
});
