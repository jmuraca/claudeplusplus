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
// Reading and writing the box both go through CPP.util (composerText /
// setComposerText), which is where the ProseMirror-safe editing lives — the
// editor owns its DOM and would discard nodes we inserted, so text is written by
// selecting and issuing the browser's own editing commands.
//
// The stash is per conversation: each /chat/<uuid> has its own slot, stored
// under its own key the way asides.js stores its cards, so a draft parked in one
// chat never surfaces in another and is reaped when that chat is deleted. It
// survives navigation and reloads, and other tabs on the same chat follow it.
// Pages with no conversation of their own — /new, a project's overview — have
// nowhere to put a draft, so the feature is idle there.
(function () {
  "use strict";

  // The composer selectors, the "is this the composer" / editable lookups and the
  // read/write helpers are shared in CPP.util (core.js), same source as
  // draft-mode, emoji-autocomplete and queue-edit.

  var STORE_PREFIX = "cppPromptStash:";

  function storeKey(id) {
    return STORE_PREFIX + id;
  }

  var CARD_W = 260;
  var GAP = 16; // between the card and the composer
  var EDGE = 12; // keep the card this far from the viewport edge

  var CHORD = CPP.util.chord("S");

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
    var ed = CPP.util.composerEditor();
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
    var ed = CPP.util.composerEditor();
    if (!ed) return;
    var current = CPP.util.composerText(ed);
    if (!current && !stash) return;
    CPP.util.setComposerText(stash, ed);
    setStash(current);
    flash();
  }

  // ---------- the card ----------

  function ensurePanel() {
    if (panel) return panel;

    panel = document.createElement("div");
    panel.className = "cps-panel";
    panel.hidden = true;

    var head = document.createElement("div");
    head.className = "cps-head";

    var title = document.createElement("span");
    title.className = "cps-title";
    var titleLabel = document.createElement("span");
    titleLabel.className = "cps-title-label";
    titleLabel.textContent = "Stashed";
    var titleHint = document.createElement("span");
    titleHint.className = "cps-title-hint";
    titleHint.textContent = " (" + CHORD + " to restore)";
    title.appendChild(titleLabel);
    title.appendChild(titleHint);

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

    panel.appendChild(head);
    panel.appendChild(bodyEl);
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

  // Anchored to the live rect of the composer: to its right when the margin can
  // hold the card, otherwise stacked above it and right-aligned. In the side
  // position the card's top lines up with the composer's top, so it reads as
  // attached to it, riding upward with the composer as a multi-line draft grows.
  // The fallback position is bottom-anchored instead, since there the card sits
  // on top of the composer rather than beside it. (Hiding the card while a modal
  // is open is done in CSS, not here — see prompt-stash.css.)
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

    var fits = r.right + GAP + CARD_W + EDGE <= window.innerWidth;
    panel.classList.toggle("cps-above", !fits);
    // The card sizes to its own content; a long draft is clamped with an
    // ellipsis in CSS so it never grows unbounded up the page.
    panel.style.height = "";
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
    // Either modifier, deliberately — not CPP.util.accel, which is strict about
    // which one. Strictness is there to keep a Mac's Ctrl+click (the secondary
    // click) from being read as an accelerator, and no such gesture is at stake
    // on a keydown: Ctrl+S on a Mac means nothing to the browser or the page, so
    // a hand that reaches for it gets the stash rather than nothing.
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== "s" && e.key !== "S") return;
    if (!CPP.util.inComposer(e.target)) return;
    // Always swallow it inside the composer, even with nothing to do — off a
    // chat page there's no slot, so the key is inert: Ctrl+S there should never
    // drop the browser's Save Page dialog on the user.
    e.preventDefault();
    e.stopImmediatePropagation();
    swap();
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
      window.addEventListener("resize", place);
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
      window.removeEventListener("resize", place);
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
