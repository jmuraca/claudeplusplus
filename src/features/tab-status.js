// Feature: Tab status glyph
// From the browser's tab strip every claude.ai tab looks identical: you can't
// tell the one that's mid-response from the one that answered five minutes ago
// and is waiting on you. This prefixes document.title with a status glyph:
//   ⏳ a response is streaming in this tab
//   ✅ a response finished while you were looking elsewhere
//   ⚠️ the response ended with an error notice
// ✅/⚠️ are "needs attention" markers, so they only appear for tabs that
// finished unattended and clear the moment you come back to the tab.
(function () {
  "use strict";

  var STATUS_GLYPHS = { generating: "⏳", done: "✅", error: "⚠️" };
  var STATUS_GLYPH_RE = /^(?:⏳|✅|⚠️)️?\s*/;

  var tabStatus = null; // null | "generating" | "done" | "error"
  var wasGenerating = false;
  var baseTitle = document.title;

  // Generation state is driven by the completion stream (relayed from
  // inject-main.js via onStream), not the DOM: claude.ai renders tokens on a
  // rAF, which browsers freeze in a backgrounded tab, so a response that
  // finishes while you're elsewhere leaves the DOM stuck mid-stream until you
  // look at it — exactly the case this feature exists for. The network stream
  // ends when the response ends, hidden tab or not.
  var netStreams = 0; // completion streams currently open
  var netSeen = false; // once we've had one, the DOM heuristic is retired
  var netErrored = false;

  // Lifecycle handles kept so onTeardown can fully undo everything.
  var headObserver = null;
  var bodyObserver = null;
  var pollTimer = null;
  var outcomeTimer = null;
  var focusHandler = null;
  var started = false;

  function userIsWatching() {
    return !document.hidden && document.hasFocus();
  }

  // Fallback for before the first stream is seen (e.g. a response already in
  // flight when the extension loaded).
  function domLooksBusy() {
    return !!document.querySelector(
      '[data-is-streaming="true"], [data-testid="stop-button"], ' +
        'button[aria-label*="Stop" i]'
    );
  }

  function isGenerating() {
    if (netStreams > 0) return true;
    return netSeen ? false : domLooksBusy();
  }

  // Error surfaces are less predictable than the streaming flag, so match on
  // the wording as well as the role — a plain toast shouldn't raise ⚠️.
  var ERROR_TEXT_RE =
    /(something went wrong|message limit|rate limit|network error|failed to (?:send|generate|respond)|unable to (?:send|respond)|please try again)/i;

  function hasErrorNotice() {
    if (document.querySelector('[data-testid*="error" i]')) return true;
    var alerts = document.querySelectorAll('[role="alert"]');
    for (var i = 0; i < alerts.length; i++) {
      if (ERROR_TEXT_RE.test(alerts[i].textContent || "")) return true;
    }
    return false;
  }

  function applyTitle() {
    var glyph = tabStatus ? STATUS_GLYPHS[tabStatus] : null;
    var desired = glyph ? glyph + " " + baseTitle : baseTitle;
    if (document.title !== desired) document.title = desired;
  }

  function setTabStatus(next) {
    if (tabStatus === next) return;
    tabStatus = next;
    applyTitle();
  }

  // The SPA rewrites the title on navigation and rename, wiping our prefix;
  // re-derive the base title from whatever it wrote and re-apply.
  function onTitleChanged() {
    baseTitle = document.title.replace(STATUS_GLYPH_RE, "");
    applyTitle();
  }

  // An error notice renders a beat after the stream stops, so re-check for a
  // short window before settling on "finished cleanly".
  function watchForOutcome() {
    // The stream told us how it ended; no need to read tea leaves in the DOM
    // (which is stale anyway in the hidden-tab case).
    if (netSeen) {
      setTabStatus(netErrored ? "error" : "done");
      return;
    }
    setTabStatus(hasErrorNotice() ? "error" : "done");
    var checks = 0;
    if (outcomeTimer) clearInterval(outcomeTimer);
    outcomeTimer = setInterval(function () {
      if (
        ++checks > 4 ||
        tabStatus === "error" ||
        isGenerating() ||
        userIsWatching()
      ) {
        clearInterval(outcomeTimer);
        outcomeTimer = null;
        return;
      }
      if (hasErrorNotice()) setTabStatus("error");
    }, 400);
  }

  function checkTabStatus() {
    var generating = isGenerating();
    if (generating) {
      setTabStatus("generating");
    } else if (wasGenerating) {
      // Just finished. If the user is right here they've already seen it;
      // only unattended tabs get flagged.
      if (userIsWatching()) setTabStatus(null);
      else watchForOutcome();
    } else if (tabStatus && userIsWatching()) {
      setTabStatus(null);
    }
    wasGenerating = generating;
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "tab-status",

    onInit: function () {
      if (started) return;
      started = true;

      onTitleChanged();

      // The <title> text changes, and React can replace the node outright.
      headObserver = new MutationObserver(onTitleChanged);
      headObserver.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true
      });

      focusHandler = function () {
        if (userIsWatching()) setTabStatus(null);
      };
      window.addEventListener("focus", focusHandler);
      window.addEventListener("visibilitychange", focusHandler);

      // Load-bearing for the navigate-away case, and the reason it can't be
      // folded into core's debounced onApply. In a backgrounded tab claude.ai's
      // token rendering (rAF) is frozen, but the data-is-streaming flip and the
      // stop-button removal at stream *end* are plain DOM state changes that
      // still fire — and a MutationObserver callback still runs — so this is
      // what flips the title to ✅ while you're on another tab. onStream is a
      // second signal, but the network stream isn't reliably delivered in the
      // background, so we can't depend on it alone. Attributes are filtered to
      // the streaming/stop-button signals so a live response doesn't wake this
      // on every token.
      bodyObserver = new MutationObserver(checkTabStatus);
      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-is-streaming", "data-testid", "aria-label"]
      });

      // Foreground backstop only — throttled to ~1/min in a hidden tab, so the
      // observer above is what actually makes the transition prompt there.
      pollTimer = setInterval(checkTabStatus, 1000);
      checkTabStatus();
    },

    // Completion-stream events relayed from inject-main.js (MAIN world).
    onStream: function (d) {
      netSeen = true;
      if (d.state === "start") {
        netStreams++;
        netErrored = false;
      } else {
        netStreams = Math.max(0, netStreams - 1);
        if (d.errored) netErrored = true;
      }
      checkTabStatus();
    },

    onTeardown: function () {
      started = false;
      if (headObserver) { headObserver.disconnect(); headObserver = null; }
      if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (outcomeTimer) { clearInterval(outcomeTimer); outcomeTimer = null; }
      if (focusHandler) {
        window.removeEventListener("focus", focusHandler);
        window.removeEventListener("visibilitychange", focusHandler);
        focusHandler = null;
      }
      // Strip our glyph and leave the app's own title in place.
      tabStatus = null;
      wasGenerating = false;
      netStreams = 0;
      onTitleChanged();
    }
  });
})();
