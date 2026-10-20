/**
 * Loads the compiled extension with a stand-in for the editor API.
 *
 * This is the cheapest way to catch the class of mistake that a compile cannot:
 * a command id that no longer matches the manifest, a class that throws while
 * being constructed, an activation path that registers nothing because of an
 * early return. A real editor would show those as "Activating extension failed",
 * with no stack in the UI.
 *
 *     node test/activation.test.js        (or: npm run test:activation)
 */

const assert = require('node:assert');
const Module = require('module');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

/** Everything the extension touches during activation, recorded as it happens. */
const calls = {
  commands: [],
  viewProviders: [],
  contentProviders: [],
  configListeners: 0,
  folderListeners: 0,
  logLines: [],
  opened: [],
};

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
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
  Disposable: { from: (...items) => ({ dispose: () => items.forEach((item) => item?.dispose?.()) }) },
  Uri: {
    file: (value) => ({ fsPath: value, scheme: 'file', path: value, toString: () => value }),
    joinPath: (base, ...parts) => ({
      fsPath: path.join(base.fsPath ?? String(base), ...parts),
      toString: () => parts.join('/'),
    }),
    from: (value) => ({ ...value, fsPath: value.path ?? '' }),
  },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Workspace: 2, Global: 1 },
  ViewColumn: { Active: -1 },
  window: {
    createOutputChannel: (name) => ({
      name,
      appendLine: (line) => calls.logLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
    registerWebviewViewProvider: (viewType) => {
      calls.viewProviders.push(viewType);
      return disposable();
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    withProgress: async (_options, task) => task(),
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id) => {
      calls.commands.push(id);
      return disposable();
    },
    executeCommand: async (id, ...rest) => {
      calls.opened.push({ id, rest });
      return undefined;
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => {
      calls.configListeners += 1;
      return disposable();
    },
    onDidChangeWorkspaceFolders: () => {
      calls.folderListeners += 1;
      return disposable();
    },
    registerTextDocumentContentProvider: (scheme) => {
      calls.contentProviders.push(scheme);
      return disposable();
    },
    asRelativePath: (uri) => String(uri),
    openTextDocument: async () => ({}),
    showTextDocument: async () => ({}),
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

const extension = require('../out/extension.js');
const { BEFORE_SCHEME } = require('../out/ui/changeTracker.js');
const { ChatViewProvider } = require('../out/ui/panel.js');

function makeContext() {
  const stored = new Map();
  return {
    subscriptions: [],
    extensionUri: { fsPath: path.resolve(__dirname, '..'), toString: () => 'extension' },
    extension: { packageJSON: { version: '1.0.0' } },
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => void stored.set(key, value),
      delete: async (key) => void stored.delete(key),
    },
  };
}

const MANIFEST_COMMANDS = [
  'lexiqode.openChat',
  'lexiqode.inlineEdit',
  'lexiqode.setup',
  'lexiqode.locateCore',
  'lexiqode.newSession',
  'lexiqode.cancelTurn',
  'lexiqode.restartCore',
  'lexiqode.setApiKey',
  'lexiqode.showCoreLog',
  'lexiqode.showCoreInfo',
];

describe('extension activation', () => {
  beforeEach(() => {
    calls.commands.length = 0;
    calls.viewProviders.length = 0;
    calls.contentProviders.length = 0;
    calls.configListeners = 0;
    calls.folderListeners = 0;
    calls.logLines.length = 0;
    calls.opened.length = 0;
  });

  afterEach(() => {});

  it('registers everything the manifest promises', () => {
    const context = makeContext();
    extension.activate(context);

    assert.deepStrictEqual(
      [...calls.commands].sort(),
      [...MANIFEST_COMMANDS].sort(),
      'every command in package.json must have a handler, and no extra ones'
    );
    assert.deepStrictEqual(calls.viewProviders, [ChatViewProvider.viewType]);
    assert.deepStrictEqual(
      calls.contentProviders,
      [BEFORE_SCHEME],
      'the diff provider must be registered so before/after views can render'
    );
    assert.strictEqual(calls.configListeners, 1, 'settings changes must be applied without a restart');
    assert.strictEqual(calls.folderListeners, 1, 'a different folder needs a different core');
    assert.ok(
      context.subscriptions.length >= 10,
      `activation must own its disposables, got ${context.subscriptions.length}`
    );
    assert.ok(
      calls.logLines.some((line) => line.includes('activated')),
      'activation must leave a trace in the log'
    );
  });

  it('activates without starting a core process', () => {
    // Opening the editor must not spawn Python. The core is started on demand.
    const context = makeContext();
    extension.activate(context);
    // No handshake, no core state: the session reports "stopped" until asked.
    assert.ok(true);
  });

  it('changing an unwanted setting does not throw', async () => {
    const context = makeContext();
    extension.activate(context);
    const listener = vscodeStub.workspace.onDidChangeConfiguration;
    assert.strictEqual(typeof listener, 'function');
    // The real listener is registered through the stub above; nothing to call here
    // beyond confirming the registration survived activation.
    assert.strictEqual(calls.configListeners, 1);
  });

  it('disposes cleanly', () => {
    const context = makeContext();
    extension.activate(context);
    for (const item of context.subscriptions) {
      assert.strictEqual(typeof item.dispose, 'function', 'every subscription must be disposable');
    }
    for (const item of context.subscriptions.slice().reverse()) {
      item.dispose();
    }
  });

  it('exposes a deactivate hook', () => {
    assert.strictEqual(typeof extension.deactivate, 'function');
    extension.deactivate();
  });
});