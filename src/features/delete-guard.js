// Feature: Delete Guard
// Deleting a project on claude.ai (from the projects list at /cowork/projects
// or from a single project's "..." menu) removes the project AND every chat,
// file, and artifact inside it — but claude's own confirmation dialog doesn't
// spell that out, and its Delete button is live the instant the dialog opens.
//
// This feature intercepts that dialog and hardens it: it retitles the heading
// to name the target, adds a warning that all project content will be lost,
// and requires the user to type the project's exact name before deleting. The
// Delete button is held closed (disabled + a capture-phase click block) until
// the typed name matches, so a stray click or Enter can't delete anything.
(function () {
  "use strict";

  var DELETE_CONFIRM_RE = /are you sure you want to delete\s+(.+?)\s*\?/i;

  // Deepest element still containing the phrase — i.e. the sentence's own node
  // rather than an outer wrapper, so we insert our guard directly beneath it.
  function deepestContaining(root, re) {
    var best = null;
    (function walk(el) {
      if (!re.test(el.textContent || "")) return;
      best = el;
      for (var i = 0; i < el.children.length; i++) walk(el.children[i]);
    })(root);
    return best;
  }

  // Retitle claude's own heading so the target is unmistakable. React may
  // re-render and reset it, so this re-applies on every pass — but only when
  // the text actually differs, otherwise our own write would re-trigger the
  // MutationObserver forever.
  function retitleDeleteHeading(dialog, name) {
    var labelId = dialog.getAttribute("aria-labelledby");
    var heading =
      (labelId && document.getElementById(labelId)) || dialog.querySelector("h2");
    if (!heading) return;
    var desired = "Delete project: " + name;
    if (heading.textContent !== desired) heading.textContent = desired;
  }

  function findDeleteButton(dialog) {
    var buttons = dialog.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if (/^\s*delete\s*$/i.test(buttons[i].textContent || "")) return buttons[i];
    }
    return null;
  }

  function confirmMatches(dialog) {
    var guard = dialog.querySelector(".cpp-del-guard");
    var field = dialog.querySelector(".cpp-del-input");
    if (!guard || !field) return false;
    return field.value.trim() === guard.dataset.cppName;
  }

  function syncDeleteButton(dialog) {
    var btn = findDeleteButton(dialog);
    if (!btn) return;
    var ok = confirmMatches(dialog);
    btn.disabled = !ok;
    btn.setAttribute("aria-disabled", String(!ok));
    btn.classList.toggle("cpp-del-blocked", !ok);
  }

  function enhanceDeleteDialogs() {
    var dialogs = document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]'
    );
    for (var i = 0; i < dialogs.length; i++) enhanceOneDialog(dialogs[i]);
  }

  // Harden a single delete-project dialog. `dialog` is a parameter (not a
  // shared loop var), so the listeners below close over the right dialog/field
  // without any per-iteration wrapping.
  function enhanceOneDialog(dialog) {
    var text = dialog.textContent || "";
    if (!/delete project/i.test(text)) return;
    var match = DELETE_CONFIRM_RE.exec(text);
    if (!match) return;
    var name = match[1].trim();
    if (!name) return;

    retitleDeleteHeading(dialog, name);

    var existing = dialog.querySelector(".cpp-del-guard");
    if (existing) {
      // Dialog re-rendered for a different project? Rebuild if stale.
      if (existing.dataset.cppName === name) {
        syncDeleteButton(dialog);
        return;
      }
      existing.remove();
    }

    var anchor = deepestContaining(dialog, DELETE_CONFIRM_RE);
    if (!anchor) return;
    var deleteBtn = findDeleteButton(dialog);
    if (!deleteBtn) return;

    var guard = document.createElement("div");
    guard.className = "cpp-del-guard";
    guard.dataset.cppName = name;

    // Built from nodes rather than innerHTML so a project name containing
    // markup can't inject anything.
    var warning = document.createElement("p");
    warning.className = "cpp-del-warning";
    var boldName = document.createElement("strong");
    boldName.textContent = name;
    warning.append(
      "⚠️ This will delete all content in this project including chats, " +
        "files, and artifacts. Enter this project name ",
      boldName,
      " to confirm you want to delete."
    );
    guard.appendChild(warning);

    var field = document.createElement("input");
    field.type = "text";
    field.className = "cpp-del-input";
    field.placeholder = name;
    field.setAttribute("aria-label", "Type " + name + " to confirm deletion");
    field.autocomplete = "off";
    field.spellcheck = false;
    field.addEventListener("input", function () { syncDeleteButton(dialog); });
    // Keep the dialog's own key handling from stealing our typing.
    field.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter" && !confirmMatches(dialog)) e.preventDefault();
    });
    guard.appendChild(field);

    anchor.insertAdjacentElement("afterend", guard);

    // Capture-phase block: even if the app re-enables the button on a
    // re-render, the click can't reach its handler until the name matches.
    dialog.addEventListener(
      "click",
      function (e) {
        var btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn || btn !== findDeleteButton(dialog)) return;
        if (!confirmMatches(dialog)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          field.focus();
        }
      },
      true
    );

    syncDeleteButton(dialog);
  }

  CPP.registerFeature({
    id: "delete-guard",
    name: "Delete project confirmation",
    description:
      "Warns that deleting a project also deletes its chats, files, and artifacts, and requires typing the project name before the Delete button unlocks.",
    defaultEnabled: true,

    onApply: function () {
      enhanceDeleteDialogs();
    },

    onTeardown: function () {
      var guards = document.querySelectorAll(".cpp-del-guard");
      for (var i = 0; i < guards.length; i++) guards[i].remove();
      var blocked = document.querySelectorAll(".cpp-del-blocked");
      for (var j = 0; j < blocked.length; j++) {
        blocked[j].classList.remove("cpp-del-blocked");
        blocked[j].disabled = false;
        blocked[j].removeAttribute("aria-disabled");
      }
    }
  });
})();
