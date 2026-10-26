'use strict';

/**
 * The folder watcher: the explorer follows the disk, not only its own buttons.
 *
 * These tests use a real temporary folder and a real `fs.watch`, because the
 * behaviour that matters is the platform's: whether a file created by another
 * process is reported at all, and whether a burst of them arrives as one
 * notification instead of two hundred.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceWatcher, ignoreFactory } = require('../src/main/workspace-watcher.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function temporaryFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Wait until `predicate` holds, or give up after `timeout` milliseconds. */
async function waitFor(predicate, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

test('a file written by another process is reported', async (t) => {
  const root = temporaryFolder(t);
  const seen = [];
  const watcher = createWorkspaceWatcher({ onChanged: (payload) => seen.push(payload), debounceMs: 40 });
  t.after(() => watcher.stop());

  assert.equal(watcher.watch(root), true);
  fs.writeFileSync(path.join(root, 'created-by-a-build.txt'), 'x', 'utf8');

  assert.ok(await waitFor(() => seen.length > 0), 'the watcher never reported the new file');
  const paths = seen.flatMap((payload) => payload.paths);
  assert.ok(
    paths.some((entry) => entry.includes('created-by-a-build.txt')),
    `the new file was not named; saw ${JSON.stringify(paths)}`
  );
  assert.equal(seen[0].root, path.resolve(root));
});

test('a burst of writes arrives as one notification', async (t) => {
  const root = temporaryFolder(t);
  const seen = [];
  const watcher = createWorkspaceWatcher({ onChanged: (payload) => seen.push(payload), debounceMs: 120 });
  t.after(() => watcher.stop());
  watcher.watch(root);

  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(root, `burst-${index}.txt`), 'x', 'utf8');
  }
  assert.ok(await waitFor(() => seen.length > 0));
  await sleep(200);

  assert.equal(seen.length, 1, `expected one coalesced notification, saw ${seen.length}`);
  assert.ok(seen[0].paths.length > 5, `expected the burst to be collected, saw ${seen[0].paths.length}`);
});

test('paths the tree never shows do not wake the window', async (t) => {
  const root = temporaryFolder(t);
  const seen = [];
  const watcher = createWorkspaceWatcher({
    onChanged: (payload) => seen.push(payload),
    shouldIgnore: ignoreFactory(['**/node_modules/**']),
    debounceMs: 40
  });
  t.after(() => watcher.stop());
  watcher.watch(root);

  fs.mkdirSync(path.join(root, 'node_modules', 'a-package'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'a-package', 'index.js'), 'x', 'utf8');
  fs.writeFileSync(path.join(root, 'visible.txt'), 'x', 'utf8');

  assert.ok(await waitFor(() => seen.length > 0));
  await sleep(150);
  const paths = seen.flatMap((payload) => payload.paths);
  assert.ok(paths.includes('visible.txt'), `the visible file was filtered out: ${JSON.stringify(paths)}`);
  assert.ok(
    paths.every((entry) => !entry.includes('node_modules')),
    `an excluded path reached the window: ${JSON.stringify(paths)}`
  );
});

test('a stopped watcher is silent, and starting another folder replaces it', async (t) => {
  const first = temporaryFolder(t);
  const second = temporaryFolder(t);
  const seen = [];
  const watcher = createWorkspaceWatcher({ onChanged: (payload) => seen.push(payload), debounceMs: 40 });
  t.after(() => watcher.stop());

  watcher.watch(first);
  watcher.watch(second);
  assert.equal(watcher.root, path.resolve(second));

  fs.writeFileSync(path.join(second, 'in-the-second-folder.txt'), 'x', 'utf8');
  assert.ok(await waitFor(() => seen.length > 0));
  assert.ok(seen.every((payload) => payload.root === path.resolve(second)));

  watcher.stop();
  const before = seen.length;
  fs.writeFileSync(path.join(second, 'after-stop.txt'), 'x', 'utf8');
  await sleep(300);
  assert.equal(seen.length, before, 'a stopped watcher reported a change');
});

test('an unwatchable folder is reported instead of thrown', async (t) => {
  const problems = [];
  const watcher = createWorkspaceWatcher({
    onChanged: () => {},
    onProblem: (message) => problems.push(message),
    debounceMs: 10
  });
  t.after(() => watcher.stop());

  const missing = path.join(os.tmpdir(), 'lexiqode-does-not-exist-9c1f0', 'nested');
  assert.equal(watcher.watch(missing), false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not watched for changes/);
});