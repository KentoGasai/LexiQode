'use strict';

/**
 * Every channel the window can call, in one place.
 *
 * Two rules are applied to all of them.
 *
 * * A handler never throws across the boundary. Electron turns a rejected
 *   invoke into a string that loses the error type and the stack, which makes a
 *   refusal from the path guard indistinguishable from a crash; instead every
 *   call answers with `{ ok, value }` or `{ ok: false, error }`.
 * * A handler that changes something is only registered here. The window has no
 *   filesystem, no shell and no network of its own, so this file is the complete
 *   list of what the UI can do to the machine.
 */

const { CHANNELS } = require('../shared/constants');
const { payloadFor } = require('../shared/i18n');

function wrap(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { ok: false, error: message };
    }
  };
}

function registerIpc({
  ipcMain,
  dialog,
  shell,
  app,
  settings,
  workspace,
  search,
  git,
  terminal,
  agent,
  updates,
  watcher,
  windowOf,
  quitForUpdate = () => {}
}) {
  const handle = (channel, handler) => ipcMain.handle(channel, wrap(handler));

  // ---------------------------------------------------------------- window
  handle(CHANNELS.window.minimise, (event) => windowOf(event)?.minimize());
  handle(CHANNELS.window.maximise, (event) => {
    const window = windowOf(event);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  handle(CHANNELS.window.close, (event) => windowOf(event)?.close());
  handle(CHANNELS.window.state, (event) => {
    const window = windowOf(event);
    return { maximized: Boolean(window?.isMaximized()), fullScreen: Boolean(window?.isFullScreen()) };
  });

  // --------------------------------------------------------------- dialogs
  handle(CHANNELS.dialogs.openFolder, async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: 'Open a folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle(CHANNELS.dialogs.openFile, async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: 'Open a file',
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
  });
  handle(CHANNELS.dialogs.saveAs, async (event, options = {}) => {
    const result = await dialog.showSaveDialog(windowOf(event), {
      title: 'Save as',
      defaultPath: options.suggestedName || undefined
    });
    return result.canceled ? null : result.filePath;
  });
  handle(CHANNELS.dialogs.confirm, async (event, options = {}) => {
    const result = await dialog.showMessageBox(windowOf(event), {
      type: options.danger ? 'warning' : 'question',
      buttons: [options.confirmLabel || 'OK', options.cancelLabel || 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: options.message || '',
      detail: options.detail || ''
    });
    return result.response === 0;
  });

  // ------------------------------------------------------------- workspace
  handle(CHANNELS.workspace.current, () => workspace.current());
  handle(CHANNELS.workspace.recent, () => settings.get().recent);
  handle(CHANNELS.workspace.open, async (event, folder) => {
    if (!folder) return null;
    const result = await workspace.open(folder);
    settings.rememberFolder(result.root);
    // The folder is watched from the moment it is open, so a file created by a
    // build, a checkout or the agent appears in the tree without a Refresh.
    watcher.watch(result.root);
    // The agent belongs to the folder it was started in, so a new folder means a
    // new core. Failures are reported through the agent status the panel already
    // shows, rather than failing the folder switch itself.
    await agent.restart().catch(() => {});
    return result;
  });
  handle(CHANNELS.workspace.close, () => {
    watcher.stop();
    workspace.close();
    // A core left running would keep working in a folder the window no longer
    // shows.
    void agent.stop().catch(() => {});
    return null;
  });
  handle(CHANNELS.workspace.tree, (event, relative) => workspace.list(relative || '.'));
  handle(CHANNELS.workspace.readFile, (event, relative) => workspace.read(relative));
  handle(CHANNELS.workspace.writeFile, (event, payload) =>
    workspace.write(payload.path, payload.text, { eol: payload.eol, hadFinalNewline: payload.hadFinalNewline })
  );
  handle(CHANNELS.workspace.createFile, (event, payload) =>
    workspace.createFile(payload.parent, payload.name)
  );
  handle(CHANNELS.workspace.createFolder, (event, payload) =>
    workspace.createFolder(payload.parent, payload.name)
  );
  handle(CHANNELS.workspace.rename, (event, payload) => workspace.rename(payload.path, payload.name));
  handle(CHANNELS.workspace.remove, (event, relative) => workspace.remove(relative, (target) => shell.trashItem(target)));
  handle(CHANNELS.workspace.reveal, (event, relative) => {
    const root = workspace.require();
    const target = require('node:path').resolve(root, relative);
    shell.showItemInFolder(target);
    return target;
  });
  handle(CHANNELS.workspace.index, () => workspace.index());

  // ---------------------------------------------------------------- search
  handle(CHANNELS.search.start, (event, payload) => {
    const searchId = payload.searchId;
    return search.start(searchId, payload.request || {});
  });
  handle(CHANNELS.search.cancel, (event, searchId) => search.cancel(searchId));

  // ------------------------------------------------------------------- git
  handle(CHANNELS.git.status, () => git.status());
  handle(CHANNELS.git.diff, (event, payload) => git.diff(payload?.path, { staged: Boolean(payload?.staged) }));
  handle(CHANNELS.git.log, (event, limit) => git.log(limit || 50));
  handle(CHANNELS.git.branches, () => git.branches());
  handle(CHANNELS.git.stage, (event, paths) => git.stage(paths));
  handle(CHANNELS.git.unstage, (event, paths) => git.unstage(paths));
  handle(CHANNELS.git.discard, (event, paths) => git.discard(paths));
  handle(CHANNELS.git.commit, (event, message) => git.commit(message));
  handle(CHANNELS.git.checkout, (event, name) => git.checkout(name));

  // -------------------------------------------------------------- terminal
  handle(CHANNELS.terminal.create, (event, options) =>
    terminal.create({ cwd: options?.cwd || workspace.current()?.root, title: options?.title })
  );
  handle(CHANNELS.terminal.write, (event, payload) => terminal.write(payload.id, payload.data));
  handle(CHANNELS.terminal.submit, (event, payload) => terminal.submit(payload.id, payload.command));
  handle(CHANNELS.terminal.resize, (event, payload) => ({ resized: false, pty: false, id: payload.id }));
  handle(CHANNELS.terminal.kill, (event, id) => terminal.kill(id));
  handle(CHANNELS.terminal.list, () => terminal.list());

  // -------------------------------------------------------------- settings
  handle(CHANNELS.settings.get, () => settings.get());
  handle(CHANNELS.settings.update, (event, patch) => settings.update(patch));

  // --------------------------------------------------------------- updates
  handle(CHANNELS.update.state, () => updates.snapshot());
  handle(CHANNELS.update.check, (event, options) => updates.check(options || {}));
  /**
   * The download and the install both answer before they are finished, which is
   * the point of them: the window shows progress from the pushed state and does
   * not hold a request open for the length of a 150 MB download.
   */
  handle(CHANNELS.update.download, () => {
    void updates.download().catch(() => {});
    return { started: true };
  });
  handle(CHANNELS.update.install, async () => {
    const state = await updates.install();
    // The swap waits for this process to disappear, so leaving is the next step
    // rather than an optional one. The delay lets this answer reach the window,
    // so a failure to start the script is visible instead of a silent exit.
    setTimeout(() => quitForUpdate(), 400);
    return state;
  });

  // ----------------------------------------------------------------- agent
  handle(CHANNELS.agent.status, () => agent.describe());
  handle(CHANNELS.agent.start, () => agent.ensureStarted());
  handle(CHANNELS.agent.stop, () => agent.stop());
  handle(CHANNELS.agent.state, () => agent.state());
  handle(CHANNELS.agent.history, () => agent.history());
  handle(CHANNELS.agent.send, (event, payload) => agent.send(payload));
  handle(CHANNELS.agent.cancel, () => agent.cancel());
  handle(CHANNELS.agent.reset, () => agent.reset());
  handle(CHANNELS.agent.conversations, () => agent.conversations());
  handle(CHANNELS.agent.conversationNew, () => agent.newConversation());
  handle(CHANNELS.agent.conversationOpen, (event, id) => agent.openConversation(id));
  handle(CHANNELS.agent.conversationRename, (event, payload) =>
    agent.renameConversation(payload.id, payload.title)
  );
  handle(CHANNELS.agent.conversationDelete, (event, id) => agent.deleteConversation(id));
  handle(CHANNELS.agent.approval, (event, payload) => agent.approval(payload));
  handle(CHANNELS.agent.models, (event, payload) => agent.models(payload || {}));
  handle(CHANNELS.agent.saveProfile, (event, patch) => agent.saveProfile(patch));
  handle(CHANNELS.agent.complete, (event, payload) => agent.complete(payload));

  // ----------------------------------------------------------------- shell
  /**
   * The window's language and its dictionary.
   *
   * One call, answered from the main process, so the list of languages lives in
   * one place and the window never has to know where a translation is stored.
   */
  handle(CHANNELS.app.i18n, () => payloadFor(settings.get().appearance.language, app.getLocale()));
  handle(CHANNELS.app.dataFolder, () => app.getPath('userData'));

  handle(CHANNELS.shell.openExternal, (event, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) throw new Error('only http and https links can be opened');
    return shell.openExternal(target);
  });

  /**
   * Put text on the system clipboard.
   *
   * Through the main process rather than `navigator.clipboard`, which needs a
   * secure context: the window is loaded from `app://`, so the browser API is
   * either absent or refuses without a permission prompt nobody can answer.
   */
  handle(CHANNELS.clipboard.write, (event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  handle(CHANNELS.shell.showItem, (event, target) => {
    shell.showItemInFolder(String(target || ''));
    return true;
  });
}

module.exports = { registerIpc };