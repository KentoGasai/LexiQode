/*
 * The editor: Monaco, the tab strip, and the state a tab carries.
 *
 * Monaco is loaded from the vendored copy through its AMD loader, because a
 * window with no network access cannot fetch it and a bundled copy would need a
 * build step for no benefit. The worker is same-origin, so language services run
 * off the main thread and a large file does not freeze typing.
 *
 * Line endings are the detail worth naming: the main process reports the ending
 * a file already used, and saving writes it back. A file is therefore never
 * silently converted, which would turn a one-line edit into a whole-file diff
 * for whoever reviews it.
 */

const MONACO_ROOT = 'vendor/monaco/vs';
import { t } from './i18n.js';

let monacoPromise = null;

/** Load Monaco once, from the vendored directory, and never from the network. */
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const workerUrl = new URL(`${MONACO_ROOT}/base/worker/workerMain.js`, document.baseURI).href;
    self.MonacoEnvironment = { getWorkerUrl: () => workerUrl };

    const loader = document.createElement('script');
    loader.src = `${MONACO_ROOT}/loader.js`;
    loader.onerror = () => reject(new Error('Monaco could not be loaded from vendor/monaco (run "npm run vendor")'));
    loader.onload = () => {
      try {
        self.require.config({ paths: { vs: MONACO_ROOT } });
        self.require(['vs/editor/editor.main'], () => resolve(self.monaco), (error) => reject(error));
      } catch (error) {
        reject(error);
      }
    };
    document.head.append(loader);
  });
  return monacoPromise;
}

const THEMES = {
  dark: {
    base: 'vs-dark',
    colors: {
      'editor.background': '#121216',
      'editor.foreground': '#dcdce3',
      'editorLineNumber.foreground': '#4c4c58',
      'editorLineNumber.activeForeground': '#9a9aa6',
      'editor.selectionBackground': '#2a4a7a',
      'editor.lineHighlightBackground': '#1a1a20',
      'editorCursor.foreground': '#6ea8fe',
      'editorIndentGuide.background1': '#22222a',
      'editorGutter.background': '#121216',
      'editorWidget.background': '#1b1b21',
      'editorWidget.border': '#2b2b33'
    }
  },
  light: {
    base: 'vs',
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#23232b',
      'editorLineNumber.foreground': '#a0a0ac',
      'editor.lineHighlightBackground': '#f4f4f7',
      'editorCursor.foreground': '#2f6fe0',
      'editorGutter.background': '#ffffff'
    }
  }
};

export async function createEditor({ api, settings, onDirtyChange, onActiveChange, onNotice }) {
  const monaco = await loadMonaco();
  const container = document.getElementById('editor');
  const tabsHost = document.getElementById('tabs');
  const welcome = document.getElementById('welcome');

  for (const [name, theme] of Object.entries(THEMES)) {
    monaco.editor.defineTheme(`lexiqode-${name}`, { base: theme.base, inherit: true, rules: [], colors: theme.colors });
  }

  const editor = monaco.editor.create(container, {
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderLineHighlight: 'all',
    fixedOverflowWidgets: true,
    padding: { top: 8, bottom: 12 }
  });

  /** path -> { model, viewState, savedVersionId, eol, hadFinalNewline, readOnly, kind } */
  const tabs = new Map();
  let active = '';
  let saveTimer = null;
  const decorations = editor.createDecorationsCollection([]);

  function currentSettings() {
    return settings();
  }

  function applyOptions() {
    const appearance = currentSettings().appearance;
    editor.updateOptions({
      fontSize: appearance.fontSize,
      tabSize: appearance.tabSize,
      minimap: { enabled: appearance.minimap },
      wordWrap: appearance.wordWrap,
      lineNumbers: appearance.lineNumbers,
      renderWhitespace: appearance.renderWhitespace,
      breadcrumbs: { enabled: appearance.breadcrumbs }
    });
    const theme = document.documentElement.dataset.theme === 'light' ? 'lexiqode-light' : 'lexiqode-dark';
    monaco.editor.setTheme(theme);
  }

  function languageFor(path) {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const known = monaco.languages.getLanguages().some((entry) => (entry.extensions || []).includes(`.${extension}`));
    return known ? extension : 'plaintext';
  }

  function isDirty(path) {
    const tab = tabs.get(path);
    return Boolean(tab) && tab.model.getAlternativeVersionId() !== tab.savedVersionId;
  }

  function renderTabs() {
    tabsHost.replaceChildren();
    welcome.hidden = tabs.size > 0;
    container.hidden = tabs.size === 0;
    for (const [path, tab] of tabs) {
      const label = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
      const node = document.createElement('button');
      node.className = 'tab';
      node.type = 'button';
      node.title = path;
      node.setAttribute('aria-selected', String(path === active));

      const nodeLabel = document.createElement('span');
      nodeLabel.className = 'tab__label';
      nodeLabel.textContent = tab.kind === 'diff' ? `${label} (diff)` : label;
      node.append(nodeLabel);

      if (isDirty(path)) {
        const dot = document.createElement('span');
        dot.className = 'tab__dirty';
        dot.title = 'Unsaved changes';
        node.append(dot);
      }

      const close = document.createElement('span');
      close.className = 'tab__close';
      close.textContent = '✕';
      close.title = 'Close';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        void closeTab(path);
      });
      node.append(close);

      node.addEventListener('click', () => setActive(path));
      node.addEventListener('auxclick', (event) => {
        if (event.button === 1) void closeTab(path);
      });
      tabsHost.append(node);
    }
  }

  function setActive(path) {
    if (!tabs.has(path)) return;
    const previous = tabs.get(active);
    if (previous && previous.kind === 'code') previous.viewState = editor.saveViewState();
    active = path;
    const tab = tabs.get(path);
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.updateOptions({ readOnly: tab.readOnly });
    if (tab.kind === 'code') editor.focus();
    renderTabs();
    onActiveChange?.(tab, editor.getPosition());
  }

  async function open(path, options = {}) {
    if (!path) return;
    if (tabs.has(path)) {
      setActive(path);
      if (options.line) reveal(path, options);
      return;
    }
    let file;
    try {
      file = await api.workspace.readFile(path);
    } catch (error) {
      onNotice?.(error.message, 'error');
      return;
    }
    if (file.binary) {
      onNotice?.(t('toast.binary', { path }), 'warn');
      return;
    }
    if (file.tooLarge) {
      onNotice?.(t('toast.tooLarge', { path }), 'warn');
      return;
    }

    const model = monaco.editor.createModel(file.text, languageFor(path), monaco.Uri.parse(`file:///${path}`));
    const tab = {
      kind: 'code',
      model,
      savedVersionId: model.getAlternativeVersionId(),
      eol: file.eol,
      hadFinalNewline: file.hadFinalNewline,
      readOnly: false,
      viewState: null
    };
    tabs.set(path, tab);
    model.onDidChangeContent(() => {
      renderTabs();
      onDirtyChange?.(path, isDirty(path));
      if (currentSettings().editor.autoSave === 'afterDelay') {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void save(path, { quiet: true }), currentSettings().editor.autoSaveDelay);
      }
    });
    setActive(path);
    if (options.line) reveal(path, options);
  }

  /** Show a git diff as a read-only tab, coloured by Monaco's diff grammar. */
  async function openDiff(path, { staged = false } = {}) {
    let diff;
    try {
      diff = await api.git.diff(path, staged);
    } catch (error) {
      onNotice?.(error.message, 'error');
      return;
    }
    const key = `diff:${path}:${staged ? 'staged' : 'unstaged'}`;
    const empty = `No differences against HEAD for ${path}${staged ? ' in the index' : ''}.`;
    const model = monaco.editor.createModel(
      diff.text && diff.text.trim() ? diff.text : empty,
      'diff',
      monaco.Uri.parse(`diff:///${encodeURIComponent(key)}`)
    );
    const previous = tabs.get(key);
    if (previous) previous.model.dispose();
    tabs.set(key, {
      kind: 'diff',
      model,
      savedVersionId: model.getAlternativeVersionId(),
      eol: '\n',
      hadFinalNewline: true,
      readOnly: true,
      viewState: null,
      source: path
    });
    setActive(key);
  }

  async function save(path, { quiet = false } = {}) {
    const tab = tabs.get(path);
    if (!tab || tab.readOnly) return false;
    if (!isDirty(path)) {
      if (!quiet) onNotice?.(t('toast.noChanges', { path }), 'info');
      return false;
    }
    try {
      await api.workspace.writeFile({
        path,
        text: tab.model.getValue(),
        eol: tab.eol,
        hadFinalNewline: tab.hadFinalNewline
      });
      tab.savedVersionId = tab.model.getAlternativeVersionId();
      renderTabs();
      onDirtyChange?.(path, false);
      if (!quiet) onNotice?.(t('toast.saved', { path }), 'ok');
      return true;
    } catch (error) {
      onNotice?.(error.message, 'error');
      return false;
    }
  }

  async function saveAll() {
    let saved = 0;
    for (const path of [...tabs.keys()]) {
      if (await save(path, { quiet: true })) saved += 1;
    }
    if (saved) onNotice?.(t('toast.savedMany', { count: saved }), 'ok');
  }

  async function closeTab(path) {
    const tab = tabs.get(path);
    if (!tab) return;
    if (isDirty(path)) {
      const answer = await api.dialogs.confirm({
        message: t('toast.saveBeforeClose', { path }),
        detail: t('toast.saveBeforeCloseDetail'),
        confirmLabel: t('toast.saveAction'),
        cancelLabel: t('toast.discardAction')
      });
      if (answer) await save(path, { quiet: true });
    }
    const order = [...tabs.keys()];
    const index = order.indexOf(path);
    tab.model.dispose();
    tabs.delete(path);
    if (active !== path) {
      renderTabs();
      return;
    }
    const next = order[index + 1] || order[index - 1];
    active = '';
    if (next && tabs.has(next)) {
      setActive(next);
      return;
    }
    editor.setModel(null);
    renderTabs();
    onActiveChange?.(null, null);
  }

  function closeAll() {
    for (const tab of tabs.values()) tab.model.dispose();
    tabs.clear();
    active = '';
    editor.setModel(null);
    renderTabs();
    onActiveChange?.(null, null);
  }

  /** Put the cursor on a line and mark the match a search result described. */
  function reveal(path, { line = 1, column = 1, length = 0, highlight = false } = {}) {
    const tab = tabs.get(path);
    if (!tab || tab.kind !== 'code') return;
    setActive(path);
    const position = { lineNumber: Math.max(1, line), column: Math.max(1, column) };
    editor.setPosition(position);
    if (highlight && length > 0) {
      const range = new monaco.Range(
        position.lineNumber,
        position.column,
        position.lineNumber,
        position.column + length
      );
      editor.setSelection(range);
      decorations.set([{ range, options: { inlineClassName: 'search-hit' } }]);
      setTimeout(() => decorations.set([]), 2600);
    } else {
      editor.revealPositionInCenterIfOutsideViewport(position);
    }
    editor.focus();
  }

  /** What the chat composer should offer as context. */
  function context() {
    const tab = tabs.get(active);
    if (!tab || tab.kind !== 'code') return { file: '', selection: '', language: '' };
    const position = editor.getPosition();
    const selection = editor.getSelection();
    const hasSelection = Boolean(selection) && !selection.isEmpty();
    return {
      file: active,
      dirty: isDirty(active),
      language: tab.model.getLanguageId(),
      line: position ? position.lineNumber : 1,
      selection: hasSelection ? tab.model.getValueInRange(selection) : '',
      selectionRange: hasSelection ? { start: selection.startLineNumber, end: selection.endLineNumber } : null
    };
  }

  function positions() {
    const position = editor.getPosition();
    const model = editor.getModel();
    return {
      line: position ? position.lineNumber : 0,
      column: position ? position.column : 0,
      lines: model ? model.getLineCount() : 0,
      language: model ? model.getLanguageId() : ''
    };
  }

  function restore(session) {
    const paths = Array.isArray(session && session.tabs) ? session.tabs : [];
    for (const path of paths) void open(path);
  }

  function session() {
    const paths = [...tabs.entries()].filter(([, tab]) => tab.kind === 'code').map(([path]) => path);
    const tab = tabs.get(active);
    return { tabs: paths.slice(0, 30), active: tab && tab.kind === 'code' ? active : '' };
  }

  editor.onDidChangeCursorPosition(() => onActiveChange?.(tabs.get(active) || null, editor.getPosition()));

  applyOptions();
  renderTabs();
  return {
    open,
    openDiff,
    closeTab,
    closeAll,
    save,
    saveAll,
    reveal,
    context,
    positions,
    restore,
    session,
    applyOptions,
    setActive,
    isDirty,
    get instance() {
      return editor;
    },
    get active() {
      return active;
    },
    get monaco() {
      return monaco;
    }
  };
}