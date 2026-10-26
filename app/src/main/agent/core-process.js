'use strict';

/**
 * Starting and supervising the Python core that runs the agent.
 *
 * The core is a separate process on purpose. It owns the model credentials,
 * the tool registry and the transcript, it has its own tests, and it can be
 * driven from a terminal without the window being open. Launching it as a
 * child of the window means one install contains both halves and the app
 * decides when the model is reachable.
 *
 * Two details are load-bearing:
 *
 * * The address and the bearer token come from the handshake line the core
 *   prints on stdout, so nothing has to be stored on disk to reach it and the
 *   credential dies with the process.
 * * Every line of its stderr is kept. When a core fails to start, the reason
 *   is almost always a model configuration problem, and that text is the only
 *   place where it is stated.
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const { coreLogFile, coreRoot, ensureDir } = require('../paths');

const HANDSHAKE_PREFIX = 'lexiqode-core-ready';
const START_TIMEOUT_MS = 30000;
const LOG_LINES = 200;

/** Candidates in the order a Windows machine is likely to have them. */
const PYTHON_CANDIDATES = [
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
  { command: 'py', args: ['-3'] }
];

let cachedPython = null;

/**
 * Find a Python that can import the core.
 *
 * Checked by importing it: a machine can have several interpreters and only
 * one with the package's dependencies installed, and learning that from an
 * import error after the window opened is worse than saying so before.
 */
function findPython(root = coreRoot()) {
  if (cachedPython) return cachedPython;
  const override = process.env.LEXIQODE_PYTHON;
  const candidates = override
    ? [{ command: override, args: [] }, ...PYTHON_CANDIDATES]
    : PYTHON_CANDIDATES;

  const attempts = [];
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, '-c', 'import json, sys; print(json.dumps({"v": sys.version.split()[0]}))'],
      { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: root } }
    );
    if (probe.error || probe.status !== 0) {
      const why = probe.error ? probe.error.code || probe.error.message : `exit ${probe.status}`;
      attempts.push(`${candidate.command}: ${why}`);
      continue;
    }
    let version = 'unknown';
    try {
      version = JSON.parse(probe.stdout.trim().split('\n').at(-1)).v;
    } catch {
      version = 'unknown';
    }
    cachedPython = { command: candidate.command, args: candidate.args, version };
    return cachedPython;
  }
  const error = new Error(`no Python interpreter found (tried: ${attempts.join(', ')})`);
  error.code = 'NO_PYTHON';
  throw error;
}

class CoreProcess {
  constructor({ workspace, onLog = () => {}, onExit = () => {} }) {
    this.workspace = workspace;
    this.onLog = onLog;
    this.onExit = onExit;
    this.child = null;
    this.connection = null;
    this.stderrTail = [];
    this.starting = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  log(line) {
    const text = String(line).trimEnd();
    if (!text) return;
    this.stderrTail.push(text);
    if (this.stderrTail.length > LOG_LINES) this.stderrTail.shift();
    this.onLog(text);
  }

  /** Start the core, or return the connection it already published. */
  async start() {
    if (this.connection && this.running) return this.connection;
    if (this.starting) return this.starting;
    this.starting = this.#spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #spawn() {
    const root = coreRoot();
    const python = findPython(root);
    const current = this.workspace.current();
    const workspace = current ? current.root : process.cwd();
    ensureDir(path.dirname(coreLogFile()));

    const args = [
      ...python.args,
      '-m',
      'lexiqode',
      'serve',
      workspace,
      '--host',
      '127.0.0.1',
      '--port',
      '0'
    ];
    this.log(`starting: ${python.command} ${args.join(' ')}`);
    const child = spawn(python.command, args, {
      cwd: workspace,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: root,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    });
    this.child = child;

    const connection = await this.#handshake(child);
    this.connection = {
      baseUrl: connection.base_url,
      token: connection.token,
      pid: connection.pid,
      workspace
    };
    this.log(`core ready at ${connection.base_url} (pid ${connection.pid})`);
    return this.connection;
  }

  /** Resolve with the connection the core announced, or reject with its why. */
  #handshake(child) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let pending = '';
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error(`the core did not report an address within ${START_TIMEOUT_MS} ms`));
      }, START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        let index = pending.indexOf('\n');
        while (index !== -1) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (line.startsWith(HANDSHAKE_PREFIX)) {
            try {
              finish(null, JSON.parse(line.slice(HANDSHAKE_PREFIX.length).trim()));
            } catch (error) {
              finish(new Error(`unreadable handshake: ${error.message}`));
            }
          } else if (line.trim()) {
            this.log(line);
          }
          index = pending.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) this.log(line);
      });

      child.on('error', (error) => {
        const message = error.code === 'ENOENT' ? `${error.path} could not be started` : error.message;
        finish(new Error(message));
      });
      child.on('close', (code) => {
        const tail = this.stderrTail.slice(-4).join(' | ');
        this.child = null;
        this.connection = null;
        this.onExit({ code: code ?? -1, reason: tail });
        finish(new Error(`the core exited with code ${code}${tail ? `: ${tail}` : ''}`));
      });
    });
  }

  async stop() {
    const child = this.child;
    this.connection = null;
    if (!child) return { stopped: false };
    // A window closing has to take the core with it: a core left behind keeps a
    // port and, on some machines, an open connection to the model.
    child.removeAllListeners('close');
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve({ stopped: true });
      };
      child.once('close', done);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        done();
      }
      setTimeout(done, 3000);
    });
  }
}

module.exports = { CoreProcess, HANDSHAKE_PREFIX, findPython };