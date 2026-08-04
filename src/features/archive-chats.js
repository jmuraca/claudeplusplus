// Feature: Archive Chats
// claude.ai offers keep-or-delete and nothing in between: a finished chat
// either clutters the sidebar and the chat lists forever, or it's gone —
// history, search hits and all. This adds the in-between. An Archive entry in
// a chat's ⋯ menu hides that chat from the left sidebar, from /chats and from
// a project's chat list, while the chat itself is untouched on claude's side —
// it still turns up in ⌘K/Ctrl+K search, and opening it works as ever.
//
// On the /chats and /project/<uuid> lists a "Show archived (N)" pill sits
// above the list whenever it holds archived chats: toggling it lists them
// again, dimmed, where the same ⋯ menu now offers Unarchive. The sidebar
// always hides archived chats — that's the point of archiving.
//
// Everything is presentation: rows are hidden with a class, never removed, so
// claude's own list state is never fought with. The archived set lives in
// chrome.storage.local under cppArchivedChats and is reaped when a chat is
// deleted for real.
(function () {
  "use strict";

  var HIDE_CLASS = "cpp-arch-hidden";
  var DIM_CLASS = "cpp-arch-dim";

  var archived = {}; // conversationUuid -> true
  var showArchived = false;
  var loaded = false;
  var storageBound = false;
  var pointerBound = false;
  var toastEl = null;
  var toastTimer = null;

  // The chat whose row hosted the last pointerdown — i.e. the chat a ⋯ menu
  // opened right after that press belongs to. The menu itself is a portal at
  // the end of <body> with nothing tying it back to its row, so the press that
  // opened it is the only moment the association is visible.
  var lastMenuConv = null;

  // ---- state --------------------------------------------------------------
  function loadState() {
    return CPP.util.get(["cppArchivedChats", "cppShowArchived"]).then(function (d) {
      archived = d.cppArchivedChats || {};
      showArchived = !!d.cppShowArchived;
      loaded = true;
    });
  }

  function saveArchived() {
    CPP.util.set({ cppArchivedChats: archived });
  }

  function setShowArchived(on) {
    showArchived = !!on;
    CPP.util.set({ cppShowArchived: showArchived });
    apply();
  }

  // ---- which page is this? ------------------------------------------------
  // The show-archived toggle (and the "list a hidden chat again" behaviour)
  // only make sense on the pages that ARE chat lists: /chats (claude has also
  // called it /recents) and a project's page.
  function onListPage() {
    return (
      /^\/(chats|recents)(\/|$)/.test(location.pathname) ||
      !!CPP.util.currentProjectId()
    );
  }

  // ---- chat rows ----------------------------------------------------------
  // Every chat entry in the UI paired with its conversation id — the same
  // enumeration project-colors tints by. Sidebar rows carry the id in
  // data-row-key ("chat:<uuid>"); elsewhere it comes from the /chat/<uuid>
  // href, scoped up to the surrounding row. A bare link outside any row is
  // only treated as a row itself in the sidebar or on a list page — anywhere
  // else (a link inside a message, say) hiding it would eat content.
  function chatRows() {
    var util = CPP.util;
    var out = [];
    var seen = new Set();

    function push(el, conv) {
      if (!el || !conv || seen.has(el)) return;
      seen.add(el);
      out.push({ el: el, conv: conv, inNav: util.inSidebar(el) });
    }

    var rows = document.querySelectorAll('[data-row-key^="chat:"]');
    for (var i = 0; i < rows.length; i++) {
      push(rows[i], rows[i].getAttribute("data-row-key").slice(5).toLowerCase());
    }

    var links = document.querySelectorAll('a[href*="/chat/"]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var conv = util.convFromHref(a.getAttribute("href") || "");
      if (!conv) continue;
      var el = a.closest("tr, li, [data-row-key]");
      if (!el && (util.inSidebar(a) || onListPage())) el = a;
      push(el, conv);
    }
    return out;
  }

  // ---- hide / show --------------------------------------------------------
  function apply() {
    if (!loaded) return;

    var targets = chatRows();
    var listArch = new Set(); // archived convs visible-in-principle on the list
    var anchorRow = null; // first list row, for placing the toggle above the list

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var isArch = !!archived[t.conv];
      if (!t.inNav) {
        if (!anchorRow) anchorRow = t.el;
        if (isArch) listArch.add(t.conv);
      }
      // The sidebar always hides an archived chat; the lists follow the
      // show-archived toggle, dimming what they show so archived rows read as
      // set aside rather than current.
      var hide = isArch && (t.inNav || !showArchived);
      t.el.classList.toggle(HIDE_CLASS, hide);
      t.el.classList.toggle(DIM_CLASS, isArch && !hide && !t.inNav);
    }

    updateGroupLabels();
    updateToggle(listArch.size, anchorRow);
    injectMenuItems();
  }

  // ---- group labels -------------------------------------------------------
  // The sidebar heads its chats with group labels — "Pinned", "Today",
  // "Aug 2". Hiding every chat under one and leaving the heading is half a
  // job: a date over nothing reads as a glitch. So after the rows are hidden,
  // each label follows its own rows — hidden when every chat row in its group
  // is, back the moment one returns. A group is the nearest ancestor of the
  // label that holds chat rows, walked up rather than matched by class (the
  // container's classes are styling churn), and never past a container that
  // holds other labels — that one is the whole list, not a group.
  function updateGroupLabels() {
    var labels = document.querySelectorAll("[data-sidebar-group-label]");
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      // The label's own row wrapper, when claude gives it one, so hiding
      // removes the row's spacing along with its text.
      var target = label.closest('[data-row-key^="label:"]') || label;

      var group = null;
      for (
        var node = label.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        if (node.querySelectorAll("[data-sidebar-group-label]").length > 1) break;
        if (node.querySelector('[data-row-key^="chat:"]')) {
          group = node;
          break;
        }
      }

      var hide = false;
      if (group) {
        var rows = group.querySelectorAll('[data-row-key^="chat:"]');
        hide = rows.length > 0;
        for (var j = 0; j < rows.length; j++) {
          if (!rows[j].classList.contains(HIDE_CLASS)) {
            hide = false;
            break;
          }
        }
      }
      target.classList.toggle(HIDE_CLASS, hide);
    }
  }

  function unhideAll() {
    var els = document.querySelectorAll("." + HIDE_CLASS + ", ." + DIM_CLASS);
    for (var i = 0; i < els.length; i++) {
      els[i].classList.remove(HIDE_CLASS);
      els[i].classList.remove(DIM_CLASS);
    }
  }

  // ---- the Show archived toggle -------------------------------------------
  // A pill above the chat list, present only where there is something to
  // reveal: on a list page whose list holds at least one archived chat.
  function updateToggle(count, anchorRow) {
    var bar = document.getElementById("cpp-arch-bar");
    if (!onListPage() || !count || !anchorRow) {
      if (bar) bar.remove();
      return;
    }

    // The list container the anchor row lives in; the bar sits just above it.
    var container = anchorRow.closest("table, ul, ol") || anchorRow.parentElement;
    if (!container || !container.parentElement) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement("div");
      bar.id = "cpp-arch-bar";
      bar.setAttribute("data-cpp", "archive");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.id = "cpp-arch-toggle";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setShowArchived(!showArchived);
      });
      bar.appendChild(btn);
    }
    // React re-renders can shuffle it out of place; put it back above the list.
    if (bar.parentElement !== container.parentElement || bar.nextElementSibling !== container) {
      container.parentElement.insertBefore(bar, container);
    }
    document.getElementById("cpp-arch-toggle").textContent =
      (showArchived ? "Hide archived" : "Show archived") + " (" + count + ")";
  }

  // ---- icon ----------------------------------------------------------------
  // Drawn as inline SVG rather than with CPP.util.icon: Anthropicons carries no
  // glyph names, and the only tray-shaped glyph we know a codepoint for is the
  // download arrow — which reads as "download", not "archive". A storage box
  // with a lid is unmistakable. Stroked in currentColor at the same optical
  // weight as the font's icons, so it sits naturally in the menu.
  function archiveIcon(unarchive) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "cpp-arch-svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var lid = document.createElementNS(NS, "rect");
    lid.setAttribute("x", "3");
    lid.setAttribute("y", "4");
    lid.setAttribute("width", "18");
    lid.setAttribute("height", "4");
    lid.setAttribute("rx", "1");
    svg.appendChild(lid);
    var body = document.createElementNS(NS, "path");
    body.setAttribute("d", "M5 8v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8");
    svg.appendChild(body);
    var mark = document.createElementNS(NS, "path");
    // Archive: the box's handle slot. Unarchive: an arrow rising out of the box.
    mark.setAttribute(
      "d",
      unarchive ? "M12 16.5V11m0 0l-2.5 2.5M12 11l2.5 2.5" : "M10 12.5h4"
    );
    svg.appendChild(mark);
    return svg;
  }

  // ---- the ⋯ menu item ----------------------------------------------------
  // A chat's ⋯ menu is recognised by its delete-chat-trigger — the one item
  // every variant of that menu carries. Our Archive/Unarchive entry goes just
  // above the separator that fences off Delete.
  function injectMenuItems() {
    var dels = document.querySelectorAll(
      '[role="menu"] [data-testid="delete-chat-trigger"]'
    );
    for (var i = 0; i < dels.length; i++) injectOneMenuItem(dels[i]);
  }

  function injectOneMenuItem(del) {
    var menu = del.closest('[role="menu"]');
    if (!menu || menu.querySelector(".cpp-archive-item")) return;
    // The row's press recorded which chat this menu is for; a menu opened from
    // the chat's own header has no row, so the URL answers instead.
    var conv = lastMenuConv || CPP.util.currentChatId();
    if (!conv) return;
    var isArch = !!archived[conv];

    var item = document.createElement("div");
    item.className = "cpp-archive-item";
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-cpp", "archive");
    item.tabIndex = -1;
    item.appendChild(archiveIcon(isArch));
    var label = document.createElement("span");
    label.textContent = isArch ? "Unarchive" : "Archive";
    item.appendChild(label);

    item.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleArchived(conv);
      // Close the menu the way create-project does: hand claude an Escape.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    item.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    // Always directly above Delete, whatever the menu variant holds elsewhere:
    // above the separator only when it is Delete's own fence, never above some
    // earlier section's separator.
    var before = del;
    var prev = del.previousElementSibling;
    if (prev && prev.getAttribute("role") === "separator") before = prev;
    del.parentNode.insertBefore(item, before);
  }

  function toggleArchived(conv) {
    var wasArch = !!archived[conv];
    if (wasArch) delete archived[conv];
    else archived[conv] = true;
    saveArchived();
    apply();
    showToast(
      wasArch
        ? "Chat unarchived"
        : "Chat archived — hidden from lists, still in search (" +
            CPP.util.chord("K") + ")"
    );
  }

  // ---- remembering which chat a menu belongs to ---------------------------
  function recordMenuTarget(e) {
    var util = CPP.util;
    // Presses inside an open menu (ours included) say nothing about rows and
    // must not clobber what the opening press recorded.
    if (util.closest(e.target, '[role="menu"], ' + util.OUR_UI)) return;

    var conv = null;
    var rowKey = util.closestEl(e.target, '[data-row-key^="chat:"]');
    if (rowKey) {
      conv = rowKey.getAttribute("data-row-key").slice(5).toLowerCase();
    }
    if (!conv) {
      var row = util.closestEl(e.target, "tr, li");
      var link = row && row.querySelector('a[href*="/chat/"]');
      if (link) conv = util.convFromHref(link.getAttribute("href") || "");
    }
    if (!conv) {
      var a = util.closestEl(e.target, 'a[href*="/chat/"]');
      if (a) conv = util.convFromHref(a.getAttribute("href") || "");
    }
    lastMenuConv = conv;
  }

  // ---- toast --------------------------------------------------------------
  function showToast(message) {
    hideToast();
    toastEl = document.createElement("div");
    toastEl.className = "cpp-toast";
    toastEl.setAttribute("data-cpp", "archive");
    toastEl.textContent = message;
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(hideToast, 4000);
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  // ---- feature registration -----------------------------------------------
  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "archive-chats",

    onInit: function () {
      if (!pointerBound) {
        pointerBound = true;
        document.addEventListener("pointerdown", recordMenuTarget, true);
      }
      if (!storageBound) {
        storageBound = true;
        chrome.storage.onChanged.addListener(function (changes, area) {
          // Both keys live in .local, but route by name rather than area so a
          // future move to sync can't silently deafen this listener.
          if (area !== "local" && area !== "sync") return;
          if (changes.cppArchivedChats) {
            archived = changes.cppArchivedChats.newValue || {};
            apply();
          }
          if (changes.cppShowArchived) {
            showArchived = !!changes.cppShowArchived.newValue;
            apply();
          }
        });
      }
      return loadState().then(apply);
    },

    onApply: function () {
      apply();
    },

    // A chat deleted for real no longer needs its archived flag. Projects need
    // no handling of their own: core fans a project delete out as chat deletes
    // for every chat project-colors knew was inside.
    onDelete: function (info) {
      if (!info || !loaded || info.kind !== "chat") return;
      if (Object.prototype.hasOwnProperty.call(archived, info.id)) {
        delete archived[info.id];
        saveArchived();
        apply();
      }
    },

    onTeardown: function () {
      if (pointerBound) {
        pointerBound = false;
        document.removeEventListener("pointerdown", recordMenuTarget, true);
      }
      lastMenuConv = null; // never let a stale row outlive the recorder
      hideToast();
      unhideAll();
      var injected = document.querySelectorAll(".cpp-archive-item, #cpp-arch-bar");
      for (var i = 0; i < injected.length; i++) injected[i].remove();
    }
  });
})();
