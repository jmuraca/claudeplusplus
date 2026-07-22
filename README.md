# Claude++

A Chrome extension with quality-of-life improvements for the **claude.ai** interface.
Everything is stored locally on your device (`chrome.storage.local`) — no account, no
backend, nothing leaves the browser.

## Features

### 🎨 Project colors
Assign a color to a project and its chats get their icon tinted that color in the
left sidebar, so you can tell at a glance which chat belongs to which project.

- Open a project page (`/project/<uuid>` or `/cowork/project/<uuid>`) — a color
  icon appears in the header, between the **pin project** button and the **⋯** menu.
  Click it to open the picker and choose a preset swatch or a custom color.
- The color is applied to that project's chats in the sidebar.
- Manage or clear saved colors from the toolbar popup.

More features can be toggled on/off from the popup.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open https://claude.ai and go to a project page.

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

| Key             | Shape                              | Purpose                          |
| --------------- | ---------------------------------- | -------------------------------- |
| `projectColors` | `{ [projectUuid]: "#rrggbb" }`     | user-chosen color per project    |
| `convProject`   | `{ [conversationUuid]: projectUuid }` | learned chat→project mapping  |
| `cppFeatures`   | `{ [featureId]: boolean }`         | per-feature enable/disable       |

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
     onTeardown(ctx) {}    // when the feature is disabled; undo DOM changes
   });
   ```

   `ctx.util` provides `currentProjectId()`, `convFromHref(href)`, the UUID regexes,
   and promise-based `get(keys)` / `set(obj)` storage helpers.

2. Add its file to `content_scripts[].js` in `manifest.json` (after `core.js`).
3. Add an entry to the `FEATURES` list in `src/popup.js` so it shows a toggle.

## Notes / limitations

- Selectors and API response shapes on claude.ai can change. The sidebar decoration
  targets rows keyed by `data-row-key="chat:<uuid>"` plus `a[href*="/chat/"]` links,
  and the API tap looks for any JSON carrying both a conversation uuid and a
  `project_uuid`. If a future redesign breaks either, those two spots are where to adjust.
- A chat's icon is tinted once its project association has been seen in an API response
  (learned mappings are cached in `convProject`, so it persists across reloads).
