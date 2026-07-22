// Runs in the PAGE's own JS context (MAIN world) so it can observe the
// results of claude.ai's own fetch/XHR calls. Content scripts run in an
// isolated world and cannot see those responses, so we patch here and hand
// the extracted data to content.js via window.postMessage.
//
// Goal: build a map of { conversationUuid -> projectUuid }. claude.ai's API
// responses (conversation lists, project detail, etc.) embed both ids, so we
// walk any relevant JSON payload generically instead of hard-coding a schema.
(function () {
  "use strict";

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ORIGIN = location.origin;

  function isUuid(v) {
    return typeof v === "string" && UUID_RE.test(v);
  }

  // Recursively find objects that carry both a conversation id and a project id.
  function walk(node, out, seen) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], out, seen);
      return;
    }

    var conv = node.uuid || node.conversation_uuid || node.id;
    var proj =
      node.project_uuid ||
      (node.project && typeof node.project === "object"
        ? node.project.uuid || node.project.id
        : null);

    if (isUuid(conv) && isUuid(proj)) {
      out.push({ conv: conv.toLowerCase(), project: proj.toLowerCase() });
    }

    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], out, seen);
    }
  }

  function post(pairs) {
    if (!pairs || !pairs.length) return;
    // Dedupe within this batch.
    var uniq = {};
    var list = [];
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i].conv + "|" + pairs[i].project;
      if (!uniq[key]) {
        uniq[key] = true;
        list.push(pairs[i]);
      }
    }
    window.postMessage({ __cpp: true, type: "map", pairs: list }, ORIGIN);
  }

  function scanText(url, text) {
    if (typeof text !== "string" || text.length === 0) return;
    // Only bother with endpoints likely to contain conversation/project data.
    if (!/\/api\//.test(url)) return;
    if (!/conversation|project|chat|recent/i.test(url)) return;
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    var out = [];
    walk(data, out, new WeakSet());
    post(out);
  }

  // --- patch fetch ---------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      var reqUrl =
        (args[0] && typeof args[0] === "object" && args[0].url) ||
        (typeof args[0] === "string" ? args[0] : "");
      return origFetch.apply(this, args).then(function (res) {
        try {
          if (res && typeof res.clone === "function") {
            res
              .clone()
              .text()
              .then(function (t) {
                scanText(reqUrl || (res && res.url) || "", t);
              })
              .catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // --- patch XMLHttpRequest -------------------------------------------------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__cppUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      this.addEventListener("load", function () {
        try {
          var rt = self.responseType;
          if (rt === "" || rt === "text") {
            scanText(self.__cppUrl || self.responseURL || "", self.responseText);
          } else if (rt === "json" && self.response) {
            var out = [];
            walk(self.response, out, new WeakSet());
            post(out);
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // --- notify content.js about SPA navigation ------------------------------
  function emitLocation() {
    window.postMessage({ __cpp: true, type: "location", url: location.href }, ORIGIN);
  }
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== "function") return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      emitLocation();
      return r;
    };
  });
  window.addEventListener("popstate", emitLocation);
})();
