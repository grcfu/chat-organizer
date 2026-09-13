/* Gemini Chat Organizer - background service worker.
   Two jobs: relay the toolbar-icon click to the content script, and (later)
   make all AI API calls. All network calls live here; the content script never
   fetches cross-origin itself, because the page's CSP would block it. */

'use strict';

const GEMINI_ORIGIN = 'https://gemini.google.com';

/* The action has no default_popup, so clicking the toolbar icon lands here.
   We just tell the content script to toggle its panel. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith(GEMINI_ORIGIN)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GCO_TOGGLE_PANEL' });
  } catch (err) {
    // Content script isn't live in this tab yet (e.g. the tab predates the
    // extension being loaded). A reload fixes it; nothing to do here.
    console.warn('[GCO] could not reach content script:', err?.message || err);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'GCO_PING':
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});
