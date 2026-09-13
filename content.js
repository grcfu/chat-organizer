/* Gemini Chat Organizer - content script.
   Injects the panel, enumerates chats, and drives Gemini's own delete flow. */

(() => {
  'use strict';

  // Guard against double-injection (SPA navigation can re-run this file).
  if (window.__gcoInjected) return;
  window.__gcoInjected = true;
})();
