// Feature: Bookmarks page
//
// The bookmarks feature (src/features/bookmarks.js) pins passages inside a chat,
// but a bookmark is only visible while you're in the chat that owns it. This adds
// a place to see them all: a "Bookmarks" entry in claude.ai's left sidebar (under
// Customize) that opens a full-page list of every bookmark across every chat —
// modelled on claude's own Chats/recents page.
//
// Click a row to jump to its passage (we navigate to the chat and scroll there),
// search or filter by chat to narrow the list, and use a row's ⋮ menu to delete.
//
// This module owns none of the bookmark data model — it reads the same
// "cppBookmarks:<chatId>" storage keys bookmarks.js writes, and reuses
// CPP.anchor to resolve and scroll to the bookmarked passage after navigation.
// So it needs no changes to bookmarks.js and works even if that feature is off.
//
// Two things worth knowing about the "page":
//   • It's a fixed, opaque overlay on <body>, not a real route — claude's SPA
//     router doesn't own /bookmarks. We pushState the URL ourselves and render
//     over whatever page is underneath, starting at the sidebar's right edge so
//     the sidebar stays usable; onApply reconciles the overlay against
//     location.pathname, so clicking any real sidebar link (or Back) closes it.
//   • Navigating to a bookmark is a full reload (location.assign): the scroll has
//     to run on the *chat* page, so we hand the target off through storage
//     (cppBookmarkGoto) and pick it up here after the reload.
(function () {
  "use strict";

  var A = CPP.anchor;
  var ctx = null;

  var PATH = "/bookmarks";
  var BM_PREFIX = "cppBookmarks:";
  var GOTO_KEY = "cppBookmarkGoto";
  var NAMES_KEY = "cppChatNames"; // cache of chatId -> human title

  // Live page state. items/names feed the list; the two filter fields are the
  // toolbar's current search term and chat selection.
  var state = { items: [], names: {} };
  var searchTerm = "";
  var filterChatId = "";

  var pageEl = null; // the overlay, or null when not shown
  var menuEl = null; // an open kebab menu, or null
  var pendingGoto = null; // a scroll target read from storage after a reload
  var gotoTries = 0;
  var warnedNoCustomize = false;

  // ---------- small helpers ----------

  function setObj(key, value) {
    var o = {};
    o[key] = value;
    return o;
  }

  function nameFor(id) {
    var n = state.names[id];
    return n && n.trim() ? n : "Chat " + id.slice(0, 8);
  }

  // ---------- load bookmarks + chat names ----------

  // Every bookmark across every chat, flattened. get(null) returns the whole
  // store; the rows under each key are bookmarks.js's own array shape.
  function loadAll() {
    return ctx.util.get(null).then(function (all) {
      var items = [];
      Object.keys(all || {}).forEach(function (key) {
        if (key.indexOf(BM_PREFIX) !== 0) return;
        var chatId = key.slice(BM_PREFIX.length).toLowerCase();
        var rows = all[key];
        if (!Array.isArray(rows)) return;
        rows.forEach(function (row) {
          if (!row || !row.anchor) return;
          items.push({ chatId: chatId, id: row.id, anchor: row.anchor });
        });
      });
      return items;
    });
  }

  // Resolve chat ids to titles via claude's own conversations list (the same
  // endpoint create-project uses). Best-effort: a deleted/archived chat simply
  // falls back to a shortened id in nameFor().
  function fetchChatNames() {
    var org = ctx.util.getOrgId();
    if (!org) return Promise.resolve({});
    return fetch(
      "/api/organizations/" + org +
        "/chat_conversations_v2?limit=200&offset=0&consistency=eventual",
      { credentials: "same-origin" }
    )
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var map = {};
        ctx.util.extractConversations(data).forEach(function (c) {
          var id = ((c.uuid || c.id || "") + "").toLowerCase();
          if (id && c.name) map[id] = c.name;
        });
        return map;
      })
      .catch(function () { return {}; });
  }

  // Reload bookmarks, render what we have immediately, fill in names from the
  // cache, and only hit the network when some chat still has no name — so routine
  // refreshes (a delete, a cross-tab change) don't re-request the whole list.
  function refresh() {
    loadAll().then(function (items) {
      state.items = items;
      renderList();

      ctx.util.get(NAMES_KEY).then(function (d) {
        var cached = (d && d[NAMES_KEY]) || {};
        state.names = Object.assign({}, cached, state.names);
        renderList();

        var missing = state.items.some(function (it) { return !state.names[it.chatId]; });
        if (!missing) return;
        fetchChatNames().then(function (fresh) {
          if (!fresh || !Object.keys(fresh).length) return;
          state.names = Object.assign({}, state.names, fresh);
          ctx.util.set(setObj(NAMES_KEY, state.names));
          renderList();
        });
      });
    });
  }

  // ---------- the page overlay ----------

  // Built to mirror claude's own /recents ("Chats and tasks") page: same serif
  // heading, the same TextInput search field, and a secondary "Filter by" button
  // in the header actions. We reuse claude's utility classes verbatim (they're in
  // claude's global stylesheet because that page uses them) and nest everything
  // in a .cds-root so the CDS design tokens (fill/text/shadow) resolve on our
  // body-parented overlay. syncTheme keeps its light/dark mode in step.
  var SEARCH_SVG =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"></circle>' +
    '<line x1="14" y1="14" x2="10.5" y2="10.5"></line></svg>';

  function ensurePage() {
    if (pageEl) return;
    var root = document.createElement("div");
    root.className = "cpp-bmpage";
    root.innerHTML =
      '<div class="cds-root text-primary cpp-bmpage-cds">' +
      '  <div class="sticky top-0 cpp-bmpage-head">' +
      '    <header class="@container mx-auto flex min-h-12 w-full max-w-4xl justify-between gap-md px-4 pt-3 md:px-8 items-center">' +
      '      <h1 class="font-heading text-2xl text-primary">Bookmarks</h1>' +
      '      <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-sm">' +
      '        <button type="button" class="cpp-bmpage-filterbtn cds-reset group/btn relative isolate inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none border-0 outline-none focus-visible:outline-hidden rounded h-control font-sans text-body font-medium transition-shadow duration-fast focus-visible:shadow-focus text-primary px-md">' +
      '          <span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] transition-colors duration-fast bg-fill-secondary group-hover/btn:bg-fill-secondary-hover inset-0 cds-btn-squish shadow-field"></span>' +
      '          <span class="inline-flex min-w-0 items-center gap-1"><span class="text-muted">Filter by</span> <span class="cpp-bmpage-filterval">All</span><span class="cpp-bmpage-filtericon shrink-0 opacity-60"></span></span>' +
      "        </button>" +
      "      </div>" +
      "    </header>" +
      '    <div class="relative mx-auto w-full max-w-4xl px-4 pt-4 md:px-8 pb-3">' +
      '      <div role="search" class="w-full">' +
      '        <div data-cds="TextInput" data-size="lg" class="h-control pl-md rounded bg-fill-field shadow-field-ring font-sans text-body text-primary transition duration-fast pr-md inline-flex cursor-text items-center gap-[var(--cds-pad-sm,6px)] has-[:focus-visible]:shadow-focus w-full">' +
      '          <span class="flex shrink-0 items-center text-muted cpp-bmpage-searchicon"></span>' +
      '          <input class="cds-input cds-reset min-w-0 flex-1 h-full bg-transparent border-0 p-0 outline-none focus-visible:outline-hidden text-body text-primary focus-visible:shadow-none placeholder:text-muted" type="text" placeholder="Search bookmarks..." aria-label="Search bookmarks">' +
      "        </div>" +
      "      </div>" +
      "    </div>" +
      "  </div>" +
      '  <div class="mx-auto w-full flex-1 px-4 md:px-8 max-w-4xl pb-16">' +
      '    <div class="cpp-bmpage-list"></div>' +
      "  </div>" +
      "</div>";
    document.body.appendChild(root);
    pageEl = root;
    positionPage();
    syncTheme();

    root.querySelector(".cpp-bmpage-searchicon").innerHTML = SEARCH_SVG;
    root
      .querySelector(".cpp-bmpage-filtericon")
      .appendChild(ctx.util.icon(ctx.util.ICON.CHEVRON_DOWN));

    var search = root.querySelector(".cds-input");
    search.value = searchTerm;
    search.addEventListener("input", function () {
      searchTerm = search.value.trim().toLowerCase();
      renderList();
    });

    var filterBtn = root.querySelector(".cpp-bmpage-filterbtn");
    filterBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openMenu(filterBtn, filterItems(), "left");
    });

    renderList();
    refresh();
  }

  // Copy claude's theme data-attributes onto our .cds-root wrapper so the CDS
  // token classes (bg-fill-*, text-*, shadow-*) render in the right light/dark
  // mode. Cheap and idempotent — safe to call on every reconcile.
  function syncTheme() {
    if (!pageEl) return;
    var el = pageEl.querySelector(".cpp-bmpage-cds");
    var src = document.querySelector(".dframe-root") || document.querySelector(".cds-root");
    if (!el || !src) return;
    ["data-mode", "data-density", "data-platform", "data-font"].forEach(function (a) {
      var v = src.getAttribute(a);
      if (v && el.getAttribute(a) !== v) el.setAttribute(a, v);
    });
  }

  // Keep claude's left sidebar clickable by starting the overlay at its right
  // edge (like claude's own Chats page), so the user can navigate away — which
  // is what closes us. Measured live, since the sidebar is resizable and can
  // collapse; falls back to full width when there's no left-docked sidebar.
  function sidebarRightEdge() {
    var cz = findCustomize();
    var bar = cz && cz.closest("nav, aside");
    if (!bar) return 0;
    var r = bar.getBoundingClientRect();
    var docked = r.left <= 1 && r.width > 0 && r.width < window.innerWidth * 0.6;
    return docked ? Math.round(r.right) : 0;
  }

  function positionPage() {
    if (pageEl) pageEl.style.left = sidebarRightEdge() + "px";
  }

  function destroyPage() {
    closeMenu();
    if (pageEl) {
      pageEl.remove();
      pageEl = null;
    }
  }

  function openBookmarksPage() {
    try { history.pushState({}, "", PATH); } catch (e) { /* ignore */ }
    ensurePage();
  }

  // The distinct chats present, as menu items for the "Filter by" dropdown.
  function filterItems() {
    var ids = {};
    state.items.forEach(function (it) { ids[it.chatId] = true; });
    var list = Object.keys(ids)
      .map(function (id) { return { id: id, name: nameFor(id) }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    var items = [{ label: "All chats", onClick: function () { filterChatId = ""; renderList(); } }];
    list.forEach(function (c) {
      items.push({ label: c.name, onClick: function () { filterChatId = c.id; renderList(); } });
    });
    return items;
  }

  function updateFilterLabel() {
    if (!pageEl) return;
    var v = pageEl.querySelector(".cpp-bmpage-filterval");
    if (v) v.textContent = filterChatId ? nameFor(filterChatId) : "All";
  }

  function emptyState(msg) {
    var el = document.createElement("div");
    el.className = "cpp-bmpage-empty";
    el.textContent = msg;
    return el;
  }

  function renderList() {
    if (!pageEl) return;
    var listEl = pageEl.querySelector(".cpp-bmpage-list");

    // Drop a filter that points at a chat with no bookmarks left.
    if (filterChatId && !state.items.some(function (it) { return it.chatId === filterChatId; })) {
      filterChatId = "";
    }
    updateFilterLabel();

    var rows = state.items.filter(function (it) {
      if (filterChatId && it.chatId !== filterChatId) return false;
      if (searchTerm) {
        var hay = ((it.anchor.quote || "") + " " + nameFor(it.chatId)).toLowerCase();
        if (hay.indexOf(searchTerm) === -1) return false;
      }
      return true;
    });

    listEl.textContent = "";
    if (!state.items.length) {
      listEl.appendChild(
        emptyState("No bookmarks yet. Select text in a chat and choose Bookmark.")
      );
      return;
    }
    if (!rows.length) {
      listEl.appendChild(emptyState("No bookmarks match your search."));
      return;
    }
    rows.forEach(function (it) { listEl.appendChild(buildRow(it)); });
  }

  function buildRow(it) {
    var row = document.createElement("div");
    row.className = "cpp-bmpage-row";

    var icon = ctx.util.icon(ctx.util.ICON.BOOKMARK);
    icon.classList.add("cpp-bmpage-row-icon");
    row.appendChild(icon);

    var main = document.createElement("div");
    main.className = "cpp-bmpage-row-main";
    var quote = document.createElement("div");
    quote.className = "cpp-bmpage-quote";
    quote.textContent = it.anchor.quote || "(no text)";
    var chat = document.createElement("div");
    chat.className = "cpp-bmpage-chat";
    chat.textContent = nameFor(it.chatId);
    main.appendChild(quote);
    main.appendChild(chat);
    row.appendChild(main);

    var kebab = document.createElement("button");
    kebab.type = "button";
    kebab.className = "cpp-bmpage-kebab";
    kebab.setAttribute("aria-label", "Bookmark actions");
    kebab.appendChild(document.createTextNode("⋮")); // ⋮
    kebab.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openMenu(kebab, [
        { label: "Delete bookmark", danger: true, onClick: function () { deleteBookmark(it); } }
      ]);
    });
    row.appendChild(kebab);

    row.addEventListener("click", function () { navigateTo(it); });
    return row;
  }

  // ---------- navigate to a bookmark (full reload + handoff) ----------

  function navigateTo(it) {
    ctx.util.set(setObj(GOTO_KEY, { id: it.chatId, anchor: it.anchor })).then(function () {
      location.assign("/chat/" + it.chatId);
    });
  }

  // Runs on the chat page after the reload. Wait until the transcript is mounted
  // enough to scroll from, then hand off to scrollToAnchor (which centres the
  // passage) and drop the stored target. If nothing mounts, give up so the
  // handoff can't strand.
  function tryGoto() {
    if (!pendingGoto) return;
    if (ctx.util.currentChatId() !== pendingGoto.id) return; // not on the target chat yet

    if (!A.scroller() || !A.mountedRange()) {
      if (++gotoTries > 40) clearGoto();
      return;
    }
    // Kick off the scroll once (it drives its own rAF loop), then stop retrying.
    var anchor = pendingGoto.anchor;
    clearGoto();
    scrollToAnchor(anchor);
  }

  // Bring the *bookmarked passage* (not just its message) to the upper part of
  // the transcript. Two things make this fiddly on a fresh chat load:
  //   • the message is virtualized, so it may not be mounted at first, and
  //   • the transcript keeps growing (older messages, images) after we arrive,
  //     which shifts everything — so a one-shot scroll drifts back out of view.
  // We resolve the live range each frame and re-pin it, hold once it's steady,
  // then do a couple of delayed corrections to catch late layout shifts.
  function scrollToAnchor(anchor) {
    var idx = anchor && anchor.msgIndex;
    var tries = 220; // ~3.5s at 60fps to let a long transcript settle
    var held = 0;
    var rechecks = 2;

    // Signed px to move scrollTop so the passage sits ~30% down (capped 200px) —
    // near the top, comfortably clear of the header and always on screen. Null
    // while the message isn't resolvable yet.
    function deltaTo(sc) {
      var res = A.resolve(anchor);
      var range = res && res.range;
      if (!range) return null;
      var rect = range.getClientRects()[0] || range.getBoundingClientRect();
      if (!rect) return null;
      var sr = sc.getBoundingClientRect();
      var desiredY = sr.top + Math.min(sc.clientHeight * 0.3, 200);
      return rect.top - desiredY;
    }

    function step() {
      var sc = A.scroller();
      if (!sc || --tries < 0) return finish();
      var delta = deltaTo(sc);
      if (delta === null) {
        // Not mounted yet: bring the message on-screen so it resolves next frame.
        if (typeof idx === "number") A.scrollToMessage(idx);
        return requestAnimationFrame(step);
      }
      if (Math.abs(delta) > 2) {
        var before = sc.scrollTop;
        sc.scrollTop += delta;
        // scrollTop clamped at the very top/bottom — as close as it can get.
        if (Math.abs(sc.scrollTop - before) < 1) return finish();
        held = 0;
      } else if (++held >= 20) {
        return finish();
      }
      requestAnimationFrame(step);
    }

    // A few late nudges after settling, in case older messages/images load in and
    // push the passage around once the rAF loop has stopped.
    function finish() {
      if (rechecks-- <= 0) return;
      setTimeout(function () {
        var sc = A.scroller();
        if (!sc) return;
        var delta = deltaTo(sc);
        if (delta !== null && Math.abs(delta) > 4) sc.scrollTop += delta;
        finish();
      }, 500);
    }

    requestAnimationFrame(step);
  }

  function clearGoto() {
    pendingGoto = null;
    gotoTries = 0;
    ctx.util.remove(GOTO_KEY);
  }

  // ---------- kebab menu ----------

  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey, true);
  }

  function onDocClick(e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }

  function onDocKey(e) {
    if (e.key === "Escape") closeMenu();
  }

  // Small dropdown, positioned under `btn`. `items` is [{label, danger?, onClick}].
  // `align` "left" pins the menu's left edge to the button (for the filter);
  // otherwise it's right-aligned (for a row's ⋮).
  function openMenu(btn, items, align) {
    closeMenu();
    var menu = document.createElement("div");
    menu.className = "cpp-bmpage-menu";

    items.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "cpp-bmpage-menu-item" + (item.danger ? " cpp-bmpage-menu-danger" : "");
      b.textContent = item.label;
      b.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        item.onClick();
        closeMenu();
      });
      menu.appendChild(b);
    });

    // Append inside the .cds-root wrapper so the menu inherits theme tokens; it's
    // position:fixed, so the DOM parent doesn't affect where it lands.
    (pageEl.querySelector(".cpp-bmpage-cds") || pageEl).appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 4 + "px";
    menu.style.left =
      (align === "left" ? r.left : Math.max(8, r.right - menu.offsetWidth)) + "px";
    menuEl = menu;

    // Defer binding so the click that opened the menu doesn't immediately close it.
    setTimeout(function () {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onDocKey, true);
    }, 0);
  }

  function deleteBookmark(it) {
    var key = BM_PREFIX + it.chatId;
    ctx.util.get(key).then(function (d) {
      var rows = (d && d[key]) || [];
      if (!Array.isArray(rows)) rows = [];
      var next = rows.filter(function (r) { return r && r.id !== it.id; });
      var done = next.length ? ctx.util.set(setObj(key, next)) : ctx.util.remove(key);
      done.then(refresh);
    });
  }

  // ---------- sidebar nav item ----------

  var CLICKABLE = 'a, button, [role="menuitem"], [role="link"], [role="button"]';

  // Icon fonts render as private-use / control codepoints in textContent; strip
  // them so a row like "<icon>Customize" compares as just "customize".
  function labelText(s) {
    return (s || "").replace(/[\u0000-\u001f\ue000-\uf8ff]/g, "").trim();
  }

  // The text contributed by an element's own direct text nodes (not descendants).
  function ownText(el) {
    var s = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    }
    return labelText(s);
  }

  // Find claude's "Customize" sidebar row: the element inside a nav/aside whose
  // own text is "Customize", resolved up to its clickable row. Matching own text
  // (not textContent) avoids picking a wrapper that merely contains the word.
  function findCustomize() {
    var bars = document.querySelectorAll("nav, aside");
    for (var b = 0; b < bars.length; b++) {
      var all = bars[b].querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        if (ownText(all[i]).toLowerCase() === "customize") {
          return all[i].closest(CLICKABLE) || all[i];
        }
      }
    }
    return null;
  }

  // Replace the cloned row's label with ours: prefer the exact "Customize" text
  // node; otherwise overwrite the longest text node (the visible label), leaving
  // any icon glyph nodes alone.
  function setLabel(root, label) {
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var best = null, n;
    while ((n = walk.nextNode())) {
      var t = labelText(n.nodeValue);
      if (!t) continue;
      if (t.toLowerCase() === "customize") { n.nodeValue = label; return; }
      if (!best || t.length > best.len) best = { node: n, len: t.length };
    }
    if (best) best.node.nodeValue = label;
    else root.appendChild(document.createTextNode(label));
  }

  // Swap the cloned row's leading glyph for a bookmark ribbon.
  function swapIcon(root) {
    var icon = root.querySelector(
      '.df-leading-slot [data-cds="Icon"], .df-leading-slot svg, [data-cds="Icon"], svg'
    );
    var glyph = ctx.util.icon(ctx.util.ICON.BOOKMARK);
    glyph.classList.add("cpp-bm-navicon");
    if (icon && icon.parentNode) icon.parentNode.replaceChild(glyph, icon);
    else root.insertBefore(glyph, root.firstChild);
  }

  // Clone claude's "Customize" row so ours inherits its exact structure and
  // classes, then rewrite the label, icon, href, and click.
  function buildNavItem(anchor) {
    var clone = anchor.cloneNode(true);
    clone.id = "cpp-bm-navitem";
    clone.classList.add("cpp-bm-navitem");
    if (clone.tagName === "A") clone.setAttribute("href", PATH);
    // claude's top-nav rows are <button>s driven by a roving-tabindex/selection
    // manager (data-roving-item / data-row-main-button). Strip those so our
    // clone doesn't get pulled into its keyboard nav or selection state.
    ["data-row-key", "aria-current", "data-roving-item", "data-row-main-button",
     "data-row", "data-selected", "aria-keyshortcuts", "tabindex"].forEach(function (a) {
      clone.removeAttribute(a);
    });
    setLabel(clone, "Bookmarks");
    swapIcon(clone);
    clone.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openBookmarksPage();
    });
    return clone;
  }

  function ensureNavItem() {
    if (document.getElementById("cpp-bm-navitem")) return;
    var anchor = findCustomize();
    if (!anchor) {
      // The sidebar may not be mounted yet; onApply will try again. Only grumble
      // once, in case claude renames or restructures the Customize entry.
      if (!warnedNoCustomize) {
        warnedNoCustomize = true;
        console.warn("[cpp] bookmarks-page: no 'Customize' sidebar entry found to anchor to");
      }
      return;
    }
    warnedNoCustomize = false;
    var container = anchor.closest("li, a, [data-row-key]") || anchor;
    if (container.parentNode) {
      container.parentNode.insertBefore(buildNavItem(anchor), container.nextSibling);
    }
  }

  // ---------- lifecycle ----------

  function onStorageChanged(changes, area) {
    if (area !== "local" || !pageEl) return;
    var touched = Object.keys(changes).some(function (k) {
      return k.indexOf(BM_PREFIX) === 0;
    });
    if (touched) refresh();
  }

  function onResize() {
    positionPage();
  }

  // Reflect the active route in the sidebar: our Bookmarks row looks selected on
  // /bookmarks, and claude's own selected row (e.g. "Chats and tasks") is
  // visually neutralized via a body-level class + CSS. We deliberately don't
  // strip claude's data-selected/aria-current — React owns those, and clearing
  // them would leave the correct row un-highlighted after navigating away (React
  // may not re-render it). The CSS override reverses cleanly when the class goes.
  function syncNavActive() {
    var active = location.pathname === PATH;
    var has = document.body.classList.contains("cpp-bm-page-open");
    if (active && !has) document.body.classList.add("cpp-bm-page-open");
    else if (!active && has) document.body.classList.remove("cpp-bm-page-open");

    var item = document.getElementById("cpp-bm-navitem");
    if (!item) return;
    if (active) {
      // Our own element — safe to drive directly; its cloned classes carry the
      // data-[selected=focused] selected styling.
      if (item.getAttribute("data-selected") !== "focused") item.setAttribute("data-selected", "focused");
      if (item.getAttribute("aria-current") !== "page") item.setAttribute("aria-current", "page");
    } else {
      if (item.hasAttribute("data-selected")) item.removeAttribute("data-selected");
      if (item.hasAttribute("aria-current")) item.removeAttribute("aria-current");
    }
  }

  function reconcile() {
    ensureNavItem();
    syncNavActive();
    if (location.pathname === PATH) { ensurePage(); positionPage(); syncTheme(); }
    else if (pageEl) destroyPage();
    tryGoto();
  }

  CPP.registerFeature({
    id: "bookmarks-page",

    onInit: function (context) {
      ctx = context;
      // A scroll target left by a click on the previous page, if any.
      ctx.util.get(GOTO_KEY).then(function (d) {
        pendingGoto = (d && d[GOTO_KEY]) || null;
        if (pendingGoto) tryGoto();
      });
      try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) {}
      window.addEventListener("resize", onResize);
    },

    // Core calls this debounced on DOM churn and SPA navigation: keep the nav
    // item in the sidebar, show/hide the page to match the URL, and finish any
    // pending scroll once the transcript has mounted.
    onApply: function () {
      reconcile();
    },

    onTeardown: function () {
      closeMenu();
      destroyPage();
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) {}
      window.removeEventListener("resize", onResize);
      document.body.classList.remove("cpp-bm-page-open");
      var nav = document.getElementById("cpp-bm-navitem");
      if (nav) nav.remove();
      state = { items: [], names: {} };
      searchTerm = "";
      filterChatId = "";
      pendingGoto = null;
    }
  });
})();
