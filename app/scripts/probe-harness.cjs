/**
 * The shared half of the window probes: start the app, attach to it, talk to it.
 *
 * Two scripts here launch the real application and question the real window.
 * The launching, the DevTools attachment and the stub endpoint are identical
 * between them, so they live once, here, and a probe only describes what it
 * wants to ask.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How to start the application.
 *
 * The development runtime by default; a packaged bundle is checked by pointing
 * `LEXIQODE_PROBE_EXE` at its own executable, which is how the packaged layout
 * (and the core it ships beside itself) gets verified rather than assumed.
 * No folder is passed: the probes open one themselves, the way a person does.
 */
function launcher({ port }) {
  const exe = process.env.LEXIQODE_PROBE_EXE || path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
  const packaged = Boolean(process.env.LEXIQODE_PROBE_EXE);
  return {
    exe,
    args: packaged
      ? [`--remote-debugging-port=${port}`]
      : ['.', `--remote-debugging-port=${port}`],
    cwd: packaged ? path.dirname(exe) : APP
  };
}

/**
 * A private configuration directory for the app under test.
 *
 * This is not tidiness, it is the difference between measuring and damaging. The
 * application keeps its settings - the model endpoint and the key with it - in
 * `%APPDATA%\LexiQode`, and a probe that saves an endpoint in order to test the
 * save button will write to whatever configuration the app was started with. The
 * first version of these probes did exactly that and overwrote the real profile
 * of the person running them, irrecoverably.
 *
 * Overriding APPDATA and LOCALAPPDATA gives the child its own userData tree:
 * `app.getPath('userData')` follows APPDATA, and the core's session files follow
 * LOCALAPPDATA. The real configuration is then never opened for writing at all,
 * and a probe is free to save, delete and re-save profiles as it likes. It also
 * means a probe can run while the application is open, because the single
 * instance lock lives in the isolated directory too.
 */
function isolatedConfig(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lexiqode-probe-${tag}-`));
  for (const name of ['roaming', 'local', 'home']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

function startApp({ port, onLine = () => {}, tag = 'app' }) {
  const { exe, args, cwd } = launcher({ port });
  const config = isolatedConfig(tag);
  const userData = path.join(config, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  // `--user-data-dir` is what actually moves the window's own settings file:
  // Electron asks Windows for the roaming directory instead of reading the
  // environment, so overriding APPDATA alone still left `app-settings.json` -
  // and the restored session with it - in the real profile. Both are set,
  // because the Python core does follow the environment for its own file.
  const child = spawn(exe, [...args, `--user-data-dir=${userData}`], {
    cwd,
    env: {
      ...process.env,
      APPDATA: path.join(config, 'roaming'),
      LOCALAPPDATA: path.join(config, 'local'),
      HOME: path.join(config, 'home'),
      XDG_CONFIG_HOME: path.join(config, 'home'),
      ELECTRON_ENABLE_LOGGING: '1',
      LEXIQODE_PROBE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Reported by the callers so a run can say where its state went; keeping it on
  // the child avoids changing the shape every caller already uses.
  child.configDir = config;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    });
  }
  return child;
}

/**
 * A minimal OpenAI-compatible endpoint, so the settings form can be tested the
 * way it is used: point it somewhere real and expect a model list back.
 */
function startStub({ port, models = ['stub-model-a', 'stub-model-b'] }) {
  const server = http.createServer((request, response) => {
    const reply = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.url && request.url.endsWith('/models')) {
      reply({ object: 'list', data: models.map((id) => ({ id })) });
      return;
    }
    reply({ choices: [{ message: { role: 'assistant', content: 'stub' }, finish_reason: 'stop' }] });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an async expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'the page threw');
    }
    return result.result.value;
  }
}

async function listTargets(port, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('app://'));
      if (page) return page;
    } catch {
      // The port is not open yet.
    }
    await sleep(500);
  }
  throw new Error('the window never appeared on the debugging port');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not attach to the window')), { once: true });
  });
  return new Session(socket);
}

/**
 * Wait for the window to finish booting.
 *
 * A target appears on the debugging port the moment it is created, which is
 * before the markup exists. Attaching instantly and evaluating there reports an
 * empty body and no elements - a measurement of the wrong moment that looks
 * exactly like a broken window. Parsing is not enough either: the activity bar,
 * the status bar and the mode buttons are built by the window's own bootstrap,
 * so those are what the wait actually waits for.
 */
async function waitForDom(session) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await session.evaluate(
      `return {
         state: document.readyState,
         ids: document.querySelectorAll('[id]').length,
         activity: document.querySelectorAll('.activity__item').length,
         status: document.querySelectorAll('.statusbar__item').length,
         modes: document.querySelectorAll('.modebtn').length
       };`
    );
    if (ready.state !== 'loading' && ready.activity > 0 && ready.status > 0 && ready.modes > 0) return ready;
    await sleep(250);
  }
  throw new Error('the window never finished booting');
}

/**
 * Run a list of named checks against one attached window, printing each result.
 *
 * A check that throws is reported as a failed check rather than ending the run:
 * the value of this kind of probe is the whole picture, and the fifth check is
 * usually the one that explains the first.
 */
async function runChecks(session, checks) {
  for (const check of checks) {
    try {
      const value = await session.evaluate(check.expression);
      console.log(`\n--- ${check.label}\n${JSON.stringify(value, null, 2)}`);
    } catch (error) {
      console.log(`\n--- ${check.label}\nFAILED: ${error.message}`);
    }
  }
}

module.exports = { APP, sleep, startApp, startStub, listTargets, connect, waitForDom, runChecks };