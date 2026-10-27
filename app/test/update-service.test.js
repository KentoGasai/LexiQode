'use strict';

/**
 * Checking for a release, fetching it, and the script that installs it.
 *
 * The parts worth testing are the ones that decide what a user is offered and
 * what happens to their installation: which release counts as newer, which asset
 * belongs to this machine, what the window is told at each step, and the order
 * of operations in the script that replaces the application folder. The last one
 * cannot be exercised here - it renames the folder this test runs from - so its
 * contract is read out of the file instead: wait for the process, unpack fully,
 * move aside rather than delete, put the old version back if the new one cannot
 * take its place.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UpdateService,
  compareVersions,
  githubSlug,
  parseVersion,
  pickArchive,
  readUpdaterScript
} = require('../src/main/update-service');

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
    packaged: options.packaged === true,
    installDir: options.installDir || path.join(os.tmpdir(), 'lexiqode-test-install'),
    dataDir: options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-update-test-')),
    fetchImpl: options.fetchImpl,
    spawnImpl: options.spawnImpl,
    onState: options.onState,
    onLog: options.onLog
  });
}

function release(tag, assets = [], extra = {}) {
  return {
    tag_name: tag,
    body: 'What changed.',
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    assets,
    ...extra
  };
}

function asset(name, size = 1024) {
  return { name, size, browser_download_url: `https://example.test/${name}` };
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

test('the archive for this machine is the one that matches it', () => {
  const assets = [
    asset('LexiQode-0.3.0-linux-x64.zip'),
    asset('LexiQode-0.3.0-win32-x64.zip', 4096),
    asset('LexiQode-0.2.0-win32-x64.zip')
  ];
  const chosen = pickArchive(release('v0.3.0', assets), { version: '0.3.0', platform: 'win32', arch: 'x64' });
  assert.equal(chosen.name, 'LexiQode-0.3.0-win32-x64.zip');
  assert.equal(chosen.size, 4096);
});

test('an archive is still offered when its name is not exactly ours', () => {
  const forThis = { version: '0.3.0', platform: 'win32', arch: 'x64' };
  assert.equal(pickArchive(release('v0.3.0', [asset('LexiQode-win32-x64.zip')]), forThis).name, 'LexiQode-win32-x64.zip');
  assert.equal(pickArchive(release('v0.3.0', [asset('bundle.zip')]), forThis).name, 'bundle.zip');
  assert.equal(pickArchive(release('v0.3.0', []), forThis), null);
  // The name is reported for what it is, so the window can say the archive does
  // not claim to be for this machine instead of installing it in silence.
  assert.equal(pickArchive(release('v0.3.0', [asset('bundle.zip')]), forThis).matchesPlatform, false);
  assert.equal(pickArchive(release('v0.3.0', [asset('LexiQode-0.3.0-win32-x64.zip')]), forThis).matchesPlatform, true);
});

test('a newer release is offered with its own archive', async () => {
  const phases = [];
  const updates = service({
    onState: (state) => phases.push(state.phase),
    fetchImpl: answering(release('v0.3.0', [asset('LexiQode-0.3.0-win32-x64.zip', 2048)]))
  });
  const state = await updates.check();
  assert.equal(state.phase, 'available');
  assert.equal(state.version, '0.3.0');
  assert.equal(state.current, '0.2.0');
  assert.equal(state.repo, REPO);
  assert.equal(state.asset.name, 'LexiQode-0.3.0-win32-x64.zip');
  // The window is told about the whole sequence, not only the end of it: that is
  // what lets it show "checking" instead of nothing.
  assert.deepEqual(phases, ['checking', 'available']);
});

test('the running version is not offered as an update', async () => {
  const updates = service({ fetchImpl: answering(release('v0.2.0', [asset('LexiQode-0.2.0-win32-x64.zip')])) });
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
});

test('a release tag with no version in it is reported, not guessed at', async () => {
  const updates = service({ fetchImpl: answering(release('nightly')) });
  const state = await updates.check();
  assert.equal(state.phase, 'unavailable');
  assert.match(state.message, /nightly/);
});

test('pre-releases are taken from the list only when asked for', async () => {
  const asked = [];
  const list = [release('v0.4.0-beta.1', [asset('LexiQode-0.4.0-beta.1-win32-x64.zip')], { prerelease: true })];
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
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => release('v0.3.0', [asset('LexiQode-0.3.0-win32-x64.zip')])
      };
    }
  });
  await updates.check();
  await updates.check();
  assert.equal(calls, 1, 'the second check should have been answered from the first');
  await updates.check({ force: true });
  assert.equal(calls, 2);
});

test('the archive is written to disk, with progress that reaches the end', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-download-test-'));
  const payload = Buffer.from('a'.repeat(4096));
  const phases = [];
  const updates = service({
    dataDir,
    onState: (state) => phases.push(state),
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://api.github.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => release('v0.3.0', [asset('LexiQode-0.3.0-win32-x64.zip', payload.length)])
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-length' ? String(payload.length) : null) },
        body: new Response(payload).body
      };
    }
  });
  await updates.check();
  const state = await updates.download();
  assert.equal(state.phase, 'downloaded');
  assert.equal(state.percent, 100);
  assert.equal(state.bytes, payload.length);
  assert.equal(fs.readFileSync(state.file).length, payload.length);
  // Nothing partial is left behind, and the progress that was pushed only ever
  // moves forward.
  assert.equal(fs.existsSync(`${state.file}.part`), false);
  const percents = phases.filter((entry) => entry.phase === 'downloading').map((entry) => entry.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
});

test('a refused download leaves no part file behind', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-download-test-'));
  const updates = service({
    dataDir,
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://api.github.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => release('v0.3.0', [asset('LexiQode-0.3.0-win32-x64.zip')])
        };
      }
      return { ok: false, status: 403, headers: { get: () => null } };
    }
  });
  await updates.check();
  await assert.rejects(() => updates.download(), /refused/);
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith('.part')), []);
});

test('a build started from source refuses to replace itself', async () => {
  const updates = service({ packaged: false });
  await assert.rejects(() => updates.install(), /started from source/);
});

test('an install without a downloaded archive is refused before anything runs', async () => {
  const updates = service({ packaged: true, spawnImpl: () => assert.fail('nothing should be started') });
  await assert.rejects(() => updates.install(), /no downloaded update/);
});

test('installing hands the swap to a detached script and names everything it needs', async () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-install-test-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-install-data-'));
  const archive = path.join(dataDir, 'LexiQode-0.3.0-win32-x64.zip');
  fs.writeFileSync(archive, 'zip');
  const calls = [];
  const updates = service({
    packaged: true,
    installDir,
    dataDir,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => {} };
    }
  });
  updates.state.phase = 'downloaded';
  updates.state.file = archive;
  updates.state.version = '0.3.0';
  const state = await updates.install();
  assert.equal(state.phase, 'installing');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, 'powershell.exe');
  assert.ok(call.options.detached, 'the script must outlive the application');
  const value = (flag) => call.args[call.args.indexOf(flag) + 1];
  assert.equal(value('-ProcessId'), String(process.pid));
  assert.equal(value('-Archive'), archive);
  assert.equal(value('-Target'), installDir);
  assert.equal(value('-Log'), path.join(dataDir, 'update.log'));
  assert.equal(value('-Exe'), path.join(installDir, path.basename(process.execPath)));
  // The script is run from a copy in the data folder: the shipped one lives
  // inside the folder that is about to be renamed aside.
  const script = value('-File');
  assert.equal(path.dirname(script), dataDir);
  assert.match(fs.readFileSync(script, 'utf8'), /waiting for the application/);
});

test('the swap script waits, unpacks first, and can put the old version back', () => {
  const script = readUpdaterScript();
  const wait = script.indexOf('while (Get-Process -Id $ProcessId');
  const unpack = script.indexOf('Expand-Archive');
  const aside = script.indexOf('Move-Item -LiteralPath $Target -Destination $old');
  const intoPlace = script.indexOf('Move-Item -LiteralPath $source -Destination $Target');
  const restore = script.indexOf('restoring the previous version');
  const restart = script.indexOf('Start-Process -FilePath $Exe');
  assert.ok(wait > 0, 'the script must wait for the application to exit');
  assert.ok(wait < unpack, 'nothing is touched while the application is running');
  assert.ok(unpack < aside, 'the archive is unpacked completely before the folder moves');
  assert.ok(aside < intoPlace, 'the current folder is moved aside, not deleted first');
  assert.ok(restore > intoPlace, 'the previous version is restored when the swap fails');
  assert.ok(restart > 0, 'the application is started again');
});