'use strict';

/**
 * Ranking is what makes a quick-open box feel fast or useless: a query that
 * matches nothing must say so, and a query that matches a lot must put the file
 * the user meant first. Both properties are asserted directly.
 *
 * The module is the window's copy, imported dynamically because it is an ES
 * module; the main process ranks nothing, so there is only one implementation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = '../src/renderer/js/fuzzy.js';

test('scoring', async (t) => {
  const { fuzzyScore, rank } = await import(MODULE);

  await t.test('a query that is not a subsequence does not match', () => {
    assert.equal(fuzzyScore('src/app.js', 'zzz'), null);
    assert.equal(fuzzyScore('abc', 'cba'), null);
  });

  await t.test('an empty query matches everything equally', () => {
    assert.equal(fuzzyScore('anything', ''), 0);
  });

  await t.test('a tight match beats a scattered one', () => {
    assert.ok(fuzzyScore('app.js', 'app') < fuzzyScore('a-p-p-deep.js', 'app'));
  });

  await t.test('a match at a segment boundary beats one inside a word', () => {
    assert.ok(fuzzyScore('src/app.js', 'app') < fuzzyScore('src/wrapper.js', 'app'));
  });

  await t.test('ranking drops non-matches and returns the best first', () => {
    const files = ['src/some/wrapper.js', 'src/app.js', 'README.md', 'src/app.test.js'];
    const ranked = rank(files, 'app');
    assert.equal(ranked.includes('README.md'), false);
    assert.equal(ranked[0], 'src/app.js');
  });

  await t.test('ranking respects its limit', () => {
    const files = Array.from({ length: 100 }, (_, index) => `file-${index}.js`);
    assert.equal(rank(files, 'file', 5).length, 5);
  });
});