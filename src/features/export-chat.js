// Feature: Export / download chat (structured XML)
//
// Adds a "Download" button to the chat header, next to claude.ai's Share
// button. Clicking it saves the whole conversation as a single, structured XML
// document that captures the meaning of each message rather than its pixels:
//
//   <chat> / <metadata> (participants, source, model, exported-at)
//   <messages> / <message role timestamp>
//     <body_text> holding block elements:
//        <paragraph>, <heading level>, <list ordered><item>,
//        <blockquote>, <table><row><cell>, <code_block language> (CDATA),
//        <divider/>
//     with inline markup inside blocks:
//        <bold>, <italic>, <strikethrough>, <code class="inline">,
//        <link url>label</link>
//
// WHY FETCH INSTEAD OF SCRAPE. claude.ai's transcript is virtualized: only a
// window of turns around the viewport is mounted in the DOM at any time (see the
// scroll-nav feature's notes). Reading the messages off the DOM would silently
// drop everything not currently on screen, so a long chat would export
// half-empty. Instead we pull the full conversation from claude.ai's internal
// REST endpoint — the same origin-authenticated API the asides feature uses —
// which returns every message with its raw markdown, then translate that
// markdown into the XML vocabulary above. The output is deterministic and
// doesn't depend on claude.ai's (unexported) rendering.
//
// Like the other Claude++ features this leans on claude.ai internals (the header
// Share button, the conversation API shape). If those change, the button either
// won't mount or the fetch fails loudly with a message — it never corrupts the
// page.
(function () {
  "use strict";

  var ctx = null;
  var BTN_ID = "cpp-export-btn";

  // ---------- ids (mirrors the asides feature) ----------

  function convoId() {
    if (!ctx) return null;
    var m = ctx.util.CHAT_RE.exec(location.pathname);
    return m ? m[1].toLowerCase() : null;
  }

  // ---------- locate the header Share button ----------

  function labelOf(el) {
    return (
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("title") || "") + " " +
      (el.textContent || "")
    ).toLowerCase();
  }

  // The Share control in the conversation header (not anything in the sidebar).
  // claude.ai renders it as a button/anchor whose visible label is "Share".
  function findShareButton() {
    var els = document.querySelectorAll('button, [role="button"], a');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest("nav, aside")) continue;
      if (/\bshare\b/.test(labelOf(el))) return el;
    }
    return null;
  }

  // ---------- fetch the conversation ----------

  function fetchConversation(org, conv) {
    // tree=True + rendering_mode=raw returns the linear message list with each
    // message's raw markdown text and content blocks.
    var url =
      "/api/organizations/" + org + "/chat_conversations/" + conv +
      "?tree=True&rendering_mode=raw&render_all_tools=false";
    return fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { "anthropic-client-platform": "web_claude_ai" }
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ""; }).then(function (body) {
          throw new Error("Fetch conversation failed (" + res.status + "): " + body.slice(0, 200));
        });
      }
      return res.json();
    });
  }

  // The raw markdown for a message. We request rendering_mode=raw, which puts
  // the full markdown source in the flat `text` field on every message.
  function messageMarkdown(msg) {
    return typeof msg.text === "string" ? msg.text : "";
  }

  // Follow parent_message_uuid from the current leaf back to the root so we
  // export only the *visible* thread. Because we request the full message tree
  // (tree=True), a conversation with edited prompts or regenerated replies also
  // carries its abandoned branches; iterating chat_messages in array order would
  // mix those in. Falls back to array order when the tree pointers are absent
  // (e.g. a plain linear chat, or a shape without current_leaf_message_uuid).
  function activePath(conversation, all) {
    var leaf = conversation.current_leaf_message_uuid;
    if (!leaf || !all.length) return all;
    var byId = {};
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].uuid) byId[all[i].uuid] = all[i];
    }
    var chain = [];
    var seen = {};
    var cur = leaf;
    // The root's parent is a sentinel uuid that isn't itself a message, so the
    // walk stops there; `seen` guards against any cycle.
    while (cur && byId[cur] && !seen[cur]) {
      seen[cur] = true;
      chain.push(byId[cur]);
      cur = byId[cur].parent_message_uuid;
    }
    if (chain.length < 2) return all; // couldn't reconstruct — trust array order
    return chain.reverse();
  }

  // Normalize the API's messages into { role, markdown, time, attachments }.
  function normalize(conversation) {
    var all = conversation.chat_messages || conversation.messages || [];
    var msgs = activePath(conversation, all);
    var out = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var role = (m.sender === "human" || m.sender === "user") ? "human" : "assistant";
      var md = messageMarkdown(m);
      var names = [];
      var files = (m.attachments || []).concat(m.files || []);
      for (var j = 0; j < files.length; j++) {
        var f = files[j];
        var name = f && (f.file_name || f.name || f.title);
        if (name) names.push(name);
      }
      if (!md.trim() && !names.length) continue;
      out.push({ role: role, markdown: md, time: m.created_at || "", attachments: names });
    }
    return out;
  }

  // Best-effort model id: conversation-level first, else the most recent
  // assistant message that carries one.
  function pickModel(conversation) {
    if (conversation.model) return conversation.model;
    var msgs = conversation.chat_messages || conversation.messages || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].model) return msgs[i].model;
    }
    return "";
  }

  // ---------- XML helpers ----------

  function pad(n) {
    return new Array(n + 1).join("    ");
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeXml(s).replace(/"/g, "&quot;");
  }

  // Wrap raw text in CDATA, splitting any literal "]]>" so it can't close the
  // section early. Used for code blocks, whose whitespace must be preserved.
  function cdata(s) {
    return "<![CDATA[" + String(s).replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
  }

  // ---------- markdown -> XML ----------

  // Inline formatting. We split on inline-code spans first and format only the
  // non-code segments, so backtick contents are never touched by the emphasis or
  // link passes. No placeholder bookkeeping, nothing that can collide with prose.
  function renderInline(text) {
    var parts = String(text == null ? "" : text).split(/(`[^`]+`)/);
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      var code = /^`([^`]+)`$/.exec(seg);
      if (code) {
        out += '<code class="inline">' + escapeXml(code[1]) + "</code>";
      } else {
        out += formatSegment(escapeXml(seg));
      }
    }
    return out;
  }

  // Links + emphasis on an already-XML-escaped, code-free segment.
  function formatSegment(text) {
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      function (_, label, url) {
        var safe = /^(https?:|mailto:|\/)/i.test(url) ? url : "#";
        return '<link url="' + escapeAttr(safe) + '">' + label + "</link>";
      }
    );
    text = text.replace(/\*\*([^*]+)\*\*/g, "<bold>$1</bold>");
    text = text.replace(/__([^_]+)__/g, "<bold>$1</bold>");
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<italic>$2</italic>");
    text = text.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<italic>$2</italic>");
    text = text.replace(/~~([^~]+)~~/g, "<strikethrough>$1</strikethrough>");
    return text;
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split("|").map(function (c) { return c.trim(); });
  }

  // Block-level renderer -> an array of indented XML lines (at indent `ind`).
  // Covers the constructs Claude actually emits, not the whole CommonMark spec.
  function renderBlocks(md, ind) {
    var lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (!para.length) return;
      out.push(pad(ind) + "<paragraph>" + renderInline(para.join(" ")) + "</paragraph>");
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      // fenced code block ``` / ~~~  (content kept verbatim in CDATA)
      var fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        flushPara();
        var marker = fence[1][0];
        var lang = fence[2].trim().split(/\s+/)[0];
        var closeRe = new RegExp("^\\s*" + marker + "{3,}\\s*$");
        var code = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // consume closing fence
        out.push(
          pad(ind) + "<code_block" +
          (lang ? ' language="' + escapeAttr(lang) + '"' : "") +
          ' xml:space="preserve">' + cdata(code.join("\n")) + "</code_block>"
        );
        continue;
      }

      // heading
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        out.push(pad(ind) + '<heading level="' + h[1].length + '">' +
                 renderInline(h[2].trim()) + "</heading>");
        i++; continue;
      }

      // horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        out.push(pad(ind) + "<divider/>");
        i++; continue;
      }

      // GFM table: a header row followed by a |---|:--:| separator row
      if (
        line.indexOf("|") !== -1 &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        flushPara();
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        out.push(pad(ind) + "<table>");
        out.push(pad(ind + 1) + '<row header="true">');
        header.forEach(function (c) {
          out.push(pad(ind + 2) + "<cell>" + renderInline(c) + "</cell>");
        });
        out.push(pad(ind + 1) + "</row>");
        rows.forEach(function (r) {
          out.push(pad(ind + 1) + "<row>");
          for (var c = 0; c < header.length; c++) {
            out.push(pad(ind + 2) + "<cell>" + renderInline(r[c] || "") + "</cell>");
          }
          out.push(pad(ind + 1) + "</row>");
        });
        out.push(pad(ind) + "</table>");
        continue;
      }

      // blockquote (one or more consecutive > lines, rendered recursively)
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, "")); i++;
        }
        out.push(pad(ind) + "<blockquote>");
        out = out.concat(renderBlocks(quote.join("\n"), ind + 1));
        out.push(pad(ind) + "</blockquote>");
        continue;
      }

      // list (unordered -*+ or ordered 1. / 1) )
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        flushPara();
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        out.push(pad(ind) + '<list ordered="' + ordered + '">');
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          var item = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
          i++;
          // fold indented continuation lines into the current item
          while (
            i < lines.length && lines[i].trim() &&
            /^\s+/.test(lines[i]) &&
            !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])
          ) {
            item += " " + lines[i].trim(); i++;
          }
          out.push(pad(ind + 1) + "<item>" + renderInline(item) + "</item>");
        }
        out.push(pad(ind) + "</list>");
        continue;
      }

      // blank line ends a paragraph
      if (!line.trim()) { flushPara(); i++; continue; }

      // otherwise accumulate into the current paragraph
      para.push(line.trim());
      i++;
    }
    flushPara();
    return out;
  }

  // ---------- assemble the document ----------

  function messageXml(m, id) {
    var role = m.role === "human" ? "user" : "assistant";
    var attrs = ' id="' + id + '" role="' + role + '"';
    if (m.time) attrs += ' timestamp="' + escapeAttr(m.time) + '"';

    var out = [pad(2) + "<message" + attrs + ">"];
    out.push(pad(3) + "<body_text>");
    out = out.concat(renderBlocks(m.markdown, 4));
    out.push(pad(3) + "</body_text>");
    if (m.attachments && m.attachments.length) {
      out.push(pad(3) + "<attachments>");
      m.attachments.forEach(function (n) {
        out.push(pad(4) + '<attachment name="' + escapeAttr(n) + '"/>');
      });
      out.push(pad(3) + "</attachments>");
    }
    out.push(pad(2) + "</message>");
    return out.join("\n");
  }

  function buildXml(conversation, messages) {
    var chatId = conversation.uuid || conversation.id || convoId() || "";
    var start = conversation.created_at || (messages[0] && messages[0].time) || "";
    var model = pickModel(conversation);
    var name = (conversation.name && conversation.name.trim()) || "";
    var exportedAt = new Date().toISOString();

    var lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(
      "<chat" +
      (chatId ? ' id="' + escapeAttr(chatId) + '"' : "") +
      (start ? ' start_time="' + escapeAttr(start) + '"' : "") +
      ">"
    );

    lines.push(pad(1) + "<metadata>");
    if (name) lines.push(pad(2) + "<title>" + escapeXml(name) + "</title>");
    lines.push(pad(2) + "<participants>");
    lines.push(pad(3) + '<participant id="user" role="user">You</participant>');
    lines.push(pad(3) + '<participant id="assistant" role="assistant">Claude</participant>');
    lines.push(pad(2) + "</participants>");
    lines.push(pad(2) + '<source provider="Anthropic" product="claude.ai"/>');
    if (model) lines.push(pad(2) + "<model>" + escapeXml(model) + "</model>");
    lines.push(pad(2) + "<exported-at>" + escapeXml(exportedAt) + "</exported-at>");
    lines.push(pad(1) + "</metadata>");

    lines.push("");
    lines.push(pad(1) + "<messages>");
    messages.forEach(function (m, idx) { lines.push(messageXml(m, idx + 1)); });
    lines.push(pad(1) + "</messages>");

    lines.push("</chat>");
    return lines.join("\n") + "\n";
  }

  // ---------- download ----------

  // A filesystem-safe version of the chat title: drop characters that are
  // illegal in filenames on common OSes, collapse whitespace, and trim trailing
  // dots/spaces (which Windows rejects). Keeps case and spaces so the title
  // stays readable in the saved file.
  function safeName(s) {
    var name = String(s || "")
      .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, "");
    return name || "claude-conversation";
  }

  function downloadXml(title, xml) {
    var d = new Date();
    var date =
      d.getFullYear() + "-" +
      ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
      ("0" + d.getDate()).slice(-2);
    var blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = safeName(title) + "_" + date + ".xml";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ---------- button + click flow ----------

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle("cpp-export-busy", busy);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var btn = e.currentTarget;
    if (btn.disabled) return;

    var org = ctx.util.getOrgId();
    var conv = convoId();
    if (!org || !conv) {
      alert("Claude++: couldn't identify this conversation to export.");
      return;
    }

    setBusy(btn, true);
    fetchConversation(org, conv)
      .then(function (data) {
        var messages = normalize(data);
        if (!messages.length) throw new Error("This conversation has no messages to export.");
        var title = (data.name && data.name.trim()) || "Claude conversation";
        downloadXml(title, buildXml(data, messages));
      })
      .catch(function (err) {
        alert("Claude++: export failed.\n\n" + (err && err.message ? err.message : err));
      })
      .then(function () { setBusy(btn, false); });
  }

  function mountButton() {
    if (!convoId()) { removeButton(); return; } // only inside a saved chat
    if (document.getElementById(BTN_ID)) return;
    var share = findShareButton();
    if (!share || !share.parentNode) return; // header not ready — retry next apply

    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.className = "cpp-export-btn";
    // Borrow the Share button's classes so we inherit claude.ai's header styling.
    if (share.className && typeof share.className === "string") {
      btn.className += " " + share.className;
    }
    btn.setAttribute("aria-label", "Download this chat as XML");
    btn.title = "Download this chat as XML";
    // The glyph is Anthropicons', same as the Share button's own icon, so the
    // two sit level in the header without any size-matching by hand.
    btn.appendChild(ctx.util.icon(ctx.util.ICON.DOWNLOAD));
    var label = document.createElement("span");
    label.className = "cpp-export-label";
    label.textContent = "Download";
    btn.appendChild(label);
    btn.addEventListener("click", onClick);

    // Sit just to the left of Share.
    share.parentNode.insertBefore(btn, share);
  }

  function removeButton() {
    var btn = document.getElementById(BTN_ID);
    if (btn) btn.remove();
  }

  // Metadata (name/description/defaultEnabled) lives in features/registry.js.
  CPP.registerFeature({
    id: "export-chat",

    onInit: function (context) {
      ctx = context;
      mountButton();
    },

    // Core calls this (debounced) on DOM churn and SPA navigation.
    onApply: function (context) {
      ctx = context;
      mountButton();
    },

    onTeardown: function () {
      removeButton();
    }
  });
})();
