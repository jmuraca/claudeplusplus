// Feature: Bookmarks
//
// Notepad++'s margin bookmarks, for a claude.ai conversation. Select a passage,
// hit Bookmark in the selection tooltip, and the text stays highlighted with a
// bookmark glyph pinned in the left margin beside it. Click the glyph to clear
// it. Bookmarks are per-chat and survive reloads.
//
// Anchoring is the whole problem and none of it lives here: the transcript is
// virtualized, so a saved Range would collapse the moment React unmounts the
// message. src/anchor.js stores offsets plus the quoted text and re-resolves on
// demand; this file just asks it where a bookmark currently is, if anywhere.
//
// Two consequences of that worth knowing when reading the paint code:
//   • a bookmark whose message is scrolled outside the render window resolves
//     to "dormant" — no range, no marker. It is not lost, and comes back on
//     scroll. Nothing is drawn for it, because the text it marks isn't on
//     screen either.
//   • the highlight is painted with the CSS Custom Highlight API rather than by
//     wrapping the text in <mark>. Nodes inserted into React-owned DOM get
//     discarded on the next render; a Highlight decorates Ranges without
//     touching the tree.
(function () {
  "use strict";

  var A = CPP.anchor;

  var HAS_HIGHLIGHT = typeof CSS !== "undefined" && "highlights" in CSS;

  var MARK = 20; // marker button, px square
  var GAP = 10; // between the marker and the message column

  // Set in onInit; used by the storage helpers and convoId.
  var ctx = null;

  /**
   * Live bookmarks for the current conversation.
   * @type {Map<string, {id: string, anchor: object, state: string}>}
   */
  var bookmarks = new Map();
  var seq = 0;

  // ---------- storage (via core's context-safe wrappers) ----------

  function storeKey(id) {
    return "cppBookmarks:" + id;
  }

  function convoId() {
    if (!ctx) return null;
    var m = ctx.util.CHAT_RE.exec(location.pathname);
    return m ? m[1].toLowerCase() : null;
  }

  function save() {
    var id = convoId();
    if (!id || !ctx) return;
    var rows = [];
    bookmarks.forEach(function (b) {
      rows.push({ id: b.id, anchor: b.anchor });
    });
    var obj = {};
    obj[storeKey(id)] = rows;
    ctx.util.set(obj);
  }

  function load(id) {
    bookmarks.clear();
    if (!id || !ctx) { repaint(); return; }
    var key = storeKey(id);
    ctx.util.get(key).then(function (data) {
      var rows = (data && data[key]) || [];
      rows.forEach(function (row) {
        if (!row || !row.anchor) return;
        bookmarks.set(row.id, { id: row.id, anchor: row.anchor, state: "dormant" });
        var n = +String(row.id).slice(1);
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      });
      repaint();
    });
  }

  // ---------- paint ----------

  var hl = HAS_HIGHLIGHT ? new Highlight() : null;
  var highlightRegistered = false;

  function registerHighlight() {
    if (!HAS_HIGHLIGHT || highlightRegistered) return;
    CSS.highlights.set("cpp-bookmark", hl);
    highlightRegistered = true;
  }

  /** @type {Map<string, Range>} bookmark id -> last resolved range */
  var ranges = new Map();
  /** @type {Map<string, HTMLElement>} bookmark id -> margin marker */
  var marks = new Map();
  var layer = null;

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "cpp-bm-layer";
    document.body.appendChild(layer);
    return layer;
  }

  function buildMark(bm) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "cpp-bm-mark";
    el.dataset.id = bm.id;
    el.title = "Remove bookmark";
    el.setAttribute("aria-label", "Remove bookmark");
    el.appendChild(ctx.util.icon(ctx.util.ICON.BOOKMARK));
    el.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      remove(bm.id);
    });
    return el;
  }

  function syncMarks() {
    marks.forEach(function (el, id) {
      if (!bookmarks.has(id)) {
        el.remove();
        marks.delete(id);
      }
    });
    bookmarks.forEach(function (bm) {
      if (marks.has(bm.id)) return;
      var el = buildMark(bm);
      marks.set(bm.id, el);
      ensureLayer().appendChild(el);
    });
  }

  /** Re-resolve every anchor against the current DOM and repaint from scratch. */
  function repaint() {
    ranges.clear();
    if (hl) hl.clear();

    var moved = false;
    bookmarks.forEach(function (bm) {
      var res = A.resolve(bm.anchor);
      // resolve() rewrites the anchor in place when it tracks text to a new
      // position, so that has to be written back or the bookmark re-hunts for
      // it on every pass — and eventually loses it once the drift exceeds the
      // search window.
      if (res.state === "moved") moved = true;
      bm.state = res.state;
      if (!res.range) return;
      ranges.set(bm.id, res.range);
      if (hl) hl.add(res.range);
    });

    syncMarks();
    reflow();
    if (moved) save();
  }

  // Scrolling doesn't invalidate a resolved Range — the text nodes are the same
  // — so it only needs the markers repositioned, not a full re-resolve.
  var flowQueued = false;
  function scheduleFlow() {
    if (flowQueued) return;
    flowQueued = true;
    requestAnimationFrame(function () {
      flowQueued = false;
      reflow();
    });
  }

  /**
   * Put every marker beside the first line of the text it marks. The left
   * margin is measured rather than computed from claude.ai's Tailwind classes:
   * the sidebar is user-resizable, so only the live rects tell the truth.
   */
  function reflow() {
    var sc = A.scroller();
    var l = A.layout();
    if (!sc || !l || !bookmarks.size) {
      if (layer) layer.hidden = true;
      return;
    }
    ensureLayer().hidden = false;

    var sr = sc.getBoundingClientRect();
    // Sit in the margin, but never off the left edge of the transcript — on a
    // narrow window the margin collapses and the marker would otherwise end up
    // under the sidebar, or off-screen entirely.
    var x = Math.max(sr.left + 2, sr.left + l.left - MARK - GAP);

    marks.forEach(function (el, id) {
      var range = ranges.get(id);
      var rect = range && range.getClientRects()[0]; // first line of the quote
      // A marker with nowhere to point: the message is unmounted (dormant), or
      // its line has scrolled out of the transcript viewport, where the marker
      // would otherwise float over the header or the composer.
      if (!rect || rect.bottom < sr.top + 4 || rect.top > sr.bottom - 4) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.style.left = x + "px";
      el.style.top = rect.top + rect.height / 2 - MARK / 2 + "px";
    });
  }

  // ---------- add / remove ----------

  /** Same passage? Compare the resolved position and the text at it. */
  function sameSpot(a, b) {
    return (
      a.msgIndex === b.msgIndex &&
      a.start === b.start &&
      a.end === b.end &&
      a.quote === b.quote
    );
  }

  function findAt(anchor) {
    var hit = null;
    bookmarks.forEach(function (bm) {
      if (!hit && sameSpot(bm.anchor, anchor)) hit = bm.id;
    });
    return hit;
  }

  function remove(id) {
    if (!bookmarks.delete(id)) return;
    save();
    repaint();
  }

  /** Bookmarking the exact passage twice clears it, the way a margin click does. */
  function toggle(anchor) {
    var existing = findAt(anchor);
    if (existing) {
      remove(existing);
      return;
    }
    var bm = { id: "b" + ++seq, anchor: anchor, state: "exact" };
    bookmarks.set(bm.id, bm);
    save();
    repaint();
  }

  // ---------- Bookmark, inside claude.ai's own selection tooltip ----------
  // See A.onSelectionTooltip for why this has to be idempotent and re-runnable.

  function injectBookmark() {
    var tip = document.querySelector(A.TOOLTIP);
    if (!tip) return;
    // Test for the button, not a marker flag: React can re-render the inner row
    // while keeping the outer tooltip node, which would leave a stale flag
    // claiming we're injected when the button is already gone.
    if (tip.querySelector("[data-cpp-bookmark]")) return;

    var reply = tip.querySelector("button");
    var row = reply && reply.parentElement;
    if (!row) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = reply.className; // inherit claude.ai's tooltip button styling
    btn.dataset.cppBookmark = "1";
    btn.append("Bookmark");
    btn.appendChild(ctx.util.icon(ctx.util.ICON.BOOKMARK));

    // mousedown would collapse the selection before we can describe it.
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !A.isSettled(sel.anchorNode)) return;
      var anchor = A.describe(sel);
      if (!anchor) return;
      toggle(anchor);
      sel.removeAllRanges(); // the highlight now stands in for the selection
    });

    // Sit immediately after Ask when the asides feature is on, so the row reads
    // Ask | Bookmark | Reply however the two features' passes interleave.
    // Either can be disabled, so neither may assume the other put anything in.
    var ask = tip.querySelector("[data-cpa-ask]");
    if (ask) {
      ask.insertAdjacentElement("afterend", btn);
      return;
    }
    var rule = document.createElement("div");
    rule.className = "cpp-bm-rule";
    row.prepend(rule);
    row.prepend(btn);
  }

  // ---------- lifecycle ----------

  var lastConvo = null;
  var unsubTooltip = null;

  function onScrollOrResize() {
    scheduleFlow();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "bookmarks",

    onInit: function (context) {
      ctx = context;
      if (!HAS_HIGHLIGHT) {
        console.warn("[cpp] CSS Custom Highlight API unavailable; bookmarks won't be marked");
      }
      registerHighlight();

      unsubTooltip = A.onSelectionTooltip(injectBookmark);
      window.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize);

      lastConvo = convoId();
      load(lastConvo);
    },

    // Core calls this (debounced) on DOM mutations and SPA navigation: keep
    // Bookmark in the tooltip, reload on a chat switch, and re-resolve anchors
    // against whatever the virtualizer has mounted now.
    onApply: function () {
      var now = convoId();
      if (now !== lastConvo) {
        lastConvo = now;
        load(now);
        return;
      }
      injectBookmark();
      if (bookmarks.size) repaint();
    },

    // Core calls this when claude.ai deletes a chat (directly, or as one of a
    // deleted project's chats — core fans those out as chat deletes). Drop the
    // per-chat storage key. Project-kind deletes are ignored: bookmarks have no
    // project concept, and member chats arrive as their own chat deletes.
    onDelete: function (info) {
      if (!info || info.kind !== "chat" || !ctx) return;
      ctx.util.remove(storeKey(info.id));
      // If the deleted chat is somehow the one on screen, drop the live state
      // too so its markers don't linger until the next reload.
      if (info.id === convoId()) {
        bookmarks.clear();
        repaint();
      }
    },

    onTeardown: function () {
      if (unsubTooltip) { unsubTooltip(); unsubTooltip = null; }
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);

      // Remove anything we grafted into claude.ai's own tooltip.
      var stray = document.querySelectorAll("[data-cpp-bookmark], .cpp-bm-rule");
      for (var i = 0; i < stray.length; i++) stray[i].remove();

      if (hl) hl.clear();
      if (HAS_HIGHLIGHT && highlightRegistered) {
        CSS.highlights.delete("cpp-bookmark");
        highlightRegistered = false;
      }

      marks.clear();
      if (layer) { layer.remove(); layer = null; }

      bookmarks.clear();
      ranges.clear();
      lastConvo = null;
    }
  });
})();
