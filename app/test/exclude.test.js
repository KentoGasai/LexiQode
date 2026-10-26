'use strict';

/**
 * The ignore rules decide what the tree, the picker and search all show, and a
 * mismatch between them is visible as "the file is there but search cannot find
 * it". These tests pin the glob semantics the rest of the app assumes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { globToRegExp, isExcluded } = require('../src/shared/exclude');
const { DEFAULTS } = require('../src/shared/constants');

test('a directory pattern excludes the directory and everything under it', () => {
  const patterns = DEFAULTS.files.exclude;
  assert.equal(isExcluded('node_modules/', patterns), true);
  assert.equal(isExcluded('node_modules/electron/index.js', patterns), true);
  assert.equal(isExcluded('packages/app/node_modules/x.js', patterns), true);
  assert.equal(isExcluded('src/app.js', patterns), false);
});

test('the git directory is excluded by the default rules', () => {
  assert.equal(isExcluded('.git/', DEFAULTS.files.exclude), true);
  assert.equal(isExcluded('.git/config', DEFAULTS.files.exclude), true);
});

test('python and build artefacts are excluded', () => {
  const patterns = DEFAULTS.files.exclude;
  assert.equal(isExcluded('core/__pycache__/x.pyc', patterns), true);
  assert.equal(isExcluded('.venv/lib/python3.11/site.py', patterns), true);
  assert.equal(isExcluded('dist/bundle.js', patterns), true);
  assert.equal(isExcluded('build/out.txt', patterns), true);
});

test('a star does not cross a directory boundary', () => {
  assert.equal(globToRegExp('src/*.js').test('src/a.js'), true);
  assert.equal(globToRegExp('src/*.js').test('src/deep/a.js'), false);
  assert.equal(globToRegExp('**/*.js').test('src/deep/a.js'), true);
});

test('a question mark matches exactly one character', () => {
  assert.equal(globToRegExp('a?c.txt').test('abc.txt'), true);
  assert.equal(globToRegExp('a?c.txt').test('ac.txt'), false);
});

test('an unparsable pattern is ignored rather than breaking the walk', () => {
  assert.equal(isExcluded('src/a.js', ['[unclosed']), false);
});

test('no patterns means nothing is excluded', () => {
  assert.equal(isExcluded('anything/at/all.js', []), false);
  assert.equal(isExcluded('anything/at/all.js', undefined), false);
});