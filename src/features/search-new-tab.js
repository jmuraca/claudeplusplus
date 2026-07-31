// Feature: Open a search result in a new tab
//
// claude.ai's search (the ⌘K / Ctrl+K command palette) draws each result as a
// <button>, not a link. That looks the same but behaves quite differently: a
// button has no href, so Ctrl/⌘+click, middle-click and the context menu's
// "Open link in new tab" all fall through to a plain activation and the chat
// replaces whatever you were reading. Searching for three chats to compare means
// three round trips through the palette.
//
// This restores the link behaviour the markup implies. A Ctrl+click (⌘+click on
// macOS), a middle-click, or Ctrl/⌘+Enter on the highlighted row opens that
// result in a new tab and leaves the palette open on its results, so several can
// be opened in a row; an unmodified click still navigates in place exactly as
// before.
//
// Two notes on how the tab is opened. The URL is rebuilt from the row, which
// carries the item's id in its DOM id and its kind in data-item-type and nothing
// else — so a kind with no known path (the palette also lists actions like "New
// chat") is left alone and falls through to claude's own handler, rather than
// opening a guess in a tab the user then has to close. And the tab itself is
// opened by clicking a throwaway anchor rather than calling window.open, so the
// browser applies its own disposition rules: the accelerator lands a background
// tab and accelerator+Shift a foreground one, the way every link on the page does.
(function () {
  "use strict";

  // The palette's results list, and one row inside it. Both are claude's own
  // markup: the listbox is #command-palette-results and every option's id is the
  // item's id under a fixed prefix.
  var RESULTS_SEL = "#command-palette-results";
  var ITEM_SEL = '[role="option"][id^="command-palette-item-"]';
  var ID_PREFIX = "command-palette-item-";

  // What each kind of result's page lives under. Kinds absent from here (the
  // palette also lists actions like "New chat") are not ours to intercept.
  var PATHS = {
    conversation: "/chat/",
    code_session: "/code/",
    project: "/project/"
  };

  // Item ids are uuids or "session_<base62>". Anything else is refused rather
  // than pasted into a URL.
  var SAFE_ID = /^[A-Za-z0-9_-]+$/;

  var started = false;

  // ---------- what was clicked ----------

  // The palette row an event landed on, or null when the event came from
  // anywhere else — including our own throwaway anchor, which sits outside the
  // list but still passes through the capture phase.
  function itemFrom(node) {
    var item = CPP.util.closestEl(node, ITEM_SEL);
    if (!item || !item.closest(RESULTS_SEL)) return null;
    return item;
  }

  // The currently highlighted row — what Enter would open.
  function selectedItem() {
    var list = document.querySelector(RESULTS_SEL);
    return list ? list.querySelector(ITEM_SEL + '[aria-selected="true"]') : null;
  }

  // The absolute URL a row points at, or null when we can't say. Nothing is
  // opened on a null: the click is handed back to claude, which lands the user
  // in the right place in this tab rather than a 404 in a new one.
  function hrefFor(item) {
    var id = (item.id || "").slice(ID_PREFIX.length);
    if (!id || !SAFE_ID.test(id)) return null;
    var base = PATHS[item.getAttribute("data-item-type")];
    return base ? location.origin + base + id : null;
  }

  // ---------- opening it ----------

  // Which gesture, if any, means "not in this tab". CPP.util.accel is the
  // platform's "open this elsewhere" modifier, and it matters here that it is
  // strict about which key: on macOS Ctrl+click is the secondary click, so
  // answering it with a tab takes the context menu away from the user. Alt is
  // excluded too — Chrome reads Alt+click as a download, which isn't ours to
  // reinterpret.
  function wantsNewTab(e) {
    if (e.altKey) return false;
    if (e.button === 1) return true; // middle-click
    if (e.button !== 0) return false; // right, back, forward
    return CPP.util.accel(e);
  }

  // Open `href` away from this tab, leaving the choice of *where* to the
  // browser: it reads the modifiers on the click, so this lands wherever the
  // same gesture on a real link would. The accelerator is asserted rather than
  // copied — it was held (or, for a middle-click, meant) by definition of our
  // getting here — and target=_blank is the floor under it, so however the
  // browser treats a synthetic click's modifiers, the result is never this tab.
  // Shift rides along, promoting the background tab to a foreground one; a
  // middle-click carries no modifiers of its own and has always meant background.
  function openAway(href, e) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("data-cpp", "search-new-tab");
    a.style.display = "none";
    document.body.appendChild(a);

    var init = {
      view: window,
      bubbles: false,
      cancelable: true,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: e.button === 1 ? false : !!e.shiftKey
    };
    init[CPP.util.IS_MAC ? "metaKey" : "ctrlKey"] = true;

    try {
      a.dispatchEvent(new MouseEvent("click", init));
    } finally {
      a.remove();
    }
  }

  // ---------- the events ----------

  // Capture phase throughout, so the gesture is ours before React's handler on
  // the row runs — otherwise the palette navigates this tab as well and the new
  // tab is pointless. stopImmediatePropagation is what actually holds the
  // palette open; preventDefault stops the middle-click autoscroll cursor.
  function claim(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onPointer(e) {
    if (!wantsNewTab(e)) return;
    var item = itemFrom(e.target);
    if (!item) return;
    var href = hrefFor(item);
    if (!href) return;
    // mousedown only blocks the row from acting early; the tab is opened on the
    // click that follows, so a press-and-drag-away never opens anything.
    if (e.type !== "mousedown") openAway(href, e);
    claim(e);
  }

  // Ctrl/⌘+Enter is the keyboard half: the palette already shows "Enter" as the
  // hint on the highlighted row, and this is that row in a new tab.
  function onKeydown(e) {
    if (e.isComposing || e.key !== "Enter" || e.altKey) return;
    if (!CPP.util.accel(e)) return;
    var item = selectedItem();
    if (!item) return;
    var href = hrefFor(item);
    if (!href) return;
    openAway(href, e);
    claim(e);
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "search-new-tab",

    onInit: function () {
      if (started) return;
      started = true;
      window.addEventListener("mousedown", onPointer, true);
      window.addEventListener("click", onPointer, true);
      // Middle-click stopped firing `click` in Chrome; `auxclick` is where a
      // non-primary button now lands.
      window.addEventListener("auxclick", onPointer, true);
      window.addEventListener("keydown", onKeydown, true);
    },

    onTeardown: function () {
      started = false;
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("click", onPointer, true);
      window.removeEventListener("auxclick", onPointer, true);
      window.removeEventListener("keydown", onKeydown, true);
    }
  });
})();
