/*
 * The window's entry point: layout, commands, keys and persistence.
 *
 * Everything the main process pushes arrives on the preload surface and is
 * re-emitted on a bus, so panels subscribe to the one thing they care about
 * instead of each registering its own listener. Layout state (which panel is
 * open, how wide it is, which tabs were open) is written back to the settings
 * file, debounced, so the window reopens where it was left without a write per
 * keystroke.
 */

import { createBus, debounce, el, icon, toast } from './ui.js';
import { createEditor } from './editor.js';
import { createExplorer } from './explorer.js';
import { createSearchPanel } from './search-panel.js';
import { createGitPanel } from './git-panel.js';
import { createTerminalPanel } from './terminal-panel.js';
import { createChat } from './chat.js';
import { rank } from './fuzzy.js';
import { current as i18nInfo, initI18n, t } from './i18n.js';

const api = window.lexiqode;
const bus = createBus();

const dom = {
  root: document.documentElement,
  sidebar: document.getElementById('sidebar'),
  chat: document.getElementById('chat'),
  panel: document.getElementById('panel'),
  activity: document.getElementById('activity'),
  statusbar: document.getElementById('statusbar'),
  overlay: document.getElementById('overlay'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
  paletteHint: document.getElementById('palette-hint'),
  brand: document.getElementById('brand')
};

let settingsValue = null;
let workspace = null;
let editor = null;
let explorer = null;
let search = null;
let git = null;
let terminal = null;
let chat = null;
let currentActivity = 'explorer';

const ACTIVITIES = [
  { id: 'explorer', icon: 'files', title: 'Explorer (Ctrl+Shift+E)' },
  { id: 'search', icon: 'search', title: 'Search (Ctrl+Shift+F)' },
  { id: 'git', icon: 'git', title: 'Source control (Ctrl+Shift+G)' },
  { id: 'chat', icon: 'spark', title: 'Assistant (Ctrl+Shift+A)' }
];

// --------------------------------------------------------------- settings

const persist = debounce((patch) => {
  void api.settings.update(patch).catch((error) => toast('error', error.message));
}, 400);

const persistSession = debounce(() => {
  if (!editor) return;
  persist({ session: { folder: workspace ? workspace.root : '', ...editor.session() } });
}, 600);

function settings() {
  return settingsValue;
}

function resolveTheme() {
  const choice = settingsValue.appearance.theme;
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyAppearance() {
  dom.root.dataset.theme = resolveTheme();
  dom.root.style.setProperty('--sidebar-width', `${settingsValue.layout.sidebarWidth}px`);
  dom.root.style.setProperty('--panel-height', `${settingsValue.layout.panelHeight}px`);
  dom.root.style.setProperty('--chat-width', `${settingsValue.layout.chatWidth}px`);
  dom.sidebar.hidden = !settingsValue.layout.sidebarVisible || currentActivity === 'chat';
  dom.panel.hidden = !settingsValue.layout.panelVisible;
  dom.chat.hidden = !settingsValue.layout.chatVisible;
  editor?.applyOptions();
}

// Channel names, spelled as the shared constants spell them. A test asserts that
// every string here exists in that file, because a typo produces an event that
// is silently never delivered.
const CH = {
  command: 'app:command',
  agentEvent: 'agent:event',
  agentStatus: 'agent:status-changed',
  searchBatch: 'search:batch',
  searchDone: 'search:done',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  settingsChanged: 'settings:changed',
  workspaceChanged: 'workspace:changed',
  windowState: 'window:state'
};

// ------------------------------------------------------------------ layout

function renderActivity() {
  dom.activity.replaceChildren();
  for (const item of ACTIVITIES) {
    const isCurrent = item.id === currentActivity;
    const open = item.id === 'chat' ? settingsValue.layout.chatVisible : settingsValue.layout.sidebarVisible;
    dom.activity.append(
      el('button', {
        class: 'activity__item',
        type: 'button',
        title: item.title,
        'aria-current': String(isCurrent && open),
        html: icon(item.icon),
        onclick: () => selectActivity(item.id)
      })
    );
  }
}

function selectActivity(id) {
  if (id === 'chat') {
    const visible = !settingsValue.layout.chatVisible;
    settingsValue.layout.chatVisible = visible;
    persist({ layout: { chatVisible: visible } });
    renderActivity();
    applyAppearance();
    if (visible) chat?.focus();
    return;
  }
  currentActivity = id;
  if (!settingsValue.layout.sidebarVisible) {
    settingsValue.layout.sidebarVisible = true;
    persist({ layout: { sidebarVisible: true } });
  }
  persist({ layout: { activity: id } });
  renderActivity();
  applyAppearance();
  void mountActivity();
}

async function mountActivity() {
  if (workspace && currentActivity === 'search') {
    search.mount();
    return;
  }
  if (workspace && currentActivity === 'git') {
    git.mount();
    return;
  }
  // Without a folder the explorer is what explains that, whichever view was
  // selected before the folder was closed.
  await explorer.refresh();
}

function toggleSidebar() {
  settingsValue.layout.sidebarVisible = !settingsValue.layout.sidebarVisible;
  persist({ layout: { sidebarVisible: settingsValue.layout.sidebarVisible } });
  applyAppearance();
  renderActivity();
}

function togglePanel(force) {
  settingsValue.layout.panelVisible = force === undefined ? !settingsValue.layout.panelVisible : Boolean(force);
  persist({ layout: { panelVisible: settingsValue.layout.panelVisible } });
  applyAppearance();
  if (settingsValue.layout.panelVisible) terminal.mount();
}

function toggleChat(force) {
  settingsValue.layout.chatVisible = force === undefined ? !settingsValue.layout.chatVisible : Boolean(force);
  persist({ layout: { chatVisible: settingsValue.layout.chatVisible } });
  applyAppearance();
  renderActivity();
  if (settingsValue.layout.chatVisible) chat?.focus();
}

// -------------------------------------------------------------- statusbar

const gitInfo = { branch: '', ahead: 0, behind: 0, repo: false };
let cursorInfo = { line: 0, column: 0, language: '', lines: 0 };

function statusItem(text, options = {}) {
  return el('button', {
    class: 'statusbar__item',
    type: 'button',
    title: options.title || '',
    dataset: { clickable: String(Boolean(options.onclick)) },
    text,
    onclick: options.onclick
  });
}

let statusNodes = {};

function renderStatusbar() {
  dom.statusbar.replaceChildren();
  const name = workspace ? workspace.name : t('status.noFolder');
  const branchText = gitInfo.repo
    ? `${gitInfo.branch || 'detached'}${gitInfo.ahead ? ` ↑${gitInfo.ahead}` : ''}${gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}`
    : t('status.noRepo');

  statusNodes = {
    folder: statusItem(name, { title: workspace ? workspace.root : t('status.openFolder'), onclick: () => void openFolder() }),
    branch: statusItem(branchText, {
      title: t('status.branchTitle'),
      onclick: () => selectActivity('git')
    }),
    agent: statusItem(t('status.agent', { state: '—' }), {
      title: t('status.agentTitle'),
      onclick: () => void restartAgent()
    }),
    model: statusItem(t('status.noModel'), {
      title: t('cmd.agentSettings'),
      onclick: () => chat.toggleSettings(true)
    }),
    cursor: statusItem('', { title: t('status.cursor', { line: '—', column: '—' }) })
  };

  dom.statusbar.append(
    statusNodes.folder,
    statusNodes.branch,
    el('span', { class: 'statusbar__spacer' }),
    statusNodes.agent,
    statusNodes.model,
    statusNodes.cursor
  );
  updateCursor();
}

function updateCursor() {
  if (!editor || !statusNodes.cursor) return;
  cursorInfo = editor.positions();
  const language = cursorInfo.language || t('status.plain');
  const position = t('status.cursor', { line: cursorInfo.line, column: cursorInfo.column });
  const lines = cursorInfo.lines ? ` · ${t('status.lines', { count: cursorInfo.lines })}` : '';
  statusNodes.cursor.textContent = `${language} · ${position}${lines}`;
}

async function refreshGit({ mount = false } = {}) {
  if (!workspace) return;
  try {
    const status = await api.git.status();
    gitInfo.repo = Boolean(status.repo);
    gitInfo.branch = status.branch || '';
    gitInfo.ahead = status.ahead || 0;
    gitInfo.behind = status.behind || 0;
  } catch {
    gitInfo.repo = false;
  }
  renderStatusbar();
  if (mount && currentActivity === 'git') await git.refresh();
}

// ---------------------------------------------------------------- palette

const palette = { open: false, mode: 'commands', items: [], index: 0, files: [] };

const COMMANDS = [
  { id: 'workspace.open', key: 'cmd.openFolder', hint: 'Ctrl+K Ctrl+O' },
  { id: 'workspace.close', key: 'cmd.closeFolder' },
  { id: 'file.open', key: 'cmd.openFile', hint: 'Ctrl+O' },
  { id: 'file.save', key: 'cmd.save', hint: 'Ctrl+S' },
  { id: 'file.saveAll', key: 'cmd.saveAll' },
  { id: 'file.close', key: 'cmd.closeEditor', hint: 'Ctrl+W' },
  { id: 'editor.find', key: 'cmd.findInFile', hint: 'Ctrl+F' },
  { id: 'search.open', key: 'cmd.findInFiles', hint: 'Ctrl+Shift+F' },
  { id: 'quickopen.open', key: 'cmd.gotoFile', hint: 'Ctrl+P' },
  { id: 'view.explorer', key: 'cmd.viewExplorer' },
  { id: 'view.search', key: 'cmd.viewSearch' },
  { id: 'view.git', key: 'cmd.viewGit' },
  { id: 'view.terminal', key: 'cmd.viewTerminal' },
  { id: 'layout.sidebar', key: 'cmd.toggleSidebar', hint: 'Ctrl+B' },
  { id: 'layout.panel', key: 'cmd.togglePanel', hint: 'Ctrl+J' },
  { id: 'layout.chat', key: 'cmd.toggleAssistant', hint: 'Ctrl+Shift+A' },
  { id: 'chat.new', key: 'cmd.newChat' },
  { id: 'chat.cancel', key: 'cmd.cancelTurn' },
  { id: 'chat.focus', key: 'cmd.focusComposer', hint: 'Ctrl+L' },
  { id: 'chat.settings', key: 'cmd.agentSettings' },
  { id: 'chat.restart', key: 'cmd.restartAgent' },
  { id: 'git.refresh', key: 'cmd.gitRefresh' },
  { id: 'theme.toggle', key: 'cmd.switchTheme' },
  { id: 'language.change', key: 'cmd.switchLanguage' },
  { id: 'about', key: 'cmd.about' }
];

function openPalette(mode, seed = '') {
  palette.open = true;
  palette.mode = mode;
  palette.index = 0;
  dom.overlay.hidden = false;
  dom.paletteInput.value = seed;
  dom.paletteInput.placeholder = mode === 'files' ? t('palette.files') : t('palette.commands');
  if (mode === 'files') {
    void explorer.files().then((files) => {
      palette.files = files;
      renderPalette();
    });
  }
  renderPalette();
  dom.paletteInput.focus();
  dom.paletteInput.select();
}

function closePalette() {
  palette.open = false;
  dom.overlay.hidden = true;
}

function renderPalette() {
  const query = dom.paletteInput.value.trim();
  palette.items =
    palette.mode === 'files'
      ? rank(palette.files, query, 80)
      : COMMANDS.map((command) => ({ label: t(command.key), id: command.id, hint: command.hint }))
          .filter((command) => !query || command.label.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 80);
  dom.paletteList.replaceChildren();
  if (!palette.items.length) {
    dom.paletteList.append(el('div', { class: 'list__empty', text: t('palette.nothing') }));
    dom.paletteHint.textContent = '';
    return;
  }
  palette.index = Math.min(palette.index, palette.items.length - 1);
  palette.items.forEach((item, index) => {
    const label = typeof item === 'string' ? item : item.label;
    const hint = typeof item === 'string' ? '' : item.hint || '';
    dom.paletteList.append(
      el('div', { class: 'palette__item', 'aria-selected': String(index === palette.index) }, [
        el('span', { class: 'palette__label', text: label }),
        hint ? el('span', { class: 'palette__meta', text: hint }) : null
      ])
    );
  });
  dom.paletteHint.textContent =
    palette.mode === 'files' ? t('palette.openFile') : t('palette.run');
  const selected = dom.paletteList.children[palette.index];
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
}

function choosePalette() {
  const item = palette.items[palette.index];
  if (!item) return;
  closePalette();
  if (palette.mode === 'files') {
    void editor.open(String(item));
  } else {
    void runCommand(item.id);
  }
}

// --------------------------------------------------------------- commands

async function openFolder() {
  const folder = await api.dialogs.openFolder();
  if (folder) await api.workspace.open(folder);
}

async function restartAgent() {
  try {
    await api.agent.stop();
    await api.agent.start();
    toast('ok', 'the agent was restarted');
  } catch (error) {
    toast('error', error.message);
  }
}

function updateTitle() {
  const name = workspace ? workspace.name : t('status.noFolder');
  document.title = `${t('app.name')} — ${name}`;
  if (dom.brand) dom.brand.textContent = t('app.name');
}

/**
 * What fills the editor area when nothing is open.
 *
 * With no folder it offers the two things that make sense - open one, or pick up
 * a recent one - instead of leaving a blank rectangle, and it is why the app does
 * not open a folder on start any more: this screen is the alternative.
 */
function renderWelcome() {
  const host = document.getElementById('welcome');
  if (!host) return;
  host.replaceChildren();
  if (workspace) return;
  const recent = (settingsValue.recent || []).slice(0, 8);
  const list = el('div', { class: 'welcome__recent' });
  for (const entry of recent) {
    list.append(
      el('button', {
        class: 'btn',
        type: 'button',
        text: entry.name || entry.path,
        title: entry.path,
        onclick: () => void api.workspace.open(entry.path).catch((error) => toast('error', error.message))
      })
    );
  }
  host.append(
    el('h1', { text: t('welcome.title') }),
    el('div', { text: t('welcome.hint') }),
    el('div', { class: 'welcome__actions' }, [
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: t('welcome.open'),
        onclick: () => void openFolder()
      })
    ]),
    recent.length ? el('div', { class: 'welcome__keys', text: t('welcome.recent') }) : null,
    recent.length ? list : null,
    el('div', { class: 'welcome__keys', text: t('welcome.keys') })
  );
}

async function runCommand(name, argument) {
  switch (name) {
    case 'workspace.open':
      await openFolder();
      break;
    case 'workspace.openPath':
      if (argument) await api.workspace.open(argument);
      break;
    case 'workspace.close':
      await api.workspace.close();
      break;
    case 'file.open': {
      const files = await api.dialogs.openFile();
      for (const file of files) {
        if (workspace && file.startsWith(workspace.root)) {
          const relative = file.slice(workspace.root.length + 1).split('\\').join('/');
          await editor.open(relative);
        } else {
          toast('warn', t('toast.outsideFolder', { path: file }));
        }
      }
      break;
    }
    case 'file.save':
      if (editor.active) await editor.save(editor.active);
      break;
    case 'file.saveAll':
      await editor.saveAll();
      break;
    case 'file.close':
      if (editor.active) await editor.closeTab(editor.active);
      break;
    case 'editor.find':
      void editor.instance.getAction('actions.find')?.run();
      break;
    case 'search.open':
      selectActivity('search');
      break;
    case 'quickopen.open':
      openPalette('files');
      break;
    case 'palette.open':
      openPalette('commands');
      break;
    case 'view.explorer':
      selectActivity('explorer');
      break;
    case 'view.search':
      selectActivity('search');
      break;
    case 'view.git':
      selectActivity('git');
      break;
    case 'view.terminal':
      togglePanel(true);
      break;
    case 'layout.sidebar':
      toggleSidebar();
      break;
    case 'layout.panel':
      togglePanel();
      break;
    case 'layout.chat':
      toggleChat();
      break;
    case 'chat.new':
      await chat.reset();
      break;
    case 'chat.cancel':
      await chat.cancel();
      break;
    case 'chat.focus':
      toggleChat(true);
      chat.focus();
      break;
    case 'chat.settings':
      toggleChat(true);
      chat.toggleSettings(true);
      break;
    case 'chat.restart':
      await restartAgent();
      break;
    case 'git.refresh':
      await refreshGit({ mount: true });
      break;
    case 'theme.toggle': {
      const next = dom.root.dataset.theme === 'dark' ? 'light' : 'dark';
      settingsValue.appearance.theme = next;
      persist({ appearance: { theme: next } });
      applyAppearance();
      break;
    }
    case 'language.change': {
      // Cycles the window language: the system's own, then each dictionary that
      // ships with the app. The setting is the same one the settings form shows.
      const order = ['system', ...i18nInfo().available];
      const index = order.indexOf(settingsValue.appearance.language);
      const next = order[(index + 1) % order.length];
      settingsValue.appearance.language = next;
      persist({ appearance: { language: next } });
      toast('info', t('toast.language', { language: next === 'system' ? t('settings.languageSystem') : next.toUpperCase() }));
      break;
    }
    case 'about':
      toast('info', t('app.about', { state: state_agentSummary() }), { timeout: 9000 });
      break;
    default:
      break;
  }
}

function state_agentSummary() {
  const agentState = chat && chat.state.agent ? chat.state.agent : { state: 'unknown', detail: '' };
  return `${agentState.state}${agentState.detail ? ` (${agentState.detail})` : ''}`;
}

// ------------------------------------------------------------- resizers

/**
 * Drag a split boundary.
 *
 * The width is written to the CSS variable while dragging, which is one style
 * recalculation per move instead of a layout pass per event, and the settings
 * file is written once when the drag ends rather than on every pixel.
 */
function wireResizer(handle, { axis, target, variable, min, max, patchKey }) {
  if (!handle) return;
  let dragging = false;
  let start = 0;
  let origin = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    start = axis === 'x' ? event.clientX : event.clientY;
    origin = axis === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
    handle.dataset.active = 'true';
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = (axis === 'x' ? event.clientX : event.clientY) - start;
    const next = Math.min(max, Math.max(min, Math.round(origin + delta)));
    dom.root.style.setProperty(variable, `${next}px`);
  });
  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    handle.dataset.active = 'false';
    const rect = target.getBoundingClientRect();
    const measured = axis === 'x' ? rect.width : rect.height;
    const next = Math.min(max, Math.max(min, Math.round(measured)));
    settingsValue.layout[patchKey] = next;
    persist({ layout: { [patchKey]: next } });
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

function wireLayout() {
  wireResizer(document.getElementById('sidebar-resizer'), {
    axis: 'x',
    target: dom.sidebar,
    variable: '--sidebar-width',
    min: 140,
    max: 900,
    patchKey: 'sidebarWidth'
  });
  wireResizer(document.getElementById('chat-resizer'), {
    axis: 'x',
    target: dom.chat,
    variable: '--chat-width',
    min: 260,
    max: 1400,
    patchKey: 'chatWidth'
  });
  wireResizer(document.getElementById('panel-resizer'), {
    axis: 'y',
    target: dom.panel,
    variable: '--panel-height',
    min: 60,
    max: 900,
    patchKey: 'panelHeight'
  });
}

// ------------------------------------------------------------------ keys

function wireKeys() {
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      if (palette.open) {
        closePalette();
        event.preventDefault();
      }
      return;
    }
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault();
      openPalette('files');
    } else if (key === 'p' && event.shiftKey) {
      event.preventDefault();
      openPalette('commands');
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault();
      void editor.saveAll();
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault();
      selectActivity('search');
    } else if (key === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (key === 'j') {
      event.preventDefault();
      togglePanel();
    } else if (key === 'a' && event.shiftKey) {
      event.preventDefault();
      toggleChat();
    } else if (event.key === '`') {
      event.preventDefault();
      togglePanel();
    }
  });

  dom.overlay.addEventListener('mousedown', (event) => {
    if (event.target === dom.overlay) closePalette();
  });
  dom.paletteInput.addEventListener('input', () => {
    palette.index = 0;
    renderPalette();
  });
  dom.paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      palette.index = Math.min(palette.items.length - 1, palette.index + 1);
      renderPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      palette.index = Math.max(0, palette.index - 1);
      renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choosePalette();
    }
  });
}

// ---------------------------------------------------------------- events

function wireEvents() {
  api.on(CH.command, (payload) => {
    if (payload && payload.name) void runCommand(payload.name, payload.argument);
  });

  api.on(CH.settingsChanged, (value) => {
    const languageChanged = value.appearance.language !== settingsValue.appearance.language;
    settingsValue = value;
    applyAppearance();
    if (!languageChanged) return;
    // A language change redraws everything the window built itself: the static
    // markup is handled by `initI18n`, and these are the parts that were already
    // drawn from the previous dictionary.
    void api.app
      .i18n()
      .then((payload) => {
        initI18n(payload);
        renderActivity();
        renderStatusbar();
        renderWelcome();
        updateTitle();
        chat.reload();
      })
      .catch(() => {});
  });

  api.on(CH.workspaceChanged, (value) => {
    workspace = value;
    updateTitle();
    renderStatusbar();
    editor.closeAll();
    if (!workspace) {
      toast('info', t('toast.folderClosed'));
      renderWelcome();
      chat.reload();
      return;
    }
    void (async () => {
      await mountActivity();
      await refreshGit({ mount: true });
      await editor.restore(settingsValue.session);
      // The core is per folder, so the transcript now belongs to a different
      // conversation; redrawing it is what keeps the panel honest.
      await chat.reload();
      renderWelcome();
      persistSession();
    })();
  });

  api.on(CH.searchBatch, (payload) => bus.emit('search:batch', payload));
  api.on(CH.searchDone, (payload) => bus.emit('search:done', payload));
  api.on(CH.terminalData, (payload) => bus.emit('terminal:data', payload));
  api.on(CH.terminalExit, (payload) => bus.emit('terminal:exit', payload));
  api.on(CH.agentEvent, (payload) => bus.emit('agent:event', payload));
  api.on(CH.agentStatus, (payload) => {
    bus.emit('agent:status-changed', payload);
    if (statusNodes.agent && payload) {
      statusNodes.agent.textContent = `agent: ${payload.state}`;
      statusNodes.agent.title = payload.detail || '';
    }
  });
  api.on(CH.windowState, () => {
    // The window chrome is drawn by the main process; nothing to reflect here
    // yet, but the subscription keeps the contract explicit.
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  settingsValue = await api.settings.get();
  // The dictionary arrives before anything is drawn, so the first paint is
  // already in the user's language instead of flashing English.
  initI18n(await api.app.i18n().catch(() => null));
  if (settingsValue.layout.activity) currentActivity = settingsValue.layout.activity;
  applyAppearance();

  editor = await createEditor({
    api,
    settings,
    onDirtyChange: () => persistSession(),
    onActiveChange: () => {
      updateCursor();
      chat?.renderContext();
      persistSession();
    },
    onNotice: (message, kind) => toast(kind || 'info', message)
  });

  explorer = createExplorer({
    api,
    activePath: '',
    onOpen: (path, options) => void editor.open(path, options),
    onNotice: (message) => toast('info', message)
  });
  search = createSearchPanel({
    api,
    bus,
    onOpen: (path, options) => void editor.open(path, options),
    onNotice: (message, kind) => toast(kind || 'info', message)
  });
  git = createGitPanel({
    api,
    onOpenDiff: (path, options) => void editor.openDiff(path, options),
    onNotice: (message, kind) => toast(kind || 'info', message)
  });
  terminal = createTerminalPanel({
    api,
    bus,
    settings,
    onNotice: (message, kind) => toast(kind || 'info', message)
  });
  chat = createChat({
    api,
    bus,
    settings,
    editor,
    onNotice: (message, kind) => toast(kind || 'info', message)
  });

  wireLayout();
  wireKeys();
  wireEvents();
  renderActivity();
  renderStatusbar();
  await chat.mount();

  // A restored layout can leave the panel visible with nothing in it, because
  // the panel is mounted when it is opened and not when it is merely shown. The
  // terminal is what belongs there, so it is created on start when the panel
  // was left open.
  if (settingsValue.layout.panelVisible) terminal.mount();

  workspace = await api.workspace.current();
  updateTitle();
  renderStatusbar();
  renderWelcome();
  if (workspace) {
    await mountActivity();
    await refreshGit({ mount: true });
    await editor.restore(settingsValue.session);
    chat.renderContext();
  } else if (currentActivity === 'explorer') {
    // The explorer draws its own explanation, in the current language.
    await mountActivity();
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settingsValue.appearance.theme === 'system') applyAppearance();
  });
}

boot().catch((error) => {
  // A window that fails to boot must say why, in the window, because the
  // developer console is not where a user looks.
  document.body.append(
    el('div', { class: 'list__empty', text: t('app.bootFailed', { message: error.message }) })
  );
  console.error(error);
});