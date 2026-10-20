/**
 * Headless tests for the extension's core client.
 *
 * These drive the *compiled* client against the *real* Python core: a real
 * child process, a real handshake on stdout, real HTTP calls and a real SSE
 * stream. No editor and no model endpoint are involved - the core is configured
 * to point at a closed port, which is enough to make a turn produce the error
 * and turn_end frames the stream has to deliver.
 *
 *     node test/client.test.js        (or: npm run test:client)
 */

const Module = require('module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

// The client imports the logger, which imports 'vscode'. Squeeze a stub in
// before anything is required so the real client code can run under plain Node.
const vscodeStub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  workspace: {},
  commands: {},
  Uri: { file: (value) => ({ fsPath: value }), joinPath: (...parts) => ({ fsPath: parts.join('/') }) },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, ...rest);
};

const { CoreClient, CoreRequestError } = require('../out/core/client.js');
const { runtimeDescriptorPath } = require('../out/core/runtime.js');

const CORE_ROOT = path.resolve(__dirname, '..', '..', 'core');
/** A port nothing listens on, so a model call fails immediately and locally. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1/v1';

/** The client shared by most cases; the last one disposes it. */
let primary;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-ext-'));
const workspace = path.join(root, 'project');
const configDir = path.join(root, 'cfg');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
process.env.LEXIQODE_CONFIG_DIR = configDir;
process.env.LEXIQODE_DATA_DIR = path.join(root, 'data');
process.env.LEXIQODE_RUNTIME_FILE = path.join(configDir, 'core-runtime.json');
fs.writeFileSync(
  path.join(configDir, 'settings.json'),
  JSON.stringify({
    version: 1,
    active_profile: 'test',
    profiles: {
      test: { id: 'test', label: 'Test', base_url: DEAD_ENDPOINT, model: 'test-model' },
    },
    agent: { auto_approve: true, max_steps: 4 },
  }),
  'utf8'
);

function makeClient(overrides = {}) {
  const frames = [];
  const states = [];
  const lines = [];
  const log = {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    core: (message) => lines.push(`core ${message}`),
  };
  const client = new CoreClient({
    workspace,
    pythonPath: process.env.LEXIQODE_PYTHON ?? 'python',
    coreRoot: CORE_ROOT,
    log,
    attachToRunningCore: false,
    events: {
      onFrame: (frame) => frames.push(frame),
      onState: (state, detail) => states.push({ state, detail }),
      onCoreStderr: (line) => lines.push(`stderr ${line}`),
    },
    ...overrides,
  });
  return { client, frames, states, log };
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('CoreClient against a real core', () => {
  before(async () => {
    primary = makeClient();
    await primary.client.start();
  });

  after(async () => {
    if (primary) {
      await primary.client.dispose();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the handshake and reaches the API', async () => {
    const info = primary.client.info;
    assert.ok(info, 'a handshake must have been parsed');
    assert.strictEqual(info.product, 'LexiQode');
    assert.strictEqual(info.protocol, 1, 'protocol version must match the extension');
    assert.ok(info.token && info.token.length >= 32, 'the handshake must carry a token');
    assert.ok(info.port > 0, 'a real port must have been assigned');
    assert.ok(info.pid > 0, 'the pid must be reported');
    assert.strictEqual(path.resolve(info.workspace), path.resolve(workspace));
    assert.strictEqual(primary.client.connectionState, 'ready');

    const health = await primary.client.health();
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.pid, info.pid);
  });

  it('reports the workspace state', async () => {
    const state = await primary.client.getState();
    assert.strictEqual(state.profile.id, 'test');
    assert.strictEqual(state.profile.model, 'test-model');
    assert.strictEqual(state.agent.auto_approve, true);
    const names = state.tools.map((tool) => tool.name);
    for (const expected of ['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'run_command']) {
      assert.ok(names.includes(expected), `${expected} must be offered`);
    }
    assert.deepStrictEqual(await primary.client.getHistory(), [], 'a fresh workspace has no history');
  });

  it('delivers turn frames over the event stream', async () => {
    // The endpoint is unreachable, so the turn fails immediately. What matters
    // here is that the frames arrive, parsed, in order.
    await primary.client.startTurn('this cannot reach a model');

    const end = await waitFor(
      () => primary.frames.find((frame) => frame.event === 'turn_end'),
      'the turn_end frame'
    );
    const names = primary.frames.map((frame) => frame.event);
    assert.ok(names.includes('turn_start'), `turn_start missing from ${names.join(', ')}`);
    assert.ok(names.includes('error'), `error missing from ${names.join(', ')}`);
    assert.strictEqual(end.data.stopped, 'error');

    const errorFrame = primary.frames.find((frame) => frame.event === 'error');
    assert.ok(
      /cannot reach|ConnectError|Connection refused|10061/i.test(errorFrame.data.message),
      `the error frame must explain the failure, got: ${errorFrame.data.message}`
    );
  });

  it('maps an API failure to a typed error', async () => {
    let caught;
    try {
      await primary.client.complete('rewrite something');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'the call must fail when the model endpoint is unreachable');
    assert.ok(
      caught instanceof CoreRequestError,
      `expected CoreRequestError, got ${caught.constructor.name}: ${caught.message}`
    );
    assert.strictEqual(caught.status, 502, `an unreachable endpoint is a bad gateway, got ${caught.status}`);
  });

  it('reports the mode catalogue the panel renders', async () => {
    const state = await primary.client.getState();
    const ids = state.modes.map((mode) => mode.id);
    for (const expected of ['agent', 'ask', 'plan', 'debug', 'review']) {
      assert.ok(ids.includes(expected), `${expected} must be offered: got ${ids.join(', ')}`);
    }
    const ask = state.modes.find((mode) => mode.id === 'ask');
    assert.strictEqual(ask.can_write, false, 'Ask must be advertised as read-only');
    assert.deepStrictEqual(
      [...ask.tools].sort(),
      ['glob', 'grep', 'list_dir', 'read_file'],
      'the advertised tools must be the ones the core enforces'
    );
    const agent = state.modes.find((mode) => mode.id === 'agent');
    assert.strictEqual(agent.tools, null, 'Agent places no restriction');
    assert.strictEqual(agent.can_write, true);
    assert.strictEqual(state.turn.mode, 'agent', 'an idle session reports the default mode');
  });

  it('starts a turn in a named mode and remembers it', async () => {
    const started = await primary.client.startTurn('summarise the workspace', { mode: 'plan' });
    assert.strictEqual(started.mode, 'plan');

    const during = await primary.client.getState();
    assert.strictEqual(during.turn.mode, 'plan');

    // A turn may not outlive the test, or the next one is refused because the
    // workspace is still busy.
    await waitFor(async () => {
      const state = await primary.client.getState();
      return state.turn.running ? undefined : state;
    }, 'the plan turn to finish');

    const after = await primary.client.getState();
    assert.strictEqual(after.turn.mode, 'plan', 'the mode survives the turn');
  });

  it('refuses an unknown mode with the valid ones', async () => {
    let caught;
    try {
      await primary.client.startTurn('hello', { mode: 'telepathy' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CoreRequestError, 'an unknown mode must be a typed error');
    assert.strictEqual(caught.status, 400);
    assert.match(caught.message, /unknown mode/);
    assert.match(caught.message, /agent/, 'the error must name what is accepted');
  });

  it('rejects a wrong token', async () => {
    const { client } = makeClient({ attachToRunningCore: false });
    // Point the clone at the running core but with a broken token.
    client.handshake = { ...primary.client.info, token: 'x'.repeat(48) };
    await assert.rejects(() => client.getState(), (error) => {
      assert.ok(error instanceof CoreRequestError);
      assert.strictEqual(error.status, 401);
      return true;
    });
  });

  it('attaches to the core another client already started', async () => {
    const second = makeClient({ attachToRunningCore: true });
    await second.client.start();
    assert.strictEqual(second.client.isAttached, true, 'the second client must attach, not spawn');
    assert.strictEqual(
      second.client.info.pid,
      primary.client.info.pid,
      'both clients must talk to the same process'
    );
    const state = await second.client.getState();
    assert.strictEqual(path.resolve(state.workspace), path.resolve(workspace));
    await second.client.dispose();
    // Disposing an attached client must not stop the core it borrowed.
    const stillThere = await primary.client.health();
    assert.strictEqual(stillThere.ok, true, 'the owner core must survive an attached client leaving');
  });

  it('writes and then removes its runtime descriptor', async () => {
    const descriptorFile = runtimeDescriptorPath(process.env);
    assert.ok(fs.existsSync(descriptorFile), 'the descriptor must exist while the core runs');
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
    assert.strictEqual(descriptor.pid, primary.client.info.pid);

    await primary.client.dispose();
    primary = undefined;
    await waitFor(
      () => !fs.existsSync(descriptorFile),
      'the runtime descriptor to be removed on shutdown'
    );
    assert.strictEqual(fs.existsSync(descriptorFile), false);
  });
});