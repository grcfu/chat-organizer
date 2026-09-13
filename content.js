/* Gemini Chat Organizer - content script.
   Injects the panel, enumerates chats, and drives Gemini's own delete flow. */

(() => {
  'use strict';

  // Guard against double-injection (SPA navigation can re-run this file).
  if (window.__gcoInjected) return;
  window.__gcoInjected = true;

  function togglePanel() {
    // Panel lands in a later commit; for now prove the message path works.
    console.log('[GCO] toggle requested');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GCO_TOGGLE_PANEL') togglePanel();
  });
})();
