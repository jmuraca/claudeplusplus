// Feature: Grid or list view for project files
//
// A project's Context panel shows uploaded files as a wall of 120px thumbnails.
// That reads well for a handful of images and badly for thirty PDFs with long,
// similar names — the name isn't shown at all, it's only the tile's
// `data-testid` and the img `alt`. This adds a grid/list switch to the panel
// header and a list view that gives each file a row with its name and kind.
//
// WHY MIRROR THE GRID RATHER THAN RESTYLE IT. The tiles are React's, and the
// list needs the file name as real text — which CSS alone can't add. Rebuilding
// those tiles in place would mean inserting nodes into React-owned children on
// every render pass and racing its reconciliation. So the list is ours end to
// end — a sibling <ul> React never sees — and every action on a row is
// forwarded to the real control it mirrors: clicking a name clicks that tile's
// own button (so the preview modal opens exactly as it does from the grid), the
// row checkbox clicks the tile's checkbox (so claude's own multi-select toolbar
// counts it and deletes it), and the row's × clicks the tile's ×.
//
// That means the real grid has to stay in the document — a control can't be
// clicked once React has unmounted it — so in list view it's clipped to zero
// height and made invisible rather than removed or `display:none`d. Keeping its
// boxes laid out matters: `display:none` collapses every tile's rect to 0×0,
// and anything claude anchors to a tile (a tooltip, a popover, a modal that
// animates out of the thumbnail) would then be positioned against the top-left
// corner of the page. `visibility:hidden` keeps the geometry honest while
// taking the tiles out of the tab order and out of hit-testing.
(function () {
  "use strict";

  var ctx = null;
  var VIEW_KEY = "cppProjectFilesView";

  var view = "grid";
  var loaded = false; // stored preference has been read
  var mounted = false; // we have chrome in the page right now

  // Where the grid, the tiles and the "is it ticked?" test live: CPP.projectFiles
  // (src/project-files.js), shared with the delete-confirmation feature so one
  // restyle on claude's side is a one-file fix on ours.
  var PF = null; // CPP.projectFiles, bound at init

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1] : "";
  }

  // One descriptor per tile, holding the live controls a row forwards to.
  // Re-read on every pass: React replaces these nodes freely, so nothing here
  // is ever cached across renders.
  function readFiles(grid) {
    var out = [];
    PF.tiles(grid).forEach(function (item) {
      var name = PF.nameOf(item);
      if (!name) return; // an upload still in flight has no tile yet
      out.push({
        item: item,
        name: name,
        kind: PF.kindOf(item) || extOf(name),
        open: PF.openButton(item),
        check: PF.checkbox(item),
        remove: PF.removeButton(item)
      });
    });
    return out;
  }

  // The live descriptor a row stands for. Rows keep the file name, not a node
  // reference: a re-render between building the row and clicking it would leave
  // any captured node detached, and the click would go nowhere. The name is key
  // enough — claude already dedupes it, appending a counter ("report 1.pdf"),
  // and it is what the delete guard matches on too.
  function lookup(row) {
    var files = readFiles(PF.grid());
    for (var i = 0; i < files.length; i++) {
      if (files[i].name === row.dataset.cppName) return files[i];
    }
    return null;
  }

  // ---------- the view toggle ----------

  function svg(paths) {
    var NS = "http://www.w3.org/2000/svg";
    var el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", "0 0 20 20");
    el.setAttribute("width", "16");
    el.setAttribute("height", "16");
    el.setAttribute("fill", "currentColor");
    el.setAttribute("aria-hidden", "true");
    paths.forEach(function (d) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      el.appendChild(p);
    });
    return el;
  }

  // Anthropicons has no grid or list glyph (see CPP.util.ICON), so these two
  // are drawn: four tiles, and three rows each led by a bullet.
  function gridIcon() {
    return svg([
      "M3 3.75A.75.75 0 0 1 3.75 3h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-.75.75h-4A.75.75 0 0 1 3 7.75zM11.5 3.75a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1-.75-.75zM3 12.25a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1-.75-.75zM11.5 12.25a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1-.75-.75z"
    ]);
  }

  function listIcon() {
    return svg([
      "M3 5a1 1 0 1 1 2 0 1 1 0 0 1-2 0M3 10a1 1 0 1 1 2 0 1 1 0 0 1-2 0M3 15a1 1 0 1 1 2 0 1 1 0 0 1-2 0",
      "M7 4.5h10a.5.5 0 0 1 0 1H7a.5.5 0 0 1 0-1M7 9.5h10a.5.5 0 0 1 0 1H7a.5.5 0 0 1 0-1M7 14.5h10a.5.5 0 0 1 0 1H7a.5.5 0 0 1 0-1"
    ]);
  }

  // Borrow a neighbouring header button's classes so ours match claude's own
  // sizing, hover and focus exactly — including `aria-pressed:text-accent`,
  // which is what marks the active view. The uploader's trailing `-mr-2` is
  // dropped: that nudge belongs to the last button in the row, not to ours.
  function borrowedClasses(bar) {
    var btn = bar.querySelector('button[data-cds="Button"]');
    if (!btn) return "";
    return (" " + btn.className + " ").replace(/\s-mr-2\s/, " ").trim();
  }

  function makeViewBtn(bar, mode, label, icon) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = ("cpp-view-btn " + borrowedClasses(bar)).trim();
    btn.dataset.cppView = mode;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.appendChild(icon());
    btn.addEventListener("click", function () { setView(mode); });
    return btn;
  }

  function ensureToggle(bar) {
    var group = bar.querySelector(".cpp-view-toggle");
    if (!group) {
      group = document.createElement("div");
      group.className = "cpp-view-toggle";
      group.dataset.cpp = "view-toggle";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "File view");
      group.appendChild(makeViewBtn(bar, "grid", "Grid view", gridIcon));
      group.appendChild(makeViewBtn(bar, "list", "List view", listIcon));
      bar.insertBefore(group, bar.firstChild);
      mounted = true;
    }
    // Written only when it differs — our own attribute writes come back round
    // as mutations, and an unconditional set would re-trigger apply forever.
    var btns = group.querySelectorAll(".cpp-view-btn");
    for (var i = 0; i < btns.length; i++) {
      var want = String(btns[i].dataset.cppView === view);
      if (btns[i].getAttribute("aria-pressed") !== want) {
        btns[i].setAttribute("aria-pressed", want);
      }
    }
  }

  function setView(mode) {
    if (view === mode) return;
    view = mode;
    var save = {};
    save[VIEW_KEY] = mode;
    ctx.util.set(save);
    render();
  }

  // ---------- the list ----------

  function buildRow(f) {
    var row = document.createElement("li");
    row.className = "cpp-file-row";
    row.dataset.cpp = "file-row";
    row.dataset.cppName = f.name;

    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "cpp-file-check";
    check.setAttribute("aria-label", "Select: " + f.name);
    check.addEventListener("click", function (e) {
      e.stopPropagation();
      var live = lookup(row);
      // Clicking the real checkbox — rather than setting `checked` — is what
      // React's change tracking actually notices.
      if (live && live.check) live.check.click();
      else check.checked = false;
    });
    row.appendChild(check);

    var kind = document.createElement("span");
    kind.className = "cpp-file-kind";
    kind.textContent = f.kind;
    row.appendChild(kind);

    var name = document.createElement("button");
    name.type = "button";
    name.className = "cpp-file-name";
    name.textContent = f.name;
    name.title = f.name;
    name.addEventListener("click", function () {
      var live = lookup(row);
      if (live && live.open) live.open.click();
    });
    row.appendChild(name);

    var rm = document.createElement("button");
    rm.type = "button";
    rm.className = "cpp-file-remove";
    rm.setAttribute("aria-label", "Remove " + f.name);
    rm.title = "Remove";
    rm.textContent = "×";
    rm.addEventListener("click", function () {
      var live = lookup(row);
      if (live && live.remove) live.remove.click();
    });
    row.appendChild(rm);

    return row;
  }

  function ensureList(grid, files) {
    var list = grid.nextElementSibling;
    if (!list || !list.classList.contains("cpp-files-list")) {
      list = document.createElement("ul");
      list.className = "cpp-files-list";
      list.dataset.cpp = "file-list";
      grid.insertAdjacentElement("afterend", list);
      mounted = true;
    }

    // Rebuild only when the rows would actually differ. Everything a row draws
    // is in the signature, so an unchanged signature means an unchanged list —
    // and rebuilding regardless would feed our own mutations back into apply.
    var sig = files
      .map(function (f) {
        return [f.name, f.kind].join("");
      })
      .join("");
    if (list.dataset.cppSig !== sig) {
      list.dataset.cppSig = sig;
      list.textContent = "";
      files.forEach(function (f) {
        list.appendChild(buildRow(f));
      });
    }

    // Selection is claude's to own, so it's mirrored on every pass. Assigning
    // the `checked` property changes no attribute and so raises no mutation.
    var sel = files.map(function (f) {
      return PF.isSelected(f.item) ? "1" : "0";
    }).join("");
    if (list.dataset.cppSel !== sel) {
      list.dataset.cppSel = sel;
      var rows = list.children;
      for (var i = 0; i < rows.length && i < files.length; i++) {
        var box = rows[i].querySelector(".cpp-file-check");
        if (box) box.checked = sel.charAt(i) === "1";
      }
    }
    return list;
  }

  function dropList() {
    var list = document.querySelector(".cpp-files-list");
    if (list) list.remove();
  }

  function cleanup() {
    if (!mounted) return;
    mounted = false;
    var group = document.querySelector(".cpp-view-toggle");
    if (group) group.remove();
    dropList();
    var source = document.querySelector(".cpp-files-source");
    if (source) source.classList.remove("cpp-files-source");
  }

  // ---------- lifecycle ----------

  function render() {
    if (!loaded || !ctx) return;
    var grid = ctx.util.currentProjectId() ? PF.grid() : null;
    if (!grid) return cleanup();

    var bar = PF.headerBar();
    if (bar) ensureToggle(bar);

    // Only list view reads the tiles, and grid is the default — while apply
    // runs several times a second on a busy page, a pass that isn't going to
    // draw a list shouldn't build a descriptor (six DOM queries) per tile.
    // firstElementChild answers "is anything uploaded?" on its own. With
    // nothing uploaded there's no list to draw either, so claude's own empty
    // state stays visible whichever view is selected.
    var files =
      view === "list" && grid.firstElementChild ? readFiles(grid) : [];
    if (!files.length) {
      grid.classList.toggle("cpp-files-source", false);
      dropList();
      return;
    }

    grid.classList.toggle("cpp-files-source", true);
    ensureList(grid, files);
  }

  // cppProjectFilesView rides chrome.storage.sync, so the choice can be changed
  // in another tab or on another machine. Reading it once at init and never
  // listening would make it a synced key that doesn't sync — bookmarks-page.js
  // watches its own preference the same way.
  function onStorageChanged(changes, area) {
    if (area !== "local" && area !== "sync") return;
    if (!changes[VIEW_KEY]) return;
    var next = changes[VIEW_KEY].newValue === "list" ? "list" : "grid";
    if (next === view) return;
    view = next;
    render();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "project-files-view",

    onInit: function (c) {
      ctx = c;
      PF = CPP.projectFiles;
      chrome.storage.onChanged.addListener(onStorageChanged);
      ctx.util.get([VIEW_KEY]).then(function (d) {
        view = d[VIEW_KEY] === "list" ? "list" : "grid";
        loaded = true;
        CPP.scheduleApply();
      });
    },

    onApply: function () {
      render();
    },

    onTeardown: function () {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      cleanup();
    }
  });
})();
