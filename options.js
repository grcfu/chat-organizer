/* Gemini Chat Organizer - options page. */

'use strict';

// Documented defaults. Models are free text so a retired id never bricks the
// extension - change it here or on the page.
const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
};

const DEFAULTS = {
  provider: 'gemini',
  model: DEFAULT_MODELS.gemini,
  apiKey: '',
};

const $ = (id) => document.getElementById(id);

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('provider').value = settings.provider;
  $('model').value = settings.model;
  $('apiKey').value = settings.apiKey;
  updateHint();
}

function updateHint() {
  const provider = $('provider').value;
  $('model-hint').textContent =
    `Free text, so it keeps working when a model id is retired. Default: ${DEFAULT_MODELS[provider]}`;
}

$('provider').addEventListener('change', () => {
  // Swap in the new provider's default model unless the user typed their own.
  const current = $('model').value.trim();
  if (!current || Object.values(DEFAULT_MODELS).includes(current)) {
    $('model').value = DEFAULT_MODELS[$('provider').value];
  }
  updateHint();
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    provider: $('provider').value,
    model: $('model').value.trim() || DEFAULT_MODELS[$('provider').value],
    apiKey: $('apiKey').value.trim(),
  });

  const status = $('status');
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

load();
