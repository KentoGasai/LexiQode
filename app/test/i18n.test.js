'use strict';

/**
 * The window's languages, checked as a contract.
 *
 * Three failure modes are worth a test, and all three are invisible until
 * somebody switches language: a key that exists in one dictionary and not the
 * other, a key the code asks for that no dictionary has, and a language that
 * cannot be resolved for a system locale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const SHARED = path.join(APP, 'src', 'shared');
const RENDERER = path.join(APP, 'src', 'renderer');
const JS = path.join(RENDERER, 'js');

const { FALLBACK, LANGUAGES, loadDictionary, payloadFor, resolveLanguage } = require('../src/shared/i18n');

const dictionaries = Object.fromEntries(LANGUAGES.map((code) => [code, loadDictionary(code)]));
const jsFiles = fs.readdirSync(JS).filter((name) => name.endsWith('.js'));
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

/** Every key the window or the menu asks for, collected from the sources. */
function keysUsed() {
  const used = new Set();
  for (const file of jsFiles) {
    // Comments are stripped first: a docstring that mentions `t('some.key')` is
    // not a call, and a test that cannot tell them apart reports phantom bugs.
    const source = stripComments(fs.readFileSync(path.join(JS, file), 'utf8'));
    for (const match of source.matchAll(/\bt\('([a-z][\w.]*)'\)/g)) used.add(match[1]);
  }
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) {
    used.add(match[1]);
  }
  const main = fs.readFileSync(path.join(APP, 'src', 'main', 'main.js'), 'utf8');
  for (const match of main.matchAll(/'(menu\.[a-z.]+)'/g)) used.add(match[1]);
  return used;
}

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('every language has a dictionary', () => {
  for (const code of LANGUAGES) {
    assert.ok(dictionaries[code], `${code} has no dictionary`);
    assert.ok(Object.keys(dictionaries[code]).length > 50, `${code} looks too small to be a dictionary`);
  }
});

test('the dictionaries have exactly the same keys', () => {
  const [first, ...rest] = LANGUAGES;
  const reference = Object.keys(dictionaries[first]).sort();
  for (const code of rest) {
    const keys = Object.keys(dictionaries[code]).sort();
    const missing = reference.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !reference.includes(key));
    assert.deepEqual(missing, [], `${code} is missing: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${code} has keys ${first} does not: ${extra.join(', ')}`);
  }
});

test('every key the code asks for exists in every dictionary', () => {
  const used = [...keysUsed()].sort();
  assert.ok(used.length > 60, `expected the window to ask for many keys, saw ${used.length}`);
  for (const code of LANGUAGES) {
    const missing = used.filter((key) => !(key in dictionaries[code]));
    assert.deepEqual(missing, [], `${code} is missing keys the code uses: ${missing.join(', ')}`);
  }
});

test('placeholders in a translation match the ones the code passes', () => {
  // A translation that drops `{count}` silently loses information; one that adds
  // an unknown placeholder prints braces in the interface.
  const source = jsFiles.map((file) => fs.readFileSync(path.join(JS, file), 'utf8')).join('\n');
  for (const code of LANGUAGES) {
    for (const [key, translation] of Object.entries(dictionaries[code])) {
      const names = [...String(translation).matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      if (!names.length) continue;
      const call = new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`);
      if (!call.test(source)) continue;
      for (const name of names) {
        assert.ok(
          source.includes(`${name}:`) || source.includes(`'${name}'`) || source.includes(`${name},`),
          `${code}:${key} uses {${name}} but no call site passes it`
        );
      }
    }
  }
});

test('a language is resolved from the preference and the system locale', () => {
  assert.equal(resolveLanguage('ru', 'en-US'), 'ru');
  assert.equal(resolveLanguage('en', 'ru-RU'), 'en');
  assert.equal(resolveLanguage('system', 'ru-RU'), 'ru');
  assert.equal(resolveLanguage('system', 'de-DE'), FALLBACK);
  assert.equal(resolveLanguage('system', ''), FALLBACK);
  assert.equal(resolveLanguage('klingon', 'de-DE'), FALLBACK);
  assert.equal(resolveLanguage(undefined, 'ru'), 'ru');
});

test('the payload carries the messages the window needs', () => {
  const payload = payloadFor('ru', 'en-US');
  assert.equal(payload.language, 'ru');
  assert.equal(payload.languageChoice, 'ru');
  assert.deepEqual(payload.available, [...LANGUAGES]);
  assert.equal(payload.messages['view.explorer'], dictionaries.ru['view.explorer']);
  assert.equal(typeof payload.messages['chat.send'], 'string');
});

test('a missing dictionary falls back instead of leaving the window blank', () => {
  const payload = payloadFor('en', 'en-US');
  assert.ok(Object.keys(payload.messages).length > 50);
});

test('both dictionaries are valid JSON, so a broken edit is caught here', () => {
  for (const code of LANGUAGES) {
    const raw = fs.readFileSync(path.join(SHARED, `i18n.${code}.json`), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `${code}.json is not valid JSON`);
  }
});