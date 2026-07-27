// Feature: Delete file confirmation
//
// Removing a file from a project's Context panel is instant and unprompted: the
// × on a thumbnail sits under the pointer the moment you hover a tile, and the
// bulk Delete that appears once files are selected takes the whole selection in
// one click. Either way the file is gone, and re-uploading it is the only way
// back. This puts an "are you sure" in front of both.
//
// HOW IT INTERCEPTS. A capture-phase click listener on the document, which runs
// before React's own root listener, so a delete is stopped dead
// (preventDefault + stopImmediatePropagation) rather than confirmed after the
// fact. Once the user confirms, the very same control is found again and
// clicked with the guard standing down — so the delete goes through claude's
// own code path, not ours. Nothing is deleted by us, and a cancel leaves the
// page exactly as it was.
//
// WHICH CLICKS COUNT. The per-file × is identified structurally: it's the
// button that is a direct child of a thumbnail wrapper (the tile's own open
// button and its checkbox are nested deeper, so neither matches). The bulk
// Delete has no such landmark, so it's matched on its label — but only when
// something is actually selected, which is the state that button exists for.
// That pairing is what keeps the label test from firing on unrelated chrome.
//
// The row × in Claude++'s own list view is deliberately skipped: it doesn't
// delete anything itself, it forwards to the tile's × — which this guards. So
// list and grid share one confirmation and can't double-prompt.
(function () {
  "use strict";

  var ctx = null;

  var DELETE_RE = /\b(delete|remove)\b/i;

  // Where the panel, the tiles and the "is it ticked?" test live:
  // CPP.projectFiles (src/project-files.js), shared with the grid/list view
  // feature. That module also records why selection can't be read from
  // input.checked — the trap that once let a bulk delete through unguarded.
  var PF = null; // CPP.projectFiles, bound at init

  var bypass = false; // set while re-issuing a click the user has confirmed
  var dialog = null;
  var lastFocus = null;

  // ---------- classifying a click ----------

  // The bulk Delete: a labelled control inside the panel but outside the grid.
  // Re-found rather than remembered, since React is free to re-render the
  // toolbar while the confirmation is open.
  function findBulkButton() {
    var grid = PF.grid();
    var panel = PF.panelRoot(grid);
    if (!panel || !grid) return null;
    var els = panel.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (grid.contains(el) || el.closest(ctx.util.OUR_UI)) continue;
      if (DELETE_RE.test(ctx.util.labelOf(el))) return el;
    }
    return null;
  }

  function findTileRemove(name) {
    var list = PF.tiles();
    for (var i = 0; i < list.length; i++) {
      if (PF.nameOf(list[i]) === name) return PF.removeButton(list[i]);
    }
    return null;
  }

  // What, if anything, this click would delete. Returns null for every click
  // that isn't a delete, which is nearly all of them — so the common path is
  // two cheap checks and out.
  function classify(el) {
    // The tile branch first: it is decided by the click's own ancestors, so it
    // costs nothing. Only if that misses do we pay for a document query — and
    // only after the label test, the cheapest way to rule out the overwhelming
    // majority of clicks.
    var item = el.closest(PF.ITEM_SEL);
    if (item) {
      var grid = PF.grid();
      if (!grid || !grid.contains(item)) return null;
      // Only the tile's own × — a direct child of the wrapper. The thumbnail's
      // open button and the select checkbox both sit deeper in.
      if (el.parentElement !== item) return null;
      var name = PF.nameOf(item);
      if (!name) return null;
      return {
        count: 1,
        names: [name],
        find: function () { return findTileRemove(name); }
      };
    }

    var label = ctx.util.labelOf(el);
    if (!DELETE_RE.test(label)) return null;
    // A bulk delete only means anything when files are selected; requiring that
    // is what stops the label test from firing on unrelated buttons. Two
    // independent readings of "how many", because either can come up short:
    // the tiles, and claude's own "Delete N selected item(s)" on the button.
    var bulkGrid = PF.grid();
    var names = bulkGrid ? PF.selectedNames(bulkGrid) : [];
    var m = /(\d+)\s+selected/i.exec(label);
    var count = names.length || (m ? parseInt(m[1], 10) : 0);
    if (!count) return null;
    // Being inside the Context panel is what keeps a "Delete" elsewhere on the
    // page out of this. When the panel can't be located at all, a label that
    // counts the selection itself ("Delete 2 selected items") is specific
    // enough to stand on its own — and not guarding is the costlier mistake.
    var panel = PF.panelRoot(bulkGrid);
    if (panel ? !panel.contains(el) : !m) return null;
    return {
      count: count,
      names: names,
      // The control the user actually clicked, so confirming can never land on
      // some other delete; re-found only if React has since replaced it.
      find: function () {
        return document.contains(el) ? el : findBulkButton();
      }
    };
  }

  function onClickCapture(e) {
    if (bypass) return;
    // This sees every click in the page and nearly all of them are irrelevant,
    // so the early-out is ordered cheapest first: a regex on the URL rules out
    // every chat and settings page before any DOM is touched.
    if (!ctx.util.currentProjectId()) return;
    var el = e.target && e.target.closest
      ? e.target.closest('button, [role="button"]')
      : null;
    if (!el) return;
    // Anything Claude++ drew is not claude.ai's delete. The list view's row ×
    // forwards to the tile's ×, which is the click that gets guarded, and the
    // dialog's own Delete button is a labelled delete sitting inside the panel
    // — intercepting either would prompt twice or trap the confirmation.
    if (el.closest(ctx.util.OUR_UI)) return;
    var target = classify(el);
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Swallowed whether or not a dialog is already up: bailing out early on an
    // open dialog would let a second click through unguarded.
    if (!dialog) open(target);
  }

  // ---------- the confirmation ----------

  // Wording follows the project-delete dialog (delete-guard.js) so the two read
  // as the same warning: a heading that names the target, a plain "are you
  // sure" line, then a blank line and the amber ⚠️ notice spelling out what
  // goes. Everything except that dialog's type-the-name input — deleting a file
  // doesn't warrant making someone spell it out.

  function plural(n) {
    return n === 1 ? "file" : "files";
  }

  // True when every file at stake could be named. A bulk delete whose count
  // came off claude's button label may know how many without knowing which.
  function named(target) {
    return target.names.length > 0;
  }

  // One file and many read the same way — a count in the heading and the
  // question, the names in the list below. A single file used to be special-
  // cased into the heading and named inline, which meant the two sizes of the
  // same dialog looked like two different dialogs.
  function countOf(target) {
    return target.count + " " + plural(target.count);
  }

  // The warning block: the ⚠️ lead, what's going, then "This can't be undone."
  // set apart on its own line.
  //
  // Files are listed one per line rather than run together in a sentence —
  // claude's file names are long and near-identical often enough
  // (…EMRS2026FAQs 1.pdf beside …EMRS2026ApplicationGuidelines 1.pdf) that a
  // comma-separated run is unreadable at exactly the moment it matters most.
  // The list scrolls past a few items, so a large selection can be named in
  // full without the dialog growing off-screen. A lone file is listed too, so
  // one and many are the same dialog at different sizes.
  //
  // The inline fallback is for a bulk delete whose count came off claude's
  // button label without the tiles being readable: there is a number to show
  // but no names to list.
  function buildWarning(target) {
    var box = document.createElement("div");
    box.className = "cpp-del-warning";

    var lead = document.createElement("p");
    lead.className = "cpp-confirm-lead";
    box.appendChild(lead);

    if (named(target)) {
      lead.textContent = "⚠️ This will permanently remove";
      var list = document.createElement("ul");
      list.className = "cpp-confirm-files";
      target.names.forEach(function (name) {
        var li = document.createElement("li");
        // Text, not innerHTML — a file name carrying markup can't inject
        // anything this way.
        li.textContent = name;
        list.appendChild(li);
      });
      box.appendChild(list);
    } else {
      var subject = document.createElement("strong");
      subject.textContent = target.count + " selected " + plural(target.count);
      lead.append("⚠️ This will permanently remove ", subject, ".");
    }

    var final = document.createElement("p");
    final.className = "cpp-confirm-final";
    final.textContent = "This can't be undone.";
    box.appendChild(final);

    return box;
  }

  function close() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) {}
    }
    lastFocus = null;
  }

  function confirmed(target) {
    var btn = target.find();
    close();
    if (!btn) return;
    // Through claude's own control, with the guard standing down — so the
    // delete follows exactly the path it would have without us.
    bypass = true;
    try { btn.click(); } finally { bypass = false; }
  }

  function open(target) {
    lastFocus = document.activeElement;

    var back = document.createElement("div");
    back.className = "cpp-modal-overlay";
    // Marks it as ours, so the click guard doesn't read the dialog's own
    // Delete button as a delete to confirm (see CPP.util.OUR_UI).
    back.dataset.cpp = "confirm";

    var box = document.createElement("div");
    box.className = "cpp-modal cpp-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");

    var title = document.createElement("h2");
    title.className = "cpp-modal-title";
    title.id = "cpp-confirm-title";
    title.textContent = "Delete " + countOf(target);
    box.setAttribute("aria-labelledby", title.id);

    var body = document.createElement("p");
    body.className = "cpp-confirm-body";
    body.id = "cpp-confirm-body";
    body.textContent =
      "Are you sure you want to delete " + countOf(target) +
      " from this project?";
    box.setAttribute("aria-describedby", body.id);

    // Wears the same class the project-delete warning does, so both dialogs
    // pick up one definition of the amber notice and can't drift apart.
    var warning = buildWarning(target);

    var actions = document.createElement("div");
    actions.className = "cpp-modal-actions";

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cpp-modal-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);

    var go = document.createElement("button");
    go.type = "button";
    go.className = "cpp-confirm-go";
    go.textContent = "Delete";
    go.addEventListener("click", function () { confirmed(target); });

    actions.appendChild(cancel);
    actions.appendChild(go);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(warning);
    box.appendChild(actions);
    back.appendChild(box);

    back.addEventListener("click", function (e) {
      if (e.target === back) close();
    });
    // Keys are handled on the dialog and stopped there, so claude's own
    // shortcuts don't also act on them while it's open.
    back.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        return close();
      }
      if (e.key !== "Tab") return;
      // Two focusable controls, so the trap is just a swap at either end.
      var first = cancel;
      var last = go;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    document.body.appendChild(back);
    dialog = back;
    // Cancel takes focus, not Delete: Enter on a dialog you didn't mean to
    // open should be the harmless answer.
    cancel.focus();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "file-delete-guard",

    onInit: function (c) {
      ctx = c;
      PF = CPP.projectFiles;
      document.addEventListener("click", onClickCapture, true);
    },

    onTeardown: function () {
      document.removeEventListener("click", onClickCapture, true);
      close();
    }
  });
})();
