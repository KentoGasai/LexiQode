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

/**
 * How far the suggestion list is kept clear of the editor's bottom edge.
 *
 * Flush against the edge is what was reported as "a small panel at the bottom
 * covers the last hint": the last row's own border sat on the boundary, and the
 * panel below - which begins exactly there - painted over it. A few pixels of
 * clearance is the difference between a list that ends and a list that is cut.
 */
const SUGGEST_GAP = 6;

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

  /**
   * The two views that are not the code editor, and why they are separate nodes.
   *
   * A coloured diff is not a document with `+` and `-` lines: it is two
   * documents compared, which is what Monaco's `DiffEditor` draws and what makes
   * an added line green and a removed one red the way a person expects. The
   * commit view is not a document at all - it is a header and a list of files -
   * so it is plain markup. Both live beside the editor and are shown in its
   * place, because a tab is a place in the window, not a kind of text.
   */
  const diffHost = document.createElement('div');
  diffHost.className = 'editor__diff';
  diffHost.hidden = true;
  const commitHost = document.createElement('div');
  commitHost.className = 'editor__commit';
  commitHost.hidden = true;
  container.append(diffHost, commitHost);

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

  /**
   * The editor's own width, published for the stylesheet to cap the suggestion
   * list with.
   *
   * Monaco draws the list with `fixedOverflowWidgets`, so it is positioned
   * against the window and its own layout caps its width to the *window*, not to
   * the editor. With the assistant panel open on the right, a list that starts
   * at the caret and runs its full 430px therefore ends up under that panel, and
   * the part that is covered is the signature - the reason the list is open.
   * Measured with `scripts/probe-suggest-fit.cjs`: in a 900px window the editor
   * was 168px wide and the list ran 372px past its right edge.
   *
   * A percentage cannot express this, because the widget's containing block is
   * the viewport rather than the editor. So the width is measured here and
   * written to a custom property the stylesheet reads; a `ResizeObserver` keeps
   * it true when the sidebar, the assistant panel or the window itself changes
   * size, which is exactly when the list would otherwise be clipped.
   */
  function publishEditorWidth() {
    container.style.setProperty('--editor-width', `${container.clientWidth}px`);
    // The gap is taken off here as well as in the clamp, so the stylesheet's own
    // cap and the position correction agree about where the bottom edge is.
    container.style.setProperty('--editor-height', `${Math.max(0, container.clientHeight - SUGGEST_GAP)}px`);
  }
  publishEditorWidth();
  const widthObserver = new ResizeObserver(publishEditorWidth);
  widthObserver.observe(container);

  /**
   * Keep the suggestion list inside the editor, not merely inside the window.
   *
   * Capping the width is not enough on its own: Monaco places the list at the
   * caret and lets it overflow the editor (`allowEditorOverflow`), so a list that
   * is narrow enough still starts at the caret and runs past the editor's right
   * edge when the caret is near it. The stylesheet caps the width; this moves the
   * list back inside when its position would take it out, which is the half CSS
   * cannot do because the position is an inline style Monaco writes.
   *
   * It runs on the widget's own style changes rather than on a timer, so it
   * follows every keystroke and every scroll without polling, and it only ever
   * moves the list - it never changes its size, which stays Monaco's decision.
   */
  function clampSuggestWidget() {
    const widget = container.querySelector('.suggest-widget.visible');
    if (!widget) return;
    const editorRect = container.getBoundingClientRect();
    const rect = widget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const overflowRight = rect.right - editorRect.right;
    // The list is kept a few pixels clear of the editor's bottom edge, not flush
    // with it. Flush is what was reported: the last row's own border sat on the
    // boundary, and the panel below - which starts exactly there - covered it.
    const overflowBottom = rect.bottom - (editorRect.bottom - SUGGEST_GAP);
    if (overflowRight > 0) {
      const left = Number.parseFloat(widget.style.left) || rect.left;
      widget.style.left = `${Math.max(editorRect.left, left - overflowRight)}px`;
    }
    if (overflowBottom > 0) {
      const top = Number.parseFloat(widget.style.top) || rect.top;
      // Moved up by exactly what it overflows, and never above the editor: a
      // list that is taller than the editor cannot be made to fit, and pushing
      // it off the top would hide the first rows instead of the last.
      widget.style.top = `${Math.max(editorRect.top, top - overflowBottom)}px`;
    }
  }

  let clampScheduled = false;
  const widgetObserver = new MutationObserver(() => {
    if (clampScheduled) return;
    clampScheduled = true;
    requestAnimationFrame(() => {
      clampScheduled = false;
      clampSuggestWidget();
    });
  });
  widgetObserver.observe(container, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  /** path -> { model, viewState, savedVersionId, eol, hadFinalNewline, readOnly, kind } */
  const tabs = new Map();
  let active = '';
  let saveTimer = null;
  const decorations = editor.createDecorationsCollection([]);

  /**
   * The diff editor, created once and reused.
   *
   * Creating one per diff would leak a DOM tree and a set of models for every
   * file a person clicks; one instance whose models are swapped is both cheaper
   * and what makes the view state (scroll position, folded regions) survive
   * switching between files of the same commit.
   */
  const diffEditor = monaco.editor.createDiffEditor(diffHost, {
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: true,
    scrollBeyondLastLine: false,
    renderOverviewRuler: false,
    originalEditable: false,
    fixedOverflowWidgets: true,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace',
    lineHeight: lineHeightFor(13)
  });

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
    // The diff editor is a second editor and does not inherit the first one's
    // options: without this, a diff would be drawn at the default font size
    // while the file beside it used the one the person chose.
    diffEditor.updateOptions({
      fontSize: appearance.fontSize,
      lineHeight: lineHeightFor(appearance.fontSize),
      renderSideBySide: appearance.wordWrap === 'off'
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
    if (!tab || tab.kind !== 'code') return false;
    return tab.model.getAlternativeVersionId() !== tab.savedVersionId;
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
      node.title = tab.label || path;
      node.setAttribute('aria-selected', String(path === active));

      const nodeLabel = document.createElement('span');
      nodeLabel.className = 'tab__label';
      nodeLabel.textContent = tab.label || (tab.kind === 'diff' ? `${label} (diff)` : label);
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

  /**
   * Show a tab, whichever of the three kinds of view it is.
   *
   * A tab is a place in the window, and the window has three kinds of place: the
   * code editor, a coloured diff, and a commit's file list. Only one is visible
   * at a time, and the code editor's own view state is saved before it is hidden
   * so returning to a file lands where it was left.
   */
  function setActive(path) {
    if (!tabs.has(path)) return;
    const previous = tabs.get(active);
    if (previous && previous.kind === 'code') previous.viewState = editor.saveViewState();
    active = path;
    const tab = tabs.get(path);

    const isCode = tab.kind === 'code';
    const isDiff = tab.kind === 'diff';
    const isCommit = tab.kind === 'commit';
    container.hidden = false;
    // `editor.getDomNode()` is null until the editor has a model, so the node is
    // found in the container instead: it is the same element and it is always
    // there once the editor has been created.
    const codeNode = container.querySelector('.monaco-editor');
    if (codeNode) codeNode.hidden = !isCode;
    diffHost.hidden = !isDiff;
    commitHost.hidden = !isCommit;

    if (isCode) {
      editor.setModel(tab.model);
      if (tab.viewState) editor.restoreViewState(tab.viewState);
      editor.updateOptions({ readOnly: tab.readOnly });
      editor.focus();
    } else if (isDiff) {
      diffEditor.setModel({ original: tab.original, modified: tab.modified });
      diffEditor.layout();
    } else if (isCommit) {
      renderCommitView(tab);
    }
    renderTabs();
    onActiveChange?.(tab, isCode ? editor.getPosition() : null);
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

  /**
   * Put a coloured diff on screen as a read-only tab.
   *
   * Monaco's `DiffEditor` compares two documents, so an added line is green and
   * a removed one is red the way a person expects - which a single document full
   * of `+` and `-` lines is not. The two models are owned by the tab and disposed
   * with it, so switching between files of a commit does not accumulate them.
   */
  function showDiffTab({ key, label, before, after, language, source }) {
    const previous = tabs.get(key);
    if (previous) {
      previous.original?.dispose();
      previous.modified?.dispose();
    }
    const original = monaco.editor.createModel(
      before,
      language,
      monaco.Uri.parse(`diff-original:///${encodeURIComponent(key)}`)
    );
    const modified = monaco.editor.createModel(
      after,
      language,
      monaco.Uri.parse(`diff-modified:///${encodeURIComponent(key)}`)
    );
    tabs.set(key, {
      kind: 'diff',
      original,
      modified,
      label,
      readOnly: true,
      source
    });
    setActive(key);
  }

  /** The working-tree diff of one file, as a coloured diff tab. */
  async function openDiff(path, { staged = false } = {}) {
    let diff;
    try {
      diff = await api.git.diff(path, staged);
    } catch (error) {
      onNotice?.(error.message, 'error');
      return;
    }
    // The patch is split into the two sides the diff editor compares: lines
    // that are not additions are the "before", lines that are not removals are
    // the "after". This is what turns a patch into a coloured comparison.
    const before = [];
    const after = [];
    for (const line of String(diff.text || '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
      if (line.startsWith('@@')) continue;
      if (line.startsWith('+')) after.push(line.slice(1));
      else if (line.startsWith('-')) before.push(line.slice(1));
      else {
        before.push(line.startsWith(' ') ? line.slice(1) : line);
        after.push(line.startsWith(' ') ? line.slice(1) : line);
      }
    }
    const key = `diff:${path}:${staged ? 'staged' : 'unstaged'}`;
    showDiffTab({
      key,
      label: `${path} (diff)`,
      before: before.join('\n'),
      after: after.join('\n'),
      language: languageFor(path),
      source: path
    });
  }

  /**
   * Show a commit the way a person reads one: a header, then the files it
   * changed.
   *
   * The list is the point. A commit is not one change but a set of them, one per
   * file, and a single wall of patch text hides which files are even involved -
   * which is why every editor with a history view shows the files first and the
   * change of one file on request. Clicking a file opens its coloured diff.
   */
  async function openCommit(commit) {
    const hash = typeof commit === 'string' ? commit : commit && commit.hash;
    if (!hash) return;
    let view;
    try {
      view = await api.git.commitView(hash);
    } catch (error) {
      onNotice?.(error.message, 'error');
      return;
    }
    if (!view.ok) {
      onNotice?.(view.error || 'the commit could not be read', 'error');
      return;
    }
    const key = `commit:${view.commit.hash}`;
    tabs.set(key, {
      kind: 'commit',
      label: `${view.commit.short} ${view.commit.subject}`.trim(),
      commit: view.commit,
      files: view.files,
      readOnly: true,
      source: view.commit.hash
    });
    setActive(key);
  }

  /** One file's change inside one commit, as a coloured diff tab. */
  async function openCommitFile(hash, path) {
    let file;
    try {
      file = await api.git.commitFile(hash, path);
    } catch (error) {
      onNotice?.(error.message, 'error');
      return;
    }
    if (file.binary) {
      onNotice?.(t('toast.binary', { path }), 'warn');
      return;
    }
    const short = String(hash).slice(0, 7);
    showDiffTab({
      key: `commit-file:${hash}:${path}`,
      label: `${path} (${short})`,
      before: file.before,
      after: file.after,
      language: languageFor(path),
      source: path
    });
  }

  /**
   * A change the assistant made, as a coloured diff tab.
   *
   * The two sides are handed in rather than read from git, because the change is
   * not committed and may not even be staged: it is the file as it was before
   * the tool ran and as it is after, which is exactly what the window watched
   * happen. The tab is keyed by the path so a second edit to the same file
   * replaces the first view instead of opening a second tab for it.
   */
  function openChangeDiff(path, before, after, { label } = {}) {
    showDiffTab({
      key: `change:${path}`,
      label: label || `${path} (${t('chat.changed')})`,
      before: String(before ?? ''),
      after: String(after ?? ''),
      language: languageFor(path),
      source: path
    });
  }

  /**
   * The commit's header and its file list, drawn as markup.
   *
   * The status letter is git's own and is shown as a word, because `M` and `A`
   * are only obvious to someone who already knows them; the colour says the same
   * thing at a glance for someone who does not.
   */
  function renderCommitView(tab) {
    commitHost.replaceChildren();
    const head = document.createElement('div');
    head.className = 'commitview__head';
    const subject = document.createElement('div');
    subject.className = 'commitview__subject';
    subject.textContent = tab.commit.subject;
    const meta = document.createElement('div');
    meta.className = 'commitview__meta';
    meta.textContent = `${tab.commit.short} · ${tab.commit.author} · ${tab.commit.when}`;
    head.append(subject, meta);
    if (tab.commit.body) {
      const body = document.createElement('div');
      body.className = 'commitview__body';
      body.textContent = tab.commit.body;
      head.append(body);
    }
    commitHost.append(head);

    const list = document.createElement('div');
    list.className = 'commitview__files';
    const STATUS = {
      A: { word: t('git.statusAdded'), kind: 'added' },
      M: { word: t('git.statusModified'), kind: 'modified' },
      D: { word: t('git.statusDeleted'), kind: 'deleted' },
      R: { word: t('git.statusRenamed'), kind: 'renamed' },
      C: { word: t('git.statusCopied'), kind: 'renamed' },
      T: { word: t('git.statusTypeChanged'), kind: 'modified' }
    };
    for (const file of tab.files) {
      const described = STATUS[file.status] || { word: file.status, kind: 'modified' };
      const row = document.createElement('button');
      row.className = 'commitview__file';
      row.type = 'button';
      row.title = file.from ? `${file.from} → ${file.path}` : file.path;
      const badge = document.createElement('span');
      badge.className = 'commitview__badge';
      badge.dataset.kind = described.kind;
      badge.textContent = described.word;
      const name = document.createElement('span');
      name.className = 'commitview__name';
      name.textContent = file.path;
      row.append(badge, name);
      row.addEventListener('click', () => void openCommitFile(tab.commit.hash, file.path));
      list.append(row);
    }
    if (!tab.files.length) {
      const empty = document.createElement('div');
      empty.className = 'list__empty';
      empty.textContent = t('git.commitNoFiles');
      list.append(empty);
    }
    commitHost.append(list);
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

  /**
   * Release whatever a tab owns.
   *
   * A code tab owns one model, a diff tab owns two, and a commit tab owns
   * nothing but its own markup. Disposing the wrong thing - or nothing - is how
   * a window that has been open all day accumulates models it can never free.
   */
  function disposeTab(tab) {
    if (!tab) return;
    if (tab.kind === 'code') tab.model.dispose();
    else if (tab.kind === 'diff') {
      tab.original?.dispose();
      tab.modified?.dispose();
    }
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
    disposeTab(tab);
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
    container.hidden = true;
    renderTabs();
    onActiveChange?.(null, null);
  }

  function closeAll() {
    for (const tab of tabs.values()) disposeTab(tab);
    tabs.clear();
    active = '';
    editor.setModel(null);
    container.hidden = true;
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
    openCommit,
    openCommitFile,
    openChangeDiff,
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