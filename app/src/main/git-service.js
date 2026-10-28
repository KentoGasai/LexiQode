'use strict';

/**
 * Git, run as a child process with an argument array.
 *
 * Nothing here builds a command string. Arguments are passed as an array, so a
 * branch name or a path can never become a second command, and paths always
 * follow `--` so a file called `--force` is a file. Output is captured with a
 * byte cap and a deadline: a `git log` in a huge repository, or a credential
 * prompt nobody can see, would otherwise hang the panel forever.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const { parseBranches, parseCommitFiles, parseDiff, parseLog, parseStatus } = require('../shared/git');

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

class GitService {
  constructor({ workspace }) {
    this.workspace = workspace;
    this.lastError = '';
  }

  #git(args, options = {}) {
    const cwd = options.cwd || this.workspace.require();
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    const expectFailure = Boolean(options.expectFailure);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd,
          windowsHide: true,
          env: {
            ...process.env,
            // A prompt would wait for input that no one can type; failing with a
            // message is more useful than hanging.
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0'
          }
        });
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: '', stderr: error.message });
        return;
      }

      let stdout = '';
      let stderr = '';
      let size = 0;
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish({ ok: false, code: -1, stdout, stderr: `${stderr}\ngit timed out after ${timeout} ms` });
      }, timeout);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          finish({ ok: false, code: -1, stdout, stderr: 'git produced more output than this panel will hold' });
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        const message = error.code === 'ENOENT' ? 'git is not installed or not on PATH' : error.message;
        finish({ ok: false, code: -1, stdout, stderr: message });
      });
      child.on('close', (code) => {
        const ok = code === 0;
        if (!ok && !expectFailure) this.lastError = stderr.trim().split('\n').slice(0, 3).join(' ');
        finish({ ok, code: code ?? -1, stdout, stderr });
      });
    });
  }

  /**
   * Is the open folder inside a work tree?
   *
   * Every other call assumes yes, so this is the one call whose failure is
   * routine: most folders a user opens are not repositories, and the panel says
   * so instead of showing an error for each refresh.
   */
  async detect() {
    if (!this.workspace.current()) return { repo: false, reason: 'no folder is open' };
    const result = await this.#git(['rev-parse', '--is-inside-work-tree'], { expectFailure: true });
    if (!result.ok) {
      const missing = /not installed|not on PATH/.test(result.stderr);
      return {
        repo: false,
        reason: missing ? 'git is not available' : 'this folder is not a git repository'
      };
    }
    const top = await this.#git(['rev-parse', '--show-toplevel'], { expectFailure: true });
    return {
      repo: result.stdout.trim() === 'true',
      topLevel: top.ok ? path.resolve(top.stdout.trim()) : '',
      reason: ''
    };
  }

  async status() {
    const detection = await this.detect();
    if (!detection.repo) return { ...detection, entries: [], staged: [], modified: [], untracked: [], conflicted: [] };
    const result = await this.#git(['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    if (!result.ok) return { repo: true, error: result.stderr.trim(), entries: [], staged: [], modified: [], untracked: [], conflicted: [] };
    return { repo: true, topLevel: detection.topLevel, ...parseStatus(result.stdout) };
  }

  async diff(relative, { staged = false } = {}) {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--cached');
    if (relative) args.push('--', relative);
    const result = await this.#git(args, { expectFailure: true });
    return { ok: result.ok, text: result.stdout, parsed: parseDiff(result.stdout), error: result.stderr.trim() };
  }

  async log(limit = 50) {
    const result = await this.#git(
      ['log', `-n${Math.max(1, Math.min(500, limit))}`, '--pretty=format:%H\u001f%an\u001f%ar\u001f%s\u001e'],
      { expectFailure: true }
    );
    return { ok: result.ok, commits: parseLog(result.stdout), error: result.ok ? '' : result.stderr.trim() };
  }

  async branches() {
    const result = await this.#git(
      ['branch', '--list', '--format=%(refname:short)\u001f%(HEAD)\u001f%(upstream:short)'],
      { expectFailure: true }
    );
    return { ok: result.ok, branches: parseBranches(result.stdout), error: result.ok ? '' : result.stderr.trim() };
  }

  async stage(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    return this.#git(['add', '--', ...list]);
  }

  async unstage(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    // `restore --staged` is the modern spelling; `reset HEAD --` is the fallback
    // for a git older than 2.23, which still exists on long-lived machines.
    const restore = await this.#git(['restore', '--staged', '--', ...list], { expectFailure: true });
    if (restore.ok) return restore;
    return this.#git(['reset', '-q', 'HEAD', '--', ...list]);
  }

  async discard(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    return this.#git(['restore', '--', ...list]);
  }

  async commit(message) {
    const text = String(message || '').trim();
    if (!text) return { ok: false, code: -1, stdout: '', stderr: 'a commit message is required' };
    return this.#git(['commit', '-m', text]);
  }

  async checkout(name) {
    const branch = String(name || '').trim();
    if (!branch) return { ok: false, code: -1, stdout: '', stderr: 'a branch name is required' };
    return this.#git(['checkout', branch]);
  }

  /**
   * The diff a commit introduced, against its first parent.
   *
   * `git show` is used rather than `git diff <hash>^ <hash>` because it also
   * works for the very first commit, which has no parent: `^` would fail there
   * and the first commit of a repository is exactly the one a person is most
   * likely to open. `--format=` drops the commit header, so what is shown is the
   * change and nothing else.
   */
  async show(hash) {
    const revision = String(hash || '').trim();
    if (!revision) return { ok: false, text: '', parsed: { header: '', hunks: [] }, error: 'a commit is required' };
    const result = await this.#git(['show', '--no-color', '--format=', '--patch', revision], {
      expectFailure: true
    });
    return {
      ok: result.ok,
      text: result.stdout,
      parsed: parseDiff(result.stdout),
      error: result.ok ? '' : result.stderr.trim()
    };
  }

  /**
   * A commit as a person reads it: who, when, what, and which files.
   *
   * The file list is what a commit view is for - the change is per file, and a
   * single wall of patch text hides which files are even involved. `--name-status`
   * gives the status letter and the paths, and `--format` gives the header, in
   * one call rather than three.
   */
  async commitView(hash) {
    const revision = String(hash || '').trim();
    if (!revision) return { ok: false, error: 'a commit is required', files: [] };
    const meta = await this.#git(
      ['show', '--no-patch', '--format=%H\u001f%an\u001f%ae\u001f%ar\u001f%ad\u001f%s\u001f%b', revision],
      { expectFailure: true }
    );
    if (!meta.ok) return { ok: false, error: meta.stderr.trim(), files: [] };
    const [full, author, email, when, date, subject, body] = meta.stdout.split('\u001f');
    const names = await this.#git(['show', '--name-status', '--format=', revision], { expectFailure: true });
    return {
      ok: true,
      error: '',
      commit: {
        hash: (full || revision).trim(),
        short: (full || revision).trim().slice(0, 7),
        author: (author || '').trim(),
        email: (email || '').trim(),
        when: (when || '').trim(),
        date: (date || '').trim(),
        subject: (subject || '').trim(),
        body: (body || '').trim()
      },
      files: parseCommitFiles(names.stdout)
    };
  }

  /**
   * One file's change in one commit, as the two sides a diff editor needs.
   *
   * A patch is not enough for a coloured diff: Monaco's diff editor compares two
   * documents, so it is given the file as it was before the commit and as it is
   * after it. `git show <rev>:<path>` reads a blob without touching the working
   * tree, and a path that did not exist on one side is an empty document - which
   * is what an added or a deleted file is.
   *
   * The parent is `<rev>^`; the first commit has none, so the "before" side is
   * empty there rather than an error.
   */
  async commitFile(hash, relative) {
    const revision = String(hash || '').trim();
    const file = String(relative || '').trim();
    if (!revision || !file) return { ok: false, error: 'a commit and a path are required' };
    const parent = await this.#git(['rev-parse', '--verify', '--quiet', `${revision}^`], { expectFailure: true });
    const before = parent.ok
      ? await this.#git(['show', `${parent.stdout.trim()}:${file}`], { expectFailure: true })
      : { ok: false, stdout: '' };
    const after = await this.#git(['show', `${revision}:${file}`], { expectFailure: true });
    return {
      ok: true,
      error: '',
      path: file,
      before: before.ok ? before.stdout : '',
      after: after.ok ? after.stdout : '',
      // A binary file has no text to compare; the view says so instead of
      // showing the replacement characters a decoded blob would produce.
      binary: /\0/.test(before.stdout || '') || /\0/.test(after.stdout || '')
    };
  }

  /**
   * Fetch from the remote, then report how the branch now stands.
   *
   * `--prune` removes remote-tracking branches that no longer exist, so a branch
   * deleted on the server stops being offered here. The fetch is what makes the
   * ahead/behind counts in the panel true; without it they describe the last
   * time the window looked, not the remote.
   */
  async fetch() {
    const result = await this.#git(['fetch', '--prune'], { timeout: 60000 });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr.trim() };
  }

  /**
   * Pull the current branch from its upstream.
   *
   * `--ff-only` is deliberate: a merge or a rebase started from a button, with
   * no way to see the conflict it produced, is how a working tree is left in a
   * state the person did not ask for. A fast-forward is the only outcome that
   * cannot need a decision, and anything else is reported so it can be done in
   * the terminal where the conflict is visible.
   */
  async pull() {
    const result = await this.#git(['pull', '--ff-only'], { timeout: 120000 });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr.trim() };
  }

  /**
   * Push the current branch to its upstream.
   *
   * `--set-upstream` is added only when the branch has none, which is the case
   * for a branch created here: without it the first push fails with a message
   * about the upstream that reads as a refusal. A branch that already tracks
   * something is pushed to it and nothing else is changed.
   */
  async push() {
    const upstream = await this.#git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { expectFailure: true }
    );
    const args = ['push'];
    if (!upstream.ok || !upstream.stdout.trim()) args.push('--set-upstream', 'origin', 'HEAD');
    const result = await this.#git(args, { timeout: 120000 });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr.trim() };
  }
}

module.exports = { GitService };