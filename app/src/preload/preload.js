'use strict';

/**
 * The only door between the window and the machine.
 *
 * The window runs with context isolation on and no Node integration: it has no
 * `require`, no `process`, no filesystem. What it has is exactly this object,
 * and every method in it corresponds to a handler that the main process
 * registered deliberately. Anything not listed here cannot be reached from the
 * page, which is what makes a compromised renderer an inconvenience rather than
 * a machine takeover.
 *
 * Calls answer with `{ ok, value }` or `{ ok: false, error }`; this layer turns
 * the second shape into a thrown Error, so the UI can use ordinary `try`/`catch`
 * and still see the message the main process produced.
 */

const { contextBridge, ipcRenderer } = require('electron');

const { CHANNELS } = require('../shared/constants');

/** Push channels the window may subscribe to. Nothing else is forwarded. */
const EVENTS = [
  CHANNELS.window.state,
  CHANNELS.workspace.changed,
  CHANNELS.settings.changed,
  CHANNELS.search.batch,
  CHANNELS.search.done,
  CHANNELS.git.changed,
  CHANNELS.terminal.data,
  CHANNELS.terminal.exit,
  CHANNELS.agent.event,
  CHANNELS.agent.statusChanged,
  CHANNELS.app.command
];

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok) return result.value;
  throw new Error((result && result.error) || 'the editor refused that request');
}

function on(channel, listener) {
  if (!EVENTS.includes(channel)) throw new Error(`channel ${channel} is not forwarded to the window`);
  const wrapped = (event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  platform: process.platform,
  events: EVENTS,
  on,
  window: {
    minimise: () => call(CHANNELS.window.minimise),
    maximise: () => call(CHANNELS.window.maximise),
    close: () => call(CHANNELS.window.close),
    state: () => call(CHANNELS.window.state)
  },
  dialogs: {
    openFolder: () => call(CHANNELS.dialogs.openFolder),
    openFile: () => call(CHANNELS.dialogs.openFile),
    saveAs: (options) => call(CHANNELS.dialogs.saveAs, options),
    confirm: (options) => call(CHANNELS.dialogs.confirm, options)
  },
  workspace: {
    current: () => call(CHANNELS.workspace.current),
    recent: () => call(CHANNELS.workspace.recent),
    open: (folder) => call(CHANNELS.workspace.open, folder),
    close: () => call(CHANNELS.workspace.close),
    tree: (relative) => call(CHANNELS.workspace.tree, relative),
    readFile: (relative) => call(CHANNELS.workspace.readFile, relative),
    writeFile: (payload) => call(CHANNELS.workspace.writeFile, payload),
    createFile: (parent, name) => call(CHANNELS.workspace.createFile, { parent, name }),
    createFolder: (parent, name) => call(CHANNELS.workspace.createFolder, { parent, name }),
    rename: (path, name) => call(CHANNELS.workspace.rename, { path, name }),
    remove: (relative) => call(CHANNELS.workspace.remove, relative),
    reveal: (relative) => call(CHANNELS.workspace.reveal, relative),
    index: () => call(CHANNELS.workspace.index)
  },
  search: {
    start: (searchId, request) => call(CHANNELS.search.start, { searchId, request }),
    cancel: (searchId) => call(CHANNELS.search.cancel, searchId)
  },
  git: {
    status: () => call(CHANNELS.git.status),
    diff: (path, staged) => call(CHANNELS.git.diff, { path, staged }),
    log: (limit) => call(CHANNELS.git.log, limit),
    branches: () => call(CHANNELS.git.branches),
    stage: (paths) => call(CHANNELS.git.stage, paths),
    unstage: (paths) => call(CHANNELS.git.unstage, paths),
    discard: (paths) => call(CHANNELS.git.discard, paths),
    commit: (message) => call(CHANNELS.git.commit, message),
    checkout: (name) => call(CHANNELS.git.checkout, name)
  },
  terminal: {
    create: (options) => call(CHANNELS.terminal.create, options),
    write: (id, data) => call(CHANNELS.terminal.write, { id, data }),
    submit: (id, command) => call(CHANNELS.terminal.submit, { id, command }),
    kill: (id) => call(CHANNELS.terminal.kill, id),
    list: () => call(CHANNELS.terminal.list)
  },
  settings: {
    get: () => call(CHANNELS.settings.get),
    update: (patch) => call(CHANNELS.settings.update, patch)
  },
  agent: {
    status: () => call(CHANNELS.agent.status),
    start: () => call(CHANNELS.agent.start),
    stop: () => call(CHANNELS.agent.stop),
    state: () => call(CHANNELS.agent.state),
    history: () => call(CHANNELS.agent.history),
    send: (payload) => call(CHANNELS.agent.send, payload),
    cancel: () => call(CHANNELS.agent.cancel),
    reset: () => call(CHANNELS.agent.reset),
    approval: (payload) => call(CHANNELS.agent.approval, payload),
    models: (payload) => call(CHANNELS.agent.models, payload),
    saveProfile: (patch) => call(CHANNELS.agent.saveProfile, patch),
    complete: (payload) => call(CHANNELS.agent.complete, payload)
  },
  shell: {
    openExternal: (url) => call(CHANNELS.shell.openExternal, url),
    showItem: (target) => call(CHANNELS.shell.showItem, target)
  }
};

contextBridge.exposeInMainWorld('lexiqode', api);