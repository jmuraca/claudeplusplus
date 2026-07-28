# Claude++

A Chrome extension with quality-of-life improvements for the **claude.ai** interface.
Your settings and bookmarks follow you between your own Chrome browsers via Chrome's
built-in sync (`chrome.storage.sync`); everything else stays on your device
(`chrome.storage.local`). Claude++ has no account, no backend, and no analytics of its
own — the only thing that leaves a device is what Chrome sync carries to your other
signed-in browsers.

<img width="1425" height="1082" alt="Screenshot 2026-07-22 184713" src="https://github.com/user-attachments/assets/8a14b9c1-05d6-4014-b766-cdff0c5f8873" />


## Features

### 🎨 Project colors
Assign a color to a project and its chats get their icon tinted that color in the
left sidebar, so you can tell at a glance which chat belongs to which project.

- Open a project page (`/project/<uuid>` or `/cowork/project/<uuid>`) — a color
  icon appears in the header, between the **pin project** button and the **⋯** menu.
  Click it to open the picker and choose a preset swatch or a custom color.
- The color is applied to that project's chats in the sidebar.
- Manage or clear saved colors from the toolbar popup.

### 📁 Create project from a chat
claude.ai's **Add to project** menu only lets you file a chat into a project that already
exists. This adds a **+ Create new project** entry to that menu, so a loose `/chat/<uuid>`
can go into a brand-new project in one step.

- Pick it, name the project in the modal, and the extension creates the project and moves the
  current chat into it — all through claude.ai's own API, nothing to watch happen. A toast
  confirms when it's done.
- The move is **verified**: it re-reads the conversation's `project_uuid` after writing (a
  `200` alone doesn't prove the change stuck), trying a few request shapes until one takes.
- claude's chat header won't re-render from an out-of-band API write, so that breadcrumb
  catches up the next time you open the chat from the project — meanwhile the extension's own
  project colors and list reflect the move right away.

### 🛡️ Delete guard
Deleting a project on claude.ai also deletes **every chat, file, and artifact inside
it**, but the built-in confirmation dialog doesn't say so and its **Delete** button is
live the moment the dialog opens. This feature hardens that dialog:

- Retitles the heading to name the project being deleted.
- Adds a warning that all project content (chats, files, artifacts) will be lost.
- Requires you to type the project's exact name to confirm. Until it matches, the
  **Delete** button stays disabled and a capture-phase click block keeps a stray click
  or Enter from deleting anything — even if the app re-enables the button on a re-render.

Works from both the projects list (`/cowork/projects`) and a single project's **⋯** menu.

### 🗂️ Grid or list view for project files
A project's **Context** panel shows uploaded files as a wall of 120px thumbnails. That reads
well for a handful of images and badly for thirty PDFs with long, similar names — the name
isn't drawn anywhere at all. This adds a **grid/list switch** to the panel header, next to
Search and Add files.

- **List view** gives each file a row: its kind chip and its full name.
- Clicking a name opens the same preview modal the thumbnail does; the row checkbox feeds
  claude's own multi-select, so selecting several and deleting them works exactly as before;
  the row's **×** removes one file, like the × on a thumbnail.
- Your choice is remembered per account (it rides `chrome.storage.sync`), so it follows you
  to your other signed-in Chrome profiles.
- Rows are a list Claude++ owns, not restyled thumbnails — the file name is only a
  `data-testid` on the tile, so no amount of CSS can draw it. Every action on a row is
  forwarded to the real control it mirrors, so nothing about opening, selecting or deleting
  a file changes.
- The real grid therefore stays in the document while the list shows (a control React has
  unmounted can't be clicked). It's clipped to zero height and made `visibility:hidden`
  rather than `display:none` so every tile keeps a truthful layout box — otherwise anything
  claude anchors to a thumbnail would be positioned against the page's top-left corner.

### 🗑️ Delete file confirmation
Removing a file from a project's **Context** panel is instant and unprompted: the **×** sits
under the pointer the moment you hover a thumbnail, and the bulk **Delete** that appears once
files are ticked takes the whole selection in one click. Re-uploading is the only way back.
This asks first.

- Covers a **single file** and a **multi-select**, in either grid or list view, always naming
  what's about to go:

  > **Delete 2 files**
  >
  > Are you sure you want to delete 2 files from this project?
  >
  > ⚠️ This will permanently remove
  > - EnergyTechMarketReadySupportEMRS2026FAQs 1.pdf
  > - EnergyTechMarketReadySupportEMRS2026ApplicationGuidelines 1.pdf
  >
  > This can't be undone.

- One file and many are the **same dialog at different sizes** — a count in the heading and
  the question, the names in the list below — rather than a lone file being special-cased
  into the heading and named inline.
- Files are listed **one per line**, not run together in a sentence: claude's file names are
  long and near-identical often enough (`…EMRS2026FAQs 1.pdf` beside
  `…EMRS2026ApplicationGuidelines 1.pdf`) that a comma-separated run is unreadable at exactly
  the moment it matters most. The list scrolls past a few items, so every name is shown in
  full without the dialog growing off-screen.
- The dialog wears the shared `.cpp-modal-*` shell (the same one the create-project dialog
  uses) and the [project-delete dialog](#️-delete-guard)'s own `.cpp-del-warning` class, so
  one edit restyles all three and they can't drift. The one thing that format drops is the
  type-the-name box — deleting a file doesn't warrant making you spell it out.
- **Cancel** holds focus, so a stray Enter on a dialog you didn't mean to open is the harmless
  answer. Escape and a click on the backdrop also cancel; Tab is trapped between the two
  buttons.
- The click is caught in the **capture phase**, before React's own handler, so the delete is
  stopped rather than confirmed after the fact. On confirm, the very same control is found
  again and clicked with the guard standing down — the delete goes out through claude's own
  code path, never ours, so a cancel leaves the page untouched.
- The per-file **×** is recognised structurally (it's the button that is a direct child of a
  thumbnail wrapper — the tile's own open button and its checkbox sit deeper in). The bulk
  **Delete** has no such landmark, so it's matched on its label, but only while files are
  actually selected — the state that button exists for. That pairing is what keeps the label
  test from firing on unrelated buttons.
- **A ticked file is not a checked checkbox.** claude keeps the selection in React state and
  styles the box from it directly: a tile input carries no `checked` even while the tile is
  plainly ticked, and React re-creates that input often enough that reading the property
  returns "nothing selected" on a freshly rendered tile. So the drawn checkmark is the
  fallback signal, and the selection count is *also* read off claude's own
  *"Delete N selected items"* label — two independent readings, because either can come up
  short, and failing to guard is the costlier mistake.
- The row **×** in list view is deliberately skipped: it deletes nothing itself, it forwards
  to the tile's ×, which *is* guarded — so the two views share one confirmation and can't
  double-prompt.

### ⏳ Thinking status in tab title
From the browser's tab strip every claude.ai tab looks identical, so you can't tell the
one that's mid-response from the one that answered a while ago and is waiting on you.
This prefixes the tab title with a status glyph:

- **⏳** — a response is streaming in this tab.
- **✅** — a response finished while you were looking at another tab (clears when you return).
- **⚠️** — the response ended with an error (clears when you return).

Generation state is read from claude.ai's own completion **network stream**, not the DOM —
a backgrounded tab freezes its token rendering, so the DOM can't be trusted, but the stream
still ends exactly when the response does. ✅/⚠️ are "needs attention" markers: they only
appear for tabs that finished unattended and clear the moment you focus the tab.

### 💬 Inline asides
Select any passage in a chat and ask a question about it — the answer streams into a card in
the right margin, anchored to the text, the way a comment sits beside a paragraph in a doc.

- Selecting text adds an **Ask** button to claude's selection popover. Type a question and the
  answer streams into a margin card pinned next to the highlight.
- Each ask runs in its own **temporary (incognito) conversation**, so it stays out of your
  chat history. Asides are saved locally per chat (`cppAsides:<uuid>`) and restored on reopen.
- Highlights re-anchor as the transcript re-renders or is edited; asides whose message has
  scrolled out of the render window collapse into a count in the margin gutter that jumps you
  back to them.
- Uses claude.ai's internal streaming API, which may change without notice.

### 🔖 Bookmarks
Margin bookmarks for a conversation, the way an editor does them. Select a passage, choose
**Bookmark**, and it stays flagged until you clear it.

- Selecting text adds a **Bookmark** button to claude's selection popover, beside **Ask**.
- The text stays highlighted in claude's brand clay, and a matching bookmark glyph pins itself
  in the **left margin** next to the first line. Click that glyph to clear it; bookmarking the
  exact same passage again clears it too.
- Saved per chat (`cppBookmarks:<uuid>`) and restored on reopen. Bookmarks re-anchor as
  the transcript re-renders or is edited; one whose message has scrolled out of the render
  window simply hides until you scroll back, since the text it marks is off screen anyway.
- No backend of ours and no network calls of its own: the only place a bookmark travels is
  `chrome.storage.sync`, which carries it to your other signed-in Chrome profiles.

### 🔖 Bookmarks page
The bookmarks above only show while you're in the chat that owns them. This adds one place to
see them all, modeled on claude's own **Chats** page.

- A **Bookmarks** entry appears in the left sidebar, under **Customize**. Clicking it opens a
  full-page list (`/bookmarks`) of every bookmark across all your chats, each row showing its
  passage and, under it, the chat it came from. The entry stays out of Claude Code
  (`claude.ai/code`), which has its own nav and no chat passages to bookmark.
- A **search** box filters by passage text, chat name or project name, and a **Filter by**
  dropdown narrows the list to a single conversation.
- Click a bookmark to open its chat and scroll straight to the passage. Each row's **⋮** menu
  deletes that bookmark.
- Chat and project titles are read from claude's own list endpoints and cached
  (`cppChatNames`, `cppProjectNames`), so a refresh only re-requests them when some id is still
  unresolved. Everything else comes from the storage the Bookmarks feature already writes.

**Grouping.** A **Group by** dropdown in the header sections the list three ways. The choice is
remembered and syncs across your profiles (`cppBookmarkGroupBy`), and a check marks the active
one in the menu.

| Mode        | Sections the list by                                                     |
| ----------- | ------------------------------------------------------------------------ |
| **Project** | the project each bookmark's chat belongs to — the default                 |
| **Chat**    | the conversation each bookmark came from                                  |
| **None**    | nothing — one flat list, the way the page looked before grouping existed  |

- Headings are sorted by title, so the order doesn't shift as bookmarks come and go — with one
  exception: under **Project**, chats with no known project collect under **Unsorted**, which is
  always pinned last.
- Which project a chat belongs to comes from the chat→project mapping `project-colors` learns
  from claude's own traffic, not from a request of ours. A chat that mapping hasn't seen yet
  sits under **Unsorted** until it has — visit it, or its project, and it moves on the next
  refresh, without a reload.
- A project heading leads with that project's color swatch when one is set — the same
  `.cpp-proj-dot` `project-colors` draws on the projects list, read from the same `projectColors`
  key, so recoloring a project updates the heading live.
- Under **Chat**, the per-row chat name is dropped, since the heading above it already says so.
- **Filter by** still applies on top: filtering to one chat leaves a single section.

### ⏸️ Draft mode
Modeled on Claude Code's Shift+Tab mode switch. Press **Shift+Tab** in the message box
to arm **Draft mode**, where you can compose freely — type, paste, attach files, dictate,
switch models — with no way to submit by accident. Press **Shift+Tab** again (or click the
button) to return to normal.

- The composer's action button becomes a blue **Pause** — the **Send** button when the box
  has text, the **Use voice mode** button when it's empty — and a **DRAFT** pill sits on the
  composer as an always-on indicator. The pause uses claude's own Anthropicons glyph (U+E0BB).
- Every submit path is blocked in a capture-phase listener: **Enter** does nothing
  (**Shift+Enter** still inserts a newline), and a click on the Send/voice button returns you
  to normal mode instead of sending. Voice mode — a text-less submit with no button to pause —
  is neutralized the same way, since draft mode is a text-only feature.
- The hover tooltip on those buttons is retitled while draft mode is on, and the state
  resets to normal when you switch chats.
- **No Enter submits while paused** — plain or with Ctrl/⌘, in a list or out of it. Instead,
  **Ctrl/⌘+Enter** takes over Enter's editing job: it breaks the line, which inside a list
  means the **next list item**. (Shift+Enter still adds a line *within* the current item, as
  it always has.) The key never reaches claude's submit handler; the line break is inserted
  directly, so drafting a bulleted list works without ever arming the send path.
- **Tab and Shift+Tab keep their list jobs**: Tab indents an item, Shift+Tab outdents one.
  Since Shift+Tab is the outdent inside a list, the mode toggle stands down there — move the
  caret out of the list to switch modes, or click the blue Pause.

### 😀 Emoji autocomplete
Slack-style emoji in the message box, driven off what you type between colons.

- **Auto-replace**: finish a shortcode with its closing colon — `:tada:` — and it swaps to the
  emoji (🎉) in place. `:+1:` → 👍, `:heart:` → ❤️. A `:word:` that isn't a known shortcode is
  left exactly as typed.
- **Picker**: type a colon at a word boundary (start of line or after a space) and a filtered
  list opens at the cursor — a bare `:` shows a popular set, and each character you add narrows
  it. **↑/↓** move, **Enter**/**Tab** or a click insert, **Esc** dismisses. It ranks exact
  shortcode over prefix over substring, then falls back to keyword matches (so `:happy` finds
  😀). Because the colon must sit at a word boundary, `http://x` and `time: 5` don't trigger it.
- The shortcodes come from a bundled dataset (`src/data/emoji.js`, ~1,900 shortcodes generated
  from GitHub's [gemoji](https://github.com/github/gemoji) — the same ones GitHub and Slack use),
  so nothing is sent anywhere. Like the other composer features, edits go through the browser's
  own editing commands on a selection rather than touching claude's ProseMirror DOM.

### ↕️ Scroll navigation buttons
A small toolbar pinned beside the scrollbar for getting around a long chat without dragging.
Top to bottom: **jump to start**, **previous message you wrote**, **next message you wrote**,
**jump to most recent**.

- Prev/next also have keyboard shortcuts: **Alt+↑** (previous) and **Alt+↓** (next), mirroring
  the up/down chevrons. They fire only while a conversation is open.
- Prev/next step between your own turns (the user messages). claude.ai's transcript is
  virtualized, so instead of enumerating every turn we lean on two facts: turns strictly
  alternate (your turns sit two indices apart, and turn 0 is always yours), and any turn can
  be reached by index — jump to an estimate, let the virtualizer mount what lands there, and
  converge. When the neighbouring turn is already mounted its exact index is used.
- The toolbar only appears while a scrollable conversation is open; **start/prev** grey out at
  the top and **most-recent/next** grey out at the bottom.
- Prev/next find your turns via claude.ai's `data-testid`, so if that ever changes those two
  simply no-op while start/most-recent keep working.

### 💾 Download chat as XML
Adds a **Download** button next to Share in the chat header. It saves the whole conversation
as a single, structured XML file with a clean, machine-readable vocabulary.

- Captures **roles and timestamps** plus rich content: headings, paragraphs, ordered/unordered
  lists, tables, blockquotes, inline and block **code**, **bold**, *italic*, ~~strikethrough~~,
  and links.
- Pulls the full transcript from claude.ai's internal API (`rendering_mode=raw`), so **nothing
  is missed in long, scrolled chats** — the on-screen DOM is virtualized and would drop
  off-screen turns.
- Follows the active thread only: because the API returns the full message *tree*, edited
  prompts and regenerated replies leave abandoned branches behind — the export walks from the
  current leaf back to the root so those don't leak in.
- Saved as `<chat title>_YYYY-MM-DD.xml`. The button only appears on saved chats (where Share
  exists) and reports loudly if the fetch fails, never corrupting the page.

### 📌 Prompt stash
Somewhere to park a prompt you've written but don't want to send yet. Press **Ctrl+S**
(**⌘S** on macOS) in the message box and the draft moves out of the composer into a card
in the right margin; press **Ctrl+S** on an empty box — or click the card — to bring it back.

- Stash a second prompt while one is already held and the two **swap**: the new text goes to
  the card, the held text lands in the box, so one key cycles between two drafts.
- The card's **×** discards the stash. It sits to the right of the composer — top-aligned and
  the same height, wearing the composer's own border width, style, colour and corner radius,
  all read from its live computed style so light/dark and any restyle follow automatically.
  When the margin is too narrow it moves to just above the composer and sizes to its content.
- One slot **per conversation**: a draft stays with the chat it was written in, and never
  turns up in another one. It survives navigation and reloads, and other tabs open on the same
  chat stay in sync. Deleting the chat reaps its stash.
- Only on a saved chat (`/chat/<uuid>`), which is the only place there's a conversation to
  stash into — on `/new` and on project pages the key is inert.
- Ctrl+S is swallowed only while the message box has focus, so the browser's Save Page keeps
  working everywhere else on claude.ai.
- The composer is a ProseMirror editor that owns its DOM, so text is never written by
  inserting nodes — the editor's contents are selected and edited through the browser's own
  editing commands (a synthetic paste, falling back to `execCommand`), which ProseMirror
  observes and folds into its document.

### ✏️ Edit queued messages
Messages you queue while Claude is replying are final — the only control on one is
**Discard**, so a typo means losing the text and typing it again. This makes a queued
message clickable.

- Click a queued message and its text comes back into the message box, and the message
  leaves the queue. Fix it up and send it again.
- If you'd already typed something, the queued text is **appended** to it, separated by a
  blank line — so clicking two queued messages merges them, in order, as separate paragraphs.
- Hovering a queued message raises a **Click to edit** label above it, opposite claude's own
  **×**, so the two actions read as a pair — the × still discards. The bubble also takes a
  pointer cursor and brings its muted text back up to full strength, the way text goes from
  dimmed to editable. A queued message you drag-select (to copy a phrase out of it) is left
  alone.
- Removal goes through claude's own Discard control rather than by deleting the bubble: the
  queue is React state, so a node pulled out from under it would come back on the next render
  — and still be sent. If the text can't be placed or the message can't be removed, the click
  is left alone entirely, so a queued message is never dropped without landing in the box.
- Keyboard reachable: each queued message is a tab stop announced as *"Edit queued message:
  &lt;the text&gt;"*, and **Enter** or **Space** pulls it back — the same treatment claude's own
  **Discard** already had. Focus shows the same cue hovering does, plus a focus ring.
- On a **touch screen** claude lays its own full-bubble Discard target over the message and
  hides the ×, so a tap there discards as it always has — intercepting it would leave no way
  to discard at all.

### 🔗 Open search results in a new tab
claude.ai's search — the **⌘K / Ctrl+K** command palette — draws each result as a
`<button>`, not a link. It looks like a link but has no `href`, so **Ctrl+click**,
middle-click and the context menu's *Open link in new tab* all fall through to a plain
activation: the chat replaces whatever you were reading, and comparing three results means
three round trips through the palette. This gives those rows the link behaviour their markup
implies.

- **Ctrl+click** (**⌘+click** on macOS), **middle-click**, or **Ctrl/⌘+Enter** on the
  highlighted row opens that result in a new tab. The palette stays open on its results, so
  several can be opened in a row. An unmodified click still navigates in place, exactly as
  before.
- The gesture is the **platform's**, not both at once: on macOS Ctrl+click is the secondary
  click, so it's left alone for the context menu rather than answered with a tab the user
  didn't ask for.
- The tab is opened by clicking a throwaway anchor rather than by calling `window.open`, so
  the **browser** applies its own disposition rules: Ctrl+click lands a background tab,
  Ctrl+Shift+click a foreground one, and middle-click a background one — the same as every
  other link on the page.
- The URL is **rebuilt from the row**, which carries only the item's id (in its DOM id) and
  its kind (`data-item-type`): a conversation becomes `/chat/<uuid>`, a Claude Code session
  `/code/<session id>`, a project `/project/<uuid>`.
- A kind with no known page (the palette also lists actions like *New chat*) is **left
  alone**: the click falls through to claude's own handler, which lands you in the right
  place in this tab rather than opening a guess in a new one.

More features can be toggled on/off from the popup.

## Install

### From the Chrome Web Store

Install from
[the store listing](https://chromewebstore.google.com/detail/ejkciacghkjmblphbmfbbjmbiilfbgde),
then open https://claude.ai. Content scripts are injected on navigation, so reload any
claude.ai tab that was already open before you installed.

### Unpacked (for development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open https://claude.ai and go to a project page.

> **The store build and an unpacked build are two different extensions.** Chrome gives each
> its own extension ID, and storage is namespaced per ID, so they share no settings and no
> saved data — see [Storage is per extension ID](#storage-is-per-extension-id). Don't run both
> at once either: each injects its own copy of the content scripts into claude.ai, and the two
> will fight over the same DOM.

## How it works

Mapping a sidebar chat to its project is the tricky bit — the sidebar DOM doesn't say
which project a chat belongs to. claude.ai's own API responses do, so the extension
observes them:

```
┌ inject-main.js (MAIN world) ─────────────┐   patches fetch/XHR, scans JSON for
│  builds { conversationUuid -> projectId } │──▶ { conv, project } pairs, posts them
└───────────────────────────────────────────┘   via window.postMessage
                     │
                     ▼
┌ core.js (ISOLATED world) ────────────────┐   feature framework + lifecycle:
│  routes messages, watches DOM + SPA nav   │   storage, MutationObserver, nav events
└───────────────────────────────────────────┘
                     │
                     ▼
┌ features/project-colors.js ──────────────┐   picker UI + icon tinting, reads/writes
│                                           │   projectColors + convProject in storage
└───────────────────────────────────────────┘
```

- `inject-main.js` runs in the page's own JS context (MAIN world) because content
  scripts run in an isolated world and can't see the page's `fetch`/XHR results.
- `core.js` runs in the isolated world where `chrome.storage` is available.

### Anchoring text to a virtualized transcript

Asides and bookmarks both have to pin something to a passage and find it again later,
which is harder than it sounds: claude.ai virtualizes the message list, so a saved
`Range` collapses the moment React unmounts the message it points into. `src/anchor.js`
(loaded after `core.js`, exposed as `CPP.anchor`) is the shared engine for that. It
stores an anchor as **character offsets plus the quoted text and ~30 chars of context
either side**, then re-resolves on demand to one of four states:

| State | Meaning |
| ------- | -------------------------------------------------------------- |
| `exact` | offsets still land on the quoted text |
| `moved` | the quote was found elsewhere in the message; offsets rewritten |
| `orphan` | the message is mounted but the quote is gone (it was edited) |
| `dormant` | the message is outside the render window — comes back on scroll |

`resolve()` rewrites the anchor **in place** when it reports `moved`, so a caller that
persists anchors should save again after a pass that reported it. It also widens the
search a few messages either side of the recorded index, because editing and resending
an earlier message renumbers every `data-rs-index` after it.

The module also owns the shared subscriber for claude.ai's selection tooltip
(`onSelectionTooltip`), which is how **Ask** and **Bookmark** get into that popover —
one poller for both, since they'd otherwise query the same node on the same frames.

### The project Context panel

Two features reach into a project's uploaded files — the grid/list switch and the delete
confirmation — and both have to answer the same questions about claude.ai's markup: where
the grid is, which tiles are in it, what each is called, whether it's ticked, which button
removes it. `src/project-files.js` (loaded after `core.js`, exposed as `CPP.projectFiles`)
owns those answers, the way `anchor.js` owns transcript anchoring, so a restyle on their
side is a one-file fix on ours.

It also records two traps worth knowing:

| Trap | Why it matters |
| ---- | -------------- |
| **Selection is not `input.checked`** | claude keeps it in React state and styles the box from it directly. A ticked tile's input carries no `checked` at all, and React re-creates that input often enough that the property reads false on a freshly rendered tile — so `isSelected()` falls back to the drawn checkmark. Trusting the property once let the first bulk delete of a session through with no confirmation. |
| **The remove × is the tile's *direct* child** | The preview button and the checkbox both sit deeper in, so "a button inside the tile" isn't specific enough to mean "the delete control". |

### Icons

Chrome we add ourselves is drawn with **claude.ai's own icon font**, Anthropicons.
Their stylesheet declares it document-wide (`@font-face { font-family:
Anthropicons-Variable }`) with no `unicode-range`, so our elements can render its
glyphs even though they hang off `<body>`. The glyphs sit at private-use codepoints
and the font carries **no semantic glyph names** — every one is just `uniXXXX` — so
`CPP.util.ICON` in `src/core.js` is the only record of what each codepoint draws.
Use `CPP.util.icon(codepoint, rotate)` to build one; `styles/content.css` carries the
`.cpp-icon` class.

### Storage keys

| Key                        | Shape                                 | Area   | Purpose                 |
| -------------------------- | ------------------------------------- | ------ | ----------------------- |
| `projectColors`            | `{ [projectUuid]: "#rrggbb" }`        | sync   | user-chosen color per project    |
| `convProject`              | `{ [conversationUuid]: projectUuid }` | local  | learned chat→project mapping     |
| `cppAsides:<conversationUuid>` | `[{ id, anchor, question, answer }]` | local | inline asides for one chat (one key per chat) |
| `cppBookmarks:<conversationUuid>` | `[{ id, anchor }]`                 | sync  | bookmarks for one chat (one key per chat) |
| `cppChatNames`             | `{ [conversationUuid]: name }`        | local  | cached chat titles for the bookmarks page |
| `cppProjectNames`          | `{ [projectUuid]: name }`             | local  | cached project titles for the bookmarks page's project headings |
| `cppBookmarkGroupBy`       | `"none" \| "project" \| "chat"`       | sync   | the bookmarks page's **Group by** choice |
| `cppBookmarkGoto`          | `{ id, anchor }`                      | local  | transient: scroll target handed to the chat page after clicking a bookmark |
| `cppPromptStash:<conversationUuid>` | `string`                     | local  | the stashed prompt for one chat (one key per chat) |
| `cppProjectFilesView`      | `"grid" \| "list"`                    | sync   | how a project's Context files are shown |
| `cppFeatures`              | `{ [featureId]: boolean }`            | sync   | per-feature enable/disable       |

**Area** is `chrome.storage.sync` (follows the user between their signed-in Chrome
profiles) or `chrome.storage.local` (stays on the device). Features never pick an
area themselves: they call `ctx.util.get`/`set`, which route each key by the
allow-list in `src/storage-sync.js` — the single place to edit when a key should
start or stop syncing. Bulky or device-scoped state (asides, the prompt stash, the
title caches) stays local to respect sync's ~100KB / 8KB-per-item quotas.

Everything keyed by a chat or project uuid is reaped when that chat/project is
deleted — see [Deletion cleanup](#deletion-cleanup) below.

#### Storage is per extension ID

`chrome.storage.local` is namespaced by extension ID, and Chrome assigns a different ID to an
unpacked build than to the Web Store build. Every key in the table above therefore belongs to
one specific install:

- **Switching from an unpacked build to the store build starts from empty.** Project colors,
  asides, the stashed prompt, and feature toggles do not carry over. Colors are the visible
  one: `project-colors` is enabled by default and running fine, but with no `projectColors`
  entries there is nothing to tint, so the sidebar looks untouched and the extension reads as
  broken when it isn't.
- **Uninstalling removes that install's data for good.** Chrome deletes an extension's storage
  with the extension, so there is nothing to migrate afterwards. Re-pick colors on the new
  install; `convProject` rebuilds itself from claude.ai's API traffic as you browse.
- There is no export/import path today, and no supported way to copy storage between IDs.

Worth knowing when debugging: `chrome.runtime.id` and `chrome.storage` answer from an
extension's isolated world whether or not the content scripts in it ever ran. Their working is
not evidence that `core.js` executed — check `typeof CPP` (set at `src/core.js:112`) for that.

### Deletion cleanup

Because storage is keyed by chat and project uuids, deleting a chat or project on
claude.ai would otherwise orphan whatever we saved under it — the chat's asides and
bookmarks and its `convProject` mapping, or a project's color. Those uuids are never
reused, so orphans are inert rather than wrong, but asides and bookmarks are a real
privacy concern: both store text quoted out of the chat (and asides the answer too),
which would outlive the chat it came from. So we reap on delete.

The authoritative "it's really gone" signal is the successful `DELETE` claude.ai
sends to the resource's own endpoint — it fires only on success, from whichever UI
path the user took (chat **⋯** menu, project menu, or the projects list):

```
DELETE /api/organizations/<org>/chat_conversations/<uuid>   → 204
DELETE /api/organizations/<org>/projects/<uuid>             → 204
```

`inject-main.js` detects those (the uuid must be the final path segment, so the
app's own follow-up `GET …/projects/<uuid>/accounts` refetches are ignored) and
posts `{ type: "delete", kind: "chat" | "project", id }`. `core.js` turns that into
an `onDelete(info, ctx)` call on each enabled feature, and **cascades**:

- **Chat deleted** → each feature drops what it keyed under that chat: `asides`
  removes `cppAsides:<id>`; `prompt-stash` removes `cppPromptStash:<id>`;
  `project-colors` removes the `convProject[id]` mapping.
- **Project deleted** → `project-colors` removes `projectColors[id]`, drops every
  `convProject` row pointing at it, and **returns those chat ids**. core then fans
  each out as its own chat delete, so a feature that doesn't know project membership
  (like `asides`) still learns which chats to reap.

A project delete therefore flows **project → its chats → each chat's asides** without
any feature needing to know more than its own storage. Deleting a single aside is
separate: the card's **×** button already removes just that entry from its chat's key.

Two limits worth knowing:

- **Bulk multi-select delete** likely uses a different endpoint/body and is not yet
  handled (see the note in `inject-main.js`).
- Cleanup only runs for **enabled** features (an `onDelete` on a disabled feature
  isn't called), so disabling `project-colors` also stops the project→chats cascade.

## Adding a feature

1. Create `src/features/<your-feature>.js` and register it:

   ```js
   CPP.registerFeature({
     id: "my-feature",
     name: "My feature",
     description: "What it does.",
     defaultEnabled: true,
     onInit(ctx) {},       // once, after settings load (and when re-enabled)
     onApply(ctx) {},      // debounced, on DOM mutation / navigation
     onNetworkMap(pairs, ctx) {}, // optional: [{ conv, project }] from the API tap
     onStream(evt, ctx) {}, // optional: { state: "start"|"end", errored } completion-stream events
     onDelete(info, ctx) {}, // optional: { kind: "chat"|"project", id } — reap storage keyed by that id.
                             // Returning chat ids from a "project" delete cascades them as chat deletes.
     onTeardown(ctx) {}    // when the feature is disabled; undo DOM changes
   });
   ```

   `ctx.util` (also reachable as the global `CPP.util`) provides
   `currentProjectId()`, `currentChatId()`, `convFromHref(href)`, the UUID regexes,
   `getOrgId()` (claude's active-org cookie, for the `/api/organizations/<org>/…`
   endpoints) and `extractConversations(data)` (normalizes claude's conversation-list
   response shapes), promise-based `get(keys)` / `set(obj)` / `remove(keys)` storage
   helpers, and `icon(codepoint, rotate)` plus the `ICON` codepoint map for
   Anthropicons glyphs, and `plainText(el)` for an element's text as a person
   reads it (block structure as newlines, zero-width spaces dropped). For the
   message box there's `composerEditor()`, `inComposer(node)`, `composerText([ed])`
   and `setComposerText(text, [ed])` — the last of which does the write the way
   ProseMirror will accept, which is not something to re-derive. Reach for these
   before re-implementing them in a feature.
   If the feature pins UI to a passage of chat text, use `CPP.anchor` rather than
   rolling your own — see [Anchoring](#anchoring-text-to-a-virtualized-transcript).

2. Add its file to `content_scripts[].js` in `manifest.json` (after `core.js`).
3. Add its `{ id, name, description, defaultEnabled }` to the list in
   `src/features/registry.js` — the single source of truth core.js and the popup
   both read, so the toggle appears automatically.

## Tests

```
npm install   # once — jsdom, the only dependency, and test-only
npm test      # node --test
```

The extension itself has no dependencies and is loaded straight from source; the
release zip is an explicit allow-list (`manifest.json`, `src`, `styles`, `icons`),
so `package.json`, `test/` and `node_modules/` never reach a build.

Tests live in `test/*.test.js` and run on Node's built-in runner against a jsdom
document. They exist for the part of a feature that is genuinely fragile: these
features reach into **claude.ai's markup**, which is not ours and changes without
notice. So a test fixture is the real DOM captured from the page, and what's
asserted is the reaching — which node an event resolves to, which of several
identically-labelled controls gets pressed, that a lookalike node elsewhere on the
page is left alone, and that teardown puts everything back. `CPP` is stubbed
rather than loaded, since `core.js` wants `chrome.*` and the storage layer, and
neither is what's under test. `.github/workflows/test.yml` runs the suite on every
push and PR that touches `src/` or `test/`.

## Releasing

Releases are fully automated. `.github/workflows/release.yml` runs on every push to `main` that
touches `manifest.json`, `src/`, `styles/`, or `icons/` (and from the **Run workflow** button),
and it:

1. runs `npm test` — a failure here stops the release, so a red suite never reaches the store;
2. stamps the manifest version with the build date (`yyyy.m.d`, plus a fourth segment for a
   second release the same day);
3. zips `manifest.json src styles icons` from a clean checkout;
4. publishes that zip as a GitHub Release;
5. uploads it to the Chrome Web Store and submits it for review. Google's review is the only
   manual gate left — the new version goes live on its own once approved.

Because the zip is built from a clean checkout, every file the manifest names must be committed.
An uncommitted asset produces a zip whose manifest points at files that aren't in the archive,
and the Web Store rejects that at upload validation rather than at build time.

### Web Store credentials

Step 5 needs four repository secrets (**Settings → Secrets and variables → Actions**). With
`CWS_EXTENSION_ID` unset the step is skipped and the rest of the release still runs, which is
what happens on a fork.

| Secret | Where it comes from |
| --- | --- |
| `CWS_EXTENSION_ID` | The item ID in the store dashboard URL — for this extension, `ejkciacghkjmblphbmfbbjmbiilfbgde`. |
| `CWS_CLIENT_ID` | An OAuth **Desktop app** client, created in the Google Cloud console. |
| `CWS_CLIENT_SECRET` | Same client. |
| `CWS_REFRESH_TOKEN` | Minted once against that client (below). |

To set it up: in the [Google Cloud console](https://console.cloud.google.com/), create a project,
enable the **Chrome Web Store API**, then under **APIs & Services → Credentials** create an OAuth
client of type **Desktop app**. Sign in as the account that owns the store listing, and if the
consent screen is in *Testing* mode add that account as a test user — otherwise the refresh token
expires after seven days.

Then mint the refresh token. Visit this URL (substituting the client ID), approve, and copy the
`code=` value out of the redirect:

```
https://accounts.google.com/o/oauth2/auth?response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/chromewebstore&redirect_uri=http://localhost&client_id=YOUR_CLIENT_ID
```

```bash
curl -s -d "client_id=YOUR_CLIENT_ID" -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=THE_CODE" -d "grant_type=authorization_code" \
     -d "redirect_uri=http://localhost" \
     https://oauth2.googleapis.com/token
```

The `refresh_token` in the response is `CWS_REFRESH_TOKEN`. It is long-lived but not permanent —
changing the Google account password or leaving the client unused for six months revokes it, and
the workflow says so explicitly when the token exchange fails. Re-run the two steps above to
replace it.

Two failures are worth recognising in the log. `ITEM_NOT_UPDATABLE` on upload means the previous
submission is still in review — wait for it to clear and re-run the workflow from the Actions tab.
A publish that fails *after* a successful upload leaves the new package sitting as a draft in the
dashboard, so it can be submitted by hand from there.

## Notes / limitations

- Selectors and API response shapes on claude.ai can change. The sidebar decoration
  targets rows keyed by `data-row-key="chat:<uuid>"` plus `a[href*="/chat/"]` links,
  and the API tap looks for any JSON carrying both a conversation uuid and a
  `project_uuid`. If a future redesign breaks either, those two spots are where to adjust.
- A chat's icon is tinted once its project association has been seen in an API response
  (learned mappings are cached in `convProject`, so it persists across reloads).
