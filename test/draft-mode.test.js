// Tests for src/features/draft-mode.js — specifically the Shift+Tab toggle and
// the one place it stands down.
//
// Draft mode's visible state is a single class on <html>, so "is it armed" is
// cheap to assert. What's worth pinning down is who wins Shift+Tab: the mode
// switch owns it in the message box, but claude's own editor owns it inside a
// list (where it outdents), and nothing owns it out on the page (where the
// browser steps focus backwards). The fixture composer therefore holds both a
// plain paragraph and a list, and the tests move the caret between them.
//
// CPP is stubbed rather than loaded: core.js wants chrome.* and the storage-sync
// module, and none of that is under test here. The util functions below mirror
// core.js closely enough that the feature can't tell the difference.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "features", "draft-mode.js"),
  "utf8"
);

const PAGE = `
<ul class="transcript"><li id="sent-item">a list in a sent message</li></ul>
<div data-chat-input-container>
  <div class="ProseMirror" contenteditable="true" data-testid="chat-input">
    <p id="para">plain text</p>
    <ul><li id="item">a list item</li><li id="empty-item"></li></ul>
  </div>
  <button aria-label="Send message"></button>
</div>
`;

function harness() {
  const dom = new JSDOM(`<body>${PAGE}</body>`, {
    url: "https://claude.ai/chat/x",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const editor = document.querySelector('[contenteditable="true"]');

  window.CPP = {
    util: {
      COMPOSER_SEL: '[data-chat-input-container], [data-testid="chat-input"]',
      // Mirrors core.js: an event target is often a text node, which a bare
      // Element.closest can't be called on.
      closestEl: (node, sel) => {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        return (el && el.closest && el.closest(sel)) || null;
      },
      closest: (node, sel) => !!window.CPP.util.closestEl(node, sel),
      // Mirrors core.js. jsdom has no innerText, so this exercises the
      // textContent branch; the newline-preserving one only exists in a browser.
      plainText: (el) =>
        (el ? (el.innerText != null ? el.innerText : el.textContent || "") : "")
          .replace(/​/g, "")
          .trim(),
      inComposer: (node) =>
        window.CPP.util.closest(node, window.CPP.util.COMPOSER_SEL) ||
        window.CPP.util.closest(document.activeElement, window.CPP.util.COMPOSER_SEL)
    },
    registerFeature(f) {
      this.feature = f;
    }
  };

  new window.Function(SOURCE).call(window);
  const feature = window.CPP.feature;
  feature.onInit();

  // Put the caret inside `el` the way a click would, so the feature's selection
  // read has something to walk up from.
  const caretIn = (el) => {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.addRange(range);
  };

  // Shift+Tab from `el`. Returns whether the event survived — i.e. whether it
  // was left for whoever handles it next (the editor, or the browser).
  const shiftTab = (el) => {
    const e = new window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    el.dispatchEvent(e);
    return !e.defaultPrevented;
  };

  // Enter from `el`, with whatever modifiers. Returns whether the event survived
  // — i.e. whether the editor still gets to act on it.
  const enter = (el, init) => {
    const e = new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init
    });
    el.dispatchEvent(e);
    return !e.defaultPrevented;
  };

  // jsdom has no execCommand, and what matters is only that the feature asked
  // for the edit — a real ProseMirror is what turns it into the next list item.
  const commands = [];
  document.execCommand = (name) => {
    commands.push(name);
    return true;
  };

  const drafting = () => document.documentElement.classList.contains("cpp-draft");

  return { window, document, feature, editor, caretIn, shiftTab, enter, commands, drafting };
}

test("Shift+Tab in the message box toggles draft mode", () => {
  const h = harness();
  h.caretIn(h.document.getElementById("para"));

  assert.equal(h.shiftTab(h.editor), false, "the key is consumed, not passed on");
  assert.equal(h.drafting(), true);

  h.shiftTab(h.editor);
  assert.equal(h.drafting(), false, "a second press returns to run mode");
});

test("Shift+Tab in a list is left to the editor to outdent", () => {
  const h = harness();
  h.caretIn(h.document.getElementById("item"));

  assert.equal(h.shiftTab(h.editor), true, "the key reaches the editor untouched");
  assert.equal(h.drafting(), false, "and draft mode is not armed");
});

test("draft mode can still be left from inside a list", () => {
  const h = harness();

  h.caretIn(h.document.getElementById("para"));
  h.shiftTab(h.editor);
  assert.equal(h.drafting(), true);

  // Armed, then the caret moves into a list: the toggle is unavailable there,
  // but the Send button still shows the blue Pause, and clicking it unpauses.
  h.caretIn(h.document.getElementById("item"));
  h.shiftTab(h.editor);
  assert.equal(h.drafting(), true, "the list keeps its outdent, mode unchanged");

  h.document
    .querySelector('button[aria-label="Send message"]')
    .dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(h.drafting(), false);
});

test("a list selection outside the composer does not suppress the toggle", () => {
  const h = harness();
  // A leftover selection in the transcript while the message box holds focus:
  // the caret isn't really in the composer's list, so the toggle still applies.
  h.caretIn(h.document.getElementById("sent-item"));

  assert.equal(h.shiftTab(h.editor), false);
  assert.equal(h.drafting(), true);
});

test("Shift+Tab outside the composer is left alone entirely", () => {
  const h = harness();
  const outside = h.document.querySelector(".transcript");
  h.caretIn(outside);

  assert.equal(h.shiftTab(outside), true, "focus stepping is untouched");
  assert.equal(h.drafting(), false);
});

// ---- Enter ----------------------------------------------------------------
// The promise is that no Enter submits while paused — in a list or out of it,
// with or without Ctrl/⌘. Ctrl/⌘+Enter then does Enter's editing job in its
// place, which is what gets a list its next item, since Shift+Enter only breaks
// the line inside the current one.

// Arm draft mode from the paragraph, then move the caret where the test wants it.
function drafting(h, el) {
  h.caretIn(h.document.getElementById("para"));
  h.shiftTab(h.editor);
  assert.equal(h.drafting(), true);
  h.caretIn(el);
}

test("no Enter reaches the app while drafting, anywhere in the box", () => {
  for (const id of ["para", "item", "empty-item"]) {
    for (const mods of [{}, { ctrlKey: true }, { metaKey: true }]) {
      const h = harness();
      drafting(h, h.document.getElementById(id));

      assert.equal(
        h.enter(h.editor, mods),
        false,
        `${Object.keys(mods)[0] || "plain"} Enter in #${id} is dropped`
      );
    }
  }
});

test("Ctrl+Enter and ⌘+Enter break the line instead of submitting", () => {
  for (const mod of ["ctrlKey", "metaKey"]) {
    const h = harness();
    drafting(h, h.document.getElementById("item"));

    h.enter(h.editor, { [mod]: true });
    assert.deepEqual(h.commands, ["insertParagraph"], `${mod} does the edit itself`);
    assert.equal(h.drafting(), true, "and stays paused");
  }
});

test("plain Enter is dropped without editing anything", () => {
  const h = harness();
  drafting(h, h.document.getElementById("item"));

  h.enter(h.editor);
  assert.deepEqual(h.commands, [], "it is not a line break in disguise");
});

test("Shift+Enter is left to the app, in a list or out of it", () => {
  for (const id of ["para", "item"]) {
    const h = harness();
    drafting(h, h.document.getElementById(id));

    assert.equal(h.enter(h.editor, { shiftKey: true }), true, `newlines still work in #${id}`);
    assert.deepEqual(h.commands, [], "the app inserts it, not us");
  }
});

test("Tab is never ours, so the editor keeps its indent", () => {
  const h = harness();
  drafting(h, h.document.getElementById("item"));

  const e = new h.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  h.editor.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
  assert.equal(h.drafting(), true, "and it is not a second way to toggle the mode");
});

test("Enter is only ours while drafting", () => {
  // Out of draft mode the feature has no business in the key at all.
  const h = harness();
  h.caretIn(h.document.getElementById("item"));

  assert.equal(h.enter(h.editor), true, "plain Enter still submits when running");
  assert.equal(h.enter(h.editor, { ctrlKey: true }), true);
  assert.deepEqual(h.commands, []);
});
