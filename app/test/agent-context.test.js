'use strict';

/**
 * What the assistant is told about the window.
 *
 * The context is a short preamble in front of every message, so what it contains
 * is what the model spends tokens on and what the panel hides from the
 * transcript. Two things are worth pinning down: a file the user pinned is named
 * even when it is not the one in the editor, and the list cannot grow without
 * bound - an unbounded preamble would be paid for by every turn of the
 * conversation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildContextPreamble } = require('../src/main/agent/service');

test('nothing open and nothing pinned says nothing at all', () => {
  assert.equal(buildContextPreamble(null), '');
  assert.equal(buildContextPreamble({}), '');
  assert.equal(buildContextPreamble({ file: '', files: [], selection: '' }), '');
});

test('the open file is named, and unsaved changes are said out loud', () => {
  const text = buildContextPreamble({ file: 'src/app.js' });
  assert.match(text, /- open file: src\/app\.js$/m);
  assert.match(buildContextPreamble({ file: 'src/app.js', dirty: true }), /src\/app\.js \(unsaved changes\)/);
});

test('files the user pinned are named, whether or not one is open', () => {
  const text = buildContextPreamble({ files: ['src/a.js', 'docs/b.md'] });
  assert.match(text, /- files the user put in context: src\/a\.js, docs\/b\.md/);
  const withOpen = buildContextPreamble({ file: 'src/a.js', files: ['docs/b.md'] });
  assert.match(withOpen, /- open file: src\/a\.js/);
  assert.match(withOpen, /- files the user put in context: docs\/b\.md/);
});

test('a repeated or empty path is not repeated to the model', () => {
  const text = buildContextPreamble({ files: ['src/a.js', 'src/a.js', '', '  ', 42] });
  assert.equal((text.match(/src\/a\.js/g) || []).length, 1);
  assert.doesNotMatch(text, /42/);
});

test('the pinned list is capped, however many arrive', () => {
  const files = Array.from({ length: 500 }, (_, index) => `src/file-${index}.js`);
  const text = buildContextPreamble({ files });
  const listed = text.split('context: ')[1].split(', ');
  assert.equal(listed.length, 40);
});

test('a selection is quoted with its language and its lines', () => {
  const text = buildContextPreamble({
    file: 'src/app.js',
    language: 'javascript',
    selection: 'const a = 1;',
    selectionRange: { start: 4, end: 6 }
  });
  assert.match(text, /selected text \(lines 4-6\):/);
  assert.match(text, /```javascript\nconst a = 1;\n```/);
});

test('the preamble is separated from the message it precedes', () => {
  const text = buildContextPreamble({ file: 'src/app.js' });
  assert.ok(text.startsWith('Context from the editor:'));
  assert.ok(text.endsWith('\n\n'), 'the message must not run into the context');
});