'use strict';

/**
 * The window's languages.
 *
 * Dictionaries are data files (`i18n.<code>.json`) rather than code, so adding a
 * language means adding a file and nothing else, and a test can compare two files
 * key by key to prove neither has drifted.
 *
 * This module runs in the main process. The window gets the chosen dictionary
 * over one IPC call instead of fetching the file itself, which keeps the
 * language list in one place and means the renderer never has to know where a
 * translation is stored.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Codes offered in the interface, in the order they are shown. */
const LANGUAGES = ['ru', 'en'];
const FALLBACK = 'en';

const cache = new Map();

function dictionaryPath(code) {
  return path.join(__dirname, `i18n.${code}.json`);
}

/** Read one dictionary, or null when there is no file for that code. */
function loadDictionary(code) {
  if (cache.has(code)) return cache.get(code);
  let messages = null;
  try {
    const raw = fs.readFileSync(dictionaryPath(code), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') messages = parsed;
  } catch {
    // A missing or broken dictionary falls back to the fallback language; the
    // interface stays usable and the failure is visible as untranslated text.
    messages = null;
  }
  cache.set(code, messages);
  return messages;
}

/** Which language the window should use, given a preference and a locale. */
function resolveLanguage(choice, locale = '') {
  const wanted = String(choice || 'system').toLowerCase();
  if (wanted !== 'system' && LANGUAGES.includes(wanted)) return wanted;
  const tag = String(locale || '').toLowerCase();
  const match = LANGUAGES.find((code) => tag.startsWith(code));
  if (match) return match;
  // English is the fallback for a system language nobody has translated yet.
  return FALLBACK;
}

/**
 * The payload the window needs: the resolved language, the codes on offer, the
 * system language that was detected, and the messages themselves.
 */
function payloadFor(choice, locale) {
  const language = resolveLanguage(choice, locale);
  const messages = loadDictionary(language) || loadDictionary(FALLBACK) || {};
  return {
    language,
    languageChoice: choice || 'system',
    detected: locale || '',
    available: [...LANGUAGES],
    messages
  };
}

module.exports = { FALLBACK, LANGUAGES, loadDictionary, payloadFor, resolveLanguage };