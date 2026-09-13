# Gemini Chat Organizer — Build Spec

This is an empty repo. Build a **Manifest V3 Chrome extension** that adds inbox-style
bulk management to Google Gemini (`gemini.google.com`). Create every file from scratch.

**The problem it solves:** Gemini's sidebar only lets you delete chats one at a time.
This extension adds multi-select (including Gmail-style **Shift+Click range select**),
bulk delete, and on-demand AI summaries.

---

## Tech constraints
- Manifest V3, **vanilla JavaScript**, no build step, no npm dependencies.
- UI is injected into the page inside a **Shadow DOM** so Gemini's CSS can't clash with it.
- **All network/API calls happen in the background service worker, never in the content
  script** (avoids the page's CSP blocking cross-origin fetch). The content script talks to
  the worker via `chrome.runtime` messaging.
- All persistent state (settings, cached summaries) lives in `chrome.storage.local`.

## File structure
- `manifest.json`
- `background.js` — service worker: toolbar-icon toggle + all AI API calls
- `content.js` — injects the panel, enumerates chats, selection logic, delete driver, scrape-for-summary
- `options.html` / `options.js` — settings page (API key, provider, model)
- `README.md` — load steps, usage, and a "how to fix selectors" section
- `icons/` — 16 / 48 / 128 px placeholder PNGs

Keep the panel CSS as a string injected into the shadow root (no separate stylesheet needed).

## Feature 1 — The panel
- A floating action button (bottom-right) toggles the panel. It also toggles when the
  extension's toolbar icon is clicked (background worker sends a message to the content script).
- Panel = right-side, full-height overlay, ~380px wide, inside a shadow root. Layout:
  header (title, live chat count, refresh, close) → search box → toolbar (Select all /
  Clear / a live "N selected" counter) → scrollable chat list → footer with the danger
  "Delete selected" button.
- Respect `prefers-color-scheme` for light/dark. System font stack, no external fonts/CDNs.
- Restrained, clean styling. Sentence case, plain verbs.

## Feature 2 — Enumerate chats
- Read the conversation list from Gemini's left sidebar. **Put every DOM selector in a single
  `CONFIG.SELECTORS` object at the top of `content.js`** so they're trivial to update when
  Google changes the UI.
- For each chat, capture: a stable-ish id (a data attribute if one exists, else derive one),
  the title text, and a live element reference.
- **Load more:** auto-scroll the sidebar's conversation container to the bottom a few times to
  force Gemini to lazy-load older chats, then re-enumerate. Make clear in the UI that only
  loaded chats are manageable.
- Prefer resilient selectors (role / aria / visible text) over brittle generated class names.
- Include a `diagnose()` function that logs the sidebar structure to the console to make
  selector fixes fast.

## Feature 3 — Selection (the whole point)
- Each row has a checkbox. A plain click toggles that one.
- **Shift+Click selects the contiguous range** between the last-clicked row and the current
  one (Gmail behavior), setting all of them to the clicked box's new state.
- `Ctrl/Cmd+A` selects all currently-visible (filtered) rows; `Escape` clears.
- The search box filters the list live by title; range select operates on the filtered view.
- Footer shows the live selected count; "Delete selected" is disabled at 0.

## Feature 4 — Bulk delete
- On "Delete selected", show a confirm step: "Delete N chats? This can't be undone."
- Then process the queue **sequentially**. For each chat, drive Gemini's own delete flow:
  1. **Re-find the row fresh** — the list re-renders after each delete, so never reuse a stale
     element reference. Match by the captured id, fall back to title.
  2. Reveal + click the chat's kebab / "more options" button.
  3. Click the **Delete** item in the menu (match by visible text, case-insensitive; keep the
     label list configurable for i18n).
  4. Click **Delete** / confirm in the confirmation dialog (match by text).
  5. Wait until the row is gone before moving on.
- Provide a helper `waitFor(predicateFn, { timeout, interval })` that polls for the async
  menus/dialogs. Wrap each deletion in try/catch and record success/failure per chat.
- Add a **~500–900ms delay between deletions** (gentler on the UI, avoids tripping abuse
  detection).
- Show a live progress bar ("Deleting 4 / 12…") and a **Stop** button that aborts the rest of
  the queue.
- On finish, show a summary ("10 deleted, 2 failed") and refresh the list.

## Feature 5 — AI summaries (on demand)
- Titles render immediately. Summaries are generated **on demand, not automatically** (they're
  slow and use API quota), and **cached**.
- Provide a per-row "Summarize" action plus a "Summarize loaded" batch action.
- To summarize a chat, the content script reads its text: programmatically open that
  conversation, wait for the main thread to render, scrape the **first user message + first
  model response** (enough for a 1–2 sentence summary), then restore the user's previous view.
  Keep this deliberate and clearly indicated in the UI since it navigates the page.
- Send the scraped text to the background worker → worker calls the AI API → returns a
  **≤2-sentence** summary → display it under the title and cache it in `chrome.storage.local`
  keyed by chat id (skip anything already cached).
- **Provider:** default to the **Google Gemini API** (`generativelanguage.googleapis.com`) —
  it has a free tier, fitting for a Gemini tool. Make provider / model / API key configurable
  on the options page. Structure the API layer as a small adapter so `api.anthropic.com`
  (Claude) or OpenAI can be dropped in later. Add the chosen API host to `host_permissions`.
- If no API key is set, disable the summary actions and point the user to the options page.

## manifest.json essentials
- `manifest_version: 3`; name, `version: "0.1.0"`, description.
- `action` with **no** `default_popup` (so the background worker receives `onClicked`).
- `background.service_worker: "background.js"`.
- `content_scripts` matching `https://gemini.google.com/*` at `document_idle`.
- `host_permissions`: the AI API host.
- `permissions`: `["storage"]`.
- `icons`: 16 / 48 / 128.

## Non-goals for v1 (do NOT build)
- No Claude.ai support yet — but structure the chat enumeration/delete code behind a small
  "site adapter" seam so a second site could be added later. Only implement Gemini.
- No export / backup.
- No folders or tags.

## Quality bar
- No external dependencies — everything vanilla.
- Every fragile selector in the one `CONFIG.SELECTORS` block, commented.
- Graceful failure: if the sidebar can't be found, the panel shows a clear message and a
  "run diagnostics" hint instead of throwing.
- `README.md` covers: load-unpacked steps, setting the API key, usage, and **exactly where and
  how to update selectors** when Gemini changes its UI.
