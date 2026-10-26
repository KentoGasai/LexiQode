'use strict';

/**
 * The application: one window, the services behind it, and the shutdown path.
 *
 * Services are created once and shared, because the settings file, the open
 * folder and the agent are all single things. Push channels (agent events,
 * search batches, terminal output) are forwarded to the window here, so the
 * renderer receives everything through the one preload surface it was given.
 */

const { app, BrowserWindow, Menu, nativeTheme, shell, dialog } = require('electron');
const path = require('node:path');

const { CHANNELS, PRODUCT } = require('../shared/constants');
const { payloadFor } = require('../shared/i18n');
const { assertAssetsPresent, handleRequests, registerScheme, urlFor } = require('./asset-protocol');
const { registerIpc } = require('./ipc');
const { rendererRoot, settingsFile, userDataDir, vendorRoot } = require('./paths');
const { SettingsStore } = require('./settings-store');
const { WorkspaceService } = require('./workspace');
const { SearchService } = require('./search-service');
const { GitService } = require('./git-service');
const { TerminalService } = require('./terminal-service');
const { AgentService } = require('./agent/service');

// Must happen before the app is ready; afterwards Electron ignores it.
registerScheme();

const BACKGROUND = { dark: '#131316', light: '#f4f4f6' };

let mainWindow = null;
let services = null;
let quitting = false;
let pendingFolder = null;

/**
 * A folder named on the command line.
 *
 * Only an absolute path that exists and is not the application's own directory
 * counts. The check is this strict because Electron is normally started as
 * `electron .`, and `.` is a directory: treating it as the folder to open made
 * the app open its own sources on every start.
 */
function folderFromArgv(argv) {
  const candidates = argv.slice(app.isPackaged ? 1 : 2).filter((value) => !value.startsWith('-'));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = path.resolve(candidate);
      if (!require('node:fs').statSync(resolved).isDirectory()) continue;
      if (resolved === path.resolve(app.getAppPath())) continue;
      return resolved;
    } catch {
      // Not a path this process can see; keep looking.
    }
  }
  return null;
}

/** The current language, resolved against the system locale. */
function translations() {
  return payloadFor(services?.settings.get().appearance.language, app.getLocale());
}

function buildServices() {
  if (services) return services;
  const settings = new SettingsStore(settingsFile());
  const workspace = new WorkspaceService({ settings });
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const search = new SearchService({
    workspace,
    settings,
    onBatch: (payload) => send(CHANNELS.search.batch, payload),
    onDone: (payload) => send(CHANNELS.search.done, payload)
  });
  const git = new GitService({ workspace });
  const terminal = new TerminalService({
    settings,
    onData: (payload) => send(CHANNELS.terminal.data, payload),
    onExit: (payload) => send(CHANNELS.terminal.exit, payload)
  });
  const agent = new AgentService({
    workspace,
    onEvent: (payload) => send(CHANNELS.agent.event, payload),
    onStatus: (payload) => send(CHANNELS.agent.statusChanged, payload),
    // The core says why it failed on stderr, and that text is the only place
    // where a model or endpoint problem is stated. It goes to the application's
    // own output so that running the app from a terminal shows the reason.
    onLog: (line) => console.log(`[agent] ${line}`)
  });

  let lastLanguage = settings.get().appearance.language;
  settings.onChange((value) => {
    send(CHANNELS.settings.changed, value);
    // The menu belongs to the main process, so a language change has to rebuild
    // it here; everything else the window re-renders itself.
    if (value.appearance.language !== lastLanguage) {
      lastLanguage = value.appearance.language;
      if (mainWindow) buildMenu();
    }
  });
  workspace.onChange((value) => send(CHANNELS.workspace.changed, value));

  services = { settings, workspace, search, git, terminal, agent, send };
  return services;
}

/** Commands the menu and the window's own shortcuts both end up in. */
function sendCommand(name, argument) {
  services?.send(CHANNELS.app.command, { name, argument });
}

/**
 * Menu labels, by the English label they are written as.
 *
 * Translating the built template rather than threading a lookup through every
 * item keeps the menu readable as a menu, and a label with no entry stays as it
 * was - which is what should happen to a role-based item Electron labels itself.
 */
const MENU_LABELS = {
  File: 'menu.file',
  Edit: 'menu.edit',
  View: 'menu.view',
  AI: 'menu.ai',
  Help: 'menu.help',
  'Open Folder…': 'menu.openFolder',
  'Open File…': 'menu.openFile',
  Save: 'menu.save',
  'Save All': 'menu.saveAll',
  'Close Editor': 'menu.closeEditor',
  'Close Folder': 'menu.closeFolder',
  Exit: 'menu.exit',
  'Find in File': 'menu.findInFile',
  'Find in Files': 'menu.findInFiles',
  'Command Palette…': 'menu.palette',
  'Go to File…': 'menu.gotoFile',
  'Toggle Sidebar': 'menu.toggleSidebar',
  'Toggle Panel': 'menu.togglePanel',
  'Toggle AI Panel': 'menu.toggleAssistant',
  Explorer: 'cmd.viewExplorer',
  Search: 'cmd.viewSearch',
  'Source Control': 'cmd.viewGit',
  Terminal: 'cmd.viewTerminal',
  'New Chat': 'menu.newChat',
  'Cancel Turn': 'menu.cancelTurn',
  'Focus Composer': 'menu.focusComposer',
  'Agent Settings…': 'menu.agentSettings',
  'Restart Agent': 'menu.restartAgent',
  'About LexiQode': 'menu.about',
  'Open Settings File': 'menu.settingsFile',
  'Open Data Folder': 'menu.dataFolder'
};

function translateMenu(items, messages) {
  return items.map((item) => {
    const translated = { ...item };
    const key = MENU_LABELS[item.label];
    if (key && messages[key]) translated.label = messages[key];
    if (Array.isArray(item.submenu)) translated.submenu = translateMenu(item.submenu, messages);
    return translated;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+K CmdOrCtrl+O', click: () => sendCommand('workspace.open') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('file.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('file.save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+K S', click: () => sendCommand('file.saveAll') },
        { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('file.close') },
        { type: 'separator' },
        { label: 'Close Folder', click: () => sendCommand('workspace.close') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in File', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('editor.find') },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendCommand('search.open') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendCommand('palette.open') },
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('quickopen.open') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('layout.sidebar') },
        { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: () => sendCommand('layout.panel') },
        { label: 'Toggle AI Panel', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendCommand('layout.chat') },
        { type: 'separator' },
        { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('view.explorer') },
        { label: 'Search', accelerator: 'CmdOrCtrl+Shift+H', click: () => sendCommand('view.search') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendCommand('view.git') },
        { label: 'Terminal', accelerator: 'CmdOrCtrl+`', click: () => sendCommand('view.terminal') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'AI',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendCommand('chat.new') },
        { label: 'Cancel Turn', accelerator: 'Escape', click: () => sendCommand('chat.cancel') },
        { label: 'Focus Composer', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('chat.focus') },
        { type: 'separator' },
        { label: 'Agent Settings…', click: () => sendCommand('chat.settings') },
        { label: 'Restart Agent', click: () => sendCommand('chat.restart') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: `About ${PRODUCT}`, click: () => sendCommand('about') },
        { label: 'Open Settings File', click: () => shell.openPath(settingsFile()) },
        { label: 'Open Data Folder', click: () => shell.openPath(userDataDir()) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(translateMenu(template, translations().messages)));
}

function createWindow() {
  const { settings } = buildServices();
  const current = settings.get();
  const dark = current.appearance.theme === 'dark' || (current.appearance.theme === 'system' && nativeTheme.shouldUseDarkColors);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0,0,0,0)',
      symbolColor: dark ? '#d8d8de' : '#333340',
      height: 34
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      devTools: true
    }
  });

  const roots = { rendererRoot: rendererRoot(), vendorRoot: vendorRoot() };
  assertAssetsPresent(roots);
  handleRequests(roots);

  const { workspace, search, git, terminal, agent } = services;
  registerIpc({
    ipcMain: require('electron').ipcMain,
    app,
    dialog,
    shell,
    settings,
    workspace,
    search,
    git,
    terminal,
    agent,
    windowOf: () => mainWindow
  });

  mainWindow.on('maximize', () => services.send(CHANNELS.window.state, { maximized: true }));
  mainWindow.on('unmaximize', () => services.send(CHANNELS.window.state, { maximized: false }));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(urlFor('index.html'));
  return mainWindow;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const folder = folderFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (folder) sendCommand('workspace.openPath', folder);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // One process to end and a handful of shells; both have to go, or the next
    // start finds an orphan holding the port.
    try {
      services?.terminal.killAll();
    } catch {
      // Nothing was open.
    }
    void (services?.agent.stop() ?? Promise.resolve()).finally(() => app.exit(0));
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('LexiQode');
    buildMenu();
    const { settings, workspace } = buildServices();
    const fromArgv = folderFromArgv(process.argv);
    // Reopening the last folder is a preference, not a default. Doing it always
    // meant the first thing a user saw was a folder they had not chosen.
    const sessionFolder = settings.get().session.folder;
    const restore =
      settings.get().files.reopenLastFolder && sessionFolder && require('node:fs').existsSync(sessionFolder)
        ? sessionFolder
        : null;
    const target = fromArgv || restore;
    if (target) await workspace.open(target).catch(() => {});
    createWindow();
    // The core is created for one folder; without one it would run in whatever
    // directory the window was launched from.
    if (settings.get().agent.autoStart && workspace.current()) {
      void services.agent.ensureStarted().catch(() => {});
    }
  });
}