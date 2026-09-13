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

/* ---------------------------------------------------------------------------
   API layer. Each provider is a small adapter with the same shape, so dropping
   in another one means adding an entry here (and its host to host_permissions
   in manifest.json) - nothing else changes.
   --------------------------------------------------------------------------- */

const PROMPT =
  'Summarise this chat in at most two sentences. Be concrete and factual. ' +
  'Do not start with "This chat" or "The user".';

const PROVIDERS = {
  gemini: {
    async summarize({ apiKey, model, text }) {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        ':generateContent';

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${PROMPT}\n\n${text}` }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
        }),
      });

      if (!res.ok) throw new Error(await describeError(res));
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    },
  },

  anthropic: {
    async summarize({ apiKey, model, text }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for browser-originated calls.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          messages: [{ role: 'user', content: `${PROMPT}\n\n${text}` }],
        }),
      });

      if (!res.ok) throw new Error(await describeError(res));
      const data = await res.json();
      return data?.content?.[0]?.text?.trim() || '';
    },
  },

  openai: {
    async summarize({ apiKey, model, text }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          messages: [{ role: 'user', content: `${PROMPT}\n\n${text}` }],
        }),
      });

      if (!res.ok) throw new Error(await describeError(res));
      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim() || '';
    },
  },
};

async function describeError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }

  if (res.status === 401 || res.status === 403) {
    return `API key rejected (${res.status}). Check it on the options page.`;
  }
  if (res.status === 429) {
    return 'Rate limited by the API. Wait a moment and try again.';
  }
  return detail || `API request failed (${res.status})`;
}

async function summarize(text) {
  const { provider = 'gemini', model, apiKey } = await chrome.storage.local.get([
    'provider',
    'model',
    'apiKey',
  ]);

  if (!apiKey) throw new Error('No API key set. Open the extension options to add one.');

  const impl = PROVIDERS[provider];
  if (!impl) throw new Error(`Unknown provider: ${provider}`);

  const summary = await impl.summarize({ apiKey, model, text });
  if (!summary) throw new Error('The API returned an empty summary.');
  return summary;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'GCO_PING':
      sendResponse({ ok: true });
      return false;

    case 'GCO_HAS_KEY':
      chrome.storage.local
        .get('apiKey')
        .then(({ apiKey }) => sendResponse({ ok: true, hasKey: Boolean(apiKey) }))
        .catch(() => sendResponse({ ok: false, hasKey: false }));
      return true; // response is async

    case 'GCO_OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case 'GCO_SUMMARIZE':
      summarize(msg.text)
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true; // response is async

    default:
      return false;
  }
});
