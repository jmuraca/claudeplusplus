// Feature: Project Colors
// Assign a color to a project via an icon button in the project header (sits
// between the "pin project" button and the "..." menu). Clicking the icon opens
// a small popover with swatches / a custom color. That project's chats then have
// their chat icon tinted the matching color in the left sidebar.
(function () {
  "use strict";

  var PRESETS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"
  ];

  var colors = {}; // projectUuid -> "#rrggbb"
  var chatMap = {}; // conversationUuid -> projectUuid
  var loaded = false;
  var mapDirty = false;
  var saveMapTimer = null;
  var docHandlersBound = false;

  function loadState(ctx) {
    return ctx.util.get(["projectColors", "convProject"]).then(function (d) {
      colors = d.projectColors || {};
      chatMap = d.convProject || {};
      loaded = true;
    });
  }

  function saveColors(ctx) {
    ctx.util.set({ projectColors: colors });
  }

  function saveMapSoon(ctx) {
    if (saveMapTimer) clearTimeout(saveMapTimer);
    saveMapTimer = setTimeout(function () {
      if (!mapDirty) return;
      mapDirty = false;
      ctx.util.set({ convProject: chatMap });
    }, 800);
  }

  function colorForConv(conv) {
    if (!conv) return null;
    var proj = chatMap[conv];
    // A chat inherits its project's color; a project's own nav entry (whose
    // uuid is the project itself) is colored too.
    return (proj && colors[proj]) || colors[conv] || null;
  }

  // ---- colored chat icons -------------------------------------------------
  // Collect every chat entry in the UI, each paired with its conversation id.
  // Sidebar rows carry the id in data-row-key ("chat:<uuid>"); elsewhere the
  // id comes from the /chat/<uuid> href.
  function chatTargets(ctx) {
    var out = [];
    var rows = document.querySelectorAll('[data-row-key^="chat:"]');
    for (var i = 0; i < rows.length; i++) {
      out.push({
        el: rows[i],
        conv: rows[i].getAttribute("data-row-key").slice(5).toLowerCase()
      });
    }
    var links = document.querySelectorAll('a[href*="/chat/"], nav a[href], aside a[href]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var conv = ctx.util.convFromHref(a.getAttribute("href") || "");
      if (!conv) continue;
      // The icon can be a sibling of the link (e.g. the recents table), so
      // scope the search to the surrounding row rather than the <a> itself.
      out.push({ el: a.closest("tr, li, [data-row-key]") || a, conv: conv });
    }
    return out;
  }

  // The leading glyph of a chat row (an icon-font span or an inline <svg>).
  function leadingIcon(el) {
    return (
      el.querySelector('.df-leading-slot [data-cds="Icon"]') ||
      el.querySelector(".df-leading-slot svg") ||
      el.querySelector('[data-cds="Icon"]') ||
      el.querySelector("svg")
    );
  }

  function tintIcon(icon, color) {
    icon.classList.add("cpp-tinted");
    icon.style.setProperty("--cpp-tint", color);
  }

  function untintIcon(icon) {
    icon.classList.remove("cpp-tinted");
    icon.style.removeProperty("--cpp-tint");
  }

  function decorate(ctx) {
    var targets = chatTargets(ctx);
    var seen = new Set();
    for (var i = 0; i < targets.length; i++) {
      var icon = leadingIcon(targets[i].el);
      if (!icon || seen.has(icon)) continue;
      seen.add(icon);
      var color = colorForConv(targets[i].conv);
      if (color) tintIcon(icon, color);
      else untintIcon(icon);
    }
    decorateProjectCards(ctx);
    // Drop any floating dots left by earlier versions of this feature.
    var dots = document.querySelectorAll(".cpp-dot");
    for (var k = 0; k < dots.length; k++) dots[k].remove();
  }

  // ---- project-list cards -------------------------------------------------
  // On the projects list (/cowork/projects) each card is an <a href=".../
  // project/<uuid>"> with the project name in a .truncate div. Prepend a small
  // colored circle before the name, tinted with that project's color.
  function decorateProjectCards(ctx) {
    var links = document.querySelectorAll('a[href*="/project/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      // Sidebar/nav project entries already get a tinted leading icon.
      if (a.closest("nav, aside")) continue;
      var m = (a.getAttribute("href") || "").match(ctx.util.PROJECT_RE);
      if (!m) continue;
      var pid = m[1].toLowerCase();
      var name = a.querySelector(".truncate");
      if (!name || !name.parentNode) continue;

      var color = colors[pid];
      var dot = name.previousElementSibling;
      if (!dot || !dot.classList || !dot.classList.contains("cpp-proj-dot")) {
        dot = null;
      }

      if (!color) {
        if (dot) dot.remove();
        continue;
      }
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "cpp-proj-dot";
        dot.setAttribute("aria-hidden", "true");
        name.parentNode.insertBefore(dot, name);
      }
      dot.style.background = color;
    }
  }

  // ---- locate the header toolbar ------------------------------------------
  function labelOf(el) {
    return (
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("title") || "") + " " +
      (el.textContent || "")
    ).toLowerCase();
  }

  // Find the "pin project" button in the project header (ignore sidebar/nav).
  function findPinButton() {
    var els = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest("nav, aside")) continue;
      if (/\bpin\b/.test(labelOf(el))) return el;
    }
    return null;
  }

  // ---- header icon button -------------------------------------------------
  function mountButton(ctx, pid) {
    var btn = document.getElementById("cpp-color-btn");
    if (btn) {
      syncUI(pid);
      return;
    }
    var pin = findPinButton();
    if (!pin || !pin.parentNode) return; // header not ready; retry on next apply

    btn = document.createElement("button");
    btn.id = "cpp-color-btn";
    btn.type = "button";
    btn.className = "cpp-color-btn";
    btn.setAttribute("aria-label", "Project color");
    btn.title = "Project color";
    // Try to visually match neighbouring header icon buttons.
    if (pin.className) btn.className += " " + pin.className;
    btn.innerHTML = '<span class="cpp-btn-dot" aria-hidden="true"></span>';

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePopover(ctx, btn);
    });

    // Insert right after the pin button -> lands between pin and the "..." menu.
    pin.parentNode.insertBefore(btn, pin.nextSibling);
    syncUI(pid);
  }

  function removeButton() {
    var btn = document.getElementById("cpp-color-btn");
    if (btn) btn.remove();
  }

  // ---- popover ------------------------------------------------------------
  function buildPopover(ctx) {
    var pop = document.createElement("div");
    pop.id = "cpp-popover";
    pop.hidden = true;
    pop.innerHTML =
      '<div class="cpp-title">Project color</div>' +
      '<div class="cpp-swatches"></div>' +
      '<div class="cpp-row">' +
      '  <input type="color" class="cpp-input" aria-label="Custom color" />' +
      '  <button type="button" class="cpp-clear">Clear</button>' +
      "</div>";

    var swatches = pop.querySelector(".cpp-swatches");
    PRESETS.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "cpp-swatch";
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.addEventListener("click", function () {
        setColor(ctx, ctx.util.currentProjectId(), c);
      });
      swatches.appendChild(b);
    });

    pop.querySelector(".cpp-input").addEventListener("input", function (e) {
      setColor(ctx, ctx.util.currentProjectId(), e.target.value);
    });
    pop.querySelector(".cpp-clear").addEventListener("click", function () {
      clearColor(ctx, ctx.util.currentProjectId());
    });
    // Clicks inside the popover shouldn't bubble to the outside-close handler.
    pop.addEventListener("click", function (e) { e.stopPropagation(); });

    document.body.appendChild(pop);
    return pop;
  }

  function getPopover(ctx) {
    return document.getElementById("cpp-popover") || buildPopover(ctx);
  }

  function positionPopover(pop, btn) {
    var r = btn.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + "px";
    // Align the popover's right edge with the button's, opening down-left.
    pop.style.right = Math.round(window.innerWidth - r.right) + "px";
  }

  function togglePopover(ctx, btn) {
    var pop = getPopover(ctx);
    if (pop.hidden) openPopover(ctx, btn, pop);
    else closePopover(pop);
  }

  function openPopover(ctx, btn, pop) {
    pop = pop || getPopover(ctx);
    positionPopover(pop, btn);
    pop.hidden = false;
    syncUI(ctx.util.currentProjectId());
    bindDocHandlers();
  }

  function closePopover(pop) {
    pop = pop || document.getElementById("cpp-popover");
    if (pop) pop.hidden = true;
  }

  function bindDocHandlers() {
    if (docHandlersBound) return;
    docHandlersBound = true;
    document.addEventListener("click", function (e) {
      var pop = document.getElementById("cpp-popover");
      if (!pop || pop.hidden) return;
      if (e.target.closest("#cpp-popover, #cpp-color-btn")) return;
      closePopover(pop);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePopover();
    });
  }

  // ---- shared UI sync -----------------------------------------------------
  function syncUI(pid) {
    var current = (pid && colors[pid]) || "";

    var dot = document.querySelector("#cpp-color-btn .cpp-btn-dot");
    if (dot) {
      dot.classList.toggle("cpp-unset", !current);
      dot.style.background = current || "";
    }

    var pop = document.getElementById("cpp-popover");
    if (!pop || pop.hidden) return;
    if (current) pop.querySelector(".cpp-input").value = current;
    var swatches = pop.querySelectorAll(".cpp-swatch");
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].classList.toggle(
        "cpp-active",
        current && swatches[i].dataset.color.toLowerCase() === current.toLowerCase()
      );
    }
    pop.querySelector(".cpp-clear").disabled = !current;
  }

  function setColor(ctx, pid, color) {
    if (!pid) return;
    colors[pid] = color;
    saveColors(ctx);
    apply(ctx);
  }

  function clearColor(ctx, pid) {
    if (!pid) return;
    delete colors[pid];
    saveColors(ctx);
    apply(ctx);
  }

  // ---- apply --------------------------------------------------------------
  function apply(ctx) {
    if (!loaded) return;
    var pid = ctx.util.currentProjectId();
    if (pid) {
      mountButton(ctx, pid);
    } else {
      removeButton();
      closePopover();
    }
    decorate(ctx);
  }

  CPP.registerFeature({
    id: "project-colors",
    name: "Project colors",
    description: "Color-code sidebar chats by project, with a picker in the project header.",
    defaultEnabled: true,

    onInit: function (ctx) {
      loadState(ctx).then(function () {
        apply(ctx);
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        if (changes.projectColors) {
          colors = changes.projectColors.newValue || {};
          apply(ctx);
        }
        if (changes.convProject) {
          chatMap = changes.convProject.newValue || {};
          apply(ctx);
        }
      });
    },

    onApply: function (ctx) {
      apply(ctx);
    },

    onNetworkMap: function (pairs, ctx) {
      var changed = false;
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (p && p.conv && p.project && chatMap[p.conv] !== p.project) {
          chatMap[p.conv] = p.project;
          changed = true;
        }
      }
      if (changed) {
        mapDirty = true;
        saveMapSoon(ctx);
        decorate(ctx);
      }
    },

    onTeardown: function () {
      removeButton();
      var pop = document.getElementById("cpp-popover");
      if (pop) pop.remove();
      var tinted = document.querySelectorAll(".cpp-tinted");
      for (var i = 0; i < tinted.length; i++) untintIcon(tinted[i]);
      var dots = document.querySelectorAll(".cpp-dot, .cpp-proj-dot");
      for (var j = 0; j < dots.length; j++) dots[j].remove();
    }
  });
})();
