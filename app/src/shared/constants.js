'use strict';

/**
 * Values both processes have to agree on.
 *
 * Kept together because a mismatch here is invisible until something silently
 * does nothing: the renderer asking for a channel the main process never
 * registered, or reading a settings key the writer spelled differently.
 */

const PRODUCT = 'LexiQode';

/** IPC channels, grouped so the preload surface reads like the API it exposes. */
const CHANNELS = {
  window: {
    minimise: 'window:minimise',
    maximise: 'window:maximise',
    close: 'window:close',
    state: 'window:state'
  },
  dialogs: {
    openFolder: 'dialogs:open-folder',
    openFile: 'dialogs:open-file',
    saveAs: 'dialogs:save-as',
    confirm: 'dialogs:confirm'
  },
  workspace: {
    current: 'workspace:current',
    recent: 'workspace:recent',
    open: 'workspace:open',
    close: 'workspace:close',
    tree: 'workspace:tree',
    readFile: 'workspace:read-file',
    writeFile: 'workspace:write-file',
    createFile: 'workspace:create-file',
    createFolder: 'workspace:create-folder',
    rename: 'workspace:rename',
    remove: 'workspace:remove',
    reveal: 'workspace:reveal',
    index: 'workspace:index',
    changed: 'workspace:changed'
  },
  search: {
    start: 'search:start',
    cancel: 'search:cancel',
    batch: 'search:batch',
    done: 'search:done'
  },
  git: {
    status: 'git:status',
    stage: 'git:stage',
    unstage: 'git:unstage',
    commit: 'git:commit',
    discard: 'git:discard',
    diff: 'git:diff',
    log: 'git:log',
    branches: 'git:branches',
    checkout: 'git:checkout',
    changed: 'git:changed'
  },
  terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    submit: 'terminal:submit',
    resize: 'terminal:resize',
    kill: 'terminal:kill',
    list: 'terminal:list',
    data: 'terminal:data',
    exit: 'terminal:exit'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    changed: 'settings:changed'
  },
  agent: {
    status: 'agent:status',
    start: 'agent:start',
    stop: 'agent:stop',
    state: 'agent:state',
    history: 'agent:history',
    send: 'agent:send',
    cancel: 'agent:cancel',
    reset: 'agent:reset',
    approval: 'agent:approval',
    models: 'agent:models',
    saveProfile: 'agent:save-profile',
    complete: 'agent:complete',
    event: 'agent:event',
    statusChanged: 'agent:status-changed'
  },
  shell: {
    openExternal: 'shell:open-external',
    showItem: 'shell:show-item'
  },
  /** Main-process to renderer: menu items and keyboard accelerators arrive here. */
  app: { command: 'app:command' }
};

/** Agent modes before the core has answered. The core is the authority. */
const FALLBACK_MODES = [
  { id: 'agent', label: 'Agent', hint: 'Do the work: read, edit and run what the task needs.' },
  { id: 'ask', label: 'Ask', hint: 'Answer from what is already known. No edits, no commands.' },
  { id: 'plan', label: 'Plan', hint: 'Read and propose a plan. Nothing is changed.' },
  { id: 'debug', label: 'Debug', hint: 'Find the cause, then fix it and prove the fix.' },
  { id: 'review', label: 'Review', hint: 'Read the change and report problems. No edits.' }
];

/** Every setting the app has, with the value used when the file says nothing. */
const DEFAULTS = {
  version: 1,
  appearance: {
    theme: 'system',
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'off',
    minimap: true,
    lineNumbers: 'on',
    renderWhitespace: 'selection',
    breadcrumbs: true
  },
  editor: {
    autoSave: 'off',
    autoSaveDelay: 1000,
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    formatOnSave: false
  },
  layout: {
    sidebarWidth: 260,
    panelHeight: 220,
    sidebarVisible: true,
    panelVisible: false,
    chatWidth: 420,
    chatVisible: true,
    activity: 'explorer',
    panel: 'terminal'
  },
  files: {
    exclude: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/__pycache__/**',
      '**/.venv/**'
    ],
    maxSearchResults: 2000,
    maxFileSizeKb: 2048
  },
  terminal: { shell: '', fontSize: 13 },
  agent: {
    autoStart: true,
    defaultMode: 'agent',
    includeActiveFile: true,
    includeSelection: true
  },
  recent: [],
  session: { folder: '', tabs: [], active: '' }
};

module.exports = { PRODUCT, CHANNELS, FALLBACK_MODES, DEFAULTS };