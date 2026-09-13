/* Gemini Chat Organizer - content script.
   Injects the panel, enumerates chats, and drives Gemini's own delete flow. */

(() => {
  'use strict';

  // Guard against double-injection (SPA navigation can re-run this file).
  if (window.__gcoInjected) return;
  window.__gcoInjected = true;

  const HOST_ID = 'gemini-chat-organizer-host';

  // ---------------------------------------------------------------------------
  // CONFIG - every fragile DOM selector in the extension lives in this one
  // object. When Google changes Gemini's markup, this is the only block you
  // should need to edit. See README > "Fixing selectors" for how to find new
  // ones. Each entry is a comma-separated fallback list, tried left to right;
  // prefer role/aria/data-test-id hooks over generated class names.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    SELECTORS: {
      // The left sidebar as a whole. Used only to fail loudly when Gemini's
      // chrome is missing entirely (signed out, or a full redesign).
      sidebarRoot: [
        'bard-sidenav',
        '[data-test-id="side-nav"]',
        'nav[role="navigation"]',
      ].join(', '),

      // The scrolling container that holds recent conversations. We scroll
      // this element to force Gemini to lazy-load older chats.
      conversationList: [
        '[data-test-id="conversation-list"]',
        '.conversations-container',
        'conversations-list',
      ].join(', '),

      // One row per conversation. Must match ONLY real chats - not Gems, not
      // "Explore Gems", not nav links.
      conversationItem: [
        '[data-test-id="conversation"]',
        '.conversation-items-container .conversation',
      ].join(', '),

      // The visible title inside a conversation row.
      conversationTitle: [
        '[data-test-id="conversation-title"]',
        '.conversation-title',
      ].join(', '),

      // The per-row kebab / "more options" button. Often only rendered on
      // hover, so we dispatch a mouseover before looking for it.
      moreButton: [
        '[data-test-id="actions-menu-button"]',
        'button[aria-label*="option" i]',
        'button[aria-label*="more" i]',
      ].join(', '),

      // Items inside the popup menu that the kebab opens.
      menuItem: [
        '[role="menuitem"]',
        '.mat-mdc-menu-item',
      ].join(', '),

      // The confirmation dialog and its buttons.
      dialog: [
        '[role="dialog"]',
        'mat-dialog-container',
      ].join(', '),
      dialogButton: 'button',

      // Main conversation pane, used when scraping a chat for a summary.
      mainThread: [
        'chat-window',
        'main [role="log"]',
        'main',
      ].join(', '),
      userMessage: [
        'user-query',
        '[data-test-id="user-query"]',
        '.query-text',
      ].join(', '),
      modelMessage: [
        'model-response',
        '[data-test-id="model-response"]',
        'message-content',
      ].join(', '),
    },

    // Visible button text, matched case-insensitively. Add your locale's
    // wording here rather than touching the delete driver.
    LABELS: {
      delete: ['delete', 'remove', 'löschen', 'supprimer', 'eliminar', 'elimina'],
      confirm: ['delete', 'remove', 'confirm', 'löschen', 'supprimer', 'eliminar'],
    },

    TIMING: {
      waitTimeout: 8000,      // give up on a menu/dialog after this long
      waitInterval: 120,      // how often waitFor() re-checks
      deleteDelayMin: 500,    // gap between deletions - gentler on the UI and
      deleteDelayMax: 900,    // avoids tripping abuse detection
      loadMoreRounds: 6,      // scroll-to-bottom passes when loading older chats
      loadMoreSettle: 700,    // wait after each scroll for lazy-load to fire
      threadRender: 6000,     // wait for a conversation to render when scraping
    },

    LIMITS: {
      batchSummarize: 20,     // max chats per "Summarize loaded" run
    },
  };

  // ---------------------------------------------------------------------------
  // Small DOM / async helpers
  // ---------------------------------------------------------------------------

  const qs = (sel, scope = document) => scope.querySelector(sel);
  const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textOf = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

  /* Poll `predicate` until it returns something truthy, or give up.
     Gemini's menus and dialogs are rendered asynchronously, so every step of
     the delete flow waits on one of these rather than guessing a delay. */
  function waitFor(predicate, options = {}) {
    const timeout = options.timeout ?? CONFIG.TIMING.waitTimeout;
    const interval = options.interval ?? CONFIG.TIMING.waitInterval;
    const deadline = Date.now() + timeout;

    return new Promise((resolve, reject) => {
      (function poll() {
        let value;
        try {
          value = predicate();
        } catch (err) {
          reject(err);
          return;
        }

        if (value) {
          resolve(value);
          return;
        }

        if (Date.now() >= deadline) {
          reject(new Error(options.message || 'Timed out waiting for the page'));
          return;
        }

        setTimeout(poll, interval);
      })();
    });
  }

  function matchesLabel(el, labels) {
    const text = textOf(el).toLowerCase();
    if (!text) return false;
    return labels.some((label) => text.includes(label));
  }

  function randomDelay() {
    const { deleteDelayMin: min, deleteDelayMax: max } = CONFIG.TIMING;
    return min + Math.random() * (max - min);
  }

  // ---------------------------------------------------------------------------
  // Site adapter seam. Only Gemini is implemented; a second site would add
  // another adapter with the same shape and the panel code would not change.
  // ---------------------------------------------------------------------------

  const geminiAdapter = {
    id: 'gemini',
    label: 'Gemini',

    matches() {
      return location.hostname === 'gemini.google.com';
    },

    /* The scrolling element that holds conversations, or null if the sidebar
       can't be found at all (collapsed, signed out, or markup changed). */
    listContainer() {
      return qs(CONFIG.SELECTORS.conversationList);
    },

    sidebar() {
      return qs(CONFIG.SELECTORS.sidebarRoot);
    },

    /* Live row elements, in sidebar order. */
    rowElements() {
      const container = this.listContainer();
      if (!container) return [];
      return qsa(CONFIG.SELECTORS.conversationItem, container);
    },

    /* A stable-ish id for a row. Gemini puts the conversation id in jslog /
       data attributes; we fall back to a title-derived key so the row is still
       addressable (matching then relies on the title, which is good enough). */
    idFor(el, index) {
      const direct =
        el.getAttribute('data-conversation-id') ||
        el.getAttribute('data-test-id-conversation') ||
        el.id;
      if (direct) return direct;

      const jslog = el.getAttribute('jslog') || '';
      const match = jslog.match(/c_[0-9a-f]{8,}/i);
      if (match) return match[0];

      const href = el.querySelector('a[href*="/app/"]')?.getAttribute('href');
      if (href) return href.split('/').pop();

      return `title:${this.titleFor(el) || `row-${index}`}`;
    },

    titleFor(el) {
      const node = el.querySelector(CONFIG.SELECTORS.conversationTitle);
      return textOf(node) || textOf(el);
    },

    /* Re-find a row from scratch. The sidebar re-renders after every delete,
       so a stored element reference goes stale immediately - match on the
       captured id first, fall back to the title. */
    findRow(chat) {
      const rows = this.rowElements();
      const byId = rows.find((el, i) => this.idFor(el, i) === chat.id);
      if (byId) return byId;
      return rows.find((el) => this.titleFor(el) === chat.title) || null;
    },

    /* The kebab is usually only rendered on hover, so fake a hover first. */
    async revealMoreButton(row) {
      row.scrollIntoView({ block: 'nearest' });
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
        row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      return waitFor(() => qs(CONFIG.SELECTORS.moreButton, row), {
        timeout: 2000,
        message: 'Could not find the chat\u2019s options button',
      });
    },

    /* The "Delete" entry in the popup menu, matched by visible text. */
    menuDeleteItem() {
      return qsa(CONFIG.SELECTORS.menuItem).find(
        (el) => el.offsetParent !== null && matchesLabel(el, CONFIG.LABELS.delete)
      );
    },

    /* The confirming button inside the modal, matched by visible text. */
    dialogConfirmButton() {
      const dialog = qsa(CONFIG.SELECTORS.dialog).find((el) => el.offsetParent !== null);
      if (!dialog) return null;
      return qsa(CONFIG.SELECTORS.dialogButton, dialog).find((el) =>
        matchesLabel(el, CONFIG.LABELS.confirm)
      );
    },
  };

  const adapters = [geminiAdapter];
  const adapter = adapters.find((a) => a.matches()) || geminiAdapter;

  // Panel styling is injected into the shadow root as a string, so Gemini's
  // stylesheets and ours can never collide. Filled in a later commit.
  const PANEL_CSS = `
    :host {
      --bg: #ffffff;
      --bg-sunk: #f6f7f9;
      --fg: #1f2124;
      --fg-dim: #5f6368;
      --line: #e3e5e8;
      --accent: #4d5bf0;
      --danger: #c5221f;
      --danger-bg: #fce8e6;
      --shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1e1f22;
        --bg-sunk: #27282c;
        --fg: #e6e7ea;
        --fg-dim: #9aa0a6;
        --line: #35373c;
        --accent: #8d97ff;
        --danger: #f28b82;
        --danger-bg: #3a1f1e;
        --shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      }
    }

    * { box-sizing: border-box; }

    .panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 380px;
      max-width: 100vw;
      height: 100vh;
      display: none;
      flex-direction: column;
      background: var(--bg);
      color: var(--fg);
      border-left: 1px solid var(--line);
      box-shadow: var(--shadow);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
            Helvetica, Arial, sans-serif;
      z-index: 2147483000;
    }

    :host(.open) .panel { display: flex; }

    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }

    .title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .title strong { font-size: 14px; font-weight: 600; }
    .count { color: var(--fg-dim); font-size: 12px; }
    .head-actions { display: flex; gap: 4px; flex: none; }

    .icon-btn, .link-btn {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: var(--fg-dim);
      font: inherit;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
    }

    .icon-btn:hover, .link-btn:hover { background: var(--bg-sunk); color: var(--fg); }
    .icon-btn:disabled, .link-btn:disabled { opacity: 0.45; cursor: default; }

    .search { padding: 10px 16px; border-bottom: 1px solid var(--line); }

    .search input {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--bg-sunk);
      color: var(--fg);
      font: inherit;
    }

    .search input:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg);
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
    }

    .selected-count { margin-left: auto; color: var(--fg-dim); font-size: 12px; }

    .status {
      margin: 0;
      padding: 8px 16px;
      font-size: 12px;
      color: var(--fg-dim);
      background: var(--bg-sunk);
      border-bottom: 1px solid var(--line);
    }

    .status[hidden] { display: none; }

    .list { flex: 1; overflow-y: auto; padding: 4px 0; }

    .empty, .notice {
      margin: 0;
      padding: 24px 16px;
      color: var(--fg-dim);
      text-align: center;
    }

    .notice code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--bg-sunk);
      padding: 1px 4px;
      border-radius: 4px;
    }

    .row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 16px;
      cursor: default;
    }

    .row:hover { background: var(--bg-sunk); }

    .row-body { min-width: 0; flex: 1; }

    .row input[type="checkbox"] {
      margin: 2px 0 0;
      width: 15px;
      height: 15px;
      accent-color: var(--accent);
      flex: none;
      cursor: pointer;
    }

    .row.selected { background: var(--bg-sunk); }

    .row-title {
      display: block;
      width: 100%;
      text-align: left;
      font: inherit;
      color: var(--fg);
      background: none;
      border: 0;
      padding: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .foot { padding: 12px 16px; border-top: 1px solid var(--line); }

    .danger {
      width: 100%;
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--bg-sunk);
      color: var(--danger);
      font: inherit;
      font-weight: 600;
      padding: 9px 12px;
      cursor: pointer;
    }

    .confirm-text { margin: 0 0 10px; color: var(--fg); }

    .confirm-actions { display: flex; align-items: center; gap: 8px; }
    .confirm-actions .danger { width: auto; flex: 1; }

    .danger:hover:not(:disabled) { background: var(--danger-bg); }
    .danger:disabled { opacity: 0.45; cursor: default; }

    .fab {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 50%;
      background: var(--bg);
      color: var(--fg);
      box-shadow: var(--shadow);
      cursor: pointer;
      z-index: 2147482999;
      transition: transform 120ms ease;
    }

    .fab:hover { transform: translateY(-1px); }
    :host(.open) .fab { display: none; }

    .fab svg { width: 20px; height: 20px; fill: currentColor; }
  `;

  const state = {
    open: false,
    loading: false,
    loadedOnce: false,
    chats: [],
    error: null,
    // Selection is keyed by chat id, not by element or index, so it survives
    // re-enumeration after a refresh or a delete.
    selected: new Set(),
    lastClickedId: null,
    suppressChange: false,
    filter: '',
    confirming: false,
    deleting: false,
  };

  const ui = { host: null, root: null, panel: null };

  // ---------------------------------------------------------------------------
  // Panel construction
  // ---------------------------------------------------------------------------

  function buildPanel() {
    if (ui.host) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Gemini chat organizer');
    panel.tabIndex = -1;
    panel.innerHTML = `
      <header class="head">
        <div class="title">
          <strong>Chat organizer</strong>
          <span class="count" data-role="count"></span>
        </div>
        <div class="head-actions">
          <button class="icon-btn" data-action="refresh" title="Refresh list">Refresh</button>
          <button class="icon-btn" data-action="close" title="Close panel">Close</button>
        </div>
      </header>

      <div class="search">
        <input type="search" data-role="search" placeholder="Search loaded chats"
               autocomplete="off" spellcheck="false" />
      </div>

      <div class="toolbar">
        <button class="link-btn" data-action="select-all">Select all</button>
        <button class="link-btn" data-action="clear">Clear</button>
        <button class="link-btn" data-action="load-older">Load older</button>
        <span class="selected-count" data-role="selected"></span>
      </div>

      <p class="status" data-role="status" hidden></p>

      <div class="list" data-role="list"></div>

      <footer class="foot" data-role="foot"></footer>
    `;

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.type = 'button';
    fab.title = 'Open chat organizer';
    fab.setAttribute('aria-label', 'Open chat organizer');
    // Inline SVG: no external assets, no CDN.
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 6h10v2H4zm0 5h10v2H4zm0 5h7v2H4zM17 6h3v2h-3zm0 5h3v2h-3zm0 5h3v2h-3z"/>' +
      '</svg>';
    fab.addEventListener('click', openPanel);

    root.appendChild(fab);
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.root = root;
    ui.panel = panel;

    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onPanelChange);
    // Shortcuts are bound to the panel, not the document, so Cmd/Ctrl+A never
    // hijacks select-all elsewhere on the Gemini page.
    panel.addEventListener('keydown', onPanelKeydown);
    panel.addEventListener('input', onPanelInput);
  }

  function onPanelClick(event) {
    // Clear the suppression flag at the start of every click rather than
    // trusting `change` to clear it: a shift+click re-renders the list, which
    // detaches the checkbox before its change event can bubble here. Left
    // sticky, that flag would swallow the next plain click.
    state.suppressChange = false;

    const box = event.target.closest('input[type="checkbox"]');
    if (box) {
      // A checkbox's checked state is already updated by the time the click
      // listener runs, so `box.checked` is the state the user just asked for.
      if (event.shiftKey && state.lastClickedId) {
        applyRange(state.lastClickedId, box.dataset.id, box.checked);
        state.suppressChange = true;
      }
      return;
    }

    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') closePanel();
    else if (action === 'refresh') refresh();
    else if (action === 'load-older') loadOlderChats();
    else if (action === 'select-all') selectAllVisible();
    else if (action === 'clear') clearSelection();
    else if (action === 'delete') requestDelete();
    else if (action === 'confirm-delete') confirmDelete();
    else if (action === 'cancel-delete') cancelDelete();
  }

  function onPanelInput(event) {
    if (event.target?.dataset?.role !== 'search') return;
    state.filter = event.target.value;
    // A filter change invalidates the range anchor: the anchor row may no
    // longer be visible.
    state.lastClickedId = null;
    render();
  }

  function onPanelChange(event) {
    const box = event.target;
    if (box?.type !== 'checkbox') return;

    if (state.suppressChange) {
      // A shift+click already handled this as a range.
      state.suppressChange = false;
      return;
    }

    const id = box.dataset.id;
    setSelected(id, box.checked);
    state.lastClickedId = id;
    box.closest('.row')?.classList.toggle('selected', box.checked);
    renderCounters();
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------

  function openPanel() {
    buildPanel();
    state.open = true;
    ui.host.classList.add('open');
    ui.panel.focus();
    refresh();
    if (!state.loadedOnce && !state.error) {
      state.loadedOnce = true;
      loadOlderChats();
    }
  }

  function closePanel() {
    state.open = false;
    ui.host?.classList.remove('open');
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function $(selector) {
    return ui.root?.querySelector(selector) || null;
  }

  function setStatus(text) {
    const el = $('[data-role="status"]');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------------------------------------------------------------------------
  // Enumeration
  // ---------------------------------------------------------------------------

  function enumerateChats() {
    state.error = null;

    if (!adapter.sidebar()) {
      state.chats = [];
      state.error =
        'Could not find Gemini\u2019s sidebar. It may be collapsed, or Google ' +
        'may have changed the markup.';
      return;
    }

    const rows = adapter.rowElements();
    if (!rows.length) {
      state.chats = [];
      state.error =
        'The sidebar is there, but no conversations matched. The selectors ' +
        'likely need updating.';
      return;
    }

    state.chats = rows.map((el, index) => ({
      id: adapter.idFor(el, index),
      title: adapter.titleFor(el) || '(untitled chat)',
      el,
    }));

    pruneSelection();
  }

  /* Drop selected ids that no longer exist, so a refresh keeps the rest of the
     selection intact instead of silently resetting it. */
  function pruneSelection() {
    const live = new Set(state.chats.map((chat) => chat.id));
    for (const id of Array.from(state.selected)) {
      if (!live.has(id)) state.selected.delete(id);
    }
  }

  function refresh() {
    enumerateChats();
    render();
  }

  /* Gemini lazy-loads older conversations as the sidebar scrolls. Drive that
     by scrolling its container to the bottom a few times, waiting for new rows
     to appear after each pass. Only chats loaded this way are manageable -
     the UI says so explicitly. */
  async function loadOlderChats() {
    const container = adapter.listContainer();
    if (!container) {
      refresh();
      return;
    }

    state.loading = true;
    const previousScroll = container.scrollTop;

    for (let round = 0; round < CONFIG.TIMING.loadMoreRounds; round += 1) {
      const before = adapter.rowElements().length;
      setStatus(`Loading older chats\u2026 ${before} so far`);
      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.TIMING.loadMoreSettle);
      const after = adapter.rowElements().length;
      if (after === before) break; // nothing new arrived; we've hit the end
    }

    container.scrollTop = previousScroll;
    state.loading = false;
    enumerateChats();
    setStatus(
      `${state.chats.length} chats loaded. Only loaded chats can be managed \u2014 ` +
        'use "Load older" to pull in more.'
    );
    render();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function visibleChats() {
    const needle = state.filter.trim().toLowerCase();
    if (!needle) return state.chats;
    return state.chats.filter((chat) => chat.title.toLowerCase().includes(needle));
  }

  function setSelected(id, on) {
    if (on) state.selected.add(id);
    else state.selected.delete(id);
  }

  function selectAllVisible() {
    for (const chat of visibleChats()) state.selected.add(chat.id);
    render();
  }

  function clearSelection() {
    state.selected.clear();
    render();
  }

  /* Gmail behaviour: shift+click sets every row between the last-clicked row
     and this one to the clicked box's new state. Operates on the filtered
     view, so a range never reaches rows the user can't see. */
  function applyRange(fromId, toId, on) {
    const chats = visibleChats();
    const from = chats.findIndex((chat) => chat.id === fromId);
    const to = chats.findIndex((chat) => chat.id === toId);
    if (from === -1 || to === -1) return;

    const [start, end] = from <= to ? [from, to] : [to, from];
    for (let i = start; i <= end; i += 1) setSelected(chats[i].id, on);

    state.lastClickedId = toId;
    render();
  }

  function onPanelKeydown(event) {
    const key = event.key;

    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAllVisible();
      return;
    }

    if (key === 'Escape') {
      event.preventDefault();
      // Escape clears a selection first; only closes the panel when there is
      // nothing selected to clear.
      if (state.selected.size) clearSelection();
      else closePanel();
    }
  }

  function renderCounters() {
    const selectedEl = $('[data-role="selected"]');
    if (selectedEl) {
      const n = state.selected.size;
      selectedEl.textContent = n ? `${n} selected` : '';
    }

    renderFooter();
  }

  function renderFooter() {
    const foot = $('[data-role="foot"]');
    if (!foot) return;

    const n = state.selected.size;

    if (state.confirming) {
      foot.innerHTML = `
        <p class="confirm-text">Delete ${n} chat${n === 1 ? '' : 's'}? This can\u2019t be undone.</p>
        <div class="confirm-actions">
          <button class="link-btn" data-action="cancel-delete">Cancel</button>
          <button class="danger" data-action="confirm-delete">Delete ${n}</button>
        </div>
      `;
      return;
    }

    foot.innerHTML =
      `<button class="danger" data-action="delete"${n ? '' : ' disabled'}>` +
      `Delete selected${n ? ` (${n})` : ''}</button>`;
  }

  function render() {
    if (!ui.root) return;
    const list = $('[data-role="list"]');
    if (!list) return;

    const chats = visibleChats();

    const countEl = $('[data-role="count"]');
    if (countEl) {
      if (!state.chats.length) countEl.textContent = '';
      else if (chats.length === state.chats.length) {
        countEl.textContent = `${state.chats.length} loaded`;
      } else {
        countEl.textContent = `${chats.length} of ${state.chats.length}`;
      }
    }

    if (state.error) {
      list.innerHTML = '';
      const notice = document.createElement('p');
      notice.className = 'notice';
      notice.textContent = state.error;
      const hint = document.createElement('p');
      hint.className = 'notice';
      hint.innerHTML =
        'Open the console and run <code>__gcoDiagnose()</code> to dump the ' +
        'sidebar structure, then update <code>CONFIG.SELECTORS</code> in ' +
        '<code>content.js</code>.';
      list.append(notice, hint);
      renderCounters();
      return;
    }

    if (!chats.length) {
      list.innerHTML = state.filter
        ? '<p class="empty">No chats match that search.</p>'
        : '<p class="empty">No chats loaded yet.</p>';
      renderCounters();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const chat of chats) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.id = chat.id;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.selected.has(chat.id);
      box.dataset.id = chat.id;
      box.setAttribute('aria-label', `Select ${chat.title}`);
      if (box.checked) row.classList.add('selected');

      const body = document.createElement('div');
      body.className = 'row-body';

      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = chat.title;
      title.title = chat.title;

      body.appendChild(title);
      row.append(box, body);
      frag.appendChild(row);
    }

    list.innerHTML = '';
    list.appendChild(frag);
    renderCounters();
  }

  // ---------------------------------------------------------------------------
  // Bulk delete
  // ---------------------------------------------------------------------------

  /* Drive Gemini's own delete flow for a single chat. Every step waits for the
     async UI rather than sleeping a fixed amount. */
  async function deleteChat(chat) {
    const row = adapter.findRow(chat);
    if (!row) throw new Error('Row not found (already deleted?)');

    const moreButton = await adapter.revealMoreButton(row);
    moreButton.click();

    const deleteItem = await waitFor(() => adapter.menuDeleteItem(), {
      message: 'Delete option never appeared in the menu',
    });
    deleteItem.click();

    const confirmButton = await waitFor(() => adapter.dialogConfirmButton(), {
      message: 'Confirmation dialog never appeared',
    });
    confirmButton.click();

    // Only move on once the row is actually gone.
    await waitFor(() => !adapter.findRow(chat), {
      message: 'Chat still present after confirming delete',
    });
  }

  async function runDelete(chats) {
    state.deleting = true;
    let done = 0;
    let failed = 0;

    for (const chat of chats) {
      try {
        await deleteChat(chat);
        state.selected.delete(chat.id);
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[GCO] failed to delete "${chat.title}":`, err?.message || err);
      }

      await sleep(randomDelay());
    }

    state.deleting = false;
    setStatus(
      failed ? `${done} deleted, ${failed} failed.` : `${done} deleted.`
    );
    refresh();
  }

  function requestDelete() {
    if (!state.selected.size) return;
    state.confirming = true;
    render();
  }

  function confirmDelete() {
    state.confirming = false;
    const chats = state.chats.filter((chat) => state.selected.has(chat.id));
    render();
    runDelete(chats);
  }

  function cancelDelete() {
    state.confirming = false;
    render();
  }

  // ---------------------------------------------------------------------------
  // Diagnostics - run __gcoDiagnose() from the console to see what each
  // selector currently matches. In DevTools, switch the console's context
  // dropdown from "top" to "Gemini Chat Organizer" first; content scripts run
  // in an isolated world.
  // ---------------------------------------------------------------------------

  function diagnose() {
    const report = {};
    console.group('[GCO] selector diagnostics');

    for (const [name, selector] of Object.entries(CONFIG.SELECTORS)) {
      const matches = qsa(selector);
      report[name] = matches.length;
      console.log(
        `%c${name}%c  ${matches.length} match(es)`,
        'font-weight:600',
        'color:inherit',
        selector
      );
      if (matches[0]) console.log('   first match:', matches[0]);
    }

    const container = adapter.listContainer();
    if (container) {
      console.log('conversation container:', container);
      console.log(
        'direct children tag/class:',
        Array.from(container.children).slice(0, 10).map(
          (el) => `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`
        )
      );
    } else {
      console.warn('No conversation container matched - fix `conversationList` first.');
    }

    const rows = adapter.rowElements();
    console.log(`enumerated ${rows.length} row(s)`);
    rows.slice(0, 5).forEach((el, i) => {
      console.log(`  [${i}] id=${adapter.idFor(el, i)} title=${adapter.titleFor(el)}`, el);
    });

    console.groupEnd();
    return report;
  }

  window.__gcoDiagnose = diagnose;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GCO_TOGGLE_PANEL') togglePanel();
  });

  buildPanel();
})();
