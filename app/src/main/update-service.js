'use strict';

/**
 * Looking for a newer release, fetching it, and putting it where this app is.
 *
 * Four decisions shape this file.
 *
 * 1. The window never talks to the network. The check, the download and the
 *    install all happen here, and the window is only told what happened. That
 *    keeps the strict content security policy in `index.html` exactly as it is,
 *    and it means a compromised renderer still has no route out of the machine.
 *
 * 2. Settings and per-machine data live in `%APPDATA%` and `%LOCALAPPDATA%`,
 *    never inside the application folder, so replacing that folder does not
 *    touch a single preference.
 *
 * 3. This process never replaces its own files. Windows will not let a running
 *    process delete or overwrite the image it is running from - that is the
 *    whole of the conflict between an update and a running app - so the swap is
 *    handed to `apply-update.ps1`, which waits for this process to exit first.
 *
 * 4. A failed update leaves a working application. The archive is unpacked
 *    completely before anything moves, the current folder is renamed aside
 *    rather than deleted, and it is renamed back if the new tree cannot take its
 *    place. The worst case is the old version starting again, with a log that
 *    says why.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE_API = 'https://api.github.com/repos';
/** GitHub refuses an API request that does not name a user agent. */
const USER_AGENT = 'LexiQode';
/** A repeated check inside this window is answered from what was already found. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** The script this file starts, shipped beside it. */
const SCRIPT_FILE = path.join(__dirname, 'apply-update.ps1');

/**
 * `v1.2.3`, `1.2.3-beta.1` and `1.2` all read as three numbers.
 *
 * Anything else has no version in it and is reported as unknown rather than
 * guessed at: comparing against a version nobody can parse is how an update
 * prompt turns into noise.
 */
function parseVersion(text) {
  const match = String(text === null || text === undefined ? '' : text)
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

/** -1 when the left version is older, 0 when they are the same, 1 when newer. */
function compareVersions(left, right) {
  const a = parseVersion(left) || [0, 0, 0];
  const b = parseVersion(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/**
 * The archive for this machine, by the name the build script gives it.
 *
 * The exact version is preferred, then any archive for this platform, then any
 * archive at all: a release whose assets are named slightly differently is still
 * worth offering, and refusing it would leave a user with nothing.
 */
function pickArchive(release, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const assets = (Array.isArray(release && release.assets) ? release.assets : []).filter(
    (asset) => asset && typeof asset.browser_download_url === 'string'
  );
  const suffix = `-${platform === 'win32' ? 'win32' : platform}-${arch}.zip`;
  const exact = assets.find(
    (asset) => String(asset.name).endsWith(suffix) && String(asset.name).includes(`-${options.version}-`)
  );
  const chosen =
    exact ||
    assets.find((asset) => String(asset.name).endsWith(suffix)) ||
    assets.find((asset) => /\.zip$/i.test(String(asset.name)));
  if (!chosen) return null;
  return {
    name: String(chosen.name),
    size: Number(chosen.size) || 0,
    url: chosen.browser_download_url,
    /**
     * Whether the name says it is for this machine.
     *
     * A release whose archive is named differently is still offered - the layout
     * inside is what the updater needs, not the label - but the window says out
     * loud that the name does not match, because that is the one case where a
     * download could be for the wrong platform.
     */
    matchesPlatform: String(chosen.name).endsWith(suffix)
  };
}

/** The text of the script that finishes the update, for a test to read. */
function readUpdaterScript() {
  return fs.readFileSync(SCRIPT_FILE, 'utf8');
}

/**
 * `owner/name` from a GitHub URL, which is what the release API takes.
 *
 * A repository declared in any of the shapes a `package.json` accepts -
 * `git+https://…​.git`, `https://github.com/…`, `owner/name` - reduces to the
 * same pair, and anything else returns an empty string so the caller reports
 * "nothing to check" instead of asking GitHub about a URL that is not one.
 */
function githubSlug(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const direct = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (direct) return `${direct[1]}/${direct[2]}`;
  const url = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/);
  return url ? `${url[1]}/${url[2]}` : '';
}

class UpdateService {
  constructor(options = {}) {
    this.settings = options.settings;
    this.currentVersion = String(options.currentVersion || '0.0.0');
    this.repository = String(options.repository || '');
    this.packaged = Boolean(options.packaged);
    this.installDir = String(options.installDir || '');
    this.dataDir = String(options.dataDir || '');
    this.fetchImpl = options.fetchImpl || null;
    /**
     * How the swap script is started. Injected so a test can check what would be
     * run without running it: this particular spawn hands a real script the job
     * of renaming the application's own folder, which is not something a test
     * may do by accident.
     */
    this.spawnImpl = options.spawnImpl || spawn;
    this.onState = options.onState || (() => {});
    this.onLog = options.onLog || (() => {});
    // The version and the repository are known before any check runs, so the
    // window can show both the moment it asks.
    this.state = { phase: 'idle', message: '', current: this.currentVersion, repo: this.repo };
    this.checking = null;
    this.checkedAt = 0;
  }

  #set(patch) {
    this.state = { ...this.state, ...patch, current: this.currentVersion, repo: this.repo };
    this.onState(this.state);
    return this.state;
  }

  /**
   * What the window should draw before it has asked for anything.
   *
   * Named `snapshot` rather than `state` because `this.state` is the state
   * object: a method of the same name is shadowed by the field, and the call
   * then fails at runtime with "state is not a function" - which is exactly what
   * happened the first time this file was written.
   */
  snapshot() {
    return this.state;
  }

  /** The repository to ask, which a setting may point somewhere else. */
  get repo() {
    return this.settings.get().updates.repo || this.repository;
  }

  get logFile() {
    return this.dataDir ? path.join(this.dataDir, 'update.log') : '';
  }

  async #fetch(url, options = {}) {
    const request = {
      ...options,
      headers: {
        'user-agent': `${USER_AGENT}/${this.currentVersion}`,
        accept: 'application/vnd.github+json',
        ...(options.headers || {})
      },
      redirect: 'follow'
    };
    if (this.fetchImpl) return this.fetchImpl(url, request);
    return fetch(url, request);
  }

  /**
   * Ask GitHub what the newest release is.
   *
   * `/releases/latest` skips drafts and pre-releases, which is what almost
   * everyone wants. A user who wants the pre-releases gets the list instead and
   * the newest entry is taken.
   */
  async check(options = {}) {
    if (this.checking) return this.checking;
    const repo = this.repo;
    if (!repo) {
      return this.#set({ phase: 'unavailable', message: 'no repository is configured to check' });
    }
    if (!options.force && this.checkedAt && Date.now() - this.checkedAt < CHECK_INTERVAL_MS) return this.state;

    this.#set({ phase: 'checking', message: '', error: '' });
    this.checking = (async () => {
      try {
        const prereleases = Boolean(this.settings.get().updates.includePrereleases);
        const url = `${RELEASE_API}/${repo}/releases${prereleases ? '?per_page=10' : '/latest'}`;
        const response = await this.#fetch(url);
        if (response.status === 404) {
          return this.#set({
            phase: 'unavailable',
            message: `no published release was found for ${repo} (a private repository answers the same way)`
          });
        }
        if (!response.ok) {
          return this.#set({ phase: 'error', message: `the release list could not be read (${response.status})` });
        }
        const body = await response.json();
        const release = Array.isArray(body) ? body.find((entry) => entry && !entry.draft) : body;
        if (!release) return this.#set({ phase: 'unavailable', message: 'no release was published yet' });

        const version = String(release.tag_name || release.name || '').replace(/^v/i, '');
        if (!parseVersion(version)) {
          return this.#set({
            phase: 'unavailable',
            message: `the release tag ${release.tag_name} carries no version`
          });
        }
        this.checkedAt = Date.now();
        if (compareVersions(version, this.currentVersion) <= 0) {
          this.onLog(`update: ${this.currentVersion} is the newest release`);
          return this.#set({ phase: 'current', version, message: '' });
        }
        const asset = pickArchive(release, { version });
        this.onLog(
          `update: ${version} is available${asset ? ` (${asset.name})` : ' without an archive for this platform'}`
        );
        return this.#set({
          phase: 'available',
          version,
          notes: String(release.body || '').slice(0, 4000),
          url: String(release.html_url || ''),
          prerelease: Boolean(release.prerelease),
          asset,
          // A release without an archive is still announced: the release page is
          // then the way to it, and staying silent would look like a failure.
          message: !asset
            ? 'this release has no archive for this platform; the release page is the way to it'
            : asset.matchesPlatform
              ? ''
              : `the archive is named ${asset.name}, which does not say it is for this platform`
        });
      } catch (error) {
        this.onLog(`update: the check failed (${error.message})`);
        return this.#set({ phase: 'error', message: error.message });
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Fetch the archive, reporting progress as it arrives. */
  async download() {
    const asset = this.state.asset;
    if (!asset) throw new Error('there is nothing to download');
    await fsp.mkdir(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, asset.name);
    const partial = `${file}.part`;
    this.#set({ phase: 'downloading', percent: 0, received: 0, total: asset.size || 0, error: '' });

    const response = await this.#fetch(asset.url, { headers: { accept: 'application/octet-stream' } });
    if (!response.ok || !response.body) throw new Error(`the download was refused (${response.status})`);
    const total = Number(response.headers.get('content-length')) || asset.size || 0;
    let received = 0;
    let lastPercent = -1;
    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      received += chunk.length;
      // Progress is pushed per percent rather than per chunk: an archive of this
      // size arrives in thousands of chunks, and a message each would cost more
      // than the download it describes.
      const percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        this.#set({ received, total, percent });
      }
    });
    try {
      await pipeline(stream, fs.createWriteStream(partial));
      await fsp.rm(file, { force: true });
      await fsp.rename(partial, file);
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => {});
      this.#set({ phase: 'error', message: `the download failed: ${error.message}` });
      throw error;
    }
    const bytes = (await fsp.stat(file)).size;
    this.onLog(`update: downloaded ${file} (${bytes} bytes)`);
    return this.#set({
      phase: 'downloaded',
      file,
      bytes,
      percent: 100,
      received: bytes,
      total: total || bytes,
      log: this.logFile
    });
  }

  /**
   * Hand the swap to a detached script and return; the caller then quits.
   *
   * The refusal for a source checkout is not a limitation to apologise for: an
   * app started with `electron .` has no build to replace, and overwriting the
   * repository it was started from would be a strange thing for it to do.
   */
  async install() {
    if (!this.packaged) {
      throw new Error('this build was started from source, so it cannot replace itself; take the archive instead');
    }
    const state = this.state;
    if (state.phase !== 'downloaded' || !state.file || !fs.existsSync(state.file)) {
      throw new Error('no downloaded update was found');
    }
    await fsp.mkdir(this.dataDir, { recursive: true });
    // Run a copy from the data folder rather than the shipped one: the shipped
    // copy lives inside the folder that is about to be renamed aside, and a
    // script executing from a folder that moves under it is a needless risk.
    const script = path.join(this.dataDir, `apply-${state.version || 'update'}.ps1`);
    await fsp.writeFile(script, readUpdaterScript(), 'utf8');
    const log = this.logFile;
    await fsp.appendFile(log, `[${new Date().toISOString()}] installing ${state.version || ''} into ${this.installDir}\n`);

    const child = this.spawnImpl(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-ProcessId',
        String(process.pid),
        '-Archive',
        state.file,
        '-Target',
        this.installDir,
        '-Exe',
        path.join(this.installDir, path.basename(process.execPath)),
        '-Log',
        log
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
    this.onLog(`update: the swap script is running (${script}); the window will close`);
    return this.#set({
      phase: 'installing',
      log,
      message: 'the window closes now and the new version starts by itself'
    });
  }
}

module.exports = {
  SCRIPT_FILE,
  UpdateService,
  compareVersions,
  githubSlug,
  parseVersion,
  pickArchive,
  readUpdaterScript
};