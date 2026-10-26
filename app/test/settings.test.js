'use strict';

/**
 * A settings file is edited by hand, truncated by crashes and written by older
 * versions, so these tests are mostly about what happens when it is wrong: the
 * app must come up with usable values instead of propagating `undefined`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadSettings, merge, sanitise, rememberFolder } = require('../src/shared/settings');
const { DEFAULTS } = require('../src/shared/constants');

test('an empty file produces the documented defaults', () => {
  const settings = loadSettings(undefined);
  assert.equal(settings.appearance.theme, 'system');
  assert.equal(settings.layout.sidebarWidth, DEFAULTS.layout.sidebarWidth);
  assert.equal(settings.version, 1);
});

test('a nested value is merged without losing its siblings', () => {
  const settings = loadSettings({ appearance: { fontSize: 18 } });
  assert.equal(settings.appearance.fontSize, 18);
  assert.equal(settings.appearance.minimap, DEFAULTS.appearance.minimap);
});

test('unknown keys are dropped instead of living in the file forever', () => {
  const settings = loadSettings({ appearance: { fontSize: 15, colour: 'red' }, nope: { a: 1 } });
  assert.equal(settings.appearance.colour, undefined);
  assert.equal(settings.nope, undefined);
});

test('a wrong type falls back to the default rather than reaching the UI', () => {
  const settings = loadSettings({ appearance: { minimap: 'yes please' }, layout: { sidebarWidth: {} } });
  assert.equal(settings.appearance.minimap, DEFAULTS.appearance.minimap);
  assert.equal(settings.layout.sidebarWidth, DEFAULTS.layout.sidebarWidth);
});

test('a number typed as a string is accepted, an unparsable one is not', () => {
  assert.equal(loadSettings({ appearance: { fontSize: '16' } }).appearance.fontSize, 16);
  assert.equal(loadSettings({ appearance: { fontSize: 'huge' } }).appearance.fontSize, DEFAULTS.appearance.fontSize);
});

test('widget sizes are clamped, so a bad value cannot destroy the layout', () => {
  assert.equal(loadSettings({ layout: { sidebarWidth: 99999 } }).layout.sidebarWidth, 900);
  assert.equal(loadSettings({ layout: { sidebarWidth: 1 } }).layout.sidebarWidth, 140);
  assert.equal(loadSettings({ appearance: { fontSize: 0 } }).appearance.fontSize, 8);
  assert.equal(loadSettings({ appearance: { tabSize: -4 } }).appearance.tabSize, 1);
  assert.equal(loadSettings({ layout: { sidebarWidth: Number.NaN } }).layout.sidebarWidth, DEFAULTS.layout.sidebarWidth);
});

test('enumerated settings only accept the values they document', () => {
  assert.equal(loadSettings({ appearance: { theme: 'neon' } }).appearance.theme, 'system');
  assert.equal(loadSettings({ appearance: { theme: 'dark' } }).appearance.theme, 'dark');
  assert.equal(loadSettings({ editor: { autoSave: 'always' } }).editor.autoSave, 'off');
  assert.equal(loadSettings({ editor: { autoSave: 'afterDelay' } }).editor.autoSave, 'afterDelay');
});

test('a malformed exclude list is replaced, not half-trusted', () => {
  const settings = loadSettings({ files: { exclude: ['ok', 42] } });
  assert.deepEqual(settings.files.exclude, DEFAULTS.files.exclude);
});

test('recent folders are de-duplicated, newest first and capped', () => {
  let settings = loadSettings({});
  for (let index = 0; index < 15; index += 1) {
    settings = rememberFolder(settings, `C:/work/p${index}`);
  }
  assert.equal(settings.recent.length, 12);
  assert.equal(settings.recent[0].path, 'C:/work/p14');
  assert.equal(settings.recent[0].name, 'p14');

  const again = rememberFolder(settings, 'C:/work/p10');
  assert.equal(again.recent.length, 12);
  assert.equal(again.recent[0].path, 'C:/work/p10');
  assert.equal(again.recent.filter((entry) => entry.path === 'C:/work/p10').length, 1);
});

test('merge keeps the shape of the base object', () => {
  const merged = merge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } });
  assert.deepEqual(merged, { a: { b: 1, c: 3 } });
});

test('sanitise never returns a shared reference to the defaults', () => {
  const one = sanitise(loadSettings({}));
  one.files.exclude.push('**/tmp/**');
  const two = sanitise(loadSettings({}));
  assert.equal(two.files.exclude.includes('**/tmp/**'), false);
});