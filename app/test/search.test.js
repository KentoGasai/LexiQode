'use strict';

/**
 * Search behaviour that a user notices immediately when it is wrong: a query
 * with a dot matching every character, a regex mistake taking the window down,
 * or a pattern that matches empty text hanging the scan.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuery, matchLine, matchLineAll, scanText, splitLines } = require('../src/shared/search');

test('a literal query is escaped, so punctuation means itself', () => {
  const matcher = buildQuery('a.b');
  assert.ok(matcher.test('a.b'));
  matcher.lastIndex = 0;
  assert.equal(matcher.test('axb'), false);
});

test('case is ignored unless asked otherwise', () => {
  assert.ok(buildQuery('Hello').test('hello world'));
  assert.equal(buildQuery('Hello', { caseSensitive: true }).test('hello world'), false);
});

test('whole word mode does not match inside a longer word', () => {
  const matcher = buildQuery('cat', { wholeWord: true });
  assert.equal(matchLine('a cat sat', matcher) !== null, true);
  assert.equal(matchLine('concatenate', matcher), null);
});

test('regular expressions are accepted and their errors are reported', () => {
  const matcher = buildQuery('\\bfoo\\d+', { regex: true });
  assert.equal(matchLine('foo12', matcher).length, 5);
  assert.throws(() => buildQuery('(unclosed', { regex: true }), /invalid pattern/);
  assert.throws(() => buildQuery('a*', { regex: true }), /empty text/);
});

test('an empty literal query is refused', () => {
  assert.throws(() => buildQuery(''), /a query is required/);
  assert.throws(() => buildQuery(null), /a query is required/);
});

test('columns are one-based and include every match on a line', () => {
  const matcher = buildQuery('ab');
  assert.deepEqual(matchLine('xxabyy', matcher), { column: 3, length: 2, text: 'ab' });
  assert.deepEqual(matchLineAll('ab-ab', matcher), [
    { column: 1, length: 2 },
    { column: 4, length: 2 }
  ]);
});

test('scanning reports one-based line numbers and a truncation flag', () => {
  const text = 'one\ntwo target\nthree target\n';
  const { matches, truncated } = scanText(text, buildQuery('target'), { relativePath: 'a.txt' });
  assert.equal(truncated, false);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].line, 2);
  assert.equal(matches[1].line, 3);
  assert.equal(matches[0].path, 'a.txt');

  const capped = scanText(text, buildQuery('target'), { maxMatches: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.truncated, true);
});

test('long lines are shortened so one minified file cannot flood the view', () => {
  const long = `x${'y'.repeat(900)}target`;
  const { matches } = scanText(long, buildQuery('target'));
  assert.equal(matches[0].text.length, 401);
  assert.ok(matches[0].text.endsWith('…'));
});

test('CRLF and a missing final newline do not shift line numbers', () => {
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  const { matches } = scanText('a\r\ntarget', buildQuery('target'));
  assert.equal(matches[0].line, 2);
});
