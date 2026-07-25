// Feature: Edit a queued message
//
// While a response is streaming, claude.ai lets you queue the next messages —
// they sit under the transcript as muted bubbles and go out when the reply
// finishes. But a queued message is final: the only control on it is Discard, so
// a typo or a half-finished thought means losing the text and typing it again.
//
// This makes a queued bubble clickable. Click it and the text comes back into
// the message box — appended after whatever you've already typed, so pulling two
// of them back merges them in order — and the message leaves the queue, ready to
// be fixed up and sent again.
//
// Two things it deliberately does not do. It never removes the bubble itself:
// the queue is React state, so a node pulled out from under it would come
// straight back on the next render and still be sent. Removal goes through
// claude's own Discard control for that row, by clicking it. And it never writes
// the composer's DOM: that's a ProseMirror editor, and CPP.util.setComposerText
// (core.js) does the edit the way ProseMirror will accept — the same path
// prompt-stash uses.
//
// The bubble the user clicks looks identical to a sent message in the
// transcript, so the queue container is what tells them apart; only bubbles
// inside it are ours to touch.
(function () {
  "use strict";

  // claude names the whole queue "pending-queue-row" (singular), not each row.
  var QUEUE_SEL = '[data-testid="pending-queue-row"]';
  var BUBBLE_SEL = "[data-user-message-bubble]";
  var TEXT_SEL = '[data-testid="user-message"]';

  // Marks the bubbles we've made clickable. Everything visible hangs off it in
  // queue-edit.css — the pointer cursor, the hover ring, and the "Click to edit"
  // label drawn above the bubble — so disabling the feature takes the whole
  // affordance with it and leaves claude's own styling untouched.
  var MARK = "cpp-qedit";

  // Separates an appended message from what's already in the box: a blank line,
  // so the two land as the separate paragraphs they were written as.
  var JOIN = "\n\n";

  var started = false;

  // ---------- the queue ----------

  // The queued bubble a click landed on, or null if the click wasn't on one.
  function queuedBubble(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || !el.closest) return null;
    var bubble = el.closest(BUBBLE_SEL);
    if (!bubble || !bubble.closest(QUEUE_SEL)) return null;
    return bubble;
  }

  function queuedText(bubble) {
    var el = bubble.querySelector(TEXT_SEL) || bubble;
    var t = el.innerText != null ? el.innerText : el.textContent || "";
    return t.replace(/\u200b/g, "").trim();
  }

  // claude's Discard control for this row. Searched from the bubble outwards and
  // stopped before the queue container: every row carries a button with the same
  // label, and one found at container level could belong to a different message
  // — discarding the wrong one is not recoverable.
  function discardButton(bubble) {
    var queue = bubble.closest(QUEUE_SEL);
    var node = bubble.parentElement;
    while (node && node !== queue) {
      var btns = node.querySelectorAll("button[aria-label]");
      for (var i = 0; i < btns.length; i++) {
        if (/discard/i.test(btns[i].getAttribute("aria-label") || "")) return btns[i];
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---------- the click ----------

  function onClickCapture(e) {
    // Middle/right clicks open menus and paste; only a plain left click edits.
    if (e.button) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var bubble = queuedBubble(e.target);
    if (!bubble) return;

    // A drag that selected text inside the bubble ends in a click too, and
    // someone picking out a phrase to copy isn't asking to edit the message.
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && bubble.contains(sel.anchorNode)) return;

    var text = queuedText(bubble);
    var ed = CPP.util.composerEditor();
    var discard = discardButton(bubble);
    // Nothing to move, nowhere to put it, or no way to take it out of the queue:
    // leave the click alone rather than half-doing the job.
    if (!text || !ed || !discard) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    var current = CPP.util.composerText(ed);
    CPP.util.setComposerText(current ? current + JOIN + text : text, ed);
    // Composer first, queue second. If the discard doesn't take, the user has the
    // text in two places, which is a nuisance they can see and fix; the other
    // order risks dropping the message on the floor.
    discard.click();
  }

  // ---------- the affordance ----------

  // A queued bubble has never been clickable, so it has to say that it is now —
  // and say what the click does, since "clickable" alone doesn't distinguish
  // edit from the discard that's been the only option until now. Marking the
  // bubble is all this does; the label and the rest of the cue are drawn in CSS
  // off that one class, which is a pseudo-element rather than a node so there's
  // nothing of ours inside React's tree for a re-render to fight over.
  function decorate() {
    var queue = document.querySelector(QUEUE_SEL);
    if (!queue) return;
    var bubbles = queue.querySelectorAll(BUBBLE_SEL);
    for (var i = 0; i < bubbles.length; i++) {
      if (!bubbles[i].classList.contains(MARK)) bubbles[i].classList.add(MARK);
    }
  }

  // React re-renders replace these nodes freely, so undecorating walks the
  // document rather than the queue: a bubble we marked may already have been
  // detached, and one still on screen may sit outside the container we last saw.
  function undecorate() {
    var marked = document.querySelectorAll("." + MARK);
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove(MARK);
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "queue-edit",

    onInit: function () {
      if (started) return;
      started = true;
      // Capture phase, so the click is ours before any handler claude has on the
      // bubble runs — the one exception being touch screens, where claude lays a
      // full-bubble Discard button over it that swallows the tap first. That's
      // deliberate: the × is hidden on touch, so intercepting the overlay would
      // leave no way to discard at all. Editing is a pointer affordance.
      window.addEventListener("click", onClickCapture, true);
    },

    // Core calls this (debounced) on DOM churn, which is every queue change.
    onApply: decorate,

    onTeardown: function () {
      started = false;
      window.removeEventListener("click", onClickCapture, true);
      undecorate();
    }
  });
})();
