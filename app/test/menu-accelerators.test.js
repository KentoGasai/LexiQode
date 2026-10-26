'use strict';

/**
 * Every accelerator the menu declares has to be one Electron can register.
 *
 * Electron takes a single key per accelerator. A chorded one - the
 * `CmdOrCtrl+K CmdOrCtrl+O` an editor from the same family uses - is rejected
 * with "Invalid accelerator token: K CmdOrCtrl" written to the application's
 * output, which nobody reads, and the menu item is then left with no shortcut
 * at all while the documentation and the command palette still advertise it.
 * Two shortcuts were in that state: open a folder, and save all.
 *
 * The check is static because the menu is built in the main process and the
 * failure is silent: the only other way to notice is for a person to press the
 * keys and conclude that nothing happened.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

/** Modifier names Electron understands, plus the separator style it accepts. */
const MODIFIERS = new Set([
  'CmdOrCtrl',
  'Cmd',
  'Ctrl',
  'Control',
  'Command',
  'Alt',
  'Option',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
]);

/** Key names that are not a single character. Electron's own list, shortened. */
const NAMED_KEYS = new Set([
  'Backspace',
  'Delete',
  'Insert',
  'Return',
  'Enter',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Esc',
  'Tab',
  'Space',
  'Plus',
  'numadd',
  'numsub',
  'nummult',
  'numdiv',
  'numdec',
  'MediaNextTrack',
  'MediaPreviousTrack',
  'MediaStop',
  'MediaPlayPause',
  'PrintScreen',
  'volumeup',
  'volumedown',
  'volumemute'
]);

function accelerators() {
  return [...MAIN.matchAll(/accelerator:\s*'([^']+)'/g)].map((match) => match[1]);
}

test('the menu declares the shortcuts it uses', () => {
  const declared = accelerators();
  assert.ok(declared.length >= 8, `expected the menu to declare its shortcuts, found ${declared.length}`);
  assert.ok(declared.includes('CmdOrCtrl+Shift+S'), 'save all should have a working accelerator');
});

test('no accelerator chains two keys, which Electron rejects', () => {
  const offenders = accelerators().filter((accelerator) => /^CmdOrCtrl\+K\s/i.test(accelerator) || /\s/.test(accelerator));
  assert.deepEqual(offenders, [], `these accelerators would be rejected: ${offenders.join(' | ')}`);
});

test('every accelerator names one modifier set and one real key', () => {
  const offenders = [];
  for (const accelerator of accelerators()) {
    const parts = accelerator.split('+');
    if (accelerator.endsWith('+')) {
      // A trailing plus means the key itself is `+`, which Electron spells
      // `Plus`; keeping the check explicit is clearer than allowing it.
      offenders.push(`${accelerator} (ends with a modifier separator)`);
      continue;
    }
    const key = parts[parts.length - 1];
    const modifierCount = parts.filter((part) => MODIFIERS.has(part)).length;
    if (modifierCount !== parts.length - 1) {
      offenders.push(`${accelerator} (uses a modifier Electron does not know)`);
      continue;
    }
    const valid =
      key.length === 1 ||
      /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
      NAMED_KEYS.has(key) ||
      /^[a-z0-9]$/.test(key);
    if (!valid) offenders.push(`${accelerator} (unknown key: ${key})`);
  }
  assert.deepEqual(offenders, [], `unusable accelerators: ${offenders.join(' | ')}`);
});

test('a chorded shortcut is implemented by the window, not declared to Electron', () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'js', 'main.js'), 'utf8');
  // The two chords the documentation promises: open a folder, and save all.
  assert.match(renderer, /chordArmed/, 'the window should implement the two-key chord');
  assert.match(renderer, /key === 'o'\)\s*void openFolder\(\)/, 'Ctrl+K Ctrl+O should open a folder');
  assert.match(renderer, /key === 's'\)\s*void editor\.saveAll\(\)/, 'Ctrl+K S should save all files');
});