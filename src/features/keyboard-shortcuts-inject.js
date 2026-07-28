// Feature: Keyboard shortcuts injection
//
// Injects Claude++ keyboard shortcuts into claude.ai's own Keyboard shortcuts
// dialog (Ctrl+/). Watches for the dialog to appear, finds the "In chats"
// section, and appends entries for the shortcuts that the extension adds:
//
//   Alt+↑  Previous message       (scroll-nav)
//   Alt+↓  Next message           (scroll-nav)
//   Shift+Tab  Draft mode         (draft-mode)
//   Ctrl+S  Stash prompt          (prompt-stash; ⌘S on macOS)
//
// The dialog is owned by React and unmounted/remounted on each open, so we
// observe body-level mutations and re-inject whenever the dialog reappears.
// Entries are marked with a data attribute so they can be removed before
// re-injection, avoiding duplicates.
(function () {
  "use strict";

  var ATTR = "data-cpp-shortcut";
  var DIALOG_SEL = '[role="dialog"]';

  // The accelerator these shortcuts are actually bound to on this machine.
  // prompt-stash answers to ⌘S on a Mac and labels its own card that way, so a
  // dialog row reading "Ctrl S" there names a chord that does nothing.
  var ACCEL = CPP.util.IS_MAC ? "⌘" : "Ctrl";

  var SHORTCUTS = [
    { label: "Previous message", keys: ["Alt", "↑"] },
    { label: "Next message", keys: ["Alt", "↓"] },
    { label: "Draft mode", keys: ["Shift", "Tab"] },
    { label: "Stash prompt", keys: [ACCEL, "S"] }
  ];

  // Build one shortcut row matching claude's own markup.
  function buildRow(label, keys) {
    var row = document.createElement("div");
    row.className = "flex items-center justify-between py-2 border-b-0.5 last:border-0 border-border-300";
    row.setAttribute(ATTR, "");

    var span = document.createElement("span");
    span.className = "flex items-center gap-2 text-sm text-text-200";
    span.textContent = label;

    var kbdWrap = document.createElement("span");
    kbdWrap.className = "flex items-center gap-2";

    var inner = document.createElement("div");
    inner.className = "flex items-center gap-1 gap-1.5";

    keys.forEach(function (k) {
      var kbd = document.createElement("kbd");
      kbd.className = "font-base select-none inline-flex items-center justify-center rounded-[4px] min-w-7 h-7 px-2 bg-bg-300";
      kbd.textContent = k;
      inner.appendChild(kbd);
    });

    kbdWrap.appendChild(inner);
    row.appendChild(span);
    row.appendChild(kbdWrap);
    return row;
  }

  // Find the "In chats" section header inside the dialog, then walk its
  // sibling elements to locate the last shortcut row in that section.
  function findInsertTarget(dialog) {
    var headers = dialog.querySelectorAll("div.font-base.mt-5.py-2");
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].textContent.trim() === "In chats") {
        // The section's rows are the siblings after the header, stopping at the
        // next section header or end of the parent.
        var parent = headers[i].parentElement;
        var nodes = parent ? parent.children : [];
        var lastRow = null;
        var inSection = false;
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j] === headers[i]) { inSection = true; continue; }
          if (inSection && nodes[j].classList.contains("font-base") && nodes[j].classList.contains("mt-5")) break;
          if (inSection) lastRow = nodes[j];
        }
        return lastRow;
      }
    }
    return null;
  }

  function inject() {
    var dialog = document.querySelector(DIALOG_SEL);
    if (!dialog) return;

    // Don't inject twice.
    if (dialog.querySelector("[" + ATTR + "]")) return;

    var target = findInsertTarget(dialog);
    if (!target) return;

    var frag = document.createDocumentFragment();
    SHORTCUTS.forEach(function (s) {
      frag.appendChild(buildRow(s.label, s.keys));
    });
    target.parentElement.insertBefore(frag, target.nextSibling);
  }

  var observer = null;
  var started = false;

  function onMutations() {
    inject();
  }

  CPP.registerFeature({
    id: "keyboard-shortcuts-inject",

    onInit: function () {
      if (started) return;
      started = true;
      // Observe new dialogs appearing. The dialog is portaled to <body>.
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
      inject();
    },

    onTeardown: function () {
      started = false;
      if (observer) { observer.disconnect(); observer = null; }
      // Clean up any rows we injected (dialog may still be open).
      var rows = document.querySelectorAll("[" + ATTR + "]");
      for (var i = 0; i < rows.length; i++) rows[i].remove();
    }
  });
})();
