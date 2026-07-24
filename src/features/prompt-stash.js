// Feature: Prompt stash (Ctrl+S)
//
// A one-slot holding pen for a prompt you've written but don't want to send
// yet, modeled on Claude Code's stash. Press Ctrl+S (⌘S on macOS) in the
// message box and whatever you've typed moves out of the composer and into a
// card in the right margin; press Ctrl+S again on an empty box to bring it
// back. Stash a second prompt while one is already held and the two swap: the
// new text goes to the card, the held text lands in the box — so one key cycles
// between two drafts.
//
// The card lives on <body>, outside React's tree, and is positioned from the
// live rect of the composer (measured, never computed from Tailwind classes —
// the sidebar is user-resizable), the same approach asides.js takes for margin
// cards. When the margin is too narrow for it, the card sits above the composer
// instead.
//
// Reading the box is easy (innerText); writing it is the delicate part, because
// the composer is a ProseMirror editor that owns its DOM and will discard nodes
// we insert. So we never touch its DOM: we select its contents and let the
// browser's own editing commands do the edit, which ProseMirror observes and
// folds into its document. A synthetic paste is tried first (it round-trips
// multi-line text in one step), with execCommand as the fallback.
//
// The stash is per conversation: each /chat/<uuid> has its own slot, stored
// under its own key the way asides.js stores its cards, so a draft parked in one
// chat never surfaces in another and is reaped when that chat is deleted. It
// survives navigation and reloads, and other tabs on the same chat follow it.
// Pages with no conversation of their own — /new, a project's overview — have
// nowhere to put a draft, so the feature is idle there.
(function () {
  "use strict";

  // Match either the composer wrapper or the editor itself, same as draft-mode,
  // so key handling works whichever the event target resolves to.
  var COMPOSER = '[data-chat-input-container], [data-testid="chat-input"]';

  // Candidates for the editable itself, most specific first.
  var EDITOR_SELECTORS = [
    '[data-chat-input-container] [contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    '[contenteditable="true"][data-testid="chat-input"]',
    'div.ProseMirror[contenteditable="true"]'
  ];

  var STORE_PREFIX = "cppPromptStash:";

  function storeKey(id) {
    return STORE_PREFIX + id;
  }

  var CARD_W = 260;
  var GAP = 16; // between the card and the composer
  var EDGE = 12; // keep the card this far from the viewport edge

  var IS_MAC = /Mac|iP(hone|ad|od)/.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""
  );
  var CHORD = IS_MAC ? "⌘S" : "Ctrl+S";

  var ctx = null;
  var started = false;
  var stash = ""; // the held prompt for `convId`; "" means nothing stashed
  var convId = null; // the chat whose slot `stash` holds; null off a chat page
  var panel = null;
  var bodyEl = null;
  var ro = null; // ResizeObserver on the composer
  var roTarget = null; // the element `ro` is currently observing

  // ---------- the chat ----------

  // The conversation on screen, or null where there isn't one: /new hasn't been
  // saved yet and a project page is not a chat, so neither has a slot to stash
  // into. Read from the path, which is what claude rewrites on navigation.
  function convoId() {
    if (!ctx) return null;
    var m = ctx.util.CHAT_RE.exec(location.pathname);
    return m ? m[1].toLowerCase() : null;
  }

  // Point the live slot at the conversation on screen. Called on every apply,
  // since an SPA navigation is just another DOM change to core; it's a no-op
  // unless the id actually changed. The load is async and navigation can beat
  // it, so the answer is dropped unless we're still on the chat it was for.
  function syncChat() {
    var id = convoId();
    if (id === convId) return;
    convId = id;
    stash = "";
    render();
    if (!id || !ctx) return;
    var key = storeKey(id);
    ctx.util.get(key).then(function (d) {
      if (convId !== id) return;
      stash = (d && d[key]) || "";
      render();
    });
  }

  // ---------- the composer ----------

  function wrapper() {
    return document.querySelector("[data-chat-input-container]");
  }

  // The element to measure. Not the wrapper: [data-chat-input-container] is a
  // sticky shell that extends well above the rounded box you actually see, so
  // aligning to its top puts the card half a card too high. Walk up from the
  // editor instead and stop at the first ancestor that paints the composer's
  // surface — a filled box with the composer's corner radius — which is the edge
  // the eye lines up against. Falls back to the wrapper if claude ever stops
  // styling the composer that way.
  function inputBox() {
    var wrap = wrapper();
    var ed = editor();
    // Start above the editable: the surface is always an ancestor of it, and the
    // editable itself sits inset by the composer's padding.
    var node = ed && ed.parentElement;
    for (var hops = 0; node && hops < 8; hops++) {
      var cs = getComputedStyle(node);
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      var bg = cs.backgroundColor || "";
      var filled = bg && bg !== "transparent" && !/,\s*0\)$/.test(bg);
      if (radius >= 8 && filled) return node;
      if (node === wrap) break;
      node = node.parentElement;
    }
    return wrap || ed;
  }

  function editor() {
    for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
      var el = document.querySelector(EDITOR_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function within(node, sel) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest(sel));
  }

  function inComposer(node) {
    return within(node, COMPOSER) || within(document.activeElement, COMPOSER);
  }

  // innerText, not textContent: it renders the block structure as newlines, so a
  // multi-paragraph prompt comes back with its line breaks intact. ProseMirror's
  // trailing break contributes a final newline, hence the trim.
  function readText(ed) {
    if (!ed) return "";
    var t = ed.innerText != null ? ed.innerText : ed.textContent || "";
    return t.replace(/\u200b/g, "").trim();
  }

  function selectAll(ed) {
    var r = document.createRange();
    r.selectNodeContents(ed);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // A synthetic paste is the one edit that carries multi-line text across in a
  // single step: ProseMirror parses the clipboard payload itself and builds the
  // paragraphs. It signals it handled the event by calling preventDefault — but
  // Chrome has historically ignored `clipboardData` passed to the constructor, in
  // which case it would "handle" an empty clipboard, so the result is verified
  // rather than trusted.
  function pasteInto(ed, text) {
    try {
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      var ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      ed.dispatchEvent(ev);
      return ev.defaultPrevented && readText(ed) !== "";
    } catch (e) {
      return false;
    }
  }

  // Replace the composer's contents. Everything goes through browser editing
  // commands on a selection, so ProseMirror sees ordinary user edits and stays in
  // sync; inserting nodes ourselves would be undone on its next render.
  function writeText(ed, text) {
    if (!ed) return;
    ed.focus();
    selectAll(ed);
    document.execCommand("delete");
    if (!text) return;
    if (pasteInto(ed, text)) return;

    // Fallback: type it in a line at a time, splitting paragraphs the way Enter
    // would. Re-select first, since a paste that preventDefault'ed without
    // inserting may have moved the selection.
    selectAll(ed);
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (i) document.execCommand("insertParagraph");
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
    }
  }

  // ---------- the stash ----------

  function setStash(text) {
    stash = text || "";
    render();
    if (!ctx || !convId) return;
    // An emptied slot is removed rather than stored as "", so a chat you've
    // finished with leaves nothing behind.
    if (!stash) {
      ctx.util.remove(storeKey(convId));
      return;
    }
    var obj = {};
    obj[storeKey(convId)] = stash;
    ctx.util.set(obj);
  }

  // One key, three outcomes, all of them a swap between the box and the slot:
  // text in the box goes to the slot and whatever was held comes back (empty
  // included), which covers stash, restore, and cycle without a mode.
  function swap() {
    if (!convId) return;
    var ed = editor();
    if (!ed) return;
    var current = readText(ed);
    if (!current && !stash) return;
    writeText(ed, stash);
    setStash(current);
    flash();
  }

  // ---------- the card ----------

  function ensurePanel() {
    if (panel) return panel;

    panel = document.createElement("div");
    panel.className = "cps-panel";
    panel.hidden = true;
    panel.title = "Click (or press " + CHORD + ") to put this back in the message box";

    var head = document.createElement("div");
    head.className = "cps-head";

    var title = document.createElement("span");
    title.className = "cps-title";
    title.textContent = "Stashed";

    var x = document.createElement("button");
    x.type = "button";
    x.className = "cps-x";
    x.textContent = "×";
    x.title = "Discard stashed prompt";
    x.setAttribute("aria-label", "Discard stashed prompt");
    x.addEventListener("click", function (e) {
      e.stopPropagation();
      setStash("");
    });

    head.appendChild(title);
    head.appendChild(x);

    bodyEl = document.createElement("div");
    bodyEl.className = "cps-body";

    var hint = document.createElement("div");
    hint.className = "cps-hint";
    hint.textContent = CHORD + " to restore";

    panel.appendChild(head);
    panel.appendChild(bodyEl);
    panel.appendChild(hint);
    panel.addEventListener("click", swap);

    document.body.appendChild(panel);
    return panel;
  }

  function flash() {
    if (!panel || panel.hidden) return;
    panel.classList.remove("cps-flash");
    void panel.offsetWidth; // restart the animation
    panel.classList.add("cps-flash");
  }

  function render() {
    if (!stash) {
      if (panel) panel.hidden = true;
      return;
    }
    ensurePanel();
    bodyEl.textContent = stash;
    place();
  }

  // Wear the composer's own edge: same border width, style and colour, same
  // corner radius. Read from the live computed style rather than copied into our
  // stylesheet as literals, so light/dark, a token retune, or a restyled composer
  // all follow with nothing to keep in sync. If claude ever draws that edge some
  // other way (a ring shadow, say, with no real border), the inline values are
  // cleared and prompt-stash.css's own border stands in.
  function matchEdge(box) {
    var cs = getComputedStyle(box);
    var hasBorder = cs.borderTopStyle !== "none" && (parseFloat(cs.borderTopWidth) || 0) > 0;
    panel.style.borderWidth = hasBorder ? cs.borderTopWidth : "";
    panel.style.borderStyle = hasBorder ? cs.borderTopStyle : "";
    panel.style.borderColor = hasBorder ? cs.borderTopColor : "";
    panel.style.borderRadius = parseFloat(cs.borderTopLeftRadius) ? cs.borderTopLeftRadius : "";
  }

  // Anchored to the live rect of the composer: to its right when the margin can
  // hold the card, otherwise stacked above it and right-aligned. In the side
  // position the card's top lines up with the composer's top, so the two read as
  // one row — meaning it rides upward with the composer as a multi-line draft
  // grows it. The fallback position is bottom-anchored instead, since there the
  // card sits on top of the composer rather than beside it.
  function place() {
    if (!panel || !stash) return;
    var box = inputBox();
    if (!box) {
      panel.hidden = true;
      return;
    }
    var r = box.getBoundingClientRect();
    if (!r.width || !r.height) {
      panel.hidden = true;
      return;
    }

    matchEdge(box);

    var fits = r.right + GAP + CARD_W + EDGE <= window.innerWidth;
    panel.classList.toggle("cps-above", !fits);
    // Beside the composer the card is the same height, so the two read as one
    // row; stacked above it, it sizes to its content instead.
    panel.style.height = fits ? Math.round(r.height) + "px" : "";
    // Only one of top/bottom is ever set; the other is cleared so a switch
    // between the two positions can't leave the card stretched between them.
    if (fits) {
      panel.style.left = Math.round(r.right + GAP) + "px";
      panel.style.top = Math.round(Math.max(EDGE, r.top)) + "px";
      panel.style.bottom = "";
    } else {
      var left = Math.max(EDGE, Math.min(r.right - CARD_W, window.innerWidth - CARD_W - EDGE));
      panel.style.left = Math.round(left) + "px";
      panel.style.bottom = Math.round(window.innerHeight - r.top + GAP / 2) + "px";
      panel.style.top = "";
    }
    panel.hidden = false;
  }

  // ---------- events ----------

  function onKeydownCapture(e) {
    // Mid-IME-composition an "s" is candidate text, not a shortcut.
    if (e.isComposing) return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== "s" && e.key !== "S") return;
    if (!inComposer(e.target)) return;
    // Always swallow it inside the composer, even with nothing to do — off a
    // chat page there's no slot, so the key is inert: Ctrl+S there should never
    // drop the browser's Save Page dialog on the user.
    e.preventDefault();
    e.stopImmediatePropagation();
    swap();
  }

  function onResize() {
    place();
  }

  // Keep the card glued to the composer when the composer moves for reasons core's
  // MutationObserver doesn't see — dragging the sidebar wider resizes it without
  // adding or removing a node.
  function watchComposer() {
    if (typeof ResizeObserver === "undefined") return;
    var box = inputBox();
    // Re-point only when React has swapped the element out from under us;
    // onApply runs on every burst of DOM churn, which is most keystrokes.
    if (!box || box === roTarget) return;
    if (!ro) ro = new ResizeObserver(place);
    else ro.disconnect();
    roTarget = box;
    ro.observe(box);
  }

  // Another tab open on the same chat stashing or restoring rewrites that
  // chat's slot; follow it so the card on screen is never showing a prompt
  // that's already been taken. Changes to other chats' slots aren't ours.
  function onStorageChanged(changes, area) {
    if (area !== "local" || !convId) return;
    var key = storeKey(convId);
    if (!changes[key]) return;
    var next = changes[key].newValue || "";
    if (next === stash) return;
    stash = next;
    render();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "prompt-stash",

    onInit: function (c) {
      ctx = c;
      if (started) return;
      started = true;
      window.addEventListener("keydown", onKeydownCapture, true);
      window.addEventListener("resize", onResize);
      try {
        chrome.storage.onChanged.addListener(onStorageChanged);
      } catch (e) {
        /* context already gone; core will shut us down */
      }
      // The slot used to be a single global one under this key; nothing reads
      // it now, so clear it rather than leave it in storage forever.
      ctx.util.remove("cppPromptStash");
      syncChat();
    },

    // Core calls this (debounced) on DOM churn and SPA navigation. Pick up a
    // move to another chat, and — since the composer is re-mounted constantly —
    // re-point the ResizeObserver and re-measure.
    onApply: function () {
      syncChat();
      if (!stash) return;
      watchComposer();
      place();
    },

    // Drop a deleted chat's slot, and the card with it if that chat is the one
    // on screen.
    onDelete: function (info) {
      if (!info || info.kind !== "chat" || !ctx) return;
      ctx.util.remove(storeKey(info.id));
      if (info.id === convId) {
        stash = "";
        render();
      }
    },

    onTeardown: function () {
      started = false;
      convId = null;
      stash = "";
      window.removeEventListener("keydown", onKeydownCapture, true);
      window.removeEventListener("resize", onResize);
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch (e) {}
      if (ro) {
        ro.disconnect();
        ro = null;
      }
      roTarget = null;
      if (panel) {
        panel.remove();
        panel = null;
        bodyEl = null;
      }
      // The stored slot is deliberately left alone: disabling the feature hides
      // the card, it shouldn't throw away the user's text.
    }
  });
})();
