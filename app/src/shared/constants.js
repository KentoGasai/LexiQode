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
    changed: 'workspace:changed',
    /**
     * Something inside the open folder changed on disk. Distinct from
     * `changed`, which means the *folder* changed and makes the window close its
     * editors: a file written by a build, a `git checkout` or the agent must
     * update the tree without throwing away what the user has open.
     */
    filesChanged: 'workspace:files-changed'
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
    show: 'git:show',
    commitView: 'git:commit-view',
    commitFile: 'git:commit-file',
    log: 'git:log',
    branches: 'git:branches',
    checkout: 'git:checkout',
    fetch: 'git:fetch',
    pull: 'git:pull',
    push: 'git:push',
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
  /**
   * Updates, from the releases published on GitHub.
   *
   * The window asks; the main process does the talking, because the window is
   * not allowed to reach the network at all. There is deliberately no download
   * and no install channel: the answer is a release page, and the archive is
   * fetched from it by the person who wants it.
   */
  update: {
    state: 'update:state',
    check: 'update:check',
    progress: 'update:progress'
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
    /**
     * Saved chats. A conversation is a file in the core, so the window asks it
     * what exists instead of keeping its own list - which is what makes a chat
     * survive closing the window, and reopening the folder.
     */
    conversations: 'agent:conversations',
    conversationNew: 'agent:conversation-new',
    conversationOpen: 'agent:conversation-open',
    conversationRename: 'agent:conversation-rename',
    conversationDelete: 'agent:conversation-delete',
    event: 'agent:event',
    statusChanged: 'agent:status-changed'
  },
  shell: {
    openExternal: 'shell:open-external',
    showItem: 'shell:show-item'
  },
  clipboard: {
    write: 'clipboard:write'
  },
  /** Main-process to renderer: menu items and keyboard accelerators arrive here. */
  app: {
    command: 'app:command',
    i18n: 'app:i18n',
    /**
     * Where this app keeps its own state.
     *
     * Asked for rather than assumed: the window is not told any paths, and a
     * window that a user can point at a folder by hand is a window that can be
     * made to open one.
     */
    dataFolder: 'app:data-folder'
  }
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
    /**
     * The window's language: 'system' follows the operating system, otherwise a
     * dictionary code from `src/shared/i18n.*.json`.
     */
    language: 'system',
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
    /**
     * Whether the window reopens the folder it was last used with. Off by
     * default: an editor that opens something on start makes the first thing a
     * user sees a folder they did not choose, and the other behaviour is one
     * setting away for anyone who wants it.
     */
    reopenLastFolder: false,
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
  terminal: {
    shell: '',
    fontSize: 13,
    /**
     * Whether opening a folder opens a shell in it, in the panel below.
     *
     * On by default because that is what a folder is opened for: the next thing
     * most people do with it is run something in it, and a terminal that has to
     * be found and pointed at the right directory first is a small tax paid on
     * every folder.
     */
    openWithFolder: true
  },
  agent: {
    autoStart: true,
    defaultMode: 'agent',
    /**
     * Selected text travels with a message when this is on.
     *
     * There is deliberately no counterpart for the open file: opening a file is
     * how a person reads it, and a message that quietly carried it would say
     * something the sender did not. A file goes into the message when the user
     * puts it there, from the row above the composer or from the tree's menu.
     */
    includeSelection: true
  },
  /**
   * Looking for a newer release.
   *
   * `repo` empty means the repository named in the application's own
   * `package.json`, so a fork that changes nothing else still checks its own
   * releases.
   */
  updates: { checkOnStart: true, repo: '', includePrereleases: false },
  recent: [],
  /**
   * What to restore on the next start. `chats` and `activeChat` are the open
   * assistant tabs: ids of conversations that live in the core, so the window
   * only remembers which ones were open, not what was said in them.
   */
  session: { folder: '', tabs: [], active: '', chats: [], activeChat: '' }
};

module.exports = { PRODUCT, CHANNELS, FALLBACK_MODES, DEFAULTS };