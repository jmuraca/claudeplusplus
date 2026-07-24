// Feature: Emoji autocomplete
//
// Slack-style emoji in the message box. Two behaviours, both driven off what
// you type between colons:
//   • Auto-replace — finish a shortcode with its closing colon (":tada:") and it
//     swaps to the emoji (🎉) in place.
//   • Picker — type a colon at a word boundary and a filtered list opens at the
//     caret; keep typing to narrow it, ↑/↓ to move, Enter/Tab or click to insert.
//
// The composer is claude.ai's ProseMirror contenteditable, which owns its DOM
// and discards nodes inserted into it — so, exactly like prompt-stash.js, we
// never touch that DOM. Every edit is a Selection over the ":query" token plus
// document.execCommand("insertText"), which ProseMirror observes as an ordinary
// user edit and folds into its document. The one difference from prompt-stash is
// that the selection is scoped to just the token, not the whole box.
//
// The shortcodes come from a bundled dataset (window.CPP_EMOJI, src/data/emoji.js,
// loaded before this script) — the same shortcodes GitHub and Slack use — so
// nothing here touches the network. The picker is a fixed overlay on <body>,
// outside React's tree, positioned from the live caret rect, the same approach
// the other Claude++ margin UIs take.
//
// Note: this is English-shortcode-bound by nature, but it doesn't key off any of
// claude's aria-labels, so it's otherwise independent of claude's own markup
// apart from the composer selectors it shares with draft-mode / prompt-stash.
(function () {
  "use strict";

  // The composer selectors, the editable lookup (CPP.util.composerEditor) and the
  // "is this the composer" test (CPP.util.inComposer) are shared in core.js, the
  // same source draft-mode and prompt-stash use.

  // A shortcode is letters/digits plus + _ - (matches gemoji aliases like
  // "+1", "sweat_smile", "e-mail").
  var TOKEN_CHARS = "a-z0-9_+\\-";
  // The whole ":name:" once the closing colon is typed — the auto-replace hook.
  var CLOSED_RE = new RegExp(":([" + TOKEN_CHARS + "]+):$", "i");
  // A live ":query" the picker feeds off. The colon must sit at a word boundary
  // (start of the text run or after whitespace) so "http://x" and "time: 5" don't
  // open the picker; the query may be empty, so a bare ":" opens it.
  var OPEN_RE = new RegExp("(?:^|\\s)(:[" + TOKEN_CHARS + "]*)$", "i");

  var MAX_RESULTS = 50; // cap the list; the rest is reachable by typing more

  var started = false;

  // Built once from window.CPP_EMOJI: a name->char map for auto-replace, and a
  // flat list for the picker's ranked search.
  var byShortcode = null;
  var searchList = null;

  // Picker state.
  var picker = null; // the overlay element, or null before first use
  var listEl = null;
  var rows = []; // { el, char, name } for the currently shown results
  var activeIndex = 0;
  var lastPath = null;

  // ---------- the composer ----------

  // The collapsed caret, only when it sits directly in a text node — which is
  // where a ":shortcode" being typed always lives. Returns null otherwise (an
  // empty paragraph, a non-collapsed selection), which reads as "no token".
  function caretInfo() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    var r = sel.getRangeAt(0);
    var node = r.startContainer;
    if (!node || node.nodeType !== 3) return null;
    return { node: node, offset: r.startOffset, text: node.nodeValue || "" };
  }

  // The live ":query" ending at the caret, or null. `start`/`end` are offsets in
  // `node` spanning the token (leading colon included), so a selection can cover
  // exactly it for replacement.
  function currentToken() {
    var ci = caretInfo();
    if (!ci) return null;
    var before = ci.text.slice(0, ci.offset);
    var m = before.match(OPEN_RE);
    if (!m) return null;
    var token = m[1]; // includes the leading colon
    return {
      node: ci.node,
      start: ci.offset - token.length,
      end: ci.offset,
      query: token.slice(1)
    };
  }

  // Replace [start,end) in `node` with `text`, the ProseMirror-safe way: select
  // the range and let the browser's own insertText command make the edit, which
  // the editor observes as a user edit. Refocusing first covers the click path,
  // where focus has left the editable (the picker's mousedown-preventDefault
  // usually keeps it, but this is the belt to that suspenders).
  function replaceRange(node, start, end, text) {
    var ed = CPP.util.composerEditor();
    if (!ed) return false;
    ed.focus();
    var range = document.createRange();
    try {
      range.setStart(node, start);
      range.setEnd(node, end);
    } catch (e) {
      return false;
    }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand("insertText", false, text);
  }

  // ---------- the dataset ----------

  function buildIndex() {
    if (byShortcode) return true;
    var data = window.CPP_EMOJI;
    if (!Array.isArray(data)) return false;
    byShortcode = Object.create(null);
    searchList = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var chr = row[0];
      var names = row[1] || [];
      var kw = row[2] || [];
      for (var j = 0; j < names.length; j++) {
        if (byShortcode[names[j]] === undefined) byShortcode[names[j]] = chr;
      }
      searchList.push({ char: chr, names: names, keywords: kw, order: i });
    }
    return true;
  }

  // Ranked search over names then keywords. Lower rank = better: exact name (0),
  // name prefix (1), name substring (2), keyword prefix (3), keyword substring
  // (4). Ties break on the dataset's own order (roughly popularity). An empty
  // query returns the head of the list as a default "popular" set, so a bare ":"
  // has something to show.
  function search(query, limit) {
    if (!buildIndex()) return [];
    query = (query || "").toLowerCase();
    if (!query) {
      var head = [];
      for (var h = 0; h < searchList.length && head.length < limit; h++) {
        head.push({ char: searchList[h].char, name: searchList[h].names[0] });
      }
      return head;
    }
    var hits = [];
    for (var i = 0; i < searchList.length; i++) {
      var e = searchList[i];
      var rank = 9;
      var matchName = e.names[0];
      for (var j = 0; j < e.names.length; j++) {
        var n = e.names[j];
        var pos = n.indexOf(query);
        if (pos === -1) continue;
        var r = n === query ? 0 : pos === 0 ? 1 : 2;
        if (r < rank) {
          rank = r;
          matchName = n;
        }
      }
      if (rank > 2) {
        for (var k = 0; k < e.keywords.length; k++) {
          var w = e.keywords[k];
          var wpos = w.indexOf(query);
          if (wpos === -1) continue;
          var kr = wpos === 0 ? 3 : 4;
          if (kr < rank) rank = kr;
          if (rank === 3) break;
        }
      }
      if (rank < 9) hits.push({ char: e.char, name: matchName, rank: rank, order: e.order });
    }
    hits.sort(function (a, b) {
      return a.rank - b.rank || a.order - b.order;
    });
    return hits.slice(0, limit);
  }

  // ---------- the picker ----------

  function ensurePicker() {
    if (picker) return picker;
    picker = document.createElement("div");
    picker.className = "cpe-picker";
    picker.setAttribute("role", "listbox");
    picker.hidden = true;

    listEl = document.createElement("div");
    listEl.className = "cpe-list";
    picker.appendChild(listEl);

    // Keep the caret/selection in the editable when a row is clicked: the default
    // mousedown would move focus out of the composer and collapse the selection
    // we need to replace.
    picker.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    document.body.appendChild(picker);
    return picker;
  }

  function isOpen() {
    return !!(picker && !picker.hidden);
  }

  function closePicker() {
    if (picker) picker.hidden = true;
    rows = [];
    activeIndex = 0;
  }

  // One result row. Split out of the loop so each row's handlers close over their
  // own `rec` (a plain `var` in the loop would leave them all sharing the last
  // one). `rec` is also the object pushed to `rows`, so mouseenter can find its
  // index and click knows which emoji it carries.
  function buildRow(it) {
    var row = document.createElement("div");
    row.className = "cpe-row";
    row.setAttribute("role", "option");

    var glyph = document.createElement("span");
    glyph.className = "cpe-emoji";
    glyph.textContent = it.char;

    var label = document.createElement("span");
    label.className = "cpe-name";
    label.textContent = ":" + it.name + ":";

    row.appendChild(glyph);
    row.appendChild(label);

    var rec = { el: row, char: it.char, name: it.name };
    row.addEventListener("mouseenter", function () {
      setActive(rows.indexOf(rec));
    });
    row.addEventListener("click", function () {
      commit(rec);
    });

    rows.push(rec);
    listEl.appendChild(row);
  }

  function renderRows(items) {
    ensurePicker();
    listEl.textContent = "";
    rows = [];
    for (var i = 0; i < items.length; i++) buildRow(items[i]);
  }

  function setActive(i) {
    if (i < 0 || i >= rows.length) return;
    if (rows[activeIndex] && rows[activeIndex].el) {
      rows[activeIndex].el.classList.remove("cpe-active");
    }
    activeIndex = i;
    var row = rows[activeIndex];
    if (row && row.el) {
      row.el.classList.add("cpe-active");
      row.el.scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    if (!rows.length) return;
    var i = (activeIndex + delta + rows.length) % rows.length;
    setActive(i);
  }

  // Open or refresh the picker for `query`. Nothing to show closes it, so an
  // unmatched ":zzz" doesn't leave an empty box hanging.
  function openPicker(query) {
    var items = search(query, MAX_RESULTS);
    if (!items.length) {
      closePicker();
      return;
    }
    renderRows(items);
    setActive(0);
    picker.hidden = false;
    position();
  }

  // Pin the picker to the live caret rect, opening below it and flipping above
  // when there isn't room. A collapsed caret's rect has zero width but a valid
  // position; if it comes back empty (rare), fall back to the composer's rect.
  function position() {
    if (!isOpen()) return;
    var rect = null;
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0).cloneRange();
      rect = r.getBoundingClientRect();
      if (rect && !rect.width && !rect.height && !rect.top && !rect.left) {
        var rects = r.getClientRects();
        if (rects && rects.length) rect = rects[0];
      }
    }
    if (!rect || (!rect.top && !rect.left && !rect.width && !rect.height)) {
      var ed = CPP.util.composerEditor();
      if (ed) rect = ed.getBoundingClientRect();
    }
    if (!rect) return;

    var GAP = 4;
    var EDGE = 8;
    var pw = picker.offsetWidth;
    var ph = picker.offsetHeight;

    var left = rect.left;
    if (left + pw > window.innerWidth - EDGE) left = window.innerWidth - EDGE - pw;
    if (left < EDGE) left = EDGE;

    var top = rect.bottom + GAP;
    if (top + ph > window.innerHeight - EDGE) {
      var above = rect.top - GAP - ph;
      if (above >= EDGE) top = above;
    }

    picker.style.left = Math.round(left) + "px";
    picker.style.top = Math.round(Math.max(EDGE, top)) + "px";
  }

  // Insert the chosen emoji in place of the live ":query" token and close. A
  // trailing space follows a picker pick, the way Slack does it, so you can keep
  // typing; the token is re-read now rather than trusted from open time, since
  // the caret may have moved.
  function commit(rec) {
    var chosen = rec || rows[activeIndex];
    if (!chosen) return;
    var tok = currentToken();
    if (!tok) {
      closePicker();
      return;
    }
    replaceRange(tok.node, tok.start, tok.end, chosen.char + " ");
    closePicker();
  }

  // ---------- detection ----------

  // Runs on every keystroke in the composer. Auto-replace wins over the picker,
  // so completing ":tada:" swaps in place instead of leaving the list open.
  function onInput(e) {
    if (e && e.isComposing) return;
    if (!CPP.util.inComposer(e.target)) {
      closePicker();
      return;
    }
    var ci = caretInfo();
    if (!ci) {
      closePicker();
      return;
    }
    var before = ci.text.slice(0, ci.offset);

    var closed = before.match(CLOSED_RE);
    if (closed) {
      if (buildIndex() && byShortcode[closed[1].toLowerCase()] !== undefined) {
        var chr = byShortcode[closed[1].toLowerCase()];
        var end = ci.offset;
        var start = end - closed[0].length;
        replaceRange(ci.node, start, end, chr);
        closePicker();
        return;
      }
      // A ":word:" that isn't a known shortcode: leave it as typed, close.
      closePicker();
      return;
    }

    var open = before.match(OPEN_RE);
    if (open) {
      openPicker(open[1].slice(1));
    } else {
      closePicker();
    }
  }

  // ---------- events ----------

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Capture at window — ahead of ProseMirror and of draft-mode's Enter guard — so
  // that while the picker is open Enter/Tab pick an emoji instead of submitting
  // (or being dropped in draft mode). Only these keys are swallowed; everything
  // else falls through to type normally and re-filter via onInput. Moving the
  // caret away from the token (arrows/Home/End/Page) just closes the picker, left
  // to act normally.
  function onKeydownCapture(e) {
    if (!isOpen() || e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        move(1);
        stop(e);
        break;
      case "ArrowUp":
        move(-1);
        stop(e);
        break;
      case "Enter":
      case "Tab":
        commit();
        stop(e);
        break;
      case "Escape":
        closePicker();
        stop(e);
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
      case "PageUp":
      case "PageDown":
        closePicker();
        break;
      default:
        break;
    }
  }

  // A press that starts anywhere but the picker dismisses it (clicking a row is
  // handled on the row, and its mousedown is preventDefaulted so it never reaches
  // here as an outside press).
  function onMousedownCapture(e) {
    if (!isOpen()) return;
    if (picker && picker.contains(e.target)) return;
    closePicker();
  }

  function onScroll() {
    if (isOpen()) position();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "emoji-autocomplete",

    onInit: function () {
      if (started) return;
      started = true;
      lastPath = location.pathname;
      buildIndex();
      window.addEventListener("input", onInput, true);
      window.addEventListener("keydown", onKeydownCapture, true);
      window.addEventListener("mousedown", onMousedownCapture, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
    },

    // Core calls this (debounced) on DOM churn and SPA navigation. The picker is
    // transient composer state; a navigation or a vanished composer should just
    // dismiss it. Kept cheap — it does nothing unless the picker is actually up.
    onApply: function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        closePicker();
        return;
      }
      if (isOpen() && !CPP.util.composerEditor()) closePicker();
    },

    onTeardown: function () {
      started = false;
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("keydown", onKeydownCapture, true);
      window.removeEventListener("mousedown", onMousedownCapture, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (picker) {
        picker.remove();
        picker = null;
        listEl = null;
      }
      rows = [];
      activeIndex = 0;
    }
  });
})();
