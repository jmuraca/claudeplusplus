// Feature: Create Project
// Adds a "+ Create new project" entry to the chat-title dropdown's
// "Add to project" submenu. Choosing it opens a modal for a project name, then
// creates the project and files the current chat into it — so a loose
// /chat/<uuid> can be put into a brand-new project in one step, instead of only
// into projects that already exist.
//
// It's all silent background API calls: create the project, then move the chat,
// verifying the move stuck by re-reading the conversation's project_uuid (a 200
// alone proves nothing — the update endpoint ignores fields it doesn't expect).
//
// We deliberately do NOT reload or drive claude's UI. An out-of-band API write
// can't make claude's SPA re-render its chat header — that breadcrumb only
// refreshes when claude's OWN mutation invalidates its OWN cache — so it stays
// as-is until the user next opens the chat from the project. Our own features
// (chat colors, project list) reflect the move immediately, and a confirmation
// toast is all we surface.
(function () {
  "use strict";

  var modalEl = null;
  var toastEl = null;

  // Org id and the current chat id come from the shared CPP.util (core.js). This
  // feature keeps no ctx of its own, so it reaches them through the global.

  // ---- "Create new project" menu item ------------------------------------
  // The "Add to project" submenu is a portal with a "Search projects" input in
  // a pinned header. That input is the stable hook: when it appears, drop our
  // item into the same header, right under the search box.
  function injectMenuItem() {
    if (!CPP.util.currentChatId()) return;
    var inputs = document.querySelectorAll(
      'input[aria-label="Search projects"], input[placeholder="Search projects"]'
    );
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var menu = input.closest('[role="menu"]');
      if (!menu || menu.querySelector(".cpp-create-project")) continue;
      var header = input.closest('[role="menu"] > div > div') || menu;

      var item = document.createElement("div");
      item.className = "cpp-create-project";
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.innerHTML =
        '<span class="cpp-create-plus" aria-hidden="true">+</span>' +
        "<span>Create new project</span>";

      item.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        // Close the menu (Escape), then show our modal on the next tick.
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        setTimeout(openModal, 0);
      });
      item.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
      });

      header.appendChild(item);
    }
  }

  // ---- modal -------------------------------------------------------------
  function closeModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
  }

  function openModal() {
    closeModal();

    var overlay = document.createElement("div");
    overlay.className = "cpp-modal-overlay";

    var panel = document.createElement("div");
    panel.className = "cpp-modal";
    panel.innerHTML =
      '<div class="cpp-modal-title">Create new project</div>' +
      '<input class="cpp-modal-input" type="text" placeholder="Project name" maxlength="200">' +
      '<div class="cpp-modal-error" hidden></div>' +
      '<div class="cpp-modal-actions">' +
      '  <button type="button" class="cpp-modal-cancel">Cancel</button>' +
      '  <button type="button" class="cpp-modal-save">Save</button>' +
      "</div>";
    overlay.appendChild(panel);

    var input = panel.querySelector(".cpp-modal-input");
    var errEl = panel.querySelector(".cpp-modal-error");
    var saveBtn = panel.querySelector(".cpp-modal-save");
    var cancelBtn = panel.querySelector(".cpp-modal-cancel");

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }

    function save() {
      var name = input.value.trim();
      if (!name) {
        showError("Enter a project name.");
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      // Create the project and move the chat into it, all via the API — no menu
      // driving, nothing the user has to watch happen.
      createProject(name).then(function (projectId) {
        closeModal();
        return moveChatToProject(name, projectId);
      }).catch(function (err) {
        showError((err && err.message) || "Something went wrong.");
      });
    }

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", closeModal);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") save();
      if (e.key === "Escape") closeModal();
      e.stopPropagation();
    });
    overlay.addEventListener("pointerdown", function (e) {
      if (e.target === overlay) closeModal();
      e.stopPropagation();
    });
    panel.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });

    document.body.appendChild(overlay);
    modalEl = overlay;
    input.focus();
  }

  // ---- API: read a conversation / its project ----------------------------
  function jsonInit(method, body) {
    return {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
  }

  function fetchConversation(org, chatId) {
    return fetch(
      "/api/organizations/" + org + "/chat_conversations/" + chatId +
        "?tree=False&rendering_mode=raw",
      { credentials: "same-origin" }
    )
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function projectOf(conv) {
    if (!conv) return null;
    var p =
      conv.project_uuid ||
      (conv.project && (conv.project.uuid || conv.project.id)) ||
      "";
    return p ? p.toLowerCase() : null;
  }

  // The chat's current project, verified against the server. A direct GET can
  // 404 for some conversations, so fall back to the list endpoint.
  function fetchChatProject(org, chatId) {
    return fetchConversation(org, chatId).then(function (conv) {
      var direct = projectOf(conv);
      if (direct) return direct;
      return fetch(
        "/api/organizations/" + org +
          "/chat_conversations_v2?limit=200&offset=0&consistency=eventual",
        { credentials: "same-origin" }
      )
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          var convs = CPP.util.extractConversations(data);
          var hit = null;
          for (var i = 0; i < convs.length; i++) {
            var id = ((convs[i].uuid || convs[i].id || "") + "").toLowerCase();
            if (id === chatId) {
              hit = convs[i];
              break;
            }
          }
          return projectOf(hit);
        })
        .catch(function () {
          return null;
        });
    });
  }

  // ---- move a chat into a project ----------------------------------------
  // The move endpoint isn't documented, so try the plausible request shapes in
  // order and verify each actually took by re-reading project_uuid — a 200
  // alone proves nothing, the endpoint ignores fields it doesn't expect.
  function assignChatToProject(org, chatId, projectId) {
    var base = "/api/organizations/" + org;
    var attempts = [
      { label: "PUT project_uuid", run: function () {
        return fetch(base + "/chat_conversations/" + chatId,
          jsonInit("PUT", { project_uuid: projectId })); } },
      { label: "PATCH project_uuid", run: function () {
        return fetch(base + "/chat_conversations/" + chatId,
          jsonInit("PATCH", { project_uuid: projectId })); } },
      { label: "PUT name+project_uuid", run: function () {
        return fetchConversation(org, chatId).then(function (cur) {
          // Never PUT an empty name — that would blank the chat's title. If we
          // couldn't read the current name, skip this shape rather than risk it.
          if (!cur || !cur.name) return null;
          return fetch(base + "/chat_conversations/" + chatId,
            jsonInit("PUT", { name: cur.name, project_uuid: projectId })); }); } },
      { label: "v2 PUT", run: function () {
        return fetch(base + "/chat_conversations_v2/" + chatId,
          jsonInit("PUT", { project_uuid: projectId })); } },
      { label: "project-scoped PUT", run: function () {
        return fetch(base + "/projects/" + projectId + "/conversations/" + chatId,
          jsonInit("PUT", {})); } }
    ];

    var i = 0;
    function tryNext() {
      if (i >= attempts.length) {
        // Last chance: maybe an earlier attempt actually took.
        return fetchChatProject(org, chatId).then(function (p) {
          return p === projectId;
        });
      }
      var attempt = attempts[i++];
      return Promise.resolve()
        .then(attempt.run)
        .then(function (res) {
          if (!res || !res.ok) return tryNext();
          return fetchChatProject(org, chatId).then(function (p) {
            return p === projectId ? true : tryNext();
          });
        })
        .catch(function () {
          return tryNext();
        });
    }
    return tryNext();
  }

  function createProject(name) {
    var org = CPP.util.getOrgId();
    if (!org) return Promise.reject(new Error("Couldn't determine your organization."));
    if (!CPP.util.currentChatId()) return Promise.reject(new Error("Open a chat first, then try again."));

    return fetch("/api/organizations/" + org + "/projects",
      jsonInit("POST", { name: name, description: "", is_private: true })
    ).then(function (res) {
      if (!res.ok) {
        throw new Error("Couldn't create the project (HTTP " + res.status + ").");
      }
      return res.json();
    }).then(function (project) {
      var projectId = (project.uuid || project.id || "").toLowerCase();
      if (!projectId) throw new Error("Project created, but no id was returned.");
      return projectId;
    });
  }

  // Move the chat into the project via a silent, verified API call, then toast.
  // (Why we don't reload or refresh claude's header: see the file header.)
  function moveChatToProject(name, projectId) {
    var org = CPP.util.getOrgId();
    var chatId = CPP.util.currentChatId();
    if (!org || !chatId) return Promise.resolve();
    return assignChatToProject(org, chatId, projectId).then(function (moved) {
      if (moved) {
        showToast('Chat added to "' + name + '"');
      } else {
        showToast(
          'Project "' + name + '" was created, but moving the chat into it ' +
            "failed. You can open it from the project directly."
        );
      }
    });
  }

  // ---- toast -------------------------------------------------------------
  function showToast(message) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement("div");
    toastEl.className = "cpp-toast";
    toastEl.textContent = message;
    document.body.appendChild(toastEl);
    setTimeout(function () {
      if (toastEl) {
        toastEl.remove();
        toastEl = null;
      }
    }, 4000);
  }

  // ---- feature registration ----------------------------------------------
  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "create-project",

    onApply: function () {
      injectMenuItem();
    },

    onTeardown: function () {
      closeModal();
      if (toastEl) {
        toastEl.remove();
        toastEl = null;
      }
      var items = document.querySelectorAll(".cpp-create-project");
      for (var i = 0; i < items.length; i++) items[i].remove();
    }
  });
})();
