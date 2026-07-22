// Feature: Inline asides
//
// Select any passage in a claude.ai conversation, ask a question about it, and
// the answer streams into a card in the right margin — anchored to the text, the
// way a comment is anchored in Google Docs or Word.
//
// This is a port of the standalone reference implementation into Claude++'s
// feature lifecycle. The engine (anchoring, cards, streaming) is unchanged; what
// differs is the wiring:
//   • all setup happens in onInit and is fully undone in onTeardown, so the
//     feature toggle works and a context invalidation goes quiet cleanly;
//   • DOM-churn re-resolution rides core's debounced onApply instead of a
//     private MutationObserver;
//   • storage goes through ctx.util.get/set (which no-op once the extension
//     context is gone) rather than chrome.storage.local directly;
//   • the current chat id comes from ctx.util.CHAT_RE.
//
// Two facts about claude.ai's transcript drive the engine:
//   1. The message list is virtualized ([data-rocksteady-sizer] + one tall
//      spacer), so an anchor is not a Range — a Range holds live text nodes and
//      collapses the moment React unmounts or re-renders them. We store offsets
//      plus the quoted text and re-resolve on demand.
//   2. Layout is class-churn city, but structure is stable: .standard-markdown
//      is the message body, [data-rs-index] is the only per-message id, and
//      data-is-streaming says when a message has settled.
//
// Painting goes through the CSS Custom Highlight API rather than wrapping text in
// <mark>: inserting nodes into React-owned DOM gets them discarded on the next
// render, whereas a Highlight decorates Ranges without touching the tree.
(function () {
  "use strict";

  var MD = ".standard-markdown";
  var FEED = '[role="feed"]';
  var SCROLLER = '[data-autoscroll-container="true"]';
  var TOOLTIP = '[data-selection-tooltip="true"]';
  var CTX = 30; // chars of prefix/suffix kept to disambiguate repeat quotes

  var HAS_HIGHLIGHT = typeof CSS !== "undefined" && "highlights" in CSS;

  // Set in onInit; used by storage helpers and convoId.
  var ctx = null;

  /**
   * Live asides for the current conversation.
   * @type {Map<string, {id: string, anchor: object, question: string, answer: string, state: string}>}
   */
  var asides = new Map();
  var seq = 0;

  // ---------- storage (via core's context-safe wrappers) ----------

  function storeKey(id) {
    return "cppAsides:" + id;
  }

  function save() {
    var id = convoId();
    if (!id || !ctx) return;
    var rows = [];
    asides.forEach(function (a) {
      rows.push({ id: a.id, anchor: a.anchor, question: a.question, answer: a.answer || "" });
    });
    var obj = {};
    obj[storeKey(id)] = rows;
    ctx.util.set(obj);
  }

  function load(id) {
    inflight.forEach(function (c) { c.abort(); });
    inflight.clear();
    asides.clear();
    activeId = null;
    if (!id || !ctx) { repaint(); return; }
    var key = storeKey(id);
    ctx.util.get(key).then(function (data) {
      var rows = (data && data[key]) || [];
      rows.forEach(function (row) {
        asides.set(row.id, {
          id: row.id,
          anchor: row.anchor,
          question: row.question,
          answer: row.answer || "",
          state: "dormant"
        });
        var n = +String(row.id).slice(1);
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      });
      repaint();
    });
  }

  // ---------- ids ----------

  function convoId() {
    if (!ctx) return null;
    var m = ctx.util.CHAT_RE.exec(location.pathname);
    return m ? m[1].toLowerCase() : null;
  }

  function getOrgId() {
    var m = /(?:^|;\s*)lastActiveOrg=([0-9a-f-]{8,})/i.exec(document.cookie);
    return m ? m[1] : null;
  }

  // ---------- layout ----------
  // Margin width is measured, never computed from Tailwind classes: the sidebar
  // is user-resizable and claude.ai's own file pane can claim the right margin,
  // so only the live rects tell the truth.

  function layout() {
    var feed = document.querySelector(FEED);
    var sc = document.querySelector(SCROLLER);
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

  function scroller() {
    return document.querySelector(SCROLLER);
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
      convoId: convoId(),
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
  //   orphan  — quote is gone (message edited); the aside survives, detached
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

  /** How far either side of the recorded index to look after a renumbering. */
  var DRIFT = 3;

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

  // ---------- paint ----------

  var normal = HAS_HIGHLIGHT ? new Highlight() : null;
  var active = HAS_HIGHLIGHT ? new Highlight() : null;
  // Focusing the question input collapses the document selection, so the text
  // being asked about stops looking selected exactly when it matters most. We
  // repaint it ourselves — a Highlight is independent of focus.
  var pendingHl = HAS_HIGHLIGHT ? new Highlight() : null;
  var highlightsRegistered = false;

  function registerHighlights() {
    if (!HAS_HIGHLIGHT || highlightsRegistered) return;
    CSS.highlights.set("cpa-aside", normal);
    CSS.highlights.set("cpa-aside-active", active);
    CSS.highlights.set("cpa-pending", pendingHl);
    active.priority = 1;
    pendingHl.priority = 2;
    highlightsRegistered = true;
  }

  var activeId = null;
  /** @type {Map<string, Range>} id -> last resolved range, for hit-testing clicks */
  var ranges = new Map();

  function repaint() {
    ranges.clear();
    if (normal) normal.clear();
    if (active) active.clear();

    asides.forEach(function (aside) {
      var res = resolve(aside.anchor);
      aside.state = res.state;
      if (!res.range) return;
      ranges.set(aside.id, res.range);
      var hl = aside.id === activeId ? active : normal;
      if (hl) hl.add(res.range);
    });
    syncCards();
    reflow();
    renderGutter();
  }

  // Scrolling doesn't invalidate a resolved Range — the text nodes are the same —
  // so it only needs a reposition, not a full re-resolve.
  var flowQueued = false;
  function scheduleFlow() {
    if (flowQueued) return;
    flowQueued = true;
    requestAnimationFrame(function () {
      flowQueued = false;
      reflow();
      renderGutter();
    });
  }

  // ---------- margin cards ----------
  // Word/Docs-style: the highlight stays in the text, the thread sits beside it
  // in the margin. The layer is a fixed element on <body>, outside React's tree.

  var CARD_W = 300;
  var GAP = 12; // between a card and the column, and between stacked cards
  var MIN_LEFT = 32; // never squeeze the left margin below this to make room

  var layer = null;
  /** @type {Map<string, HTMLElement>} aside id -> card element */
  var cards = new Map();

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "cpa-layer";
    document.body.appendChild(layer);
    return layer;
  }

  // The transcript and the composer are both inside the scroll container, so
  // padding it is what moves them together. Shifting the column itself would
  // leave the composer centred and visibly misaligned underneath.
  var shiftEl = null;
  var appliedShift = 0;
  function applyShift(px) {
    if (px === appliedShift) return;
    if (!shiftEl) {
      shiftEl = document.createElement("style");
      document.head.appendChild(shiftEl);
    }
    shiftEl.textContent = px
      ? SCROLLER + "{padding-right:" + px + "px;transition:padding-right .18s ease}"
      : "";
    appliedShift = px;
  }

  /**
   * How much to pad the scroller so a card fits, and what we get for it. Padding
   * by P moves the centred column left by P/2, so the right margin gains P/2 —
   * meaning P = 2 * (want - margin). Clamped so the left margin never collapses.
   */
  function plan() {
    var l = layout();
    if (!l) return null;

    // Measure back to the unshifted layout first. l.right already includes the
    // shift we applied last pass, so planning from it would compound each time
    // and the column would creep sideways.
    var baseRight = l.right - appliedShift / 2;
    var baseLeft = l.left + appliedShift / 2;

    var want = CARD_W + GAP * 2;
    var maxShift = Math.max(0, (baseLeft - MIN_LEFT) * 2);
    var shift = Math.min(maxShift, Math.max(0, (want - baseRight) * 2));
    var right = baseRight + shift / 2;
    return { shift: shift, right: right, mode: right >= CARD_W + GAP ? "cards" : "dots" };
  }

  function syncCards() {
    cards.forEach(function (el, id) {
      if (!asides.has(id)) {
        el.remove();
        cards.delete(id);
      }
    });
    asides.forEach(function (aside) {
      if (cards.has(aside.id)) return;
      var el = buildCard(aside);
      cards.set(aside.id, el);
      layer.appendChild(el);
    });
  }

  // ---------- inline markdown ----------
  // Answers often come back with **bold**, *italic*, `code`, and [links](url).
  // Render a small, safe subset by building real DOM nodes rather than assigning
  // innerHTML — the text is model output, so nothing it emits should be able to
  // execute or inject markup. Anything unrecognised (including a half-typed **
  // mid-stream) falls through as literal text. Newlines are preserved by the
  // card's `white-space: pre-wrap`, so only inline spans are handled here.
  var INLINE_RULES = [
    {
      re: /`([^`]+)`/,
      build: function (m) {
        var e = document.createElement("code");
        e.textContent = m[1];
        return e;
      }
    },
    {
      re: /\*\*([\s\S]+?)\*\*/,
      build: function (m) {
        var e = document.createElement("strong");
        appendInline(e, m[1]);
        return e;
      }
    },
    {
      re: /\*([\s\S]+?)\*/,
      build: function (m) {
        var e = document.createElement("em");
        appendInline(e, m[1]);
        return e;
      }
    },
    {
      re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
      build: function (m) {
        var a = document.createElement("a");
        a.href = m[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        appendInline(a, m[1]);
        return a;
      }
    }
  ];

  function appendInline(parent, text) {
    while (text) {
      var best = null;
      var bestRule = null;
      for (var i = 0; i < INLINE_RULES.length; i++) {
        var m = INLINE_RULES[i].re.exec(text);
        // Earliest match wins; on a tie the earlier rule wins, so ** beats *.
        if (m && (!best || m.index < best.index)) {
          best = m;
          bestRule = INLINE_RULES[i];
        }
      }
      if (!best) {
        parent.appendChild(document.createTextNode(text));
        return;
      }
      if (best.index > 0) {
        parent.appendChild(document.createTextNode(text.slice(0, best.index)));
      }
      parent.appendChild(bestRule.build(best));
      text = text.slice(best.index + best[0].length);
    }
  }

  function renderAnswer(el, text) {
    el.textContent = "";
    appendInline(el, text || "");
  }

  function buildCard(aside) {
    var el = document.createElement("div");
    el.className = "cpa-card";
    el.dataset.id = aside.id;

    var quote = document.createElement("div");
    quote.className = "cpa-card-quote";
    quote.textContent = aside.anchor.quote;
    el.appendChild(quote);

    var q = document.createElement("div");
    q.className = "cpa-card-q";
    q.textContent = aside.question;
    el.appendChild(q);

    var a = document.createElement("div");
    a.className = "cpa-card-a";
    renderAnswer(a, aside.answer || "");
    el.appendChild(a);

    var del = document.createElement("button");
    del.type = "button";
    del.className = "cpa-card-x";
    del.title = "Delete aside";
    del.textContent = "×";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      var c = inflight.get(aside.id);
      if (c) c.abort();
      asides.delete(aside.id);
      if (activeId === aside.id) activeId = null;
      save();
      repaint();
    });
    el.appendChild(del);

    // Clicking a card always opens it; it never toggles shut. Dismissal is a
    // click elsewhere, which the document handler covers.
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      if (activeId === aside.id) return;
      activeId = aside.id;
      repaint();
    });

    return el;
  }

  /**
   * Position every card, then push overlapping ones down. The stacking pass is
   * what makes this read as margin comments rather than as floating divs.
   */
  function reflow() {
    var p = plan();
    var sc = scroller();
    if (!p || !sc || !asides.size) {
      applyShift(0);
      if (layer) layer.hidden = true;
      return;
    }

    layer.hidden = false;
    applyShift(p.shift);
    layer.dataset.mode = p.mode;

    var sr = sc.getBoundingClientRect();
    var left = sr.right - p.right + GAP;
    var items = [];

    asides.forEach(function (aside) {
      var el = cards.get(aside.id);
      if (!el) return;
      var range = ranges.get(aside.id);

      // Dormant asides are represented by the gutter counts, not by a card.
      if (!range && aside.state === "dormant") {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.classList.toggle("cpa-active", aside.id === activeId);
      el.classList.toggle("cpa-orphan", aside.state === "orphan");
      el.style.left = left + "px";
      el.style.width = Math.min(CARD_W, p.right - GAP) + "px";

      // Orphans have no text to sit beside, so they pin to the top.
      var top = range ? range.getBoundingClientRect().top : sr.top + 8;
      items.push({ el: el, top: top });
    });

    items.sort(function (a, b) { return a.top - b.top; });
    var cursor = -Infinity;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var top = Math.max(it.top, cursor);
      it.el.style.top = top + "px";
      cursor = top + it.el.offsetHeight + 8;
    }
  }

  // ---------- asking ----------

  function chatTitle() {
    var el = document.querySelector('[data-testid="chat-title-split"] button');
    return (el && el.textContent && el.textContent.trim()) || "";
  }

  /**
   * A bare quote is often unanswerable — "what does this mean" about a selected
   * variable name needs the sentence around it. Pull a window from the same
   * block, which is available whenever the message is mounted.
   */
  function contextFor(anchor) {
    var article = articleFor(anchor.msgIndex);
    var md = article && article.querySelectorAll(MD)[anchor.mdIndex];
    var text = md && md.children[anchor.blockIndex] && md.children[anchor.blockIndex].textContent;
    if (!text) return "";
    var pad = 250;
    var slice = text.slice(Math.max(0, anchor.start - pad), anchor.end + pad);
    return slice === anchor.quote ? "" : slice;
  }

  function buildPrompt(aside) {
    var ctxWindow = contextFor(aside.anchor);
    return [
      chatTitle() && "Conversation: " + chatTitle(),
      'Selected text:\n"""' + aside.anchor.quote + '"""',
      ctxWindow && 'Surrounding context:\n"""' + ctxWindow + '"""',
      "Question: " + aside.question
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // ---------- claude.ai internal API helpers ----------

  /** Lazy UUID v4, persisted so the same device ID is reused across sessions. */
  var _deviceId = null;
  function deviceId() {
    if (_deviceId) return _deviceId;
    _deviceId = crypto.randomUUID();
    if (ctx) {
      ctx.util.set({ cppAsideDeviceId: _deviceId });
    }
    return _deviceId;
  }

  /**
   * A throwaway conversation for a single ask. Each aside is one self-contained
   * question — the prompt already carries the quote plus a window of surrounding
   * context — so there is no reason to share history between asides. A temporary
   * conversation is isolated (no cross-aside bleed) and stays out of the sidebar;
   * the answer is streamed out and persisted locally, so the conversation itself
   * is disposable and its ID is never stored.
   */
  function createTempConv() {
    var org = getOrgId();
    if (!org) return Promise.reject(new Error("Not logged in (no org cookie)"));

    return fetch("/api/organizations/" + org + "/chat_conversations", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "anthropic-client-platform": "web_claude_ai",
        "anthropic-device-id": deviceId()
      },
      body: JSON.stringify({
        name: "",
        model: "claude-sonnet-4-6",
        is_temporary: true
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ""; }).then(function (body) {
          throw new Error("Create aside conversation failed (" + res.status + "): " + body.slice(0, 200));
        });
      }
      return res.json().then(function (data) {
        var newId = data.uuid || data.id;
        if (!newId) throw new Error("Create aside conversation returned no ID");
        return newId;
      });
    });
  }

  /**
   * Async generator that yields parsed SSE event objects from a ReadableStream.
   * Each yielded object has shape { event: string, data: any }.
   */
  async function* parseSSE(body) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buf = "";

    function parseFrame(frame) {
      var eventType = "";
      var dataLines = [];
      var lines = frame.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("event:") === 0) eventType = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return null;
      var raw = dataLines.join("\n");
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
      return { event: eventType, data: parsed };
    }

    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });

        // SSE frames are separated by double newlines.
        var frames = buf.split("\n\n");
        buf = frames.pop(); // incomplete tail stays in buffer

        for (var i = 0; i < frames.length; i++) {
          var evt = parseFrame(frames[i]);
          if (evt) yield evt;
        }
      }
      if (buf.trim()) {
        var last = parseFrame(buf);
        if (last) yield last;
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ===========================================================================
  // THE SEAM. Everything else is engine-agnostic: it takes a prompt and pushes
  // text through onDelta as it arrives, then resolves. Swap the body of this one
  // function and nothing above or below it changes. Wired to claude.ai's internal
  // streaming completion endpoint.
  // ===========================================================================
  async function askProvider(opts) {
    var org = getOrgId();
    if (!org) throw new Error("Not logged in — cannot ask Claude");

    var asideConvId = await createTempConv();
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var locale = navigator.language || "en-US";

    var body = {
      prompt: opts.prompt,
      model: "claude-sonnet-4-6",
      timezone: tz,
      locale: locale,
      rendering_mode: "messages",
      create_conversation_params: {
        name: "",
        model: "claude-sonnet-4-6",
        is_temporary: true
      }
    };

    var res = await fetch(
      "/api/organizations/" + org + "/chat_conversations/" + asideConvId + "/completion",
      {
        method: "POST",
        credentials: "same-origin",
        signal: opts.signal,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "anthropic-client-platform": "web_claude_ai",
          "anthropic-device-id": deviceId(),
          referer: "/chat/" + asideConvId
        },
        body: JSON.stringify(body)
      }
    );

    if (!res.ok) {
      var errBody = await res.text().catch(function () { return ""; });
      throw new Error("Claude API error " + res.status + ": " + errBody.slice(0, 300));
    }
    if (!res.body) throw new Error("Response has no body");

    var out = "";
    for await (var evt of parseSSE(res.body)) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");

      if (evt.event === "content_block_delta" && evt.data && evt.data.delta && evt.data.delta.text) {
        var chunk = evt.data.delta.text;
        out += chunk;
        opts.onDelta(chunk);
      } else if (evt.event === "message_stop") {
        break;
      } else if (evt.event === "error" || (evt.data && evt.data.type === "error")) {
        var msg = typeof evt.data === "string"
          ? evt.data
          : (evt.data && evt.data.error && evt.data.error.message) || JSON.stringify(evt.data);
        throw new Error("Stream error: " + msg);
      }
    }
    return out;
  }

  /** @type {Map<string, AbortController>} */
  var inflight = new Map();

  function paintAnswer(id, text, pending) {
    var card = cards.get(id);
    if (!card) return;
    renderAnswer(card.querySelector(".cpa-card-a"), text);
    card.dataset.pending = pending ? "1" : "";
    // Answer text changes the card's height, so the stack has to re-settle.
    scheduleFlow();
  }

  function runAsk(aside) {
    var prev = inflight.get(aside.id);
    if (prev) prev.abort();
    var ctrl = new AbortController();
    inflight.set(aside.id, ctrl);

    var acc = "";
    paintAnswer(aside.id, "…", true);

    askProvider({
      prompt: buildPrompt(aside),
      signal: ctrl.signal,
      onDelta: function (chunk) {
        acc += chunk;
        aside.answer = acc;
        paintAnswer(aside.id, acc, true);
      }
    }).then(function () {
      aside.answer = acc;
      paintAnswer(aside.id, acc, false);
      save();
    }).catch(function (err) {
      if (ctrl.signal.aborted) return; // superseded or deleted; leave it alone
      aside.answer = "⚠️ " + ((err && err.message) || err);
      paintAnswer(aside.id, aside.answer, false);
    }).finally(function () {
      inflight.delete(aside.id);
    });
  }

  // ---------- dormant gutter ----------
  // An aside whose message is outside the render window has nothing to attach to,
  // but the user still needs to know it exists — otherwise scrolling looks like
  // it deletes their work. Surface them as counts at the top and bottom of the
  // margin, each seeking to the nearest one.

  var gutter = null;

  function ensureGutter() {
    if (gutter) return gutter;
    function make(dir, glyph) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "cpa-gutter";
      b.dataset.dir = dir;
      b.dataset.glyph = glyph;
      b.hidden = true;
      b.addEventListener("click", function () {
        var target = b.dataset.target;
        if (target) scrollToMessage(+target);
      });
      document.body.appendChild(b);
      return b;
    }
    gutter = { up: make("up", "↑"), down: make("down", "↓") };
    return gutter;
  }

  function renderGutter() {
    var m = mountedRange();
    var l = layout();
    var sc = scroller();

    // Don't build the gutter DOM until there's something to put in it — an empty
    // conversation shouldn't add anything to the page. If it was built earlier
    // (asides since deleted), just hide it.
    if (!asides.size || !m || !l || !sc) {
      if (gutter) gutter.up.hidden = gutter.down.hidden = true;
      return;
    }

    var g = ensureGutter();
    var up = g.up;
    var down = g.down;

    var above = [];
    var below = [];
    asides.forEach(function (a) {
      if (a.state !== "dormant") return;
      (a.anchor.msgIndex < m.lo ? above : below).push(a.anchor.msgIndex);
    });

    var sr = sc.getBoundingClientRect();
    function place(el, list, pick, top) {
      el.hidden = !list.length;
      if (!list.length) return;
      el.textContent = el.dataset.glyph + " " + list.length;
      el.dataset.target = String(pick(list));
      el.style.left = sr.right - l.right + 12 + "px";
      el.style.top = top + "px";
    }

    // Nearest to the current window, so clicking takes the shortest trip.
    place(up, above, function (v) { return Math.max.apply(Math, v); }, sr.top + 60);
    place(down, below, function (v) { return Math.min.apply(Math, v); }, sr.bottom - 44);
  }

  // ---------- selection popover ----------

  var popover = null;

  function closePopover() {
    if (popover) popover.remove();
    popover = null;
    if (pendingHl) pendingHl.clear();
  }

  function createAside(anchor, question) {
    var aside = { id: "a" + ++seq, anchor: anchor, question: question, answer: "", state: "exact" };
    asides.set(aside.id, aside);
    activeId = aside.id;
    save();
    repaint(); // builds the card first, so there's somewhere to stream into
    runAsk(aside);
    return aside;
  }

  var ARROW =
    "M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66," +
    "117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z";

  // Verbatim from claude.ai's send button. Cloning the live button doesn't work
  // as the only strategy — it exists only while the composer has text in it — so
  // we carry the classes and let their stylesheet colour them for us.
  var SEND_BTN_CLASS =
    "cds-reset group/btn relative isolate inline-flex shrink-0 items-center " +
    "justify-center gap-1.5 whitespace-nowrap select-none " +
    "cursor-[var(--cds-cursor-interactive)] border-0 outline-none rounded " +
    "h-control font-sans text-body font-medium transition-shadow duration-fast " +
    "focus-visible:shadow-focus text-on-brand aspect-square w-control px-0";

  var SEND_FILL_CLASS =
    "absolute -z-[1] rounded-[inherit] transition-colors duration-fast " +
    "bg-fill-brand group-hover/btn:bg-fill-brand-hover inset-[0.5px] cds-btn-squish";

  /**
   * The arrow itself is an Anthropicons glyph at a private-use codepoint, which
   * can't be written literally — so lift it from a live send button when one is
   * on screen, and fall back to an equivalent SVG when the composer is empty.
   */
  function makeSendIcon() {
    var live = document.querySelector('button[aria-label="Send message"] [data-cds="Icon"]');
    if (live) return live.cloneNode(true);

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", ARROW);
    svg.appendChild(p);
    return svg;
  }

  function makeSend() {
    var el = document.createElement("button");
    el.type = "button";
    el.className = SEND_BTN_CLASS;
    el.setAttribute("aria-label", "Ask");
    el.dataset.cpaSend = "1";

    var fill = document.createElement("span");
    fill.className = SEND_FILL_CLASS;
    fill.setAttribute("aria-hidden", "true");
    el.appendChild(fill);

    var slot = document.createElement("span");
    slot.className = "inline-flex min-w-0 items-center gap-1";
    slot.appendChild(makeSendIcon());
    el.appendChild(slot);

    return el;
  }

  function openPopover(range, anchor) {
    closePopover();

    // Snapshot the range before focus moves — the live one from getSelection() is
    // mutated out from under us as soon as the input takes focus.
    var held = range.cloneRange();
    if (pendingHl) pendingHl.add(held);
    var rect = held.getBoundingClientRect();

    var el = document.createElement("div");
    el.className = "cpa-popover";

    // CDS tokens (--cds-*, bg-fill-brand, text-on-brand) are scoped to .cds-root
    // and keyed off its data-mode, so a popover parented to <body> would resolve
    // them to nothing. Mirror the live root's configuration.
    var root = document.querySelector(".cds-root");
    if (root) {
      el.classList.add("cds-root");
      ["data-mode", "data-density", "data-platform", "data-font"].forEach(function (attr) {
        var v = root.getAttribute(attr);
        if (v) el.setAttribute(attr, v);
      });
      el.style.fontSize = root.style.fontSize || "";
    }

    var body = document.createElement("div");
    body.className = "cpa-composer";

    var input = document.createElement("input");
    input.type = "text";
    // `font-large` is claude.ai's own type utility — borrowing it matches the
    // composer's size and family exactly; asides.css carries a fallback in case
    // the utility is ever renamed.
    input.className = "cpa-question font-large";
    input.placeholder = "Ask about this…";

    function submit() {
      var q = input.value.trim();
      if (!q) return;
      closePopover();
      var s = window.getSelection();
      if (s) s.removeAllRanges();
      createAside(anchor, q);
    }

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") closePopover();
      e.stopPropagation();
    });
    body.appendChild(input);

    var send = makeSend();
    send.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep selection
    send.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    });
    body.appendChild(send);

    el.appendChild(body);
    document.body.appendChild(el);

    var w = el.offsetWidth;
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
    var top = rect.top - el.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    el.style.left = left + "px";
    el.style.top = top + "px";

    popover = el;
    input.focus();
  }

  // ---------- Ask, inside claude.ai's own selection tooltip ----------
  // claude.ai already shows a selection tooltip, so we add to it rather than
  // racing it with a second floating thing. The tooltip is React's, and it
  // re-renders on every reposition, so injection has to be idempotent and re-run
  // from onApply + the mount-poll below — the button's presence is what keeps
  // repeated passes cheap and stops us stacking duplicates.

  var ASK_ICON =
    "M128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24," +
    "20.24l34.05-11.35A104,104,0,1,0,128,24Z";

  function injectAsk() {
    var tip = document.querySelector(TOOLTIP);
    if (!tip) return;
    // Test for the button, not a marker flag: React can re-render the inner row
    // while keeping the outer tooltip node, which would leave a stale flag
    // claiming we're injected when the button is already gone.
    if (tip.querySelector("[data-cpa-ask]")) return;

    var reply = tip.querySelector("button");
    var row = reply && reply.parentElement;
    if (!row) return;

    var ask = document.createElement("button");
    ask.type = "button";
    ask.className = reply.className;
    ask.dataset.cpaAsk = "1";
    ask.append("Ask");

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ASK_ICON);
    svg.appendChild(path);
    ask.appendChild(svg);

    var rule = document.createElement("div");
    rule.className = "cpa-tip-rule";

    // mousedown would collapse the selection before we can describe it.
    ask.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ask.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !isSettled(sel.anchorNode)) return;
      var anchor = describe(sel);
      if (!anchor) return;
      openPopover(sel.getRangeAt(0), anchor);
    });

    row.prepend(rule);
    row.prepend(ask);
  }

  // claude.ai mounts its selection tooltip a beat *after* mouseup, and the exact
  // frame varies. onApply catches most mounts and every re-render, but the very
  // first mount can land between its passes — which is why a fresh selection
  // sometimes showed Reply with no Ask. So on any selection we also poll for a
  // short window until the tooltip appears and injection lands. injectAsk is
  // idempotent, so the extra calls are cheap no-ops once Ask is in.
  var injectTries = 0;
  var injectTimer = null;
  function chaseTooltip() {
    injectAsk();
    if (document.querySelector(TOOLTIP) || ++injectTries >= 20) {
      clearInterval(injectTimer);
      injectTimer = null;
    }
  }
  function scheduleInject() {
    // Only chase the tooltip when there's an actual text selection to act on.
    // Both mouseup and selectionchange call this, so without the guard a plain
    // click, or typing in our own popover input, would kick off a pointless 1s
    // poll. The tooltip only appears for a non-collapsed selection anyway.
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    injectTries = 0;
    if (injectTimer) return;
    injectTimer = setInterval(chaseTooltip, 50); // ~1s window, 20 tries
    chaseTooltip();
  }

  // ---------- our own chrome, for the click handler and observers ----------

  var OURS = ".cpa-gutter, .cpa-popover, .cpa-layer, [data-cpa-ask]";
  function isOurs(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest(OURS));
  }

  /** Clicking a highlight opens its aside — the entry point back into a thread. */
  function onDocClick(e) {
    if (popover && popover.contains(e.target)) return;
    // The Ask button stops propagation, so reaching here means a click that
    // wasn't for the popover — dismiss it and drop the pending highlight.
    if (popover) closePopover();

    // Clicks on our own chrome are already handled by those elements. Falling
    // through to hit-testing would find no highlight under the cursor and clear
    // activeId — instantly undoing the toggle the card just performed.
    if (isOurs(e.target)) return;

    var hit = null;
    ranges.forEach(function (range, id) {
      if (hit) return;
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        if (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        ) { hit = id; break; }
      }
    });
    if (hit || activeId) {
      activeId = hit;
      repaint();
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") closePopover();
  }

  function onScrollOrResize() {
    scheduleFlow();
  }

  // ---------- lifecycle ----------

  var lastConvo = null;

  CPP.registerFeature({
    id: "asides",

    onInit: function (context) {
      ctx = context;
      if (!HAS_HIGHLIGHT) {
        console.warn("[cpp] CSS Custom Highlight API unavailable; asides won't be marked");
      }
      ensureLayer();
      registerHighlights();

      // Reuse a persisted device id across sessions if we have one. Guard on
      // _deviceId being unset so a race — an ask that ran before this resolved
      // and already generated + persisted one — isn't clobbered with a stale id.
      ctx.util.get("cppAsideDeviceId").then(function (d) {
        if (!_deviceId && d && d.cppAsideDeviceId) _deviceId = d.cppAsideDeviceId;
      });

      document.addEventListener("click", onDocClick);
      document.addEventListener("mouseup", scheduleInject);
      document.addEventListener("selectionchange", scheduleInject);
      document.addEventListener("keydown", onKeydown);
      window.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize);

      lastConvo = convoId();
      load(lastConvo);
    },

    // Core calls this (debounced) on DOM mutations and SPA navigation. It stands
    // in for the reference's private MutationObserver: keep Ask in the tooltip,
    // reload on chat switch, and re-resolve anchors against the fresh DOM.
    onApply: function () {
      var now = convoId();
      if (now !== lastConvo) {
        lastConvo = now;
        load(now);
        return;
      }
      injectAsk();
      if (asides.size) repaint();
    },

    // Core calls this when claude.ai deletes a chat (directly, or as one of a
    // deleted project's chats — core fans those out as chat deletes). Drop the
    // per-chat storage key. Project-kind deletes are ignored: asides has no
    // project concept, and the member chats arrive as their own chat deletes.
    onDelete: function (info) {
      if (!info || info.kind !== "chat" || !ctx) return;
      ctx.util.remove(storeKey(info.id));
      // If the deleted chat is somehow the one on screen, drop the live state
      // too so its cards/highlights don't linger until the next reload.
      if (info.id === convoId()) {
        inflight.forEach(function (c) { c.abort(); });
        inflight.clear();
        asides.clear();
        activeId = null;
        repaint();
      }
    },

    onTeardown: function () {
      inflight.forEach(function (c) { c.abort(); });
      inflight.clear();
      closePopover();

      document.removeEventListener("click", onDocClick);
      document.removeEventListener("mouseup", scheduleInject);
      document.removeEventListener("selectionchange", scheduleInject);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      if (injectTimer) { clearInterval(injectTimer); injectTimer = null; }

      // Remove anything we grafted into claude.ai's own tooltip.
      var stray = document.querySelectorAll("[data-cpa-ask], .cpa-tip-rule");
      for (var i = 0; i < stray.length; i++) stray[i].remove();

      if (normal) normal.clear();
      if (active) active.clear();
      if (pendingHl) pendingHl.clear();
      if (HAS_HIGHLIGHT && highlightsRegistered) {
        CSS.highlights.delete("cpa-aside");
        CSS.highlights.delete("cpa-aside-active");
        CSS.highlights.delete("cpa-pending");
        highlightsRegistered = false;
      }

      cards.clear();
      if (layer) { layer.remove(); layer = null; }
      if (gutter) { gutter.up.remove(); gutter.down.remove(); gutter = null; }
      if (shiftEl) { shiftEl.remove(); shiftEl = null; }
      appliedShift = 0;

      asides.clear();
      ranges.clear();
      activeId = null;
      lastConvo = null;
    }
  });
})();
