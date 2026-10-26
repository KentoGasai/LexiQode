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

const { parseBranches, parseDiff, parseLog, parseStatus } = require('../shared/git');

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
}

module.exports = { GitService };