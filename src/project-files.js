// Claude++ — the project Context panel (isolated-world, loaded after core.js).
//
// Shared by every feature that reaches into a project's uploaded files: the
// grid/list view switch (project-files-view) and the delete confirmation
// (file-delete-guard). Both need to answer the same questions about claude.ai's
// markup — where is the grid, which tiles are in it, what is this one called,
// is it selected, which button removes it — and answering them twice is how the
// two drifted apart once already.
//
// This is the same move core.js makes for the composer ("the selectors and the
// 'is this the composer' test live here once rather than copied into each") and
// anchor.js makes for the transcript: one module owning one hard-won piece of
// claude.ai knowledge, so a restyle on their side is a one-file fix on ours.
//
// The panel, as of this writing:
//
//   <div>                                   ← panelRoot(): holds both of these
//     <div>… <h3>Context</h3> … [buttons]</div>   ← headerBar() is the buttons
//     <div>
//       <div>…selection toolbar, when files are ticked…</div>
//       <ul>                                ← grid()
//         <div class="group/thumbnail">     ← a tile
//           <div data-testid="<file name>"> ← nameOf() reads this
//             <button>…thumbnail…</button>  ← openButton(): the preview
//             <div>…<p>pdf</p>… <label><input type=checkbox>…</label></div>
//           </div>
//           <button>×</button>              ← removeButton(): a DIRECT child
//         </div>
//       </ul>
//
// Two traps are recorded here so no caller has to rediscover them:
//
//   1. SELECTION IS NOT `input.checked`. claude keeps it in React state and
//      styles the box from it directly — a ticked tile's input carries no
//      `checked` at all, and React re-creates that input often enough that the
//      property reads false on a freshly rendered tile. isSelected() falls back
//      to the drawn checkmark. Trusting the property is what once let the first
//      bulk delete of a session through with no confirmation.
//   2. THE REMOVE × IS THE TILE'S DIRECT CHILD. The preview button and the
//      checkbox both sit deeper in, so "a button inside the tile" is not
//      specific enough to mean "the delete control".
(function () {
  "use strict";

  // Tailwind's `group/thumbnail`, matched as a class token rather than written
  // into a selector, where the slash would need escaping.
  var ITEM_SEL = '[class~="group/thumbnail"]';
  var UPLOADER_SEL = '[data-testid="project-doc-uploader-dropdown-trigger"]';

  // The <ul> holding the file tiles, or null when the panel isn't mounted.
  function grid() {
    var item = document.querySelector("ul > " + ITEM_SEL);
    return item ? item.parentElement : null;
  }

  // The header's button row, found via the uploader's testid rather than any
  // visible label, so it doesn't depend on the interface language.
  function headerBar() {
    var add = document.querySelector(UPLOADER_SEL);
    return add ? add.parentElement : null;
  }

  // The panel as a whole: the nearest ancestor holding both the grid and the
  // header's buttons. Derived from those two landmarks rather than matched on a
  // class, so it survives a restyle. Pass the grid in if you already have it.
  function panelRoot(g) {
    g = g || grid();
    if (!g) return null;
    var bar = headerBar();
    if (!bar) return g.parentElement;
    var el = g;
    while (el && !el.contains(bar)) el = el.parentElement;
    return el || g.parentElement;
  }

  function tiles(g) {
    g = g || grid();
    if (!g) return [];
    return Array.prototype.slice.call(g.querySelectorAll(":scope > " + ITEM_SEL));
  }

  // "" for a tile with no name — an upload still in flight has no name yet, and
  // callers use that to skip it.
  function nameOf(item) {
    var tile = item.querySelector("[data-testid]");
    return (tile && tile.getAttribute("data-testid")) || "";
  }

  function checkbox(item) {
    return item.querySelector('input[type="checkbox"]');
  }

  // See trap 1 in the header comment: the drawn checkmark, not the property, is
  // what reliably says "selected".
  function isSelected(item) {
    var box = checkbox(item);
    if (!box) return false;
    if (box.checked) return true;
    var label = box.closest("label") || box.parentElement;
    return !!(label && label.querySelector("svg"));
  }

  // See trap 2: a direct child, which the preview button and checkbox are not.
  // Absent while the panel is in selection mode, so callers must tolerate null.
  function removeButton(item) {
    return item.querySelector(":scope > button");
  }

  function openButton(item) {
    var tile = item.querySelector("[data-testid]");
    return tile ? tile.querySelector("button") : null;
  }

  // The uppercase extension chip claude draws along a thumbnail's bottom edge,
  // lowercased as it stores it ("pdf"); "" when the tile has none.
  // textContent, not plainText — a one-word chip can't contain the block
  // structure innerText exists to render, and innerText forces a layout flush.
  function kindOf(item) {
    var tile = item.querySelector("[data-testid]");
    var badge = tile && tile.querySelector("p");
    return badge ? (badge.textContent || "").trim() : "";
  }

  function selectedNames(g) {
    return tiles(g).filter(isSelected).map(nameOf).filter(Boolean);
  }

  CPP.projectFiles = {
    ITEM_SEL: ITEM_SEL,
    grid: grid,
    headerBar: headerBar,
    panelRoot: panelRoot,
    tiles: tiles,
    nameOf: nameOf,
    kindOf: kindOf,
    checkbox: checkbox,
    isSelected: isSelected,
    removeButton: removeButton,
    openButton: openButton,
    selectedNames: selectedNames
  };
})();
