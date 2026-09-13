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
  const PANEL_CSS = '';

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
