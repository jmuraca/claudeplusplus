// Feature: Inline asides
//
// Select any passage in a claude.ai conversation, ask a question about it, and
// the answer streams into a card in the right margin — anchored to the text, the
// way a comment is anchored in Google Docs or Word.
//
// This is a port of the standalone reference implementation into Claude++'s
// feature lifecycle. The cards and streaming are unchanged; what differs is the
// wiring:
//   • all setup happens in onInit and is fully undone in onTeardown, so the
//     feature toggle works and a context invalidation goes quiet cleanly;
//   • DOM-churn re-resolution rides core's debounced onApply instead of a
//     private MutationObserver;
//   • storage goes through ctx.util.get/set (which no-op once the extension
//     context is gone) rather than chrome.storage.local directly;
//   • the current chat id comes from ctx.util.CHAT_RE;
//   • anchoring — describing a selection, re-resolving it against a virtualized
//     transcript, and seeking to a message — lives in src/anchor.js, shared
//     with bookmarks. See that file for why an anchor is offsets and not a
//     Range.
//
// Painting goes through the CSS Custom Highlight API rather than wrapping text in
// <mark>: inserting nodes into React-owned DOM gets them discarded on the next
// render, whereas a Highlight decorates Ranges without touching the tree.
(function () {
  "use strict";

  var A = CPP.anchor;

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
      var res = A.resolve(aside.anchor);
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
      ? A.SCROLLER + "{padding-right:" + px + "px;transition:padding-right .18s ease}"
      : "";
    appliedShift = px;
  }

  /**
   * How much to pad the scroller so a card fits, and what we get for it. Padding
   * by P moves the centred column left by P/2, so the right margin gains P/2 —
   * meaning P = 2 * (want - margin). Clamped so the left margin never collapses.
   */
  function plan() {
    var l = A.layout();
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
    var sc = A.scroller();
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

  function buildPrompt(aside) {
    var ctxWindow = A.contextFor(aside.anchor);
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
        if (target) A.scrollToMessage(+target);
      });
      document.body.appendChild(b);
      return b;
    }
    gutter = { up: make("up", "↑"), down: make("down", "↓") };
    return gutter;
  }

  function renderGutter() {
    var m = A.mountedRange();
    var l = A.layout();
    var sc = A.scroller();

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

  function injectAsk() {
    var tip = document.querySelector(A.TOOLTIP);
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

    // Reply's own icon is an Anthropicons glyph, so Ask uses one too — same
    // font, inheriting the same size and weight from the shared className,
    // which is the only way the two sit level with each other.
    ask.appendChild(ctx.util.icon(ctx.util.ICON.ASK));

    var rule = document.createElement("div");
    rule.className = "cpa-tip-rule";

    // mousedown would collapse the selection before we can describe it.
    ask.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ask.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !A.isSettled(sel.anchorNode)) return;
      var anchor = A.describe(sel);
      if (!anchor) return;
      openPopover(sel.getRangeAt(0), anchor);
    });

    row.prepend(rule);
    row.prepend(ask);
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
  var unsubTooltip = null;

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
      document.addEventListener("keydown", onKeydown);
      unsubTooltip = A.onSelectionTooltip(injectAsk);
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
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      if (unsubTooltip) { unsubTooltip(); unsubTooltip = null; }

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
