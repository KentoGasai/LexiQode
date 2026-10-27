/*
 * The editor: Monaco, the tab strip, and the state a tab carries.
 *
 * Monaco is loaded from the vendored copy through its AMD loader, because a
 * window with no network access cannot fetch it and a bundled copy would need a
 * build step for no benefit. Its language services run in workers that it starts
 * and prepares itself, out of the vendored tree; this file deliberately says
 * nothing about where those workers are (`createEditor` explains why), and the
 * `asset-protocol` scheme is what makes them load.
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

/**
 * The line height Monaco should use for a given font size.
 *
 * Monaco's own default is `round(fontSize * 1.4)` - 18px at the default size of
 * 13 - and this repeats it rather than leaving the option unset, because unset
 * means "inherit", and what was inherited was `body`'s `line-height: 1.5`. The
 * editor then drew 19.5px lines while Monaco measured 18px ones, and the
 * suggestion widget, which is laid out from those measurements, came out wrong.
 */
function lineHeightFor(fontSize) {
  return Math.round(fontSize * 1.4);
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
  /**
   * Nothing is installed into `MonacoEnvironment` here, and that is the third
   * answer to this question.
   *
   * The first version told Monaco the worker's address and got it wrong -
   * `vendor/monaco/vs/base/worker/workerMain.js` does not exist in a 0.57 tree -
   * which made the language service fail in some runs and not others.
   *
   * The second named the address correctly (`getWorker` returning the bundled
   * file). Every run then started a worker and no run failed to load one, but the
   * service still never answered: Monaco does not simply load that file, it sets
   * up the worker's environment first - its locale, its file root, its product
   * metadata - and then imports it, and a worker started without that answers
   * word suggestions only. No diagnostics, no signatures. Measured, not guessed:
   * the probe showed `markers: 0` and a suggestion with no signature.
   *
   * So the address is left alone; Monaco both names its workers and prepares
   * them. What this window owes them instead is a protocol that answers reliably,
   * which is `corsEnabled` and the response headers in `asset-protocol.js`.
   */
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
    padding: { top: 8, bottom: 12 },
    /**
     * The font, stated rather than inherited.
     *
     * Monaco measures the suggestion widget with the *editor's* font metrics but
     * paints the rows in a monospace font of its own. Left unset, `fontFamily`
     * fell through to `body`'s UI font (`--font`), so the widget was sized for a
     * proportional face while the text inside it was monospaced and wider: rows
     * were clipped and the detail column collapsed to nothing. Measured with
     * `scripts/probe-suggest-style.cjs` - the editor reported the UI font while
     * the label reported Consolas. Naming the same monospace stack the rest of
     * the window uses (`--mono`) makes the two agree.
     *
     * `lineHeight` is pinned for the same reason: `body`'s `line-height: 1.5`
     * was inherited into the editor (19.5px) while Monaco laid its rows out at
     * 18px, so the two disagreed about how tall a line is. It is derived from the
     * font size rather than fixed, because the size is a setting (8-40) and a
     * constant would crowd the lines at the top of that range.
     */
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace',
    lineHeight: lineHeightFor(13),
    /**
     * Suggestions, stated rather than inherited.
     *
     * Monaco's defaults already suggest words from the document while typing, but
     * "the default happens to be on" is not a promise: it changes between
     * versions, and a person editing Python or PowerShell gets their only help
     * from these lines. Comments and strings are left out on purpose - a
     * suggestion list that fires inside prose is noise.
     */
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: 'currentDocument',
    tabCompletion: 'on',
    parameterHints: { enabled: true },
    acceptSuggestionOnEnter: 'on',
    snippetSuggestions: 'inline',
    bracketPairColorization: { enabled: true }
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
      lineHeight: lineHeightFor(appearance.fontSize),
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

  /**
   * Name -> language id, from the registry Monaco actually has.
   *
   * The registry is the only authority worth asking: the tokenizers and the
   * language services register themselves in it, and what it holds differs
   * between Monaco versions. It is walked once, lazily, because it is filled by
   * the time the editor is created and re-walking it per tab would be waste.
   */
  let languageTable = null;
  function languages() {
    if (languageTable) return languageTable;
    languageTable = { filenames: new Map(), extensions: new Map() };
    for (const entry of monaco.languages.getLanguages()) {
      for (const filename of entry.filenames || []) languageTable.filenames.set(filename.toLowerCase(), entry.id);
      for (const extension of entry.extensions || []) languageTable.extensions.set(extension.toLowerCase(), entry.id);
    }
    return languageTable;
  }

  /**
   * The language id for a path.
   *
   * This used to return the file's *extension* and call it a language. `.js` is
   * not a language id and neither is `.py`, so every JavaScript, Python,
   * Markdown, YAML and PowerShell file was opened as plain text: no colours and
   * no language service. Only `.json`, `.css` and `.html` looked right, and only
   * because for those three the extension and the id happen to be the same
   * word - which is also why the mistake survived as long as it did.
   *
   * A name the registry knows wins over the extension, so `Dockerfile`,
   * `Makefile` and `CMakeLists.txt` are recognised for what they are.
   */
  function languageFor(path) {
    const name = String(path).slice(String(path).lastIndexOf('/') + 1).toLowerCase();
    const table = languages();
    const byName = table.filenames.get(name);
    if (byName) return byName;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return 'plaintext';
    return table.extensions.get(name.slice(dot)) || 'plaintext';
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

  /**
   * The suggestion list, made to appear while someone is typing.
   *
   * `quickSuggestions` is Monaco's own promise to do this and it is set above,
   * but it was measured and the promise does not always hold: typing `col` into a
   * CSS file offered *nothing* in one run and seven selectors in the next, and in
   * the empty-handed run the very same text produced all seven the moment the
   * list was asked for by name. The language service was still starting, and
   * Monaco's automatic path had already given up on it - while a probe that asked
   * for the list by hand reported suggestions and hid the gap for a whole release.
   *
   * So the list is asked for here, and asked for twice: at once, so the common
   * case feels immediate, and once more after a pause, which is what covers a
   * service that was still coming up. Four rules keep this from becoming noise.
   * Only a single character counts (a paste inserts many and is not typing); only
   * a character that can begin a name counts; a list that is already open is left
   * to Monaco; and inside a comment or a string nothing is asked for at all,
   * because the option above says those are not places suggestions belong and an
   * explicit request would otherwise bypass that.
   */
  const STARTS_A_NAME = /[0-9A-Za-z_$\u0400-\u04ff]/;
  const SUGGEST_AFTER_MS = [80, 600];
  let suggestTimers = [];

  function suggestIsOpen() {
    return Boolean(document.querySelector('.suggest-widget.visible'));
  }

  /** Whether the caret sits in a comment or a string, read from the tokenizer. */
  function insideProse() {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return false;
    try {
      const tokens = monaco.editor.tokenize(model.getLineContent(position.lineNumber), model.getLanguageId())[0] || [];
      let type = '';
      for (const token of tokens) {
        if (token.offset > position.column - 1) break;
        type = token.type;
      }
      return /comment|string/.test(type);
    } catch {
      // A language whose tokenizer refuses is not a reason to withhold the list.
      return false;
    }
  }

  function askForSuggestions() {
    if (suggestIsOpen() || !editor.getModel() || !editor.hasTextFocus()) return;
    editor.trigger('lexiqode', 'editor.action.triggerSuggest', {});
  }

  editor.onDidType((typed) => {
    for (const timer of suggestTimers) clearTimeout(timer);
    suggestTimers = [];
    if (typed.length !== 1) return;
    if (!STARTS_A_NAME.test(typed) && typed !== '.') return;
    if (suggestIsOpen() || insideProse()) return;
    suggestTimers = SUGGEST_AFTER_MS.map((delay) => setTimeout(askForSuggestions, delay));
  });

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