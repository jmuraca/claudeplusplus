#!/usr/bin/env node
// Regenerate src/data/emoji.js — the bundled shortcode dataset the
// emoji-autocomplete feature reads at runtime.
//
// Source: GitHub's gemoji database (github/gemoji, db/emoji.json) — the same
// shortcodes GitHub and Slack use. This script fetches it, keeps just what the
// picker needs (char + shortcode aliases + search keywords), and writes the
// dataset as a small IIFE that sets window.CPP_EMOJI.
//
// Usage:  node scripts/gen-emoji.js
//
// It's deterministic: re-running against the same gemoji revision reproduces the
// committed file byte-for-byte, so a diff shows exactly what upstream changed.
// The extension itself never touches the network — only this generator does, and
// only when you run it.
"use strict";

var fs = require("fs");
var path = require("path");

var SOURCE = "https://raw.githubusercontent.com/github/gemoji/master/db/emoji.json";
var OUT = path.resolve(__dirname, "..", "src", "data", "emoji.js");

// Words not worth indexing from descriptions — too generic to help a search.
var STOP = new Set([
  "a", "an", "the", "of", "and", "or", "with", "to", "in", "on", "for", "at",
  "up", "down", "face"
]);

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function build(raw) {
  return raw
    .filter(function (e) {
      return e && e.emoji && Array.isArray(e.aliases) && e.aliases.length;
    })
    .map(function (e) {
      var names = e.aliases.slice(); // shortcodes
      var nameSet = new Set(names);
      var kw = new Set();
      // description words + tags, minus stopwords and anything already a name
      tokens(e.description).forEach(function (t) {
        if (!STOP.has(t) && !nameSet.has(t)) kw.add(t);
      });
      (e.tags || []).forEach(function (t) {
        var tt = t.toLowerCase();
        if (!nameSet.has(tt)) kw.add(tt);
      });
      return [e.emoji, names, Array.from(kw)];
    });
}

function render(entries) {
  var header =
    "// Emoji dataset for the emoji-autocomplete feature (bundled, offline).\n" +
    "//\n" +
    "// Generated from GitHub's gemoji database (github/gemoji, db/emoji.json) — the\n" +
    "// same shortcodes GitHub and Slack use. Do not hand-edit; regenerate with\n" +
    "//   node scripts/gen-emoji.js\n" +
    "// Each row is [char, names, keywords]:\n" +
    "//   char     — the emoji string (may include a variation selector / ZWJ sequence)\n" +
    "//   names    — shortcode aliases; typing :<name>: auto-replaces to char\n" +
    "//   keywords — extra search terms (description words + tags) for the picker\n" +
    "//\n" +
    "// Loaded as an ISOLATED-world content script before emoji-autocomplete.js, which\n" +
    "// reads window.CPP_EMOJI once at init to build its lookup + search index.\n" +
    "(function (root) {\n" +
    '  "use strict";\n' +
    "  root.CPP_EMOJI = [\n";
  var body = entries
    .map(function (row) {
      return "  " + JSON.stringify(row);
    })
    .join(",\n");
  var footer = "\n  ];\n})(typeof window !== \"undefined\" ? window : this);\n";
  return header + body + footer;
}

async function main() {
  var res = await fetch(SOURCE);
  if (!res.ok) throw new Error("fetch " + SOURCE + " -> HTTP " + res.status);
  var raw = await res.json();
  var entries = build(raw);
  var out = render(entries);
  fs.writeFileSync(OUT, out);
  console.log(
    "wrote " + OUT + " — " + entries.length + " emoji, " +
      (Buffer.byteLength(out) / 1024).toFixed(1) + " KB"
  );
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
