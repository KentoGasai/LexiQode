'use strict';

/**
 * Looking for a newer release, and pointing at it.
 *
 * This application does not install its own updates, and that is a decision
 * rather than a gap. The first version did: it downloaded the archive, unpacked
 * it, and handed a detached script the job of replacing the application folder
 * once the process had gone. What it produced was confusion. A window started
 * from source refused with a message nobody could act on - the install simply
 * did not happen - and replacing a portable application in place is a great deal
 * of machinery to ask anyone to trust for something a person does by unpacking a
 * zip. So the check reports, and the release page does the rest.
 *
 * Two consequences are deliberate and worth stating, because they are what makes
 * this file safe to have:
 *
 * 1. Nothing here writes a file, starts a process or touches the installation.
 *    The whole service is one HTTP request and a version comparison, and a test
 *    reads this file to assert exactly that.
 *
 * 2. The window never talks to the network. The request is made in the main
 *    process; the window is told what was found, and opens the release page in
 *    the user's browser when asked.
 */

const RELEASE_API = 'https://api.github.com/repos';
/** GitHub refuses an API request that does not name a user agent. */
const USER_AGENT = 'LexiQode';
/** A repeated check inside this window is answered from what was already found. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
    this.fetchImpl = options.fetchImpl || null;
    this.onState = options.onState || (() => {});
    this.onLog = options.onLog || (() => {});
    this.checking = null;
    this.checkedAt = 0;
    // The version and the repository are known before any check runs, so the
    // window can show both the moment it asks.
    this.state = {
      phase: 'idle',
      message: '',
      current: this.currentVersion,
      repo: this.repo,
      releasesUrl: this.releasesPage
    };
  }

  #set(patch) {
    this.state = { ...this.state, ...patch, current: this.currentVersion, repo: this.repo, releasesUrl: this.releasesPage };
    this.onState(this.state);
    return this.state;
  }

  /**
   * What the window should draw before it has asked for anything.
   *
   * Named `snapshot` rather than `state` because `this.state` is the state
   * object: a method of the same name is shadowed by the field, and the call
   * then fails at runtime with "state is not a function".
   */
  snapshot() {
    return this.state;
  }

  /** The repository to ask, which a setting may point somewhere else. */
  get repo() {
    return this.settings.get().updates.repo || this.repository;
  }

  /** The page a person can download from, which exists whether or not a release does. */
  get releasesPage() {
    return this.repo ? `https://github.com/${this.repo}/releases` : '';
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
   * Ask GitHub what the newest release is, and report it.
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

        const tag = String(release.tag_name || release.name || '');
        const version = tag.replace(/^v/i, '');
        if (!parseVersion(version)) {
          return this.#set({ phase: 'unavailable', message: `the release tag ${tag} carries no version` });
        }
        this.checkedAt = Date.now();
        // The page is what the window opens, so it is built here and always
        // present: a release with no html_url still has a page on GitHub.
        const page = String(release.html_url || `${this.releasesPage}/tag/${tag}`);
        if (compareVersions(version, this.currentVersion) <= 0) {
          this.onLog(`update: ${version} is the newest release (running ${this.currentVersion})`);
          return this.#set({ phase: 'current', version, page, url: page, message: '' });
        }
        this.onLog(`update: ${version} is available: ${page}`);
        return this.#set({
          phase: 'available',
          version,
          page,
          url: page,
          notes: String(release.body || '').slice(0, 4000),
          prerelease: Boolean(release.prerelease),
          message: ''
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
}

module.exports = { UpdateService, compareVersions, githubSlug, parseVersion };