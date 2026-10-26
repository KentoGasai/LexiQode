'use strict';

/**
 * A search reports progress before it finds anything.
 *
 * Batches exist so results appear while the search is still running, and the
 * same channel carries the counter the panel shows - "3 совпадений · 3886
 * файлов". That counter used to stop at nothing: a batch was only sent once it
 * had at least one match, so a search over a large folder showed "Поиск…" and
 * no movement for as long as it took to reach the first hit, which on a real
 * repository is several seconds of a panel that looks frozen. The fix is a
 * progress-only batch on the same interval, and this is the test that keeps it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SearchService } = require('../src/main/search-service');
const { DEFAULTS } = require('../src/shared/constants');

/** A folder of small text files: the first ones do not contain the query. */
function folder(t, { files = 30, hitAt = 25 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < files; index += 1) {
    const body = index === hitAt ? 'the needle is here\n' : `line ${index}\n`;
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), body, 'utf8');
  }
  return root;
}

/** Run a search to completion and collect everything it reported. */
function search(root, query, { batchIntervalMs = 0 } = {}) {
  return new Promise((resolve) => {
    const batches = [];
    const service = new SearchService({
      workspace: { require: () => root },
      settings: { get: () => DEFAULTS },
      batchIntervalMs,
      onBatch: (payload) => batches.push(payload),
      onDone: (payload) => resolve({ batches, done: payload })
    });
    service.start(1, { query });
  });
}

test('progress arrives before the first match does', async (t) => {
  const root = folder(t, { files: 30, hitAt: 25 });
  const { batches, done } = await search(root, 'needle');

  const beforeFirstMatch = batches.filter((payload) => payload.matches.length === 0);
  assert.ok(beforeFirstMatch.length > 0, 'expected progress with no matches yet');
  assert.ok(
    beforeFirstMatch[0].progress.filesScanned > 0,
    'a progress report should say how many files were looked at'
  );

  const scanned = beforeFirstMatch.map((payload) => payload.progress.filesScanned);
  assert.deepEqual(
    [...scanned].sort((left, right) => left - right),
    scanned,
    'the counter should only move forwards'
  );
  assert.ok(scanned[0] < done.filesScanned, 'the first report should precede the end of the walk');
});

test('the match is reported once, with its file and line', async (t) => {
  const root = folder(t, { files: 30, hitAt: 25 });
  const { batches, done } = await search(root, 'needle');

  const matches = batches.flatMap((payload) => payload.matches);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, 'file-025.txt');
  assert.equal(matches[0].line, 1);
  assert.equal(done.total, 1);
  assert.equal(done.filesWithMatches, 1);
  assert.equal(done.cancelled, false);
});

test('a query that matches nothing still reports its progress and its end', async (t) => {
  const root = folder(t, { files: 20 });
  const { batches, done } = await search(root, 'nothing-at-all-matches-this');

  assert.ok(batches.length > 0, 'a fruitless search should still say what it looked at');
  assert.equal(done.total, 0);
  assert.equal(done.filesScanned, 20);
  assert.equal(done.error || null, null);
});

test('a folder that is not there ends the search rather than hanging it', async () => {
  const missing = path.join(os.tmpdir(), 'lexiqode-search-not-there-9c31');
  const { done } = await search(missing, 'needle');
  assert.equal(done.total, 0);
  assert.equal(done.filesScanned, 0);
  assert.equal(done.cancelled, false);
});