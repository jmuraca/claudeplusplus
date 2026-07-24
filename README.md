# Claude++

A Chrome extension with quality-of-life improvements for the **claude.ai** interface.
Everything is stored locally on your device (`chrome.storage.local`) — no account, no
backend, nothing leaves the browser.

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

### Storage keys

| Key                        | Shape                                 | Purpose                          |
| -------------------------- | ------------------------------------- | -------------------------------- |
| `projectColors`            | `{ [projectUuid]: "#rrggbb" }`        | user-chosen color per project    |
| `convProject`              | `{ [conversationUuid]: projectUuid }` | learned chat→project mapping     |
| `cppAsides:<conversationUuid>` | `[{ id, anchor, question, answer }]` | inline asides for one chat (one key per chat) |
| `cppPromptStash:<conversationUuid>` | `string`                     | the stashed prompt for one chat (one key per chat) |
| `cppFeatures`              | `{ [featureId]: boolean }`            | per-feature enable/disable       |

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
its `convProject` mapping, or a project's color. Those uuids are never reused, so
orphans are inert rather than wrong, but the asides case is a real privacy concern:
the question/answer text would outlive the chat it was about. So we reap on delete.

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

   `ctx.util` provides `currentProjectId()`, `convFromHref(href)`, the UUID regexes,
   and promise-based `get(keys)` / `set(obj)` / `remove(keys)` storage helpers.

2. Add its file to `content_scripts[].js` in `manifest.json` (after `core.js`).
3. Add its `{ id, name, description, defaultEnabled }` to the list in
   `src/features/registry.js` — the single source of truth core.js and the popup
   both read, so the toggle appears automatically.

## Releasing

`.github/workflows/release.yml` builds the packaged zip and publishes it to GitHub Releases on
every push to `main` that touches `manifest.json`, `src/`, `styles/`, or `icons/`. It stamps
the manifest version with the build date (`yyyy.m.d`, plus a fourth segment for a second
release the same day) and zips `manifest.json src styles icons` from a clean checkout.

To publish to the Web Store, upload the `claudeplusplus.zip` **asset from the GitHub release**.
Do not upload a zip built by hand from the working tree — it will contain whatever is
uncommitted and can easily be an older or half-finished build.

Because the zip is built from a clean checkout, every file the manifest names must be committed.
An uncommitted asset produces a zip whose manifest points at files that aren't in the archive,
and the Web Store rejects that at upload validation rather than at build time.

## Notes / limitations

- Selectors and API response shapes on claude.ai can change. The sidebar decoration
  targets rows keyed by `data-row-key="chat:<uuid>"` plus `a[href*="/chat/"]` links,
  and the API tap looks for any JSON carrying both a conversation uuid and a
  `project_uuid`. If a future redesign breaks either, those two spots are where to adjust.
- A chat's icon is tinted once its project association has been seen in an API response
  (learned mappings are cached in `convProject`, so it persists across reloads).
