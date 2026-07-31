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
  var MOUNT_WAIT = 48; // ms a jump first waits on the virtualizer, then backs off
  var MAX_PASSES = 18; // converging passes before a jump gives up and goes back
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
  var seekId = 0; // bumps on every jump so an in-flight seek stops stepping
  var seeking = null; // the turn a jump is converging on, while it converges

  // ---------- DOM helpers ----------
  // Every [data-rs-index] lookup is scoped to the feed. The index is a position
  // in one virtualized list, so a row from any other list on the page — and
  // claude.ai virtualizes more than the transcript — is a different list's row
  // wearing the same number.

  function scrollerEl() {
    return document.querySelector(SCROLLER);
  }

  function feedEl() {
    return document.querySelector(FEED);
  }

  // A turn the virtualizer has retired but kept in the tree — and one it has
  // just mounted but not yet placed — still answers a query, while reporting an
  // empty box at the origin. Counted as present it reads as a turn sitting at
  // the very top of the transcript, so a row we can't measure counts as not
  // there at all: unmounted is exactly what it is, and the seek below already
  // knows how to reach an unmounted turn.
  function boxOf(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  function articleFor(idx) {
    var feed = feedEl();
    var el = feed && feed.querySelector('[data-rs-index="' + idx + '"]');
    return boxOf(el) ? el : null;
  }

  function mountedArticles() {
    var feed = feedEl();
    if (!feed) return [];
    return Array.prototype.filter.call(feed.querySelectorAll(ARTICLE), boxOf);
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
  //
  // "Last" is decided by where the turns actually sit, not by their index: a row
  // the virtualizer has just mounted but not yet placed reads as sitting at the
  // very top of the list, and picking it by index would hand back a turn from
  // far down the chat as the one we're on — which then sends next/prev off to
  // wherever that turn lives.
  function currentUserIndex() {
    var sc = scrollerEl();
    if (!sc) return null;
    var anchorY = sc.getBoundingClientRect().top + TOP_OFFSET + 4;
    var best = null;
    mountedArticles().forEach(function (a) {
      if (!isUserArticle(a)) return;
      var top = boxOf(a).top;
      if (top > anchorY) return;
      if (best === null || top > best.top) best = { top: top, idx: +a.dataset.rsIndex };
    });
    return best === null ? null : best.idx;
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
  // scroll straight to it; otherwise we jump to an estimate of where it is, let
  // the virtualizer mount whatever lands there, and converge.
  //
  // An estimate is an average row height taken across the mounted window, and
  // one long answer in that window makes it a bad predictor of the short turns
  // below — a single pass can overshoot the rest of the transcript, where the
  // scroller clamps at the bottom. So the loop also keeps a bracket of the
  // scroll positions the turn can still be at, and every pass narrows it: the
  // mounted window is a contiguous run of turns around the viewport, so a window
  // sitting entirely above the turn we want proves the turn is further down than
  // here, and one entirely below proves it is further up. An estimate outside
  // the bracket is replaced by the bracket's midpoint, which halves the search
  // rather than trusting an average that has already been wrong once.
  //
  // What the bracket must not be narrowed by is a window measured before the
  // virtualizer has caught up with the last jump: those are the old rows in
  // their new positions — still contiguous, still numbered, and now nowhere near
  // the viewport. Believed, they rule out the very ground the turn is standing
  // on. A window that doesn't touch the viewport is not evidence, so the pass
  // waits for the next one instead. Waiting is also all a slow mount costs:
  // passes back off rather than reading a re-render that hasn't happened yet as
  // proof that the turn can't be reached.
  //
  // A seek that runs out of passes puts the reader back where they started. The
  // one exception is a bracket that closes on nothing while we're pinned against
  // the end the missing turn would be past — pressing "next" on the last message
  // belongs at the bottom, and "prev" on the first belongs at the top.
  function seekToTop(idx) {
    var sc = scrollerEl();
    if (!sc) return;

    var mine = ++seekId;
    var origin = sc.scrollTop;
    // The bracket holds what the passes have proved, not how tall the transcript
    // is: a virtualized list only knows the height of what it has measured, so
    // the end of it moves as rows mount. The live end is applied on top, each
    // pass, as a limit on where we can actually scroll.
    var lo = 0; // nearest scroll position the turn can still be at
    var hi = Infinity; // furthest
    var pass = 0;

    seeking = { id: mine, idx: idx };

    function done() {
      if (seeking && seeking.id === mine) seeking = null;
    }

    function align(el) {
      var scRect = sc.getBoundingClientRect();
      var target = sc.scrollTop + (el.getBoundingClientRect().top - scRect.top) - TOP_OFFSET;
      sc.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      done();
    }

    // The mounted window, measured, but only while it's the window belonging to
    // where we are now — see above.
    function placed(m) {
      var first = articleFor(m.lo);
      var last = articleFor(m.hi);
      if (!first || !last) return null;
      var fr = first.getBoundingClientRect();
      var lr = last.getBoundingClientRect();
      var sr = sc.getBoundingClientRect();
      if (lr.bottom < sr.top || fr.top > sr.bottom) return null;
      return { fr: fr, lr: lr, sr: sr };
    }

    function estimate(m, w) {
      var avg = Math.max(1, (w.lr.bottom - w.fr.top) / (m.hi - m.lo + 1));
      return sc.scrollTop + (w.fr.top - w.sr.top) + (idx - m.lo) * avg - TOP_OFFSET;
    }

    function noSuchTurn(below) {
      // Only the end the turn would be past counts: overshooting to the bottom
      // while hunting a turn behind us is a bad estimate, not the end of the
      // chat, and leaving the reader there is the whole complaint.
      var atEnd = below
        ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1
        : sc.scrollTop <= 1;
      if (!atEnd) sc.scrollTop = origin;
      done();
    }

    function step() {
      if (mine !== seekId) return; // a newer jump took over
      var el = articleFor(idx);
      if (el) { align(el); return; }
      if (++pass > MAX_PASSES) { sc.scrollTop = origin; done(); return; }

      var m = mountedRange();
      var w = m && placed(m);
      if (w && (idx > m.hi || idx < m.lo)) {
        var below = idx > m.hi;
        var here = sc.scrollTop;
        if (below) lo = Math.max(lo, here + 1);
        else hi = Math.min(hi, here - 1);

        // The bracket, as far as the scroller can currently be scrolled. Nothing
        // left inside it means no scroll position shows that turn at the top.
        var near = lo;
        var far = Math.min(hi, Math.max(0, sc.scrollHeight - sc.clientHeight));
        if (near > far) { noSuchTurn(below); return; }

        // Either edge is on the far side of where we are, so a position inside
        // the bracket is always a move in the right direction.
        var next = estimate(m, w);
        if (next < near || next > far) next = (near + far) / 2;
        sc.scrollTop = next;
      }

      setTimeout(step, Math.min(MOUNT_WAIT * 5, MOUNT_WAIT + 16 * pass));
    }

    step();
  }

  // ---------- actions ----------

  // The two far jumps also stop any seek still converging, so a slow one can't
  // haul the reader back off the end they just asked for.
  function goTop() {
    var sc = scrollerEl();
    seekId++;
    seeking = null;
    if (sc) sc.scrollTo({ top: 0, behavior: "auto" });
  }

  function goBottom() {
    var sc = scrollerEl();
    seekId++;
    seeking = null;
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: "auto" });
  }

  // Which turn a step starts from. Held keys and quick repeats arrive while the
  // last jump is still converging, and the transcript is then parked partway
  // between turns — reading the view would step from wherever that happens to
  // be, so a press mid-jump steps on from the turn the jump is heading to.
  //
  // Only a turn read from the view has the mounted window around it, so that's
  // also what says whether the exact neighbour is there to be used: mid-jump the
  // window is around the ground the search is crossing, where the nearest user
  // turn is no relation of the one we're stepping from.
  function stepFrom() {
    if (seeking) return { idx: seeking.idx, live: false };
    return { idx: currentUserIndex(), live: true };
  }

  function goPrevUser() {
    var from = stepFrom();
    var cur = from.idx;
    if (cur === null) { goTop(); return; } // already above the first question
    var mounted = from.live ? mountedUserIndices() : [];
    var target = null;
    for (var i = mounted.length - 1; i >= 0; i--) {
      if (mounted[i] < cur) { target = mounted[i]; break; }
    }
    if (target === null) target = cur - 2; // alternation: previous user turn
    if (target < 0) { goTop(); return; }
    seekToTop(target);
  }

  function goNextUser() {
    var from = stepFrom();
    var cur = from.idx;
    var target = null;
    var mounted = from.live ? mountedUserIndices() : [];
    if (cur === null) {
      target = mounted.length ? mounted[0] : 0; // first question
    } else {
      for (var i = 0; i < mounted.length; i++) {
        if (mounted[i] > cur) { target = mounted[i]; break; }
      }
      if (target === null) target = cur + 2; // alternation: next user turn
    }
    seekToTop(target);
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
      seekId++; // strand any seek still converging
      seeking = null;
      window.removeEventListener("keydown", onKeydown, true);
      if (boundScroller) {
        boundScroller.removeEventListener("scroll", onScroll);
        boundScroller = null;
      }
      removeBar();
    }
  });
})();
