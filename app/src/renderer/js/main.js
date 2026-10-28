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
import { createAppSettings } from './app-settings.js';
import { rank } from './fuzzy.js';
import { nextSize } from './split.js';
import { commandFor } from './run.js';
import { agentStateKey, current as i18nInfo, initI18n, t } from './i18n.js';

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
let appSettings = null;
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

/**
 * Re-read what a change on disk could have affected.
 *
 * Debounced, because a build or a checkout produces hundreds of events in a
 * second and each redraw re-reads the visible part of the tree. The git panel is
 * refreshed only while it is the panel on screen: `git status` is a process, and
 * running one for a background tab is work nobody asked for.
 */
const refreshAfterDiskChange = debounce(() => {
  if (!workspace) return;
  void Promise.resolve(explorer?.refresh({ force: true })).catch(() => {});
  if (currentActivity === 'git' && git) void git.refresh().catch(() => {});
}, 250);

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
  workspaceFilesChanged: 'workspace:files-changed',
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

/**
 * Draw the sidebar view that is currently selected.
 *
 * Draws are queued rather than run as they are asked for. A view clears the
 * sidebar and then rebuilds it, both after an await, so two overlapping draws
 * can interleave: a draw started during boot once landed after the draw a click
 * had started, and the sidebar ended up showing the explorer's message with the
 * search panel's contents appended to it. One chain means the draw that was
 * asked for last is the one that finishes last.
 */
let activityDraw = Promise.resolve();

function mountActivity() {
  const next = activityDraw.then(() => drawActivity(), () => drawActivity());
  // The queue must not carry a rejection forward into every later draw.
  activityDraw = next.catch(() => {});
  return next;
}

async function drawActivity() {
  // Each view decides what to show with no folder open, and each of them says
  // something useful: the search and repository views explain that they work
  // inside a folder and offer to open one. Falling back to the explorer here
  // instead - which is what this used to do - left the file tree on screen when
  // the user pressed Search or Source control, so both buttons looked dead.
  if (currentActivity === 'search') {
    await search.mount();
    return;
  }
  if (currentActivity === 'git') {
    git.mount();
    return;
  }
  // Forced: switching to the explorer is a request to see the folder as it is
  // now, and the files that appeared since the last look were written by the
  // agent, by a command in the terminal, or by something outside this window.
  await explorer.refresh({ force: true });
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

/**
 * Open the folder in a shell, in the panel below.
 *
 * A folder is opened in order to work in it, and the next thing most people do
 * is run something in it - so the shell is already there and already in the
 * right directory instead of having to be found and pointed at it. The setting
 * turns it off for anyone who wants the panel to stay as it was, and the session
 * from the previous folder is closed rather than left pointing somewhere else.
 */
async function openFolderInTerminal(folder) {
  if (!folder || !terminal || !settingsValue.terminal.openWithFolder) return;
  if (!settingsValue.layout.panelVisible) {
    settingsValue.layout.panelVisible = true;
    persist({ layout: { panelVisible: true } });
    applyAppearance();
  }
  terminal.mount();
  const session = await terminal.openInFolder();
  if (session) toast('info', t('toast.terminalOpened', { folder: folder.name || folder.root }));
}

// -------------------------------------------------------------------- run

/**
 * The command the Play button would send, or null when there is nothing to run.
 *
 * Kept as one function because three things ask the same question: the button
 * (does it draw at all, and what does its tooltip say), the command palette, and
 * the menu item that arrives from the main process.
 */
function runPlan() {
  const file = editor?.active || '';
  if (!file) return null;
  return commandFor(file, {
    shell: settingsValue.terminal.shell,
    root: workspace ? workspace.root : ''
  });
}

/** Draw the run button: present only when there is a file it could run. */
function renderEditorActions() {
  const host = document.getElementById('editor-actions');
  if (!host) return;
  host.replaceChildren();
  const plan = runPlan();
  if (!plan) return;
  host.append(
    el('button', {
      class: 'iconbtn runbtn',
      type: 'button',
      title: t('run.button', { command: plan.command }),
      'aria-label': t('run.button', { command: plan.command }),
      html: icon('play'),
      onclick: () => void runActiveFile()
    })
  );
}

/**
 * Run the file in the editor, in the shell below.
 *
 * The file is saved first: running a stale copy of what is on screen is the kind
 * of surprise that costs an hour, and the editor knows whether there is anything
 * to save. The panel is opened before the command is sent, because the output has
 * to appear somewhere, and a long-running program keeps the shell after the
 * window stops watching it - the session is the user's, not the button's.
 */
async function runActiveFile() {
  const file = editor?.active;
  if (!file) {
    toast('info', t('run.noFile'));
    return;
  }
  const plan = runPlan();
  if (!plan) {
    toast('info', t('run.unsupported', { path: file }));
    return;
  }
  await editor.save(file, { quiet: true });
  togglePanel(true);
  terminal.mount();
  try {
    await terminal.run(plan.command);
    toast('info', t('run.started', { command: plan.command }));
  } catch (error) {
    toast('error', error.message);
  }
}

// -------------------------------------------------------------- statusbar

const gitInfo = { branch: '', ahead: 0, behind: 0, repo: false };
let cursorInfo = { line: 0, column: 0, language: '', lines: 0 };

function statusItem(text, options = {}) {
  const node = el('button', {
    class: 'statusbar__item',
    type: 'button',
    title: options.title || '',
    dataset: { clickable: String(Boolean(options.onclick)), role: options.role || '' },
    onclick: options.onclick
  });
  /**
   * An icon is markup from this file's own set, and a label is text.
   *
   * The split matters: a title from a dictionary must never be able to become
   * markup, so only `icon(name)` is allowed to write into the element, and
   * everything else goes in as text.
   */
  if (options.icon) {
    node.innerHTML = icon(options.icon);
    node.setAttribute('aria-label', options.title || '');
  } else {
    node.textContent = text;
  }
  return node;
}

let statusNodes = {};
/** The last profile the assistant reported, so a redrawn status bar keeps it. */
let modelProfile = null;

function renderStatusbar() {
  dom.statusbar.replaceChildren();
  const name = workspace ? workspace.name : t('status.noFolder');
  const branchText = gitInfo.repo
    ? `${gitInfo.branch || 'detached'}${gitInfo.ahead ? ` ↑${gitInfo.ahead}` : ''}${gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}`
    : t('status.noRepo');

  statusNodes = {
    theme: statusItem('', {
      title: t('status.themeTitle', { current: '', next: '' }),
      role: 'theme',
      onclick: () => void cycleTheme()
    }),
    /**
     * The settings, as a button.
     *
     * They were reachable from the File menu, from the command palette and from
     * `Ctrl+,` - three ways, none of them visible. A window whose settings have
     * no button is a window whose settings most people never find.
     */
    settings: statusItem('', {
      title: t('status.settingsTitle'),
      role: 'settings',
      icon: 'settings',
      onclick: () => appSettings?.toggle(true)
    }),
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
      role: 'model',
      onclick: () => chat.toggleSettings(true)
    }),
    cursor: statusItem('', { title: t('status.cursor', { line: '—', column: '—' }) })
  };

  dom.statusbar.append(
    statusNodes.theme,
    statusNodes.settings,
    statusNodes.folder,
    statusNodes.branch,
    el('span', { class: 'statusbar__spacer' }),
    statusNodes.agent,
    statusNodes.model,
    statusNodes.cursor
  );
  updateCursor();
  renderThemeStatus();
  // The bar is rebuilt from scratch on a workspace change, so the model and the
  // agent state are put back from what was last reported rather than reset.
  renderModelStatus(modelProfile);
}

/**
 * The theme, at the left end of the status bar.
 *
 * One button with a three-state cycle, because a theme has three choices and a
 * button has to be able to reach all of them: dark, light, and the system's own.
 * The command palette runs the same cycle, so the two cannot disagree about what
 * the current theme is. The title names what the next click will do, which is
 * the only thing a button that changes something cannot show by itself.
 */
const THEME_ORDER = ['dark', 'light', 'system'];

function themeName(choice) {
  if (choice === 'light') return t('theme.light');
  if (choice === 'system') return t('theme.system');
  return t('theme.dark');
}

function nextTheme(choice) {
  const index = THEME_ORDER.indexOf(choice);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

function renderThemeStatus() {
  if (!statusNodes.theme) return;
  const choice = settingsValue.appearance.theme;
  statusNodes.theme.textContent = t('status.theme', { theme: themeName(choice) });
  statusNodes.theme.title = t('status.themeTitle', {
    current: themeName(choice),
    next: themeName(nextTheme(choice))
  });
  statusNodes.theme.dataset.choice = choice;
}

function cycleTheme() {
  const next = nextTheme(settingsValue.appearance.theme);
  settingsValue.appearance.theme = next;
  persist({ appearance: { theme: next } });
  applyAppearance();
  renderThemeStatus();
}

function updateCursor() {
  if (!editor || !statusNodes.cursor) return;
  cursorInfo = editor.positions();
  const language = cursorInfo.language || t('status.plain');
  const position = t('status.cursor', { line: cursorInfo.line, column: cursorInfo.column });
  const lines = cursorInfo.lines ? ` · ${t('status.lines', { count: cursorInfo.lines })}` : '';
  statusNodes.cursor.textContent = `${language} · ${position}${lines}`;
}

/**
 * What the model item in the status bar says.
 *
 * It was drawn once with the words "no model chosen" and never touched again, so
 * it said that after a model had been saved, after the assistant had answered
 * with it, and while the same window showed the model in the settings form. The
 * plugin is told by the assistant panel, which is what talks to the core.
 */
function renderModelStatus(profile) {
  modelProfile = profile && statusNodes.model ? profile : modelProfile;
  if (!statusNodes.model) return;
  const model = profile && profile.model ? String(profile.model) : '';
  statusNodes.model.textContent = model ? t('status.model', { model }) : t('status.noModel');
  statusNodes.model.title = model ? `${t('cmd.agentSettings')}\n${model}` : t('cmd.agentSettings');
  statusNodes.model.dataset.missing = String(!model);
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
  { id: 'file.saveAll', key: 'cmd.saveAll', hint: 'Ctrl+K S' },
  { id: 'file.run', key: 'cmd.runFile', hint: 'F5' },
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
  { id: 'settings.open', key: 'cmd.appSettings', hint: 'Ctrl+,' },
  { id: 'update.check', key: 'cmd.checkUpdates' },
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
  try {
    const folder = await api.dialogs.openFolder();
    if (!folder) return;
    await api.workspace.open(folder);
  } catch (error) {
    // A folder that cannot be opened has to say so: this call used to swallow
    // the refusal, so choosing a folder that the path guard rejected looked
    // exactly like the button doing nothing.
    toast('error', error.message);
  }
}

async function restartAgent() {
  try {
    await api.agent.stop();
    await api.agent.start();
    toast('ok', t('toast.agentRestarted'));
  } catch (error) {
    toast('error', error.message);
  }
}

function updateTitle() {
  const name = workspace ? workspace.name : t('status.noFolder');
  document.title = `${t('app.name')} — ${name}`;
  if (dom.brand) dom.brand.textContent = t('app.name');
  renderFolderButton();
}

/**
 * The folder button in the title bar: which folder is open, and the way to
 * change it.
 */
function renderFolderButton() {
  const button = document.getElementById('titlebar-folder');
  if (!button) return;
  const open = Boolean(workspace);
  button.textContent = open ? workspace.name : t('welcome.open');
  button.title = open ? `${workspace.root}\n${t('cmd.openFolder')}` : t('welcome.open');
  button.dataset.empty = String(!open);
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
    case 'file.run':
      // The menu, the palette and the button all arrive here: one place decides
      // what running a file means, including what it says when it cannot.
      await runActiveFile();
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
    case 'settings.open':
      appSettings?.toggle(true);
      break;
    case 'update.check':
      // The menu item and the palette entry both land here: one place decides
      // what "check for updates" does, including what it says when it finds
      // nothing.
      await appSettings?.checkUpdates({ force: true });
      break;
    case 'theme.toggle': {
      cycleTheme();
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
 *
 * `invert` is for a boundary that is anchored on the far side of its panel: the
 * chat sits against the right edge and the panel against the bottom, so moving
 * their handles towards the middle of the window *grows* them while the raw
 * pointer delta is negative. Adding the delta there shrank the panel the user
 * was trying to enlarge, which is the one thing a resizer must never do.
 */
function wireResizer(handle, { axis, target, variable, min, max, patchKey, invert = false }) {
  if (!handle) return;
  let dragging = false;
  let start = 0;
  let origin = 0;
  const size = (delta, measured) =>
    nextSize({ origin: measured, delta, invert, min, max });

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    start = axis === 'x' ? event.clientX : event.clientY;
    origin = axis === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
    handle.dataset.active = 'true';
    // Capture is what keeps the drag alive while the pointer is away from the
    // two-pixel handle, but it can refuse - and a refusal must not stop a drag
    // the user has already started.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the boundary still follows the pointer while it is over
      // the handle, which is better than not following it at all.
    }
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = (axis === 'x' ? event.clientX : event.clientY) - start;
    const next = size(delta, origin);
    dom.root.style.setProperty(variable, `${next}px`);
  });
  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    handle.dataset.active = 'false';
    const rect = target.getBoundingClientRect();
    const measured = axis === 'x' ? rect.width : rect.height;
    const next = size(0, measured);
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
    patchKey: 'chatWidth',
    invert: true
  });
  wireResizer(document.getElementById('panel-resizer'), {
    axis: 'y',
    target: dom.panel,
    variable: '--panel-height',
    min: 60,
    max: 900,
    patchKey: 'panelHeight',
    invert: true
  });

  // The folder button in the title bar: open a folder, or switch to another.
  document.getElementById('titlebar-folder')?.addEventListener('click', () => void openFolder());
}

// ------------------------------------------------------------------ keys

function wireKeys() {
  /**
   * Two-key chords, the way VS Code has them.
   *
   * Electron cannot express these as a menu accelerator - given
   * `CmdOrCtrl+K CmdOrCtrl+O` it logs "Invalid accelerator token: K CmdOrCtrl"
   * and the menu item quietly has no shortcut at all, so the shortcut the
   * palette advertises did nothing. The window implements the chord itself: the
   * first key arms it, a second key within two seconds completes it.
   */
  let chordArmed = false;
  let chordTimer = 0;
  const clearChord = () => {
    chordArmed = false;
    clearTimeout(chordTimer);
  };

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      clearChord();
      if (palette.open) {
        closePalette();
        event.preventDefault();
      }
      return;
    }
    if (!mod) {
      clearChord();
      return;
    }
    const key = event.key.toLowerCase();
    if (chordArmed) {
      clearChord();
      event.preventDefault();
      if (key === 'o') void openFolder();
      else if (key === 's') void editor.saveAll();
      return;
    }
    if (key === 'k' && !event.shiftKey) {
      chordArmed = true;
      chordTimer = setTimeout(clearChord, 2000);
      event.preventDefault();
      return;
    }
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
    } else if (event.key === ',') {
      // The shortcut every editor uses for its settings, and the one the menu
      // advertises for this dialog.
      event.preventDefault();
      appSettings?.toggle(true);
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
    // The settings dialog draws from the file, so it follows a change made
    // anywhere - including a control in the assistant's own sheet.
    appSettings?.refresh();
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
    renderEditorActions();
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
      await openFolderInTerminal(workspace);
      persistSession();
    })();
  });

  api.on(CH.searchBatch, (payload) => bus.emit('search:batch', payload));
  api.on(CH.searchDone, (payload) => bus.emit('search:done', payload));
  api.on(CH.terminalData, (payload) => bus.emit('terminal:data', payload));
  api.on(CH.terminalExit, (payload) => bus.emit('terminal:exit', payload));
  /**
   * Something inside the folder changed on disk.
   *
   * The main process watches the folder, because the window has no filesystem
   * and because a build, a `git checkout` or the agent writing through the core
   * all happen outside this process. The tree is re-read, and a problem with the
   * watch itself is said out loud once rather than leaving a tree that quietly
   * stops updating.
   */
  api.on(CH.workspaceFilesChanged, (payload) => {
    const changed = payload || {};
    if (changed.problem) {
      toast('warn', changed.problem);
      return;
    }
    void refreshAfterDiskChange();
  });
  api.on(CH.agentEvent, (payload) => {
    bus.emit('agent:event', payload);
    // A finished turn is when the agent may have written files, and none of
    // those writes pass through the explorer's own bookkeeping, so its cache is
    // dropped and the next look at the tree re-reads it.
    if (payload && payload.name === 'turn_end') explorer?.invalidate();
  });
  api.on(CH.agentStatus, (payload) => {
    bus.emit('agent:status-changed', payload);
    if (statusNodes.agent && payload) {
      // The state arrives in English from the main process; the status bar has
      // to say it in the window's language, the same way the assistant's own
      // header does, or the two disagree about the same agent.
      statusNodes.agent.textContent = t('status.agent', { state: t(`agent.${agentStateKey(payload.state)}`) });
      statusNodes.agent.title = payload.detail || t('status.agentTitle');
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
      // The button belongs to the file that is open, so it is drawn with it.
      renderEditorActions();
      persistSession();
    },
    onNotice: (message, kind) => toast(kind || 'info', message)
  });

  explorer = createExplorer({
    api,
    activePath: '',
    onOpen: (path, options) => void editor.open(path, options),
    onNotice: (message) => toast('info', message),
    // The tree is where a file is found, so it is also where one is put into the
    // next message: the composer's own row only ever saw the editor's active tab,
    // which is why a file could appear in the context with no way to take it out.
    onToggleContext: (path) => {
      chat?.toggleContextFile(path);
      const attached = Boolean(chat && chat.hasContextFile(path));
      toast('info', t(attached ? 'toast.contextAdded' : 'toast.contextRemoved', { path }));
    },
    isContextFile: (path) => Boolean(chat && chat.hasContextFile(path))
  });
  search = createSearchPanel({
    api,
    bus,
    onOpen: (path, options) => void editor.open(path, options),
    onNotice: (message, kind) => toast(kind || 'info', message),
    onOpenFolder: () => void openFolder()
  });
  git = createGitPanel({
    api,
    onOpenDiff: (path, options) => void editor.openDiff(path, options),
    onOpenCommit: (commit) => void editor.openCommit(commit),
    onNotice: (message, kind) => toast(kind || 'info', message),
    onOpenFolder: () => void openFolder()
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
    onNotice: (message, kind) => toast(kind || 'info', message),
    onProfile: (profile) => renderModelStatus(profile)
  });
  appSettings = createAppSettings({
    api,
    settings,
    onNotice: (message, kind) => toast(kind || 'info', message)
  });
  appSettings.mount();

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
    await openFolderInTerminal(workspace);
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