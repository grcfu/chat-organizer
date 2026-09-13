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
    chats: [],
    error: null,
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
        <input type="search" data-role="search" placeholder="Search loaded chats" />
      </div>

      <div class="toolbar">
        <button class="link-btn" data-action="select-all">Select all</button>
        <button class="link-btn" data-action="clear">Clear</button>
        <span class="selected-count" data-role="selected"></span>
      </div>

      <div class="list" data-role="list"></div>

      <footer class="foot">
        <button class="danger" data-action="delete" disabled>Delete selected</button>
      </footer>
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
  }

  function onPanelClick(event) {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') closePanel();
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------

  function openPanel() {
    buildPanel();
    state.open = true;
    ui.host.classList.add('open');
    render();
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

  function render() {
    if (!ui.root) return;
    const list = $('[data-role="list"]');
    if (!list) return;
    list.innerHTML = '<p class="empty">No chats loaded yet.</p>';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GCO_TOGGLE_PANEL') togglePanel();
  });

  buildPanel();
})();
