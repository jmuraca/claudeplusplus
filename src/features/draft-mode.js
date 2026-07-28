// Feature: Draft mode (Shift+Tab)
//
// A composer guard modeled on Claude Code's Shift+Tab mode switch. Press
// Shift+Tab while the message box is focused to enter DRAFT mode: you can still
// type, paste, attach files, dictate, and change models — everything works —
// but nothing can submit by accident. Press Shift+Tab again (or click the
// button) to return to normal "run" mode.
//
// Lists are where its keys give way to claude's editor: Shift+Tab outdents an
// item rather than toggling the mode, and Ctrl/⌘+Enter starts the next item
// rather than doing nothing. See the list-aware keys section below.
//
// Visible state is all CSS, keyed off a single `cpp-draft` class on <html> — so
// it survives claude.ai re-mounting the composer on nearly every keystroke with
// no re-injection. The composer's action button turns into a blue Pause (the
// Send button when the box has text, the "Use voice mode" button when it's
// empty), and a "DRAFT" pill sits on the composer as an always-on indicator.
//
// Submission is blocked in the *capture* phase at `window` — the earliest point
// in dispatch, ahead of claude's ProseMirror editor (on the contenteditable),
// its base-ui button handlers, and every React handler — so one listener
// neutralizes every submit path:
//   • Enter in the composer, plain or with Ctrl/⌘ (Shift+Enter is left alone, so
//     newlines still work; Ctrl/⌘+Enter inserts one instead of submitting, which
//     is how a list gets its next item while paused)
//   • a click on the Send or voice button (which instead returns you to run mode)
//
// Two smaller pieces round it out: while draft mode is on we rewrite the hover
// tooltip on those buttons (claude's base-ui popups) to the draft label, and the
// CSS freezes claude's Send<->voice crossfade so the Pause doesn't flicker on the
// empty<->has-text swap.
//
// Note: selectors and tooltip text key off claude's English aria-labels, so like
// the other Claude++ features this is effectively English-locale-bound.
(function () {
  "use strict";

  var DRAFT_CLASS = "cpp-draft";

  // The two composer buttons that draft mode takes over. They're mutually
  // exclusive: Send shows only when the box has text, "Use voice mode" only when
  // it's empty. Voice mode is a text-less submit path with no button to pause,
  // so in draft mode we neutralize it too — repainted as the same blue Pause and
  // click-blocked. (The "Press and hold to record" dictation button is left
  // alone: it only inserts text into the box, which stays draft-protected.)
  var SEND_BTN = 'button[aria-label="Send message"]';
  var VOICE_BTN = 'button[aria-label="Use voice mode"]';
  var BLOCKED_BTN = SEND_BTN + ", " + VOICE_BTN;

  // These buttons keep their aria-labels in draft mode (our CSS keys off them,
  // and they're still the real submit paths underneath), so claude's own base-ui
  // hover tooltip would read "Send message" / "Use voice mode" — misleading while
  // submission is blocked. We rewrite just those tooltips' text while draft mode
  // is on, to the same wording as the composer pill, and restore it on exit.
  var TIP_TARGETS = ["Send message", "Use voice mode"];
  var DRAFT_LABEL = "Draft mode on (shift+tab to cycle)";
  var TIP_ORIG_ATTR = "data-cpp-tip-orig";

  var draftOn = false;
  var lastPath = null;
  var started = false;

  // The composer selector and the "is this the composer" test are shared in
  // CPP.util (core.js), so draft-mode, prompt-stash and emoji-autocomplete key
  // off the same source. The Shift+Tab toggle is scoped to the composer via
  // CPP.util.inComposer so it keeps its normal focus-stepping job elsewhere.

  // ---- list-aware keys ----------------------------------------------------
  // The message box is a ProseMirror editor, and inside a list it binds keys the
  // rest of the box doesn't. Two of them are ours the rest of the time, and both
  // stand down in a list rather than cost the user an editing command with no
  // replacement:
  //
  //   • Tab and Shift+Tab indent and outdent an item — Shift+Tab being the only
  //     way to pull one back a level. Tab was never ours; Shift+Tab hands itself
  //     back in a list, so the mode toggle is simply unavailable there.
  //   • Enter starts the next item. That one stays blocked — Enter must never
  //     reach the submit handler, in a list or out of it — so Ctrl/⌘+Enter does
  //     the editing job in its place while paused; see insertBreak.
  //
  // This reads the selection rather than the event target: a keydown in a
  // contenteditable targets the editor root, not the <li> the caret is in. The
  // list item is then confirmed to be inside the composer, so a stale selection
  // left somewhere else on the page (a transcript list, the sidebar) can't
  // suppress the toggle. `[role="listitem"]` rides along in case a list renders
  // as styled divs rather than real <li>s.
  var LIST_ITEM_SEL = 'li, [role="listitem"]';

  function caretInListItem() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.anchorNode) return false;
    var item = CPP.util.closestEl(sel.anchorNode, LIST_ITEM_SEL);
    return !!item && CPP.util.closest(item, CPP.util.COMPOSER_SEL);
  }

  // Enter's editing job, done by us instead of by the key. Draft mode drops
  // Enter outright — that's the whole promise, and a key handed to the editor in
  // the hope that it consumes it is a submit one binding away — so while paused,
  // Ctrl/⌘+Enter stands in: it breaks the line, and in a list that means the next
  // item. Nothing is dispatched at the page; this is the browser's own editing
  // command, which ProseMirror observes and folds into its document (the same
  // path CPP.util.setComposerText falls back to).
  //
  // The caret is in the message box by the time we get here — the keydown came
  // from it — so the command lands where the user is typing.
  function insertBreak() {
    try {
      document.execCommand("insertParagraph");
    } catch (err) {
      /* an editor that won't take the command just gets no line break */
    }
  }

  // ---- tooltip rewrite ----------------------------------------------------
  // claude's tooltips are base-ui popups portaled to <body> with role="tooltip",
  // mounted on hover and unmounted on leave. We only watch while draft mode is
  // on, and only react to tooltip nodes, so this stays off the hot path during
  // normal use (and never touches transcript text — those mutations aren't new
  // body-level [role="tooltip"] nodes).
  var tipObserver = null;

  // Rewrite a tooltip whose text is one of TIP_TARGETS to our label, stashing the
  // exact original on the tooltip element so exit can restore it verbatim.
  // Editing just the matching text node leaves any sibling markup (e.g. a
  // shortcut hint) alone.
  function retitleTooltip(tip) {
    if (!tip || tip.nodeType !== 1 || tip.hasAttribute(TIP_ORIG_ATTR)) return;
    var walk = document.createTreeWalker(tip, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walk.nextNode())) {
      if (n.nodeValue && TIP_TARGETS.indexOf(n.nodeValue.trim()) !== -1) {
        tip.setAttribute(TIP_ORIG_ATTR, n.nodeValue);
        n.nodeValue = DRAFT_LABEL;
        return;
      }
    }
  }

  // Undo retitleTooltip, restoring the stashed original text.
  function revertTooltip(tip) {
    if (!tip || !tip.getAttribute) return;
    var orig = tip.getAttribute(TIP_ORIG_ATTR);
    if (orig === null) return;
    var walk = document.createTreeWalker(tip, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walk.nextNode())) {
      if (n.nodeValue && n.nodeValue.trim() === DRAFT_LABEL) {
        n.nodeValue = orig;
        break;
      }
    }
    tip.removeAttribute(TIP_ORIG_ATTR);
  }

  function tooltipsIn(node) {
    if (!node || node.nodeType !== 1) return [];
    var found = [];
    if (node.matches && node.matches('[role="tooltip"]')) found.push(node);
    if (node.querySelectorAll) {
      var inner = node.querySelectorAll('[role="tooltip"]');
      for (var i = 0; i < inner.length; i++) found.push(inner[i]);
    }
    return found;
  }

  function onTipMutations(muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var tips = tooltipsIn(added[j]);
        for (var k = 0; k < tips.length; k++) retitleTooltip(tips[k]);
      }
    }
  }

  function startTipObserver() {
    if (tipObserver) return;
    // Catch a tooltip that's already open at the moment draft mode is armed
    // (hovering the button, then pressing Shift+Tab).
    var open = document.querySelectorAll('[role="tooltip"]');
    for (var i = 0; i < open.length; i++) retitleTooltip(open[i]);

    tipObserver = new MutationObserver(onTipMutations);
    tipObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopTipObserver() {
    if (tipObserver) {
      tipObserver.disconnect();
      tipObserver = null;
    }
    // If a rewritten tooltip is still on screen as we leave draft mode, put its
    // text back so the next hover in run mode reads correctly.
    var open = document.querySelectorAll("[" + TIP_ORIG_ATTR + "]");
    for (var i = 0; i < open.length; i++) revertTooltip(open[i]);
  }

  function setDraft(on) {
    on = !!on;
    if (on === draftOn) return;
    draftOn = on;
    document.documentElement.classList.toggle(DRAFT_CLASS, on);
    if (on) startTipObserver();
    else stopTipObserver();
  }

  // Capture at `window` — the earliest point in the dispatch, ahead of any
  // page-level capture listener on document/root and every React handler — so we
  // reliably win the race for both submit paths.
  function onKeydownCapture(e) {
    // Never intervene mid-IME-composition: an Enter there is committing a
    // candidate, not submitting a message.
    if (e.isComposing) return;

    // Shift+Tab (bare — no other modifier) toggles the mode, but only from
    // within the composer and outside a list, so Shift+Tab keeps its normal
    // focus-stepping job everywhere else on the page and its outdent job in
    // lists.
    if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      CPP.util.inComposer(e.target) &&
      !caretInListItem()
    ) {
      e.preventDefault(); // hold focus in the box instead of stepping back
      e.stopImmediatePropagation();
      setDraft(!draftOn);
      return;
    }

    if (!draftOn) return;

    // In draft mode, plain Enter (and Ctrl/⌘+Enter) must not submit. Both are
    // dropped before anything else in the page sees them. Shift+Enter is left
    // untouched, so the app still inserts a line inside the current block.
    //
    // Ctrl/⌘+Enter then takes over Enter's editing job: it breaks the line, and
    // in a list it starts the next item — the one thing Shift+Enter can't do,
    // since it stays within the item. The key still never reaches the submit
    // handler; the edit is made here instead.
    if (e.key === "Enter" && !e.shiftKey && CPP.util.closest(e.target, CPP.util.COMPOSER_SEL)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) insertBreak();
    }
  }

  // Clicking the blue Pause (whichever button is showing — Send when there's
  // text, "Use voice mode" when empty) never submits or starts voice; it unpauses
  // (back to run mode), leaving the normal button under the cursor for a
  // deliberate second click.
  function onClickCapture(e) {
    if (!draftOn) return;
    var btn = e.target && e.target.closest && e.target.closest(BLOCKED_BTN);
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setDraft(false);
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "draft-mode",

    onInit: function () {
      if (started) return;
      started = true;
      lastPath = location.pathname;
      window.addEventListener("keydown", onKeydownCapture, true);
      window.addEventListener("click", onClickCapture, true);
    },

    // Core calls this (debounced) on DOM churn and SPA navigation. Draft mode is
    // a transient, per-composer state; leaving a conversation should return the
    // safe default (run mode) rather than carry a hidden "armed" state onto the
    // next chat.
    onApply: function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        setDraft(false);
      }
    },

    onTeardown: function () {
      started = false;
      window.removeEventListener("keydown", onKeydownCapture, true);
      window.removeEventListener("click", onClickCapture, true);
      setDraft(false);
    }
  });
})();
