/* Gemini Chat Organizer - content script.
   Injects the panel, enumerates chats, and drives Gemini's own delete flow. */

(() => {
  'use strict';

  // Guard against double-injection (SPA navigation can re-run this file).
  if (window.__gcoInjected) return;
  window.__gcoInjected = true;

  const HOST_ID = 'gemini-chat-organizer-host';

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
})();
