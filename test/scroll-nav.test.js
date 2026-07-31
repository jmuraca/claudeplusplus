// Tests for src/features/scroll-nav.js — prev/next through the messages you
// wrote (Alt+↑ / Alt+↓ and the toolbar's chevrons).
//
// The feature is pure geometry over someone else's virtualized list, so the
// harness below is a stand-in for that list rather than a snapshot of markup:
// turn heights, a scroller with a real scrollTop, and rects computed from both.
// Three of its behaviours are the ones the feature has to survive, and all three
// are what claude.ai's transcript actually does:
//
//   * only a window of turns around the viewport is in the tree, so the turn you
//     are jumping to usually isn't there yet when you press the key;
//   * mounting the window that a jump landed in takes a beat, not a frame —
//     re-measuring too early sees the old rows in their new positions;
//   * a turn scrolled out of the window is left in the tree, still carrying its
//     data-rs-index and now measuring 0×0 at the origin. A chat you have read to
//     the bottom and then jumped back to the top of leaves a pile of these,
//     every one of them numbered higher than the turn you are actually on.
//
// That last one is the trap: read as real, the highest of those numbers is "the
// message you're on", and the next jump goes wherever that turn lives — the end
// of the chat.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadFeature } = require("./cpp");

const VIEW = 800; // scroller height
const OVERSCAN = 200; // px kept mounted either side of the viewport
const MOUNT_MS = 30; // how long the virtualizer takes to mount a new window
const TOP_OFFSET = 12; // the feature parks a turn this far below the top edge

// A transcript with one answer far longer than the rest — a long code dump among
// short replies. The average row height of whatever is mounted around such a
// turn says nothing about the turns past it, which is what a jump to an unmounted
// turn has to estimate from.
function lopsided(turns, monster) {
  return Array.from({ length: turns }, function (_, i) {
    if (i % 2 === 0) return 90;
    return i === monster ? 40000 : 400;
  });
}

// Even indices are the turns you wrote. The long second turn is what a real
// chat looks like — one question, one very long answer — and it puts the turn
// after it well outside the first mounted window.
function heights(turns) {
  return Array.from({ length: turns }, function (_, i) {
    if (i % 2 === 0) return 90; // a question
    return i === 1 ? 3000 : 600; // an answer
  });
}

function rect(top, height, width) {
  return {
    top: top, bottom: top + height, height: height,
    left: 0, right: width, width: width, x: 0, y: top
  };
}

// A page holding the transcript, plus — when `sidebar` is set — a second
// virtualized list whose rows carry the same data-rs-index numbering the
// transcript uses.
function page(sidebar) {
  return (
    (sidebar
      ? '<nav id="sidebar">' +
        Array.from({ length: 12 }, function (_, i) {
          return '<div data-rs-index="' + i + '">recent chat ' + i + "</div>";
        }).join("") +
        "</nav>"
      : "") +
    '<div data-autoscroll-container="true"><div role="feed"></div></div>'
  );
}

function harness(opts) {
  const o = opts || {};
  const h = o.heights || heights(o.turns || 40);
  const mountMs = o.mountMs || MOUNT_MS;
  const offsets = [];
  let total = 0;
  h.forEach(function (height) { offsets.push(total); total += height; });
  const maxScroll = Math.max(0, total - VIEW);

  const dom = new JSDOM("<body>" + page(o.sidebar) + "</body>", {
    url: "https://claude.ai/chat/x",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;

  const sc = document.querySelector('[data-autoscroll-container="true"]');
  const feed = document.querySelector('[role="feed"]');

  let scrollTop = 0;
  let timer = null;

  Object.defineProperty(sc, "clientHeight", { get: function () { return VIEW; } });
  Object.defineProperty(sc, "scrollHeight", { get: function () { return total; } });
  Object.defineProperty(sc, "scrollTop", {
    get: function () { return scrollTop; },
    set: function (v) {
      scrollTop = Math.max(0, Math.min(maxScroll, Number(v) || 0));
      // A browser reports the scroll and the virtualizer reacts to it, both
      // after the fact — the toolbar's greyed-out states ride on that event.
      // Scrolling again while a render is pending doesn't restart it, it only
      // changes what that render will find: mounting costs what it costs, and a
      // jump made in the middle of one doesn't buy the reader a faster one.
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        sc.dispatchEvent(new window.Event("scroll"));
        remount();
      }, mountMs);
    }
  });
  sc.scrollTo = function (arg) { sc.scrollTop = (arg && arg.top) || 0; };
  sc.getBoundingClientRect = function () { return rect(0, VIEW, 900); };
  feed.getBoundingClientRect = function () { return rect(-scrollTop, total, 700); };

  // Rows are never removed once mounted, only retired — see the header note.
  const rows = new Map();

  function mount(i) {
    let row = rows.get(i);
    if (!row) {
      const el = document.createElement("div");
      el.setAttribute("data-rs-index", String(i));
      if (i % 2 === 0) {
        const msg = document.createElement("div");
        msg.setAttribute("data-testid", "user-message");
        msg.textContent = "message " + i;
        el.appendChild(msg);
      }
      el.getBoundingClientRect = function () {
        return rows.get(i).retired ? rect(0, 0, 0) : rect(offsets[i] - scrollTop, h[i], 700);
      };
      feed.appendChild(el);
      row = { el: el, retired: false };
      rows.set(i, row);
    }
    row.retired = false;
  }

  function inWindow(i) {
    return offsets[i] < scrollTop + VIEW + OVERSCAN && offsets[i] + h[i] > scrollTop - OVERSCAN;
  }

  function remount() {
    rows.forEach(function (row, i) { row.retired = !inWindow(i); });
    for (let i = 0; i < h.length; i++) if (inWindow(i)) mount(i);
  }

  remount();

  if (o.sidebar) {
    document.querySelectorAll("#sidebar [data-rs-index]").forEach(function (el, i) {
      el.getBoundingClientRect = function () { return rect(60 + i * 40, 40, 260); };
    });
  }

  const feature = loadFeature(window, "features/scroll-nav.js");
  feature.onInit();

  const press = function (key) {
    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: key, altKey: true, bubbles: true, cancelable: true })
    );
  };

  // Which turn the transcript is parked on: the one sitting on the line the
  // feature aligns to. Null while the view sits between turns. The first turn is
  // the exception the line can't hold — parking it would want a scrollTop of
  // -TOP_OFFSET, and the scroller stops at 0 — so at the top of the chat the
  // clamped position is what being parked on it looks like.
  const parked = function () {
    for (let i = 0; i < h.length; i++) {
      if (Math.abs(Math.max(0, offsets[i] - TOP_OFFSET) - scrollTop) <= 2) return i;
    }
    return null;
  };

  const scrollTo = function (top) {
    sc.scrollTop = top;
    sc.dispatchEvent(new window.Event("scroll"));
    remount();
  };

  // A jump converges over several passes, each waiting on the virtualizer, so
  // wait for the scroller to hold still rather than for a fixed number of them.
  // A pass waits longer the longer mounting is taking, so what counts as still
  // has to outlast that.
  const settle = async function () {
    const tick = Math.max(40, mountMs);
    let last = null;
    let still = 0;
    for (let i = 0; i < 80 && still < 4; i++) {
      await new Promise(function (r) { setTimeout(r, tick); });
      if (sc.scrollTop === last) still++;
      else { still = 0; last = sc.scrollTop; }
    }
  };

  const step = async function (key) { press(key); await settle(); };

  return {
    window, document, feature, sc, feed, rows, offsets, total, maxScroll,
    press, step, settle, parked, scrollTo,
    top: function () { return sc.scrollTop; },
    button: function (key) { return document.querySelector(".cpp-scrollnav-" + key); }
  };
}

test("Alt+↓ walks one message at a time, fetching turns the virtualizer hasn't mounted", async () => {
  const h = harness();
  assert.equal(h.rows.has(2), false, "the second question starts outside the window");

  for (const expected of [2, 4, 6, 8, 10]) {
    await h.step("ArrowDown");
    assert.equal(h.parked(), expected);
  }
});

test("Alt+↑ walks back the same way", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.step("ArrowDown");
  assert.equal(h.parked(), 10);

  for (const expected of [8, 6, 4, 2]) {
    await h.step("ArrowUp");
    assert.equal(h.parked(), expected);
  }
});

// The reported bug, in the order it was hit: read to the end of a long chat,
// jump back to the start, then step down. Every turn the virtualizer retired on
// the way back is still in the tree wearing a number from the end of the chat,
// and taking those at face value sent the second press to the last message.
test("turns left in the tree from the bottom of the chat don't hijack the next jump", async () => {
  const h = harness();

  h.scrollTo(h.maxScroll);
  h.button("top").click();
  await h.settle();
  assert.equal(h.top(), 0, "the top button lands at the start of the chat");

  const stranded = [];
  h.rows.forEach(function (row, i) { if (row.retired) stranded.push(i); });
  assert.ok(
    stranded.some(function (i) { return i > 20; }),
    "the virtualizer left the last turns it showed in the tree"
  );

  await h.step("ArrowDown");
  assert.equal(h.parked(), 2, "next goes to the second question, not to the end of the chat");

  await h.step("ArrowDown");
  assert.equal(h.parked(), 4);
});

test("another virtualized list on the page isn't read as part of the transcript", async () => {
  const h = harness({ sidebar: true });

  await h.step("ArrowDown");
  assert.equal(h.parked(), 2, "the sidebar's row 2 is not the transcript's turn 2");

  await h.step("ArrowDown");
  assert.equal(h.parked(), 4);
});

test("next on the last message you wrote settles at the end of the chat", async () => {
  const h = harness({ turns: 12 });

  for (let i = 0; i < 8; i++) await h.step("ArrowDown");
  assert.equal(h.top(), h.maxScroll, "the chat ends here and the view stays there");
});

// The reported bug the second time: from the top of a long chat, a few presses
// walk one question at a time and then a press lands at the end of the chat and
// stays there. Mounting a window of a real transcript — markdown, code blocks,
// highlighting — takes longer than a couple of frames, and a jump that reads the
// window before it has been rebuilt sees the turns it was already looking at, in
// their new positions. That is not the transcript running out of turns, but it
// used to be read as one, and the reader was left wherever the jump had
// overshot to: the bottom.
test("a virtualizer that takes its time to mount doesn't end the walk", async () => {
  const h = harness({ mountMs: 260 });

  for (const expected of [2, 4, 6, 8, 10, 12]) {
    await h.step("ArrowDown");
    assert.equal(h.parked(), expected);
    assert.notEqual(h.top(), h.maxScroll, "the walk never runs off the end of the chat");
  }
});

// One very long answer among short ones makes the average row height around it a
// wild over-estimate of what lies below, so the jump that follows it overshoots
// the whole transcript and the scroller clamps at the bottom. Landing there is
// evidence about the estimate, not about the turn: the turn is still where it
// always was, above.
test("a jump that overshoots the whole transcript still finds its turn", async () => {
  const h = harness({ heights: lopsided(40, 5), mountMs: 120 });

  for (const expected of [2, 4, 6, 8, 10]) {
    await h.step("ArrowDown");
    assert.equal(h.parked(), expected);
  }
});

// Alt+↓ held down, or pressed as fast as you can read: each press arrives while
// the last jump is still converging, with the transcript parked between turns.
test("presses that arrive mid-jump keep their place in the walk", async () => {
  const h = harness({ heights: lopsided(40, 5), mountMs: 120 });

  for (let i = 0; i < 5; i++) {
    h.press("ArrowDown");
    await new Promise(function (r) { setTimeout(r, 60); }); // still mid-jump
  }
  await h.settle();
  assert.equal(h.parked(), 10, "five presses walk five questions, not more or fewer");
});

test("prev from the first message you wrote goes to the start", async () => {
  const h = harness();
  await h.step("ArrowDown");
  assert.equal(h.parked(), 2);

  await h.step("ArrowUp");
  assert.equal(h.parked(), 0);

  await h.step("ArrowUp");
  assert.equal(h.top(), 0);
});
