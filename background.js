/* Gemini Chat Organizer - background service worker.
   All network calls live here; the content script never fetches cross-origin
   itself, because the page's CSP would block it. */

'use strict';
