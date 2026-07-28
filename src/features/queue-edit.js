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

  // Prefixes the accessible name, which then carries the message text itself —
  // parallel to claude's own "Discard queued message" on the × beside it, and
  // enough on its own to tell the two buttons in a row apart.
  var LABEL = "Edit queued message: ";

  var started = false;

  // ---------- the queue ----------

  // The queued bubble a click landed on, or null if the click wasn't on one.
  function queuedBubble(node) {
    var bubble = CPP.util.closestEl(node, BUBBLE_SEL);
    if (!bubble || !bubble.closest(QUEUE_SEL)) return null;
    return bubble;
  }

  function queuedText(bubble) {
    return CPP.util.plainText(bubble.querySelector(TEXT_SEL) || bubble);
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

  // ---------- pulling one back ----------

  // Move a queued message into the composer and out of the queue. Returns false
  // without touching anything when it can't be done in full — nothing to move,
  // nowhere to put it, or no way to take it out of the queue — so the caller can
  // leave the event alone rather than half-doing the job.
  function pullBack(bubble) {
    var text = queuedText(bubble);
    var ed = CPP.util.composerEditor();
    var discard = discardButton(bubble);
    if (!text || !ed || !discard) return false;

    var current = CPP.util.composerText(ed);
    CPP.util.setComposerText(current ? current + JOIN + text : text, ed);
    // Composer first, queue second. If the discard doesn't take, the user has the
    // text in two places, which is a nuisance they can see and fix; the other
    // order risks dropping the message on the floor. setComposerText has already
    // put focus in the box, so removing the row can't strand it.
    discard.click();
    return true;
  }

  function onClickCapture(e) {
    // Modified clicks are the browser's (context menu, open-in-tab habits).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var bubble = queuedBubble(e.target);
    if (!bubble) return;

    // A drag that selected text inside the bubble ends in a click too, and
    // someone picking out a phrase to copy isn't asking to edit the message.
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && bubble.contains(sel.anchorNode)) return;

    if (!pullBack(bubble)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // The keyboard half of the same affordance: decorate() makes each queued
  // bubble a focusable button, and a button is expected to answer to Enter and
  // Space. Without this the feature would be reachable by mouse only, while the
  // Discard beside it has always been on the tab ring.
  function onKeydownCapture(e) {
    if (e.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;

    var bubble = queuedBubble(e.target);
    if (!bubble) return;
    if (!pullBack(bubble)) return;
    // Space would otherwise scroll the transcript out from under the composer
    // we've just filled.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ---------- the affordance ----------

  // A queued bubble has never been actionable, so it has to say that it is now —
  // and say what the action is, since the × beside it has trained the opposite
  // expectation. Sighted users get that from CSS hanging off the class (the
  // hover cue and the "Click to edit" label, drawn as a pseudo-element so
  // there's nothing of ours inside React's tree for a re-render to fight over);
  // everyone else gets it from the button role, the tab stop, and a label that
  // names both the action and the message it applies to.
  //
  // Guarded on the class, not applied unconditionally: every attribute write is
  // a mutation, core re-applies on mutations, and the two would chase each other
  // for as long as a queue existed.
  function decorate() {
    var queue = document.querySelector(QUEUE_SEL);
    if (!queue) return;
    var bubbles = queue.querySelectorAll(BUBBLE_SEL);
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      if (b.classList.contains(MARK)) continue;
      b.classList.add(MARK);
      b.setAttribute("role", "button");
      b.setAttribute("tabindex", "0");
      b.setAttribute("aria-label", LABEL + queuedText(b));
    }
  }

  // React re-renders replace these nodes freely, so undecorating walks the
  // document rather than the queue: a bubble we marked may already have been
  // detached, and one still on screen may sit outside the container we last saw.
  // Only what decorate() set is removed — claude puts no role, tabindex or label
  // on these bubbles of its own, so there's nothing of its to clobber.
  function undecorate() {
    var marked = document.querySelectorAll("." + MARK);
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove(MARK);
      marked[i].removeAttribute("role");
      marked[i].removeAttribute("tabindex");
      marked[i].removeAttribute("aria-label");
    }
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "queue-edit",

    onInit: function () {
      if (started) return;
      started = true;
      // Capture phase, so the event is ours before any handler claude has on the
      // bubble runs — the one exception being touch screens, where claude lays a
      // full-bubble Discard button over it that swallows the tap first. That's
      // deliberate: the × is hidden on touch, so intercepting the overlay would
      // leave no way to discard at all. Tapping there discards, as it always has.
      window.addEventListener("click", onClickCapture, true);
      window.addEventListener("keydown", onKeydownCapture, true);
    },

    // Core calls this (debounced) on DOM churn, which is every queue change.
    onApply: decorate,

    onTeardown: function () {
      started = false;
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("keydown", onKeydownCapture, true);
      undecorate();
    }
  });
})();
