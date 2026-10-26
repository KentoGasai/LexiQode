'use strict';

/**
 * Opening a folder has to reach the window.
 *
 * The window keeps its own idea of the open folder, and every panel asks that
 * idea rather than the filesystem: whether the assistant can start, whether the
 * sidebar shows the tree or the search fields, whether the status bar names a
 * branch. The only thing that updates it is the notification tested here.
 *
 * It did not arrive. The service used to keep its listener in a property called
 * `onChange`, so the main process's `workspace.onChange(callback)` - a line that
 * reads exactly like a subscription - called the default no-op instead of
 * registering anything. The window therefore never learned about the folder it
 * had just been told to open: the welcome screen stayed up, the status bar said
 * no folder was open, and the Search and Source control buttons fell back to the
 * explorer and looked dead while the folder was in fact open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../src/main/workspace');
const { DEFAULTS } = require('../src/shared/constants');

function service() {
  return new WorkspaceService({ settings: { get: () => DEFAULTS } });
}

/** A real folder, because opening one is what these tests are about. */
function temporaryFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-workspace-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('a listener registered after construction hears about an open folder', async (t) => {
  const folder = temporaryFolder(t);
  const workspace = service();
  const seen = [];
  workspace.onChange((value) => seen.push(value));

  await workspace.open(folder);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].root, path.resolve(folder));
  assert.equal(seen[0].name, path.basename(folder));
});

test('closing the folder is reported as "no folder", not as silence', async (t) => {
  const folder = temporaryFolder(t);
  const workspace = service();
  const seen = [];
  workspace.onChange((value) => seen.push(value));

  await workspace.open(folder);
  workspace.close();

  assert.equal(seen.length, 2);
  assert.equal(seen[0].root, path.resolve(folder));
  assert.equal(seen[1], null, 'the window is told the folder is gone, not merely left unchanged');
  assert.equal(workspace.current(), null);
});

test('every listener hears every change, and unsubscribing is honoured', async (t) => {
  const folder = temporaryFolder(t);
  const workspace = service();
  const first = [];
  const second = [];
  const unsubscribe = workspace.onChange((value) => first.push(value));
  workspace.onChange((value) => second.push(value));

  await workspace.open(folder);
  unsubscribe();
  workspace.close();

  assert.equal(first.length, 1, 'the unsubscribed listener should have heard only the first change');
  assert.equal(second.length, 2, 'the remaining listener should have heard both');
});

test('one listener that throws does not silence the others', async (t) => {
  const folder = temporaryFolder(t);
  const workspace = service();
  const seen = [];
  workspace.onChange(() => {
    throw new Error('this listener is broken');
  });
  workspace.onChange((value) => seen.push(value));

  await workspace.open(folder);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].root, path.resolve(folder));
});

test('a folder that cannot be opened is refused, and nothing is reported', async () => {
  const workspace = service();
  const seen = [];
  workspace.onChange((value) => seen.push(value));

  await assert.rejects(() => workspace.open(path.join(os.tmpdir(), 'lexiqode-not-a-folder-4f2c')), /ENOENT/);

  assert.deepEqual(seen, []);
  assert.equal(workspace.current(), null);
});

test('opening the same folder again still reports it, so the window refreshes', async (t) => {
  const folder = temporaryFolder(t);
  const workspace = service();
  const seen = [];
  workspace.onChange((value) => seen.push(value));

  await workspace.open(folder);
  await workspace.open(folder);

  assert.equal(seen.length, 2);
});