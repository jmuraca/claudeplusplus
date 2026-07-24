// Feature registry — the single source of truth for feature metadata.
//
// Loaded in two contexts:
//   • as the first isolated-world content script (before core.js), so core can
//     look up a feature's defaultEnabled by id when the module registers, and
//   • in popup.html (before popup.js), so the settings panel can render one
//     toggle per feature.
//
// Feature modules under src/features/ pass only { id, ...hooks } to
// CPP.registerFeature; their user-facing name/description/defaultEnabled live
// here so there's exactly one place to edit when a feature is added or renamed.
(function (root) {
  "use strict";

  root.CPP_FEATURES = [
    {
      id: "project-colors",
      name: "Project colors",
      description:
        "Color-code sidebar chats by project, with a picker in the project header.",
      defaultEnabled: true
    },
    {
      id: "create-project",
      name: "Create project from a chat",
      description:
        'Adds "+ Create new project" to the Add-to-project menu, so a loose chat can be filed into a new project in one step.',
      defaultEnabled: true
    },
    {
      id: "delete-guard",
      name: "Delete project confirmation",
      description:
        "Warns that deleting a project also deletes its chats, files, and artifacts, and requires typing the project name before the Delete button unlocks.",
      defaultEnabled: true
    },
    {
      id: "tab-status",
      name: "Thinking status in tab title",
      description:
        "Prefixes the browser tab title with a status glyph — ⏳ while a response is streaming, ✅ when one finishes while you're on another tab, ⚠️ if it ended with an error — so you can tell at a glance which tab is working or waiting on you.",
      defaultEnabled: true
    },
    {
      id: "asides",
      name: "Inline asides",
      description:
        "Select any passage in a chat, ask a question about it, and the answer streams into a card in the right margin — anchored to the text, like a comment in a doc. Each ask runs in its own temporary (incognito) conversation, so it stays out of your history. Uses claude.ai's internal API, which may change without notice.",
      defaultEnabled: true
    },
    {
      id: "bookmarks",
      name: "Bookmarks",
      description:
        "Select any passage in a chat and choose Bookmark to flag it, the way margin bookmarks work in an editor. The text stays highlighted and a bookmark appears in the left margin beside it; click that to clear it. Bookmarking the same passage again also clears it. Saved per chat, kept across reloads, stored only on this device.",
      defaultEnabled: true
    },
    {
      id: "bookmarks-page",
      name: "Bookmarks page",
      description:
        "Adds a Bookmarks entry to the left sidebar (under Customize) that opens a full page listing every bookmark across all your chats. Search or filter by chat, click a bookmark to jump to that chat and scroll to the passage, and use a row's ⋮ menu to delete it. Reads the same on-device storage as the Bookmarks feature.",
      defaultEnabled: true
    },
    {
      id: "emoji-autocomplete",
      name: "Emoji autocomplete",
      description:
        "Slack-style emoji in the message box. Finish a shortcode with its closing colon (:tada:) and it swaps to the emoji in place; or type a colon at a word boundary to open a picker at the cursor that narrows as you keep typing — ↑/↓ to move, Enter/Tab or click to insert. Uses a bundled shortcode set (the same ones GitHub and Slack use), so nothing is sent anywhere.",
      defaultEnabled: true
    },
    {
      id: "scroll-nav",
      name: "Scroll navigation buttons",
      description:
        "Adds a small toolbar beside the scrollbar to jump around a long chat: to the start, to the previous message you wrote (Alt+↑), to the next message you wrote (Alt+↓), and to the most recent message.",
      defaultEnabled: true
    },
    {
      id: "export-chat",
      name: "Download chat as XML",
      description:
        "Adds a Download button next to Share in the chat header. Saves the whole conversation as a structured XML file — messages with roles and timestamps, and rich content (headings, paragraphs, lists, tables, blockquotes, inline/block code, bold, italic, links) in a clean, machine-readable vocabulary. Fetches the full transcript from claude.ai's internal API, so nothing is missed in long, scrolled chats.",
      defaultEnabled: true
    },
    {
      id: "draft-mode",
      name: "Draft mode (Shift+Tab)",
      description:
        "Press Shift+Tab in the message box to arm Draft mode: keep typing, attaching files, dictating, and switching models freely, with no way to submit by accident. The Send button turns into a blue Pause; press Shift+Tab again (or click it) to return to normal. Shift+Enter still inserts a newline.",
      defaultEnabled: true
    },
    {
      id: "prompt-stash",
      name: "Prompt stash (Ctrl+S)",
      description:
        "Press Ctrl+S (⌘S on macOS) in the message box to set a prompt aside: it leaves the composer and waits in a card beside it. Press Ctrl+S on an empty box (or click the card) to bring it back. Stash a second prompt while one is held and the two swap, so one key cycles between two drafts. The card's × discards it. One slot per conversation, kept across reloads — a draft stashed in a chat stays with that chat.",
      defaultEnabled: true
    }
  ];
})(typeof window !== "undefined" ? window : this);
