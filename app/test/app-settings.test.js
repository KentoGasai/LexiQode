'use strict';

/**
 * The settings dialog, checked against the two things it can silently get wrong.
 *
 * The form is built from a schema, so a label or a hint is a key from a
 * dictionary rather than a literal: a typo there shows the key itself in the
 * interface, and nothing else would notice. And every row names a path into the
 * settings object - `appearance.theme` - which has to be a key the settings file
 * actually has, or the control writes a value that is dropped on the next read.
 *
 * Both checks are static because the form is drawn in the window: the cost of
 * not having them is a broken control nobody sees until somebody opens the
 * dialog.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS } = require('../src/shared/constants');
const { LANGUAGES, loadDictionary } = require('../src/shared/i18n');

const APP = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(APP, 'src', 'renderer', 'js', 'app-settings.js'), 'utf8');
const dictionaries = Object.fromEntries(LANGUAGES.map((code) => [code, loadDictionary(code)]));

/** Everything between the schema and the module's own code. */
function schema() {
  const start = SOURCE.indexOf('const SECTIONS');
  const end = SOURCE.indexOf('export function createAppSettings');
  assert.ok(start !== -1 && end > start, 'the settings schema should be one block');
  return SOURCE.slice(start, end);
}

test('every label, hint and option in the form is a key the dictionaries have', () => {
  const text = schema();
  const keys = new Set();
  for (const match of text.matchAll(/(?:label|title|hint):\s*'([^']+)'/g)) keys.add(match[1]);
  for (const match of text.matchAll(/\['[^']+',\s*'([^']+)'\]/g)) keys.add(match[1]);
  assert.ok(keys.size > 30, `expected the schema to name many keys, saw ${keys.size}`);
  for (const code of LANGUAGES) {
    const missing = [...keys].filter((key) => !(key in dictionaries[code]));
    assert.deepEqual(missing, [], `${code} is missing keys the settings form asks for: ${missing.join(', ')}`);
  }
});

test('every setting the form writes is one the settings file has', () => {
  const paths = [...schema().matchAll(/path:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(paths.length >= 20, `expected the form to write many settings, saw ${paths.length}`);
  for (const key of paths) {
    const [section, field] = key.split('.');
    assert.ok(DEFAULTS[section], `the settings file has no section ${section}`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULTS[section], field),
      `${key} is not a setting the file holds, so writing it would be dropped`
    );
  }
});

test('the mode list in the form is the mode list the assistant has', () => {
  const renderer = fs.readFileSync(path.join(APP, 'src', 'renderer', 'js', 'chat.js'), 'utf8');
  const listed = SOURCE.match(/const MODE_IDS = \[([^\]]+)\]/);
  assert.ok(listed, 'the form should name the modes it offers');
  for (const id of listed[1].split(',').map((entry) => entry.trim().replace(/'/g, ''))) {
    assert.match(renderer, new RegExp(`\\b${id}:\\s*\\{`), `chat.js does not know the mode ${id}`);
  }
});