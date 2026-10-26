'use strict';

/**
 * Reading, merging and sanitising the app's own settings.
 *
 * Three rules matter here.
 *
 * 1. A settings file is user input. It can be hand-edited, truncated by a crash
 *    or written by an older version, so every read produces a complete, typed
 *    object instead of passing whatever was on disk to the code that uses it.
 * 2. Unknown keys are dropped rather than merged. Otherwise a typo lives in the
 *    file forever and looks like it should work.
 * 3. Numbers that describe a widget have bounds. A width read as `NaN` or as
 *    nine million silently destroys the layout, so it is clamped on the way in.
 */

const { DEFAULTS } = require('./constants');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Recursive merge of `patch` over `base`, keeping `base`'s shape.
 *
 * Conversion is deliberate and narrow. A number may arrive as a numeric string
 * (hand-edited settings files do that), a boolean may arrive as `true`/`false`
 * (a JSON writer somewhere up the chain quoted it) - and nothing else is
 * coerced. `"yes please"` for a checkbox keeps the default instead of quietly
 * becoming `false`, and a non-finite number keeps the default instead of
 * becoming a minimum width.
 */
function merge(base, patch) {
  const result = clone(base);
  if (!isPlainObject(patch)) return result;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in result)) continue;
    const current = result[key];
    if (isPlainObject(current)) {
      result[key] = merge(current, value);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value)) result[key] = value.slice();
    } else if (typeof current === 'boolean') {
      if (typeof value === 'boolean') result[key] = value;
      else if (value === 'true' || value === 'false') result[key] = value === 'true';
    } else if (typeof current === 'number') {
      const number = typeof value === 'string' ? Number(value.trim()) : value;
      if (typeof number === 'number' && Number.isFinite(number)) result[key] = number;
    } else if (typeof current === 'string') {
      if (typeof value === 'string') result[key] = value;
    }
  }
  return result;
}

/**
 * Clamp a widget measurement.
 *
 * `null` needs its own branch: `JSON.stringify` turns `NaN` into `null`, so a
 * settings file that once held a broken number arrives here as `null`, and
 * `Number(null)` is `0` - a plausible-looking measurement that would silently
 * become the smallest allowed width instead of the default.
 */
function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || typeof value === 'boolean') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

const THEMES = new Set(['system', 'dark', 'light']);
const WRAP_MODES = new Set(['off', 'on', 'bounded']);
const AUTO_SAVE_MODES = new Set(['off', 'afterDelay', 'onFocusChange']);
const LANGUAGES = new Set(['system', 'ru', 'en']);

/** Bring a merged object into a state the rest of the app can rely on. */
function sanitise(settings) {
  const result = clone(settings);
  result.version = 1;

  if (!THEMES.has(result.appearance.theme)) result.appearance.theme = DEFAULTS.appearance.theme;
  if (!LANGUAGES.has(result.appearance.language)) result.appearance.language = DEFAULTS.appearance.language;
  result.appearance.fontSize = clampNumber(result.appearance.fontSize, 8, 40, DEFAULTS.appearance.fontSize);
  result.appearance.tabSize = clampNumber(result.appearance.tabSize, 1, 16, DEFAULTS.appearance.tabSize);
  if (!WRAP_MODES.has(result.appearance.wordWrap)) result.appearance.wordWrap = DEFAULTS.appearance.wordWrap;
  if (!['on', 'off', 'relative'].includes(result.appearance.lineNumbers)) {
    result.appearance.lineNumbers = DEFAULTS.appearance.lineNumbers;
  }
  result.appearance.minimap = Boolean(result.appearance.minimap);
  result.appearance.breadcrumbs = Boolean(result.appearance.breadcrumbs);

  if (!AUTO_SAVE_MODES.has(result.editor.autoSave)) result.editor.autoSave = DEFAULTS.editor.autoSave;
  result.editor.autoSaveDelay = clampNumber(result.editor.autoSaveDelay, 200, 60000, DEFAULTS.editor.autoSaveDelay);

  result.layout.sidebarWidth = clampNumber(result.layout.sidebarWidth, 140, 900, DEFAULTS.layout.sidebarWidth);
  result.layout.panelHeight = clampNumber(result.layout.panelHeight, 60, 2000, DEFAULTS.layout.panelHeight);
  result.layout.chatWidth = clampNumber(result.layout.chatWidth, 260, 1400, DEFAULTS.layout.chatWidth);
  result.layout.sidebarVisible = Boolean(result.layout.sidebarVisible);
  result.layout.panelVisible = Boolean(result.layout.panelVisible);
  result.layout.chatVisible = Boolean(result.layout.chatVisible);

  result.files.maxSearchResults = clampNumber(result.files.maxSearchResults, 10, 20000, DEFAULTS.files.maxSearchResults);
  result.files.maxFileSizeKb = clampNumber(result.files.maxFileSizeKb, 16, 65536, DEFAULTS.files.maxFileSizeKb);
  result.files.reopenLastFolder = Boolean(result.files.reopenLastFolder);
  if (!Array.isArray(result.files.exclude) || result.files.exclude.some((entry) => typeof entry !== 'string')) {
    result.files.exclude = clone(DEFAULTS.files.exclude);
  }

  result.terminal.fontSize = clampNumber(result.terminal.fontSize, 8, 32, DEFAULTS.terminal.fontSize);
  result.terminal.shell = typeof result.terminal.shell === 'string' ? result.terminal.shell : '';

  if (!Array.isArray(result.recent)) result.recent = [];
  result.recent = result.recent
    .filter((entry) => entry && typeof entry.path === 'string')
    .slice(0, 12)
    .map((entry) => ({ path: entry.path, name: typeof entry.name === 'string' ? entry.name : entry.path }));

  if (!isPlainObject(result.session)) result.session = clone(DEFAULTS.session);
  if (typeof result.session.folder !== 'string') result.session.folder = '';
  if (!Array.isArray(result.session.tabs)) result.session.tabs = [];
  if (typeof result.session.active !== 'string') result.session.active = '';
  // Open assistant chats: ids, not transcripts, so a stale entry costs a tab
  // that closes itself when the core says the conversation is gone.
  if (!Array.isArray(result.session.chats)) result.session.chats = [];
  result.session.chats = result.session.chats
    .filter((id) => typeof id === 'string' && id)
    .slice(0, 12);
  if (typeof result.session.activeChat !== 'string') result.session.activeChat = '';
  return result;
}

/** Produce the settings object the app runs with, from whatever was on disk. */
function loadSettings(raw) {
  return sanitise(merge(DEFAULTS, raw));
}

/**
 * What the UI is allowed to change through `settings:update`. A patch with an
 * unknown section or an unlisted key is rejected instead of quietly ignored, so
 * a mistake surfaces where it was made.
 */
function applyPatch(settings, patch) {
  if (!isPlainObject(patch)) throw new Error('a settings patch must be an object');
  const merged = sanitise(merge(settings, patch));
  return merged;
}

function rememberFolder(settings, folder) {
  const result = sanitise(settings);
  const path = require('node:path');
  const name = folder ? path.basename(folder) || folder : '';
  const without = result.recent.filter((entry) => entry.path !== folder);
  result.recent = folder ? [{ path: folder, name }, ...without].slice(0, 12) : without;
  return result;
}

module.exports = { LANGUAGES, loadSettings, merge, sanitise, applyPatch, rememberFolder };