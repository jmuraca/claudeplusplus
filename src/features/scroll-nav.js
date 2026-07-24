// Feature: Scroll navigation buttons
//
// A small vertical toolbar pinned to the bottom-right of the transcript, beside
// the scrollbar, with four jumps for getting around a long conversation quickly:
//
//   ⤒  jump to the top / start of the chat
//   ↑  jump to the previous message you wrote   (Alt+↑)
//   ↓  jump to the next message you wrote       (Alt+↓)
//   ⤓  jump to the most recent message (bottom)
//
// "Messages you wrote" are the user turns. claude.ai's transcript is virtualized
// (only a window of turns around the viewport is mounted), so we can't enumerate
// every user turn from the DOM. Two facts make navigation reliable anyway:
//
//   1. Turns strictly alternate — one user turn, one assistant turn — and each
//      turn is a single [data-rs-index] element. So user turns sit two indices
//      apart, and the very first turn (index 0) is always the human's. When the
//      neighbouring user turn is mounted we use its exact index; otherwise we
//      step by two, which the alternation guarantees is correct.
//   2. Any turn can be reached by index even while unmounted: jump to an
//      estimate, let the virtualizer mount whatever lands there, re-measure, and
//      converge — the same trick the asides feature uses to seek an anchor.
//
// The toolbar lives on <body> (position:fixed), outside React's tree, so
// claude.ai re-renders never wipe it. It's shown only while a scrollable
// conversation feed is present.
//
// Note: the user-turn selector keys off claude.ai's data-testid, so — like the
// other Claude++ features — prev/next is effectively English-DOM-bound. If that
// testid ever changes, top/bottom keep working and prev/next simply no-op.
(function () {
  "use strict";

  var SCROLLER = '[data-autoscroll-container="true"]';
  var FEED = '[role="feed"]';
  var ARTICLE = "[data-rs-index]";
  var USER_MSG = '[data-testid="user-message"]';

  var TOP_OFFSET = 12; // px of breathing room above a message we land on
  var Z = 2147482990; // just under the asides popover layer

  // Icons are Anthropicons glyphs (see CPP.util.ICON). The far-jump pair reads
  // as an arrow travelling into a bar, the step pair as a bare chevron — the
  // bar is what distinguishes "go to the end" from "go one more". The font
  // only ships that arrow-into-bar horizontally, so both are rotated upright:
  // "|←" turned 90° clockwise points up into its bar, "→|" points down into
  // its bar.
  var BTNS = [
    { key: "top", label: "Jump to start of chat", act: goTop,
      cp: "ARROW_BAR_LEFT", rotate: 90 },
    { key: "prev", label: "Previous message you wrote (Alt+↑)", act: goPrevUser,
      cp: "CHEVRON_UP" },
    { key: "next", label: "Next message you wrote (Alt+↓)", act: goNextUser,
      cp: "CHEVRON_DOWN" },
    { key: "bottom", label: "Jump to most recent", act: goBottom,
      cp: "ARROW_BAR_RIGHT", rotate: 90 }
  ];

  var bar = null; // toolbar element
  var boundScroller = null; // scroller we've attached the scroll listener to
  var started = false;

  // ---------- DOM helpers ----------

  function scrollerEl() {
    return document.querySelector(SCROLLER);
  }

  function articleFor(idx) {
    return document.querySelector('[data-rs-index="' + idx + '"]');
  }

  function mountedArticles() {
    return Array.prototype.slice.call(document.querySelectorAll(ARTICLE));
  }

  function isUserArticle(a) {
    return !!a.querySelector(USER_MSG);
  }

  // lo/hi index range currently mounted, for the seek estimator.
  function mountedRange() {
    var els = mountedArticles();
    if (!els.length) return null;
    var idx = els
      .map(function (e) { return +e.dataset.rsIndex; })
      .sort(function (a, b) { return a - b; });
    return { lo: idx[0], hi: idx[idx.length - 1] };
  }

  // ---------- which user turn are we "on"? ----------
  // The current user turn is the last one whose top edge sits at or above the
  // anchor line — the same line seekToTop parks a message on (TOP_OFFSET below
  // the viewport top). Using that line, not the raw viewport top, is what makes
  // "next" advance off a turn we just landed on rather than treating it as still
  // ahead of us. Returns null when the view sits above the first user turn.
  function currentUserIndex() {
    var sc = scrollerEl();
    if (!sc) return null;
    var anchorY = sc.getBoundingClientRect().top + TOP_OFFSET + 4;
    var best = null;
    mountedArticles().forEach(function (a) {
      if (!isUserArticle(a)) return;
      var top = a.getBoundingClientRect().top;
      if (top <= anchorY) {
        var idx = +a.dataset.rsIndex;
        if (best === null || idx > best) best = idx;
      }
    });
    return best;
  }

  // Mounted user-turn indices, ascending — used to prefer an exact neighbour
  // over the alternation-based step of two.
  function mountedUserIndices() {
    return mountedArticles()
      .filter(isUserArticle)
      .map(function (a) { return +a.dataset.rsIndex; })
      .sort(function (a, b) { return a - b; });
  }

  // ---------- seeking ----------

  // Align turn `idx` near the top of the viewport. If it's already mounted we
  // scroll straight to it; otherwise we estimate its position from the mounted
  // rows, jump, let the virtualizer mount what lands there, and converge.
  function seekToTop(idx, smooth, tries) {
    var sc = scrollerEl();
    if (!sc) return;
    if (tries === undefined) tries = 14;

    function align(el) {
      var scRect = sc.getBoundingClientRect();
      var target = sc.scrollTop + (el.getBoundingClientRect().top - scRect.top) - TOP_OFFSET;
      sc.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
    }

    function step() {
      var el = articleFor(idx);
      if (el) { align(el); return; }
      if (--tries <= 0) return;

      var m = mountedRange();
      var first = m && articleFor(m.lo);
      var last = m && articleFor(m.hi);
      if (!first || !last || m.hi === m.lo) return;

      var fr = first.getBoundingClientRect();
      var lr = last.getBoundingClientRect();
      var sr = sc.getBoundingClientRect();
      var avg = Math.max(1, (lr.bottom - fr.top) / (m.hi - m.lo + 1));

      var before = sc.scrollTop;
      sc.scrollTop += fr.top - sr.top + (idx - m.lo) * avg - TOP_OFFSET;
      if (Math.abs(sc.scrollTop - before) < 1) return;
      requestAnimationFrame(step);
    }

    step();
  }

  // ---------- actions ----------

  function goTop() {
    var sc = scrollerEl();
    if (sc) sc.scrollTo({ top: 0, behavior: "auto" });
  }

  function goBottom() {
    var sc = scrollerEl();
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: "auto" });
  }

  function goPrevUser() {
    var cur = currentUserIndex();
    if (cur === null) { goTop(); return; } // already above the first question
    var mounted = mountedUserIndices();
    var target = null;
    for (var i = mounted.length - 1; i >= 0; i--) {
      if (mounted[i] < cur) { target = mounted[i]; break; }
    }
    if (target === null) target = cur - 2; // alternation: previous user turn
    if (target < 0) { goTop(); return; }
    seekToTop(target, true);
  }

  function goNextUser() {
    var cur = currentUserIndex();
    var target = null;
    var mounted = mountedUserIndices();
    if (cur === null) {
      target = mounted.length ? mounted[0] : 0; // first question
    } else {
      for (var i = 0; i < mounted.length; i++) {
        if (mounted[i] > cur) { target = mounted[i]; break; }
      }
      if (target === null) target = cur + 2; // alternation: next user turn
    }
    seekToTop(target, true);
  }

  // ---------- keyboard ----------
  // Alt+↑ / Alt+↓ mirror the prev/next buttons — the up/down chevrons made
  // literal. Bare Alt only (any other modifier is left for the browser/app), and
  // only while a conversation scroller is present so the combo is inert
  // elsewhere. Alt+Arrow isn't a cursor motion in claude's editor, so this is
  // safe to run even while the composer is focused.
  function onKeydown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!scrollerEl()) return;
    e.preventDefault();
    if (e.key === "ArrowUp") goPrevUser();
    else goNextUser();
  }

  // ---------- toolbar ----------

  function buildBar() {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "cpp-scrollnav";
    bar.style.zIndex = String(Z);
    BTNS.forEach(function (b) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "cpp-scrollnav-btn cpp-scrollnav-" + b.key;
      el.title = b.label;
      el.setAttribute("aria-label", b.label);
      el.appendChild(CPP.util.icon(CPP.util.ICON[b.cp], b.rotate));
      el.addEventListener("click", function (e) {
        e.preventDefault();
        b.act();
      });
      bar.appendChild(el);
      b.el = el;
    });
    document.body.appendChild(bar);
  }

  function removeBar() {
    if (!bar) return;
    bar.remove();
    bar = null;
    BTNS.forEach(function (b) { b.el = null; });
  }

  // Grey out top/prev at the very top and bottom/next at the very bottom.
  function refreshDisabled() {
    if (!bar) return;
    var sc = scrollerEl();
    if (!sc) return;
    var atTop = sc.scrollTop <= 2;
    var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    BTNS.forEach(function (b) {
      if (!b.el) return;
      var off = (atTop && (b.key === "top" || b.key === "prev")) ||
                (atBottom && (b.key === "bottom" || b.key === "next"));
      b.el.disabled = off;
    });
  }

  function onScroll() {
    refreshDisabled();
  }

  function bindScroller() {
    var sc = scrollerEl();
    if (sc === boundScroller) return;
    if (boundScroller) boundScroller.removeEventListener("scroll", onScroll);
    boundScroller = sc;
    if (sc) sc.addEventListener("scroll", onScroll, { passive: true });
  }

  // Show the toolbar only when there's a scrollable conversation to navigate.
  function sync() {
    var sc = scrollerEl();
    var feed = document.querySelector(FEED);
    var scrollable = sc && feed && sc.scrollHeight > sc.clientHeight + 40;
    if (scrollable) {
      buildBar();
      bindScroller();
      refreshDisabled();
    } else {
      removeBar();
    }
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "scroll-nav",

    onInit: function () {
      started = true;
      window.addEventListener("keydown", onKeydown, true);
      sync();
    },

    // Core calls this (debounced) on DOM churn and SPA navigation.
    onApply: function () {
      if (!started) return;
      sync();
    },

    onTeardown: function () {
      started = false;
      window.removeEventListener("keydown", onKeydown, true);
      if (boundScroller) {
        boundScroller.removeEventListener("scroll", onScroll);
        boundScroller = null;
      }
      removeBar();
    }
  });
})();
