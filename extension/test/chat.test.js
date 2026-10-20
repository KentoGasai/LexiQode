/**
 * The chat surfaces, verified without an editor.
 *
 * The interesting behaviour is not "does a panel appear" - that is the editor's
 * job - but the decisions the extension makes: fanning one conversation out to
 * several surfaces, treating an approval as inline when something is on screen
 * and as a modal dialog when nothing is, and keeping the selected mode in step
 * with the next turn.
 *
 * Running this under plain Node with a stand-in for the editor API means none of
 * it needs a GUI, so it can be checked on every change instead of only when
 * somebody clicks through the product.
 *
 *     node test/chat.test.js        (or: npm run test:chat)
 */

const assert = require('node:assert');
const Module = require('module');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');

// --------------------------------------------------------------- editor stand-in

const calls = {
  posted: [],
  dialogs: [],
  executed: [],
  info: [],
  errors: [],
};

/** Answers the next modal question with whatever the test set up. */
let nextDialogAnswer;

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire(value) {
    for (const listener of this.listeners.slice()) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.length = 0;
  }
}

const disposable = () => ({ dispose: () => {} });

const vscodeStub = {
  EventEmitter: FakeEventEmitter,
  Disposable: { from: (items) => ({ dispose: () => items.forEach((item) => item?.dispose?.()) }) },
  Uri: {
    file: (value) => ({ fsPath: value, scheme: 'file', path: value, toString: () => value }),
    joinPath: (base, ...parts) => ({
      fsPath: path.join(base.fsPath ?? String(base), ...parts),
      toString: () => parts.join('/'),
    }),
    from: (value) => ({ ...value, fsPath: value.path ?? '' }),
  },
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Workspace: 2, Global: 1 },
  ProgressLocation: { Notification: 15 },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    showWarningMessage: async (message, _options, ...buttons) => {
      calls.dialogs.push({ message, buttons });
      return nextDialogAnswer;
    },
    showInformationMessage: async (message) => {
      calls.info.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      calls.errors.push(message);
      return undefined;
    },
    showInputBox: async () => undefined,
    withProgress: async (_options, task) => task(),
  },
  commands: {
    registerCommand: () => disposable(),
    executeCommand: async (id, ...rest) => {
      calls.executed.push({ id, rest });
      return undefined;
    },
    getCommands: async () => [],
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeWorkspaceFolders: () => disposable(),
    registerTextDocumentContentProvider: () => disposable(),
    asRelativePath: (uri) => String(uri),
    openTextDocument: async () => ({}),
    applyEdit: async () => true,
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, ...rest);
};

const { ChatController } = require('../out/ui/chatController.js');

// --------------------------------------------------------------- test doubles

class FakeSurface {
  constructor(visible = true) {
    this.messages = [];
    this.visible = visible;
    this.webview = {
      postMessage: (message) => {
        this.messages.push(message);
        calls.posted.push(message);
        return Promise.resolve(true);
      },
      options: {},
    };
  }

  /** The most recent message of a type, or undefined. */
  last(type) {
    return [...this.messages].reverse().find((message) => message.type === type);
  }

  all(type) {
    return this.messages.filter((message) => message.type === type);
  }
}

class FakeSession {
  constructor() {
    this.frameEmitter = new FakeEventEmitter();
    this.stateEmitter = new FakeEventEmitter();
    this.onFrame = this.frameEmitter.event;
    this.onState = this.stateEmitter.event;
    this.mode = 'agent';
    this.currentState = { connection: 'stopped' };
    this.calls = [];
    this.answers = [];
    this.modeCatalogue = [
      { id: 'agent', label: 'Agent', can_write: true },
      { id: 'ask', label: 'Ask', can_write: false },
    ];
  }

  record(name, ...args) {
    this.calls.push({ name, args });
  }

  async send(text, mode) {
    this.record('send', text, mode);
  }

  async cancel() {
    this.record('cancel');
  }

  async reset() {
    this.record('reset');
  }

  async history() {
    return [];
  }

  async policySnapshot() {
    return { writes: false, commands: false };
  }

  async modes() {
    return this.modeCatalogue;
  }

  async describeModel() {
    return 'test-model at http://provider.test/v1';
  }

  async answerApproval(id, approved, remember, reason) {
    this.answers.push({ id, approved, remember, reason });
    return true;
  }

  async openChange() {
    this.record('openChange');
  }

  async applyPolicy() {
    this.record('applyPolicy');
  }

  async restart() {
    this.record('restart');
  }

  async ensureClient() {
    return undefined;
  }

  call(name) {
    return this.calls.filter((entry) => entry.name === name);
  }
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  core: () => {},
  show: () => {},
  dispose: () => {},
};

const secrets = {
  get: async () => undefined,
  store: async () => {},
  delete: async () => {},
};

function makeController() {
  const session = new FakeSession();
  const controller = new ChatController(session, logger, secrets);
  return { session, controller };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('chat surfaces', () => {
  beforeEach(() => {
    calls.posted.length = 0;
    calls.dialogs.length = 0;
    calls.executed.length = 0;
    calls.info.length = 0;
    calls.errors.length = 0;
    nextDialogAnswer = undefined;
  });

  it('gives every attached surface the same start', async () => {
    const { controller } = makeController();
    const sidebar = new FakeSurface(true);
    const tab = new FakeSurface(true);

    controller.attach(sidebar);
    controller.attach(tab);
    await settle();

    for (const surface of [sidebar, tab]) {
      const init = surface.last('init');
      assert.ok(init, 'each surface must be initialised');
      assert.strictEqual(init.mode, 'agent', 'the init must carry the selected mode');
      assert.strictEqual(init.modes.length, 2, 'the mode catalogue must be offered');
      assert.strictEqual(init.model, 'test-model at http://provider.test/v1');
      assert.strictEqual(init.allowWrites, false, 'the init must carry the approval policy');
    }
    assert.strictEqual(controller.surfaceCount, 2);
  });

  it('sends a late mode catalogue without clobbering the header', async () => {
    // The catalogue only exists once the core answers, so it arrives after the
    // init. Sending a second, partial init would blank the model line.
    const { controller, session } = makeController();
    session.currentState = { connection: 'starting' };
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();

    const updates = sidebar.all('modes');
    assert.strictEqual(updates.length, 1, `expected one mode update, got ${updates.length}`);
    assert.strictEqual(updates[0].modes.length, 2);
    assert.strictEqual(
      sidebar.last('init').model,
      'test-model at http://provider.test/v1',
      'the header must survive the catalogue refresh'
    );
  });

  it('fans one stream out to both surfaces', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    const tab = new FakeSurface(false);
    controller.attach(sidebar);
    controller.attach(tab);
    await settle();

    session.frameEmitter.fire({ event: 'text_delta', data: { text: 'hello' } });
    session.frameEmitter.fire({ event: 'tool_start', data: { id: 't1', name: 'read_file' } });
    await settle();

    for (const surface of [sidebar, tab]) {
      const frames = surface.all('frame');
      assert.strictEqual(frames.length, 2, 'both frames must reach every surface');
      assert.deepStrictEqual(
        frames.map((frame) => frame.event),
        ['text_delta', 'tool_start']
      );
    }
  });

  it('stops sending to a surface that has gone away', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();
    controller.detach(sidebar);

    session.frameEmitter.fire({ event: 'text_delta', data: { text: 'after close' } });
    await settle();

    assert.strictEqual(sidebar.all('frame').length, 0, 'a detached surface must not receive frames');
    assert.strictEqual(controller.surfaceCount, 0);
  });

  it('asks inline when a surface is on screen', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();

    session.frameEmitter.fire({
      event: 'approval_request',
      data: { id: 'a1', family: 'write', summary: 'edit main.py', detail: '' },
    });
    await settle();

    assert.strictEqual(calls.dialogs.length, 0, 'a visible surface is enough, no dialog');
    const card = sidebar.all('frame').find((frame) => frame.event === 'approval_request');
    assert.ok(card, 'the card must reach the visible surface');
    assert.strictEqual(card.data.id, 'a1');
  });

  it('asks in a dialog when nothing is visible, and delivers the answer', async () => {
    const { controller, session } = makeController();
    const hidden = new FakeSurface(false);
    controller.attach(hidden);
    await settle();
    session.answers.length = 0;
    nextDialogAnswer = 'Allow';

    session.frameEmitter.fire({
      event: 'approval_request',
      data: { id: 'a2', family: 'command', summary: 'run pytest', detail: 'exit code checked' },
    });
    await settle();

    assert.strictEqual(calls.dialogs.length, 1, 'an unseen request must become a dialog');
    assert.match(calls.dialogs[0].message, /run pytest/);
    assert.deepStrictEqual(calls.dialogs[0].buttons, ['Allow', 'Always allow', 'Deny']);
    assert.deepStrictEqual(
      session.answers,
      [{ id: 'a2', approved: true, remember: false, reason: '' }],
      'the answer must reach the core'
    );
  });

  it('records a dismissal as a refusal with a reason', async () => {
    const { controller, session } = makeController();
    controller.attach(new FakeSurface(false));
    await settle();
    session.answers.length = 0;
    nextDialogAnswer = undefined; // the user closed the dialog

    session.frameEmitter.fire({
      event: 'approval_request',
      data: { id: 'a3', family: 'write', summary: 'write file' },
    });
    await settle();

    assert.strictEqual(session.answers.length, 1);
    assert.strictEqual(session.answers[0].approved, false);
    assert.match(session.answers[0].reason, /no answer/);
  });

  it('never asks twice about the same request', async () => {
    const { controller, session } = makeController();
    controller.attach(new FakeSurface(false));
    await settle();
    nextDialogAnswer = 'Deny';

    const frame = { event: 'approval_request', data: { id: 'a4', family: 'write', summary: 'x' } };
    session.frameEmitter.fire(frame);
    await settle();
    session.frameEmitter.fire(frame);
    await settle();

    assert.strictEqual(calls.dialogs.length, 1, `expected one dialog, got ${calls.dialogs.length}`);
  });

  it('remembers the chosen mode and sends the next turn with it', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();

    await controller.handle({ type: 'setMode', mode: 'ask' });
    assert.strictEqual(controller.mode, 'ask');
    assert.strictEqual(sidebar.last('mode').mode, 'ask', 'the surfaces must be told');

    await controller.handle({ type: 'send', text: 'what does this do?' });
    assert.strictEqual(session.call('send').length, 1);
    assert.deepStrictEqual(session.call('send')[0].args, ['what does this do?', 'ask']);
  });

  it('ignores an empty prompt instead of starting a turn', async () => {
    const { controller, session } = makeController();
    controller.attach(new FakeSurface(true));
    await settle();

    await controller.handle({ type: 'send', text: '   ' });

    assert.strictEqual(session.call('send').length, 0);
  });

  it('reports a failure to start a turn in the chat instead of throwing', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();
    session.send = async () => {
      throw new Error('a turn is already running in this workspace');
    };

    await controller.handle({ type: 'send', text: 'do something' });

    const notice = sidebar.all('connection').find((message) => message.detail);
    assert.ok(notice, 'the failure must be shown');
    assert.match(notice.detail, /already running/);
    assert.strictEqual(notice.state, 'error');
  });

  it('publishes the connection state to every surface', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    const tab = new FakeSurface(true);
    controller.attach(sidebar);
    controller.attach(tab);
    await settle();

    session.currentState = { connection: 'ready' };
    session.stateEmitter.fire(session.currentState);
    await settle();

    for (const surface of [sidebar, tab]) {
      const connection = surface.last('connection');
      assert.ok(connection, 'the state must reach every surface');
      assert.strictEqual(connection.state, 'ready');
      assert.match(connection.model, /test-model/);
    }
  });

  it('stops posting after disposal', async () => {
    const { controller, session } = makeController();
    const sidebar = new FakeSurface(true);
    controller.attach(sidebar);
    await settle();
    const before = sidebar.messages.length;

    controller.dispose();
    session.frameEmitter.fire({ event: 'text_delta', data: { text: 'after dispose' } });
    await settle();

    assert.strictEqual(sidebar.messages.length, before, 'no messages after disposal');
    assert.strictEqual(controller.surfaceCount, 0, 'surfaces are released');
  });
});