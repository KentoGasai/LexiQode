'use strict';

/**
 * Looking for a release, and pointing at it.
 *
 * The parts worth testing are the ones that decide what a user is told: which
 * release counts as newer, what happens when there is none to find, and - most
 * of all - that this service cannot touch the machine. The first version could:
 * it downloaded the archive and handed a detached script the job of replacing
 * the application folder, and a window started from source refused with a
 * message nobody could act on. The checks below hold the line that replaced it:
 * one HTTP request, one comparison, and a page for the user to visit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { UpdateService, compareVersions, githubSlug, parseVersion } = require('../src/main/update-service');

const APP = path.resolve(__dirname, '..');
const REPO = 'owner/name';

function store(overrides = {}) {
  const value = { updates: { checkOnStart: true, includePrereleases: false, repo: '', ...overrides } };
  return { get: () => value, value };
}

function service(options = {}) {
  return new UpdateService({
    settings: store(options.settings),
    currentVersion: options.currentVersion || '0.2.0',
    // An explicit empty repository means "nothing is configured", which is a
    // different case from a caller that did not name one.
    repository: options.repository === undefined ? REPO : options.repository,
    fetchImpl: options.fetchImpl,
    onState: options.onState,
    onLog: options.onLog
  });
}

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    body: 'What changed.',
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    assets: [],
    ...extra
  };
}

/** A fetch that answers the same thing for every call. */
function answering(body, options = {}) {
  const status = options.status || 200;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body
  });
}

test('the state is read through a method, because the field borrows the name', () => {
  // `this.state` is the state object; a method called `state` is shadowed by it
  // and the call fails with "not a function", which is how this was first found.
  const updates = service({});
  assert.equal(typeof updates.snapshot, 'function');
  assert.equal(typeof updates.state, 'object');
  assert.equal(updates.snapshot().phase, 'idle');
  assert.equal(updates.snapshot().current, '0.2.0');
});

test('a version reads as three numbers, whatever shape it arrives in', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
  assert.deepEqual(parseVersion('1.2.3-beta.4'), [1, 2, 3]);
  assert.deepEqual(parseVersion(' 2 '), [2, 0, 0]);
  assert.equal(parseVersion('nightly'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('versions are compared by number, not as text', () => {
  // The trap: "0.10.0" is older than "0.9.0" only as a string.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
});

test('a repository is read out of every shape a package declares it in', () => {
  assert.equal(githubSlug('https://github.com/KentoGasai/LexiQode.git'), 'KentoGasai/LexiQode');
  assert.equal(githubSlug('git+https://github.com/KentoGasai/LexiQode.git'), 'KentoGasai/LexiQode');
  assert.equal(githubSlug('https://github.com/KentoGasai/LexiQode'), 'KentoGasai/LexiQode');
  assert.equal(githubSlug('KentoGasai/LexiQode'), 'KentoGasai/LexiQode');
  assert.equal(githubSlug('https://example.com/not/github'), '');
  assert.equal(githubSlug(''), '');
  assert.equal(githubSlug(undefined), '');
});

test('a newer release is reported with the page that has it', async () => {
  const phases = [];
  const updates = service({
    onState: (state) => phases.push(state.phase),
    fetchImpl: answering(release('v0.3.0'))
  });
  const state = await updates.check();
  assert.equal(state.phase, 'available');
  assert.equal(state.version, '0.3.0');
  assert.equal(state.current, '0.2.0');
  assert.equal(state.repo, REPO);
  assert.equal(state.url, `https://github.com/${REPO}/releases/tag/v0.3.0`);
  assert.equal(state.page, state.url);
  assert.match(state.notes, /What changed/);
  // The window is told about the whole sequence, not only the end of it: that is
  // what lets it show "checking" instead of nothing.
  assert.deepEqual(phases, ['checking', 'available']);
});

test('a release without a page still has one on GitHub', async () => {
  const updates = service({ fetchImpl: answering(release('v0.3.0', { html_url: undefined })) });
  const state = await updates.check();
  assert.equal(state.url, `https://github.com/${REPO}/releases/tag/v0.3.0`);
});

test('every state names the page, so the window can always offer it', () => {
  const updates = service({});
  const idle = updates.snapshot();
  assert.equal(idle.releasesUrl, `https://github.com/${REPO}/releases`);
});

test('the running version is not offered as an update', async () => {
  const updates = service({ fetchImpl: answering(release('v0.2.0')) });
  const state = await updates.check();
  assert.equal(state.phase, 'current');
  assert.equal(state.version, '0.2.0');
});

test('a repository with no release, and a private one, are not failures', async () => {
  const updates = service({ fetchImpl: answering({ message: 'Not Found' }, { status: 404 }) });
  const state = await updates.check();
  assert.equal(state.phase, 'unavailable');
  assert.match(state.message, /no published release/);
});

test('a check without a repository says so instead of asking nobody', async () => {
  const updates = service({ repository: '', fetchImpl: async () => assert.fail('nothing should be fetched') });
  const state = await updates.check();
  assert.equal(state.phase, 'unavailable');
  assert.match(state.message, /no repository/);
  assert.equal(state.releasesUrl, '');
});

test('a release tag with no version in it is reported, not guessed at', async () => {
  const updates = service({ fetchImpl: answering(release('nightly')) });
  const state = await updates.check();
  assert.equal(state.phase, 'unavailable');
  assert.match(state.message, /nightly/);
});

test('pre-releases are taken from the list only when asked for', async () => {
  const asked = [];
  const list = [release('v0.4.0-beta.1', { prerelease: true })];
  const updates = service({
    settings: { includePrereleases: true },
    fetchImpl: async (url) => {
      asked.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => list };
    }
  });
  const state = await updates.check();
  assert.match(asked[0], /\/releases\?per_page=10$/);
  assert.equal(state.phase, 'available');
  assert.equal(state.version, '0.4.0-beta.1');
  assert.equal(state.prerelease, true);
});

test('a repeated check is answered from the last one until it is asked to look again', async () => {
  let calls = 0;
  const updates = service({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => release('v0.3.0') };
    }
  });
  await updates.check();
  await updates.check();
  assert.equal(calls, 1, 'the second check should have been answered from the first');
  await updates.check({ force: true });
  assert.equal(calls, 2);
});

/**
 * The line this whole file holds: the update check cannot change the machine.
 *
 * An earlier version could - it downloaded an archive and started a script that
 * replaced the application folder - and a window started from source refused
 * with a message that left the user with nothing to do. The check is read-only
 * now, and the way to fetch a release is a browser. This test reads the file
 * because that is the only way to assert the absence of a capability.
 */
test('the service cannot download, install or start anything', () => {
  const source = fs.readFileSync(path.join(APP, 'src', 'main', 'update-service.js'), 'utf8');
  assert.doesNotMatch(source, /require\('node:child_process'\)/, 'it must not be able to start a process');
  assert.doesNotMatch(source, /require\('node:fs/, 'it must not be able to read or write a file');
  assert.doesNotMatch(source, /\bspawn\b|\bexecFile\b|\bcreateWriteStream\b/, 'no way to run or fetch anything onto disk');

  const updates = service({});
  assert.equal(updates.download, undefined, 'there is no download to call');
  assert.equal(updates.install, undefined, 'there is no install to call');
  assert.equal(
    fs.existsSync(path.join(APP, 'src', 'main', 'apply-update.ps1')),
    false,
    'the script that replaced the application folder is gone with it'
  );
});