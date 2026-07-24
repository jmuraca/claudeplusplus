// Claude++ — transcript anchoring engine (isolated-world, loaded after core.js).
//
// Shared by every feature that has to pin something to a passage of text in a
// claude.ai conversation and still find it later: inline asides, bookmarks.
//
// Two facts about claude.ai's transcript drive the whole design:
//   1. The message list is virtualized ([data-rocksteady-sizer] + one tall
//      spacer), so an anchor is not a Range — a Range holds live text nodes and
//      collapses the moment React unmounts or re-renders them. We store offsets
//      plus the quoted text and re-resolve on demand.
//   2. Layout is class-churn city, but structure is stable: .standard-markdown
//      is the message body, [data-rs-index] is the only per-message id, and
//      data-is-streaming says when a message has settled.
//
// An anchor is a plain, JSON-safe object — safe to persist — of the shape:
//   { msgIndex, mdIndex, blockIndex, start, end, quote, prefix, suffix }
// Note that resolve() *rewrites* msgIndex/mdIndex/blockIndex/start/end in place
// when it finds the quote somewhere new, so a caller holding one should save it
// again after a resolve pass that reported "moved".
(function () {
  "use strict";

  var MD = ".standard-markdown";
  var FEED = '[role="feed"]';
  var SCROLLER = '[data-autoscroll-container="true"]';
  var CTX = 30; // chars of prefix/suffix kept to disambiguate repeat quotes
  var DRIFT = 3; // how far either side of the recorded index to look after a renumbering

  // ---------- text offsets ----------
  // Selections inside a code block span dozens of syntax-highlight <span>s, so
  // offsets are always measured against the block's flattened textContent, never
  // per text node.

  /** Char offset of (node, offset) into container's flattened text. */
  function offsetIn(container, node, offset) {
    var walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var total = 0;
    var n;
    while ((n = walk.nextNode())) {
      if (n === node) return total + offset;
      total += n.nodeValue.length;
    }
    return -1;
  }

  /** Inverse of offsetIn: char offsets -> a live Range inside `block`. */
  function rangeAt(block, start, end) {
    var walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    var total = 0;
    var open = false;
    var n;
    while ((n = walk.nextNode())) {
      var len = n.nodeValue.length;
      // `>` not `>=` so an offset sitting on a node boundary starts at the
      // beginning of the next node rather than the tail of the previous one.
      if (!open && total + len > start) {
        range.setStart(n, start - total);
        open = true;
      }
      if (open && total + len >= end) {
        range.setEnd(n, end - total);
        return range;
      }
      total += len;
    }
    return null;
  }

  /** The direct child of `root` that contains `node`. */
  function blockOf(root, node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el.parentElement !== root) el = el.parentElement;
    return el;
  }

  // ---------- capture ----------

  /**
   * Turn a live Selection into a persistable anchor, or null if the selection
   * isn't one we can pin (spans two messages, two blocks, or sits outside the
   * transcript entirely).
   */
  function describe(sel) {
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);

    var md = range.startContainer.parentElement && range.startContainer.parentElement.closest(MD);
    if (!md || !md.contains(range.endContainer)) return null;

    // A message can hold several .standard-markdown blocks — Claude interleaves
    // reasoning pills with prose — so record which one.
    var article = md.closest("[data-rs-index]");
    if (!article) return null;
    var mdIndex = Array.prototype.indexOf.call(article.querySelectorAll(MD), md);

    var block = blockOf(md, range.startContainer);
    if (!block || block !== blockOf(md, range.endContainer)) return null;

    var start = offsetIn(block, range.startContainer, range.startOffset);
    var end = offsetIn(block, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;

    var text = block.textContent;
    return {
      msgIndex: +article.dataset.rsIndex,
      mdIndex: mdIndex,
      blockIndex: Array.prototype.indexOf.call(md.children, block),
      start: start,
      end: end,
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CTX), start),
      suffix: text.slice(end, end + CTX)
    };
  }

  /** Streaming messages append text continuously, so offsets taken mid-stream drift. */
  function isSettled(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var wrap = el && el.closest("[data-is-streaming]");
    return !wrap || wrap.dataset.isStreaming === "false";
  }

  // ---------- resolve ----------
  //   exact   — offsets land and the text there still equals the quote
  //   moved   — quote found elsewhere in the message; offsets rewritten
  //   orphan  — quote is gone (message edited); the anchor survives, detached
  //   dormant — the message is outside the render window; comes back on scroll

  function articleFor(msgIndex) {
    return document.querySelector('[data-rs-index="' + msgIndex + '"]');
  }

  function blockFor(anchor, article) {
    var md = article.querySelectorAll(MD)[anchor.mdIndex];
    return md ? md.children[anchor.blockIndex] || null : null;
  }

  /** How many chars of context agree on each side — higher is a better match. */
  function contextScore(text, at, anchor) {
    var before = text.slice(Math.max(0, at - CTX), at);
    var after = text.slice(at + anchor.quote.length, at + anchor.quote.length + CTX);
    var n = 0;
    while (
      n < Math.min(before.length, anchor.prefix.length) &&
      before[before.length - 1 - n] === anchor.prefix[anchor.prefix.length - 1 - n]
    ) n++;
    var m = 0;
    while (m < Math.min(after.length, anchor.suffix.length) && after[m] === anchor.suffix[m]) m++;
    return n + m;
  }

  /** Search a message for the quote, best context match wins. */
  function relocate(anchor, article) {
    var best = null;
    var mds = article.querySelectorAll(MD);
    for (var i = 0; i < mds.length; i++) {
      var children = mds[i].children;
      for (var j = 0; j < children.length; j++) {
        var block = children[j];
        var text = block.textContent;
        var at = text.indexOf(anchor.quote);
        while (at !== -1) {
          var s = contextScore(text, at, anchor);
          if (!best || s > best.score) best = { block: block, at: at, score: s };
          at = text.indexOf(anchor.quote, at + 1);
        }
      }
    }
    return best;
  }

  /** Rewrite the stored anchor to wherever we just found the quote. */
  function adopt(anchor, article, hit) {
    var md = hit.block.closest(MD);
    anchor.msgIndex = +article.dataset.rsIndex;
    anchor.mdIndex = Array.prototype.indexOf.call(article.querySelectorAll(MD), md);
    anchor.blockIndex = Array.prototype.indexOf.call(md.children, hit.block);
    anchor.start = hit.at;
    anchor.end = hit.at + anchor.quote.length;
    return rangeAt(hit.block, anchor.start, anchor.end);
  }

  function resolve(anchor) {
    var article = articleFor(anchor.msgIndex);

    if (article) {
      var block = blockFor(anchor, article);
      if (block && block.textContent.slice(anchor.start, anchor.end) === anchor.quote) {
        var range = rangeAt(block, anchor.start, anchor.end);
        if (range) return { state: "exact", range: range };
      }
      var hit = relocate(anchor, article);
      if (hit) {
        var r2 = adopt(anchor, article, hit);
        if (r2) return { state: "moved", range: r2 };
      }
    }

    // Editing and resending an earlier message renumbers every data-rs-index
    // after it, so a miss at the recorded index doesn't mean the text is gone.
    // Widen outwards and stop at the first distance that matches — nearest wins,
    // since a further match is more likely to be coincidental repetition.
    for (var d = 1; d <= DRIFT; d++) {
      var best = null;
      var candidates = [anchor.msgIndex - d, anchor.msgIndex + d];
      for (var k = 0; k < candidates.length; k++) {
        var near = articleFor(candidates[k]);
        if (!near) continue;
        var h = relocate(anchor, near);
        if (h && (!best || h.score > best.hit.score)) best = { near: near, hit: h };
      }
      if (best) {
        var r3 = adopt(anchor, best.near, best.hit);
        if (r3) return { state: "moved", range: r3 };
      }
    }

    // No article means the virtualizer simply hasn't mounted it — not a failure.
    return { state: article ? "orphan" : "dormant", range: null };
  }

  /**
   * A bare quote is often unanswerable on its own — "what does this mean" about
   * a selected variable name needs the sentence around it. Pull a window from
   * the same block, which is available whenever the message is mounted. Returns
   * "" when the block holds nothing beyond the quote itself.
   */
  function contextFor(anchor, pad) {
    if (pad === undefined) pad = 250;
    var article = articleFor(anchor.msgIndex);
    var md = article && article.querySelectorAll(MD)[anchor.mdIndex];
    var text = md && md.children[anchor.blockIndex] && md.children[anchor.blockIndex].textContent;
    if (!text) return "";
    var slice = text.slice(Math.max(0, anchor.start - pad), anchor.end + pad);
    return slice === anchor.quote ? "" : slice;
  }

  // ---------- layout / scrolling ----------
  // Margin width is measured, never computed from Tailwind classes: the sidebar
  // is user-resizable and claude.ai's own file pane can claim the right margin,
  // so only the live rects tell the truth.

  function scroller() {
    return document.querySelector(SCROLLER);
  }

  function layout() {
    var feed = document.querySelector(FEED);
    var sc = scroller();
    if (!feed || !sc) return null;
    var f = feed.getBoundingClientRect();
    var s = sc.getBoundingClientRect();
    return {
      left: Math.round(f.left - s.left),
      right: Math.round(s.right - f.right),
      column: Math.round(f.width)
    };
  }

  function mountedRange() {
    var els = document.querySelectorAll("[data-rs-index]");
    if (!els.length) return null;
    var idx = Array.prototype.map
      .call(els, function (e) { return +e.dataset.rsIndex; })
      .sort(function (a, b) { return a - b; });
    return { lo: idx[0], hi: idx[idx.length - 1], count: idx.length };
  }

  // Seeking to an unmounted message can't use scrollIntoView — the node does not
  // exist. Estimate from the height of the rows that *are* mounted, jump, let the
  // virtualizer mount whatever lands there, and re-measure. Each pass lands
  // closer because the local px-per-message estimate improves.
  function scrollToMessage(msgIndex, tries) {
    if (tries === undefined) tries = 10;
    var sc = scroller();
    if (!sc) return;

    function step() {
      var el = articleFor(msgIndex);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      if (--tries <= 0) return;

      var m = mountedRange();
      var first = m && articleFor(m.lo);
      var last = m && articleFor(m.hi);
      if (!first || !last) return;

      var fr = first.getBoundingClientRect();
      var lr = last.getBoundingClientRect();
      var sr = sc.getBoundingClientRect();
      var avg = Math.max(1, (lr.bottom - fr.top) / (m.hi - m.lo + 1));

      var before = sc.scrollTop;
      sc.scrollTop += fr.top - sr.top + (msgIndex - m.lo) * avg - sc.clientHeight / 2;

      if (Math.abs(sc.scrollTop - before) < 1) return;
      requestAnimationFrame(step);
    }

    step();
  }

  // ---------- claude.ai's own selection tooltip ----------
  // claude.ai already shows a tooltip when you select text, so features that
  // offer an action on a selection (Ask, Bookmark) add to it rather than racing
  // it with a second floating thing. The tooltip is React's and re-renders on
  // every reposition, so an injector has to be idempotent — testing for its own
  // button, not for a marker flag, since React can rebuild the inner row while
  // keeping the outer node.
  //
  // The mount lands a beat after mouseup and the exact frame varies, so a
  // feature's onApply pass can fall between the mount and the frame React
  // settles on — which is what used to leave a fresh selection showing Reply
  // with no Ask. Hence the short poll after any selection.
  //
  // One poller for all subscribers: they query the same node on the same
  // frames, so running an interval per feature would double the work to reach
  // exactly the same result.
  var TOOLTIP = '[data-selection-tooltip="true"]';
  var injectors = [];
  var injectTries = 0;
  var injectTimer = null;
  var listening = false;

  function chaseTooltip() {
    for (var i = 0; i < injectors.length; i++) {
      try { injectors[i](); } catch (e) { /* one bad injector mustn't stop the rest */ }
    }
    if (document.querySelector(TOOLTIP) || ++injectTries >= 20) {
      clearInterval(injectTimer);
      injectTimer = null;
    }
  }

  function scheduleInject() {
    // Only chase when there's a real selection to act on. Both mouseup and
    // selectionchange land here, so without the guard a plain click — or typing
    // in a feature's own popover — would kick off a pointless 1s poll. The
    // tooltip only appears for a non-collapsed selection anyway.
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    injectTries = 0;
    if (injectTimer) return;
    injectTimer = setInterval(chaseTooltip, 50); // ~1s window, 20 tries
    chaseTooltip();
  }

  /**
   * Run `fn` whenever the selection tooltip may need our buttons put back.
   * Returns an unsubscribe for onTeardown.
   */
  function onSelectionTooltip(fn) {
    injectors.push(fn);
    if (!listening) {
      listening = true;
      document.addEventListener("mouseup", scheduleInject);
      document.addEventListener("selectionchange", scheduleInject);
    }
    return function () {
      var i = injectors.indexOf(fn);
      if (i !== -1) injectors.splice(i, 1);
      if (injectors.length || !listening) return;
      listening = false;
      document.removeEventListener("mouseup", scheduleInject);
      document.removeEventListener("selectionchange", scheduleInject);
      if (injectTimer) { clearInterval(injectTimer); injectTimer = null; }
    };
  }

  CPP.anchor = {
    MD: MD,
    FEED: FEED,
    SCROLLER: SCROLLER,
    TOOLTIP: TOOLTIP,
    CTX: CTX,

    onSelectionTooltip: onSelectionTooltip,

    describe: describe,
    isSettled: isSettled,
    resolve: resolve,
    contextFor: contextFor,

    articleFor: articleFor,
    mountedRange: mountedRange,
    scroller: scroller,
    layout: layout,
    scrollToMessage: scrollToMessage,

    // Exposed for callers that build ranges from offsets they already hold.
    rangeAt: rangeAt
  };
})();
