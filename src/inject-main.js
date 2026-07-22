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

  var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var UUID_RE = new RegExp("^" + UUID + "$", "i");
  var ORIGIN = location.origin;

  // A chat or project deletion is a DELETE to its own REST resource, with the
  // uuid as the final path segment. Anchored to end-of-path (allowing a query or
  // hash) so a DELETE against a *sub*-resource (…/chat_conversations/<id>/foo)
  // doesn't read as deleting the chat itself.
  var DEL_PROJECT_RE = new RegExp("/projects/(" + UUID + ")/?(?:[?#].*)?$", "i");
  var DEL_CHAT_RE = new RegExp("/chat_conversations/(" + UUID + ")/?(?:[?#].*)?$", "i");

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

  // A successful DELETE against a chat's or project's own resource is the
  // authoritative "it's really gone" signal — it fires only on success, from
  // whichever UI path the user took. We hand the id to content.js so features
  // can reap whatever they persisted under it (and, for a project, its chats).
  //
  // Confirmed shapes (single delete):
  //   DELETE /api/organizations/<org>/chat_conversations/<uuid>  -> 204
  //   DELETE /api/organizations/<org>/projects/<uuid>            -> 204
  // The app's own follow-up GET .../projects/<uuid>/accounts 404s are ignored
  // both by the method check and by anchoring the uuid to the end of the path.
  //
  // NOTE: bulk multi-select delete is unconfirmed and likely a different
  // endpoint/body — not handled here.
  function reportDelete(method, url, ok) {
    if (!ok || String(method).toUpperCase() !== "DELETE") return;
    if (!/\/api\//.test(url || "")) return;
    var m = DEL_PROJECT_RE.exec(url);
    if (m) return postDelete("project", m[1]);
    m = DEL_CHAT_RE.exec(url);
    if (m) return postDelete("chat", m[1]);
  }

  function postDelete(kind, id) {
    window.postMessage(
      { __cpp: true, type: "delete", kind: kind, id: id.toLowerCase() },
      ORIGIN
    );
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
      var reqMethod =
        (args[0] && typeof args[0] === "object" && args[0].method) ||
        (args[1] && args[1].method) ||
        "GET";
      return origFetch.apply(this, args).then(function (res) {
        try {
          reportDelete(reqMethod, reqUrl || (res && res.url) || "", res && res.ok);
          if (res && typeof res.clone === "function") {
            var ctype = (res.headers && res.headers.get("content-type")) || "";
            if (/text\/event-stream/i.test(ctype)) {
              // A completion stream: watch it for the tab-status glyph. Don't
              // hand it to scanText — it's SSE, not the conversation JSON that
              // tap wants, and .text()'ing it would buffer the whole response.
              maybeWatchStream(res);
            } else {
              res
                .clone()
                .text()
                .then(function (t) {
                  scanText(reqUrl || (res && res.url) || "", t);
                })
                .catch(function () {});
            }
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
      this.__cppMethod = method;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      this.addEventListener("load", function () {
        try {
          var okStatus = self.status >= 200 && self.status < 300;
          reportDelete(self.__cppMethod, self.__cppUrl || self.responseURL || "", okStatus);
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

  // --- completion-stream watch ---------------------------------------------
  // The tab-status feature can't read generation state from the DOM: claude.ai
  // renders streamed tokens on a rAF, which browsers freeze in a backgrounded
  // tab, so a response that finishes while you're elsewhere leaves the DOM
  // stuck mid-stream until you look at it. The network stream doesn't lie — it
  // ends when the response ends, hidden tab or not. Detection is by response
  // content-type (text/event-stream) rather than URL, so it survives claude.ai
  // renaming the completion endpoint.
  function reportStream(state, errored) {
    window.postMessage(
      { __cpp: true, type: "stream", state: state, errored: !!errored },
      ORIGIN
    );
  }

  // Read a clone of the stream to its end. We consume the clone fully, so this
  // doesn't back up the branch the app itself is reading.
  function watchStream(res) {
    reportStream("start");
    var errored = !res.ok;
    if (!res.body) {
      reportStream("end", errored);
      return;
    }
    var reader = res.clone().body.getReader();
    var decoder = new TextDecoder();
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          reportStream("end", errored);
          return;
        }
        var chunk = decoder.decode(r.value, { stream: true });
        // SSE error frames, however they're spelled.
        if (/event:\s*error|"type"\s*:\s*"error"|"error"\s*:\s*\{/i.test(chunk)) {
          errored = true;
        }
        return pump();
      });
    }
    // A dropped connection is still a finished generation — and one worth
    // flagging, since the answer is incomplete.
    pump().catch(function () {
      reportStream("end", true);
    });
  }

  function maybeWatchStream(res) {
    if (!res) return;
    var type = (res.headers && res.headers.get("content-type")) || "";
    if (!/text\/event-stream/i.test(type)) return;
    if (!/\/api\//.test(res.url || "")) return;
    watchStream(res);
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
