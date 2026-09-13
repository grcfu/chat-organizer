# Gemini Chat Organizer

A Manifest V3 Chrome extension that adds inbox-style bulk management to
[Gemini](https://gemini.google.com): multi-select with Gmail-style Shift+Click
range select, bulk delete, jump-to-chat, and optional on-demand AI summaries.

Gemini's sidebar only lets you delete chats one at a time. This fixes that.

No build step, no npm, no external dependencies — plain JavaScript, loaded as-is.

---

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open <https://gemini.google.com> and reload the tab.

You should see a round button in the bottom-right corner. Click it — or the
extension's toolbar icon — to open the panel.

If you loaded the extension while a Gemini tab was already open, reload that tab.
The content script only injects into pages loaded after the extension.

---

## Usage

| Action | How |
| --- | --- |
| Open / close the panel | Floating button, or the toolbar icon |
| Select one chat | Click its checkbox |
| Select a range | Click one checkbox, then **Shift+Click** another |
| Select everything visible | **Ctrl/Cmd+A** (only while the panel has focus) |
| Clear the selection | **Escape**, or "Clear" |
| Close the panel | **Escape** again, with nothing selected |
| Filter the list | Type in the search box |
| See what a chat is | Click its **title** — opens it, panel stays open |
| Delete in bulk | Select, then **Delete selected**, then confirm |

**Only loaded chats can be managed.** Gemini lazy-loads its sidebar, so the panel
scrolls it on first open to pull in older chats, and "Load older" pulls in more.
Anything still unloaded isn't in the list.

Deletion runs **one chat at a time**, driving Gemini's own menu → dialog flow,
with a 500–900 ms gap between each. That's deliberate: it's gentler on the UI and
avoids looking like abuse. A progress bar shows where it's up to and **Stop**
aborts the rest of the queue. Failures are counted, not fatal — you'll get a
"10 deleted, 2 failed" summary at the end.

### Jump to a chat vs. summaries

Clicking a title is the fast way to answer "what is this chat?" — free, instant,
no setup. Summaries exist for the other case: scanning a **large backlog** where
reading 30 one-liners beats clicking into 30 chats.

Worth knowing: generating a summary opens the chat anyway, so it costs the same
navigation as jumping. It only pays off on re-read, from the cache.

---

## Optional: AI summaries

**The extension is fully usable without this.** Multi-select, bulk delete, search
and jump-to-chat all work with no API key. Summaries stay off until you add one.

1. Get a key from [Google AI Studio](https://aistudio.google.com/apikey) (free tier).
2. Right-click the extension icon → **Options** (or `chrome://extensions` →
   *Details* → *Extension options*).
3. Paste the key, hit **Save**.

A **Summarize** link then appears on each row, plus **Summarize loaded** for a
batch (capped at 20 per run). Summaries are generated **on demand only** — never
automatically — and cached in `chrome.storage.local`, keyed by chat id. Cached
entries are deleted along with their chat.

Summarizing navigates the page: it opens the chat, reads the first user message
and first model response, then sends you back. Any unsent draft in the composer
will be lost, which is why the batch action confirms first.

### Other providers

The API layer in `background.js` is a small adapter per provider, so Anthropic
and OpenAI are already wired up. To use one:

1. Pick it on the options page.
2. Add its host to `host_permissions` in `manifest.json`:
   - Anthropic → `https://api.anthropic.com/*`
   - OpenAI → `https://api.openai.com/*`
3. Reload the extension at `chrome://extensions`.

Model ids are a free-text field with a documented default, so a retired model id
never bricks the extension — just type the current one.

**Note on the key:** it's stored in `chrome.storage.local` in plain text, like
every extension's local settings. Anyone with access to your Chrome profile can
read it. Use a restricted key if that matters to you.

---

## Fixing selectors when Gemini changes

This extension drives Google's UI by reading its DOM, and Google changes that DOM
without warning. When it breaks, **one block is all you need to edit.**

### Where

Every fragile selector lives in `CONFIG.SELECTORS` at the top of `content.js`.
Nothing else in the codebase queries the page by class or tag name. Each entry is
a comma-separated fallback list, tried left to right, and each is commented with
what it's expected to match.

```js
const CONFIG = {
  SELECTORS: {
    sidebarRoot: 'bard-sidenav, [data-test-id="side-nav"], nav[role="navigation"]',
    conversationList: '[data-test-id="conversation-list"], .conversations-container, …',
    conversationItem: '[data-test-id="conversation"], …',
    // …
  },
  LABELS: { delete: ['delete', 'remove', …], confirm: […] },
  TIMING: { … },
};
```

### How

1. Open Gemini with the panel showing the failure.
2. Open DevTools → **Console**.
3. Switch the console's context dropdown from **top** to **Gemini Chat Organizer**.
   Content scripts run in an isolated world; without this step the next step
   won't resolve.
4. Run:

   ```js
   __gcoDiagnose()
   ```

   It prints every selector, how many elements it currently matches, the first
   match for each, the conversation container's direct children, and the first
   five enumerated rows with their derived ids and titles.

5. Find the entry reporting **0 matches** — that's your break.
6. Inspect the real element in the Elements panel and pick a resilient hook:
   prefer `data-test-id`, `role`, or `aria-label` over generated class names like
   `.ng-tns-c123456789-4`, which change on every Google deploy.
7. **Add** your new selector to the front of that entry's list rather than
   replacing the old one — the fallbacks cost nothing and keep the extension
   working across A/B-tested variants.
8. Reload the extension at `chrome://extensions`, then reload the Gemini tab.

### What usually breaks, and the symptom

| Symptom | Selector to check |
| --- | --- |
| "Could not find Gemini's sidebar" | `sidebarRoot` |
| "The sidebar is there, but no conversations matched" | `conversationList`, `conversationItem` |
| Rows appear but titles are blank or show the whole row's text | `conversationTitle` |
| Gems or nav links appear as if they were chats | `conversationItem` — tighten it |
| "Could not find the chat's options button" | `moreButton` |
| "Delete option never appeared in the menu" | `menuItem`, or `LABELS.delete` |
| "Confirmation dialog never appeared" | `dialog`, `dialogButton`, or `LABELS.confirm` |
| "No messages found in that chat" | `mainThread`, `userMessage`, `modelMessage` |

### Not using English?

Delete and confirm buttons are matched by **visible text**, case-insensitively,
against `CONFIG.LABELS`. Add your locale's wording to those arrays — don't touch
the delete driver itself.

### Timing

If your connection or machine is slow and steps time out, raise the values in
`CONFIG.TIMING` (all milliseconds). `deleteDelayMin` / `deleteDelayMax` are the
deliberate pause between deletions — raising them is safe, lowering them is not
recommended.

---

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: toolbar toggle + **all** network calls |
| `content.js` | Panel, enumeration, selection, delete driver, scraping |
| `options.html` / `options.js` | Settings: provider, model, API key |
| `icons/` | 16 / 48 / 128 px icons |

Two structural rules worth preserving if you extend this:

- **All network calls happen in the service worker**, never the content script.
  Gemini's CSP blocks cross-origin `fetch` from the page context.
- **The UI lives in a Shadow DOM**, so Gemini's stylesheets and this panel's can
  never collide.

Chat enumeration and deletion sit behind a small **site adapter** (`geminiAdapter`
in `content.js`). A second site would add another adapter with the same shape;
the panel code wouldn't change.

---

## Limitations

- Only chats loaded into the sidebar can be managed.
- Deletion is irreversible — Gemini has no trash to recover from.
- Selectors are best-effort against a UI that changes without notice; see above.
- Gemini only, by design. No export, no folders, no tags.
