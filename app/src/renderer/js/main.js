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
  if (!workspace) {
    document.getElementById('sidebar-title').textContent = 'Explorer';
    return;
  }
  if (currentActivity === 'search') search.mount();
  else if (currentActivity === 'git') git.mount();
  else await explorer.refresh();
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
  const name = workspace ? workspace.name : 'no folder open';
  const branchText = gitInfo.repo
    ? `${gitInfo.branch || 'detached'}${gitInfo.ahead ? ` ↑${gitInfo.ahead}` : ''}${gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}`
    : 'no repository';

  statusNodes = {
    folder: statusItem(name, { title: workspace ? workspace.root : 'Open a folder', onclick: () => void openFolder() }),
    branch: statusItem(branchText, {
      title: 'Source control',
      onclick: () => selectActivity('git')
    }),
    agent: statusItem('agent: —', { title: 'Restart the agent', onclick: () => void restartAgent() }),
    model: statusItem('no model', { title: 'Agent settings', onclick: () => chat.toggleSettings(true) }),
    cursor: statusItem('', { title: 'Cursor position' })
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
  statusNodes.cursor.textContent = `${cursorInfo.language || 'plain'} · Ln ${cursorInfo.line}, Col ${cursorInfo.column}${
    cursorInfo.lines ? ` · ${cursorInfo.lines} lines` : ''
  }`;
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
  { id: 'workspace.open', label: 'Open folder…', hint: 'Ctrl+K Ctrl+O' },
  { id: 'workspace.close', label: 'Close folder' },
  { id: 'file.open', label: 'Open file…', hint: 'Ctrl+O' },
  { id: 'file.save', label: 'Save file', hint: 'Ctrl+S' },
  { id: 'file.saveAll', label: 'Save all files' },
  { id: 'file.close', label: 'Close editor', hint: 'Ctrl+W' },
  { id: 'editor.find', label: 'Find in file', hint: 'Ctrl+F' },
  { id: 'search.open', label: 'Find in files', hint: 'Ctrl+Shift+F' },
  { id: 'quickopen.open', label: 'Go to file…', hint: 'Ctrl+P' },
  { id: 'view.explorer', label: 'View: Explorer' },
  { id: 'view.search', label: 'View: Search' },
  { id: 'view.git', label: 'View: Source control' },
  { id: 'view.terminal', label: 'View: Terminal' },
  { id: 'layout.sidebar', label: 'Toggle sidebar', hint: 'Ctrl+B' },
  { id: 'layout.panel', label: 'Toggle panel', hint: 'Ctrl+J' },
  { id: 'layout.chat', label: 'Toggle assistant', hint: 'Ctrl+Shift+A' },
  { id: 'chat.new', label: 'Assistant: new conversation' },
  { id: 'chat.cancel', label: 'Assistant: cancel turn' },
  { id: 'chat.focus', label: 'Assistant: focus composer', hint: 'Ctrl+L' },
  { id: 'chat.settings', label: 'Assistant: endpoint settings' },
  { id: 'chat.restart', label: 'Assistant: restart the agent' },
  { id: 'git.refresh', label: 'Source control: refresh' },
  { id: 'theme.toggle', label: 'Appearance: switch dark and light' },
  { id: 'about', label: 'About LexiQode' }
];

function openPalette(mode, seed = '') {
  palette.open = true;
  palette.mode = mode;
  palette.index = 0;
  dom.overlay.hidden = false;
  dom.paletteInput.value = seed;
  dom.paletteInput.placeholder = mode === 'files' ? 'file name' : 'command name';
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
      : COMMANDS.map((command) => ({ label: command.label, id: command.id, hint: command.hint }))
          .filter((command) => !query || command.label.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 80);
  dom.paletteList.replaceChildren();
  if (!palette.items.length) {
    dom.paletteList.append(el('div', { class: 'list__empty', text: 'Nothing matches.' }));
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
    palette.mode === 'files' ? 'Enter opens · Esc closes' : 'Enter runs · Esc closes';
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
  const name = workspace ? workspace.name : 'no folder';
  document.title = `LexiQode — ${name}`;
  if (dom.brand) dom.brand.textContent = 'LexiQode';
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
          toast('warn', `${file} is outside the open folder; open its folder first`);
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
    case 'about':
      toast('info', `LexiQode · agent ${state_agentSummary()}`, { timeout: 9000 });
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
    settingsValue = value;
    applyAppearance();
  });

  api.on(CH.workspaceChanged, (value) => {
    workspace = value;
    updateTitle();
    renderStatusbar();
    editor.closeAll();
    if (!workspace) {
      toast('info', 'the folder was closed');
      return;
    }
    void (async () => {
      await mountActivity();
      await refreshGit({ mount: true });
      await editor.restore(settingsValue.session);
      chat.renderContext();
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
  if (workspace) {
    await mountActivity();
    await refreshGit({ mount: true });
    await editor.restore(settingsValue.session);
    chat.renderContext();
  } else if (currentActivity === 'explorer') {
    document.getElementById('sidebar-title').textContent = 'Explorer';
    document.getElementById('sidebar-body').replaceChildren(
      el('div', { class: 'list__empty', text: 'No folder is open. Press Ctrl+K Ctrl+O to open one.' })
    );
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settingsValue.appearance.theme === 'system') applyAppearance();
  });
}

boot().catch((error) => {
  // A window that fails to boot must say why, in the window, because the
  // developer console is not where a user looks.
  document.body.append(
    el('div', { class: 'list__empty', text: `LexiQode could not start: ${error.message}` })
  );
  console.error(error);
});