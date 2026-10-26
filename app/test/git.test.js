'use strict';

/**
 * Porcelain parsing is checked against literal git output, including the cases
 * that only appear in a real repository: a rename, a conflicted merge, an
 * upstream that is both ahead and behind, and a repository with no commits yet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatus, parseLog, parseBranches, parseDiff } = require('../src/shared/git');

const SEP = '\u001f';

test('branch, upstream and divergence are read from the header lines', () => {
  const status = parseStatus(
    [
      '# branch.oid 1f2e3d4c',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3'
    ].join('\n')
  );
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 3);
  assert.equal(status.detached, false);
});

test('a repository with no commits reports itself as initial', () => {
  const status = parseStatus('# branch.oid (initial)\n# branch.head main\n? a.txt\n');
  assert.equal(status.initial, true);
  assert.deepEqual(status.untracked, ['a.txt']);
});

test('modified, staged and untracked entries are separated', () => {
  const status = parseStatus(
    [
      '1 .M N... 100644 100644 100644 aaaa bbbb src/changed.js',
      '1 M. N... 100644 100644 100644 aaaa bbbb src/staged.js',
      '1 MM N... 100644 100644 100644 aaaa bbbb src/both.js',
      '? src/new.js'
    ].join('\n')
  );
  assert.deepEqual(status.modified, ['src/changed.js', 'src/both.js']);
  assert.deepEqual(status.staged, ['src/staged.js', 'src/both.js']);
  assert.deepEqual(status.untracked, ['src/new.js']);
  assert.equal(status.entries.length, 4);
});

test('a rename keeps both names', () => {
  const status = parseStatus('2 R. N... 100644 100644 100644 aaaa bbbb R100 dst/new.js\tsrc/old.js\n');
  assert.equal(status.entries[0].path, 'dst/new.js');
  assert.equal(status.entries[0].renamedFrom, 'src/old.js');
  assert.deepEqual(status.staged, ['dst/new.js']);
});

test('a conflict is not reported as an ordinary modification', () => {
  const status = parseStatus('u UU N... 100644 100644 100644 100644 a b c src/conflict.js\n');
  assert.deepEqual(status.conflicted, ['src/conflict.js']);
  assert.deepEqual(status.modified, []);
});

test('paths with spaces survive parsing', () => {
  const status = parseStatus('1 .M N... 100644 100644 100644 aaaa bbbb my docs/a b.md\n');
  assert.deepEqual(status.modified, ['my docs/a b.md']);
});

test('ignored paths are not listed and empty input is not an error', () => {
  assert.deepEqual(parseStatus('! build/out.js\n').entries, []);
  assert.equal(parseStatus('').entries.length, 0);
  assert.equal(parseStatus(undefined).branch, '');
});

test('commit log records are split on their own separator', () => {
  const stdout = `abc123${SEP}Ann${SEP}2 days ago${SEP}First subject\u001edef456${SEP}Bob${SEP}3 days ago${SEP}Second\u001e`;
  const commits = parseLog(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].short, 'abc123');
  assert.equal(commits[0].subject, 'First subject');
  assert.equal(commits[1].author, 'Bob');
});

test('branches report which one is current', () => {
  const branches = parseBranches(`main${SEP}*${SEP}origin/main\nfeature${SEP} ${SEP}\n`);
  assert.equal(branches.length, 2);
  assert.equal(branches[0].current, true);
  assert.equal(branches[0].upstream, 'origin/main');
  assert.equal(branches[1].current, false);
});

test('a diff is split into hunks with the file header kept apart', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    'index 111..222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three'
  ].join('\n');
  const parsed = parseDiff(diff);
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].header, '@@ -1,2 +1,3 @@');
  assert.deepEqual(parsed.hunks[0].lines, [' one', '+two', ' three']);
  assert.match(parsed.header, /diff --git/);
});