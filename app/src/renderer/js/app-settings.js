/*
 * The application's own settings.
 *
 * Until this file existed the window had exactly one settings surface, and it
 * was the agent's: an endpoint, a key and a model. Everything else the settings
 * file holds - the theme, the language, the editor's numbers, the folders search
 * skips, where the terminal starts - could only be changed by editing JSON by
 * hand, and several of them had no surface at all.
 *
 * Two rules shape it. Every control writes through `settings:update`, and the
 * dialog redraws from the `settings:changed` event that comes back, so the file
 * stays the authority on what a setting is rather than this form. And a redraw
 * is skipped while the keyboard is inside the dialog, because rebuilding a form
 * under somebody who is typing into it throws away the caret and the selection
 * for no reason.
 *
 * The same file owns the offer of a new version, since that is the one thing an
 * application is expected to tell its user about on its own.
 */

import { clear, el, iconButton } from './ui.js';
import { t } from './i18n.js';

const THEME_OPTIONS = [
  ['system', 'settings.themeSystem'],
  ['dark', 'settings.themeDark'],
  ['light', 'settings.themeLight']
];
const LANGUAGE_OPTIONS = [
  ['system', 'settings.languageSystem'],
  ['ru', 'RU'],
  ['en', 'EN']
];
const WRAP_OPTIONS = [
  ['off', 'settings.wrapOff'],
  ['on', 'settings.wrapOn'],
  ['bounded', 'settings.wrapBounded']
];
const LINES_OPTIONS = [
  ['on', 'settings.linesOn'],
  ['off', 'settings.linesOff'],
  ['relative', 'settings.linesRelative']
];
const WHITESPACE_OPTIONS = [
  ['none', 'settings.wsNone'],
  ['selection', 'settings.wsSelection'],
  ['all', 'settings.wsAll'],
  ['boundary', 'settings.wsBoundary']
];
const SAVE_OPTIONS = [
  ['off', 'settings.saveOff'],
  ['afterDelay', 'settings.saveAfterDelay']
];
const MODE_IDS = ['agent', 'ask', 'plan', 'debug', 'review'];

/**
 * What the dialog shows, as data.
 *
 * A schema rather than a hand-built form: the controls differ only in how a
 * value is read, written and drawn, and a form written out by hand is where a
 * new setting gets forgotten in one of the three places.
 */
const SECTIONS = [
  {
    title: 'settings.groupAppearance',
    rows: [
      { path: 'appearance.theme', label: 'settings.theme', type: 'select', options: THEME_OPTIONS, hint: 'settings.themeHint' },
      {
        path: 'appearance.language',
        label: 'settings.language',
        type: 'select',
        options: LANGUAGE_OPTIONS,
        hint: 'settings.languageHint'
      },
      { path: 'appearance.fontSize', label: 'settings.fontSize', type: 'number', min: 8, max: 40 },
      { path: 'appearance.tabSize', label: 'settings.tabSize', type: 'number', min: 1, max: 16 },
      { path: 'appearance.wordWrap', label: 'settings.wordWrap', type: 'select', options: WRAP_OPTIONS },
      { path: 'appearance.lineNumbers', label: 'settings.lineNumbers', type: 'select', options: LINES_OPTIONS },
      {
        path: 'appearance.renderWhitespace',
        label: 'settings.renderWhitespace',
        type: 'select',
        options: WHITESPACE_OPTIONS
      },
      { path: 'appearance.minimap', label: 'settings.minimap', type: 'check' },
      { path: 'appearance.breadcrumbs', label: 'settings.breadcrumbs', type: 'check' }
    ]
  },
  {
    title: 'settings.groupEditor',
    rows: [
      { path: 'editor.autoSave', label: 'settings.autoSave', type: 'select', options: SAVE_OPTIONS },
      { path: 'editor.autoSaveDelay', label: 'settings.autoSaveDelay', type: 'number', min: 200, max: 60000 }
    ]
  },
  {
    title: 'settings.groupLayout',
    rows: [
      { path: 'layout.sidebarWidth', label: 'settings.sidebarWidth', type: 'number', min: 140, max: 900 },
      { path: 'layout.panelHeight', label: 'settings.panelHeight', type: 'number', min: 60, max: 2000 },
      { path: 'layout.chatWidth', label: 'settings.chatWidth', type: 'number', min: 260, max: 1400 },
      { path: 'layout.sidebarVisible', label: 'settings.sidebarVisible', type: 'check' },
      { path: 'layout.panelVisible', label: 'settings.panelVisible', type: 'check' },
      { path: 'layout.chatVisible', label: 'settings.chatVisible', type: 'check' }
    ]
  },
  {
    title: 'settings.groupFiles',
    rows: [
      { path: 'files.reopenLastFolder', label: 'settings.reopenLastFolder', type: 'check' },
      { path: 'files.maxSearchResults', label: 'settings.maxSearchResults', type: 'number', min: 10, max: 20000 },
      { path: 'files.maxFileSizeKb', label: 'settings.maxFileSize', type: 'number', min: 16, max: 65536 },
      { path: 'files.exclude', label: 'settings.exclude', type: 'lines', hint: 'settings.excludeHint' }
    ]
  },
  {
    title: 'settings.groupTerminal',
    rows: [
      { path: 'terminal.openWithFolder', label: 'settings.openWithFolder', type: 'check', hint: 'settings.openWithFolderHint' },
      { path: 'terminal.shell', label: 'settings.terminalShell', type: 'text', hint: 'settings.terminalShellHint' },
      { path: 'terminal.fontSize', label: 'settings.terminalFont', type: 'number', min: 8, max: 32 }
    ]
  },
  {
    title: 'settings.groupAssistant',
    rows: [
      { path: 'agent.autoStart', label: 'settings.agentAutoStart', type: 'check' },
      { path: 'agent.defaultMode', label: 'settings.agentDefaultMode', type: 'select', options: MODE_IDS.map((id) => [id, `chat.mode${id[0].toUpperCase()}${id.slice(1)}`]) },
      { path: 'agent.includeSelection', label: 'settings.includeSelection', type: 'check' }
    ]
  },
  {
    title: 'settings.groupUpdates',
    rows: [
      { path: 'updates.checkOnStart', label: 'settings.checkOnStart', type: 'check' },
      { path: 'updates.includePrereleases', label: 'settings.includePrereleases', type: 'check' },
      { path: 'updates.repo', label: 'settings.updateRepo', type: 'text', hint: 'settings.updateRepoHint' },
      { type: 'update' }
    ]
  }
];

export function createAppSettings({ api, settings, onNotice }) {
  const overlay = document.getElementById('settings-overlay');
  const body = document.getElementById('settings-body');
  const headActions = document.getElementById('settings-head-actions');

  const updateOverlay = document.getElementById('update-overlay');
  const updateBody = document.getElementById('update-body');
  const updateHeadActions = document.getElementById('update-head-actions');

  const state = { update: null, offered: '', open: false, prompt: false };

  /** Where the project lives, from the answer the update check gave. */
  function repositoryUrl() {
    const repo = state.update && state.update.repo ? String(state.update.repo) : '';
    return repo ? `https://github.com/${repo}` : 'https://github.com';
  }

  function valueAt(path) {
    return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), settings());
  }

  /** Write one setting; the redraw comes back through `settings:changed`. */
  async function write(path, value) {
    const [section, key] = path.split('.');
    try {
      await api.settings.update({ [section]: { [key]: value } });
    } catch (error) {
      onNotice?.(error.message, 'error');
      render();
    }
  }

  function row(labelKey, control, hintKey) {
    const valueCell = el('div', { class: 'settings__value' }, Array.isArray(control) ? control : [control]);
    if (hintKey) valueCell.append(el('span', { class: 'settings__hint', text: t(hintKey) }));
    return el('div', { class: 'settings__row' }, [el('span', { class: 'settings__label', text: t(labelKey) }), valueCell]);
  }

  function controlFor(row_) {
    const value = valueAt(row_.path);
    if (row_.type === 'select') {
      const select = el('select', {
        onchange: () => void write(row_.path, select.value)
      });
      for (const [option, labelKey] of row_.options) {
        select.append(el('option', { value: option, text: t(labelKey) }));
      }
      select.value = String(value);
      return select;
    }
    if (row_.type === 'number') {
      const input = el('input', {
        type: 'number',
        min: String(row_.min),
        max: String(row_.max),
        // Written when the field is left rather than per keystroke: a half-typed
        // number is not a setting, and `4` on the way to `40` is one.
        onchange: () => void write(row_.path, Number(input.value))
      });
      input.value = String(value);
      return input;
    }
    if (row_.type === 'text') {
      const input = el('input', {
        type: 'text',
        placeholder: row_.placeholder || '',
        onchange: () => void write(row_.path, input.value)
      });
      input.value = String(value || '');
      return input;
    }
    if (row_.type === 'lines') {
      const area = el('textarea', {
        rows: '6',
        spellcheck: 'false',
        onchange: () =>
          void write(
            row_.path,
            area.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          )
      });
      area.value = (Array.isArray(value) ? value : []).join('\n');
      return area;
    }
    return el('span', { text: String(value) });
  }

  function checkFor(row_) {
    const box = el('input', {
      type: 'checkbox',
      onchange: () => void write(row_.path, box.checked)
    });
    box.checked = Boolean(valueAt(row_.path));
    const node = el('label', { class: 'settings__check' }, [box, el('span', { text: t(row_.label) })]);
    if (row_.hint) node.title = t(row_.hint);
    return node;
  }

  /**
   * The updates block: what this version is, what was found, and where to get it.
   *
   * There is no Download button and no install button, and that is the decision
   * this whole surface is built on: the application does not replace its own
   * files. An earlier version tried, and what a person saw was a refusal they
   * could not act on. The page is the answer - it holds the archive, its digest
   * and the notes, and a browser is a far better installer than a detached
   * PowerShell script.
   */
  function updateBlock() {
    const update = state.update || {};
    const wrapper = el('div', { class: 'settings__update' });
    const current = update.current || '';
    wrapper.append(
      el('span', { class: 'settings__note', text: t('settings.updateCurrent', { version: current }) })
    );
    const phase = update.phase || 'idle';
    if (update.version && phase === 'available') {
      wrapper.append(el('span', { class: 'settings__note', text: t('settings.updateLatest', { version: update.version }) }));
    }
    if (update.message) wrapper.append(el('span', { class: 'settings__hint', text: update.message }));
    if (update.notes && phase === 'available') {
      wrapper.append(
        el('span', { class: 'settings__note', text: t('update.notes') }),
        el('pre', { class: 'update__notes', text: update.notes.slice(0, 1200) })
      );
    }

    const buttons = el('div', { class: 'settings__buttons' });
    if (phase === 'checking') {
      buttons.append(el('span', { class: 'spinner' }), el('span', { text: t('settings.updateChecking') }));
    } else {
      buttons.append(
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.updateNow'),
          onclick: () => void checkUpdates({ force: true })
        })
      );
    }
    buttons.append(
      el('button', {
        // Primary when there is something to fetch, quiet otherwise: the page is
        // always worth having, but on a current version it is not the point.
        class: phase === 'available' ? 'btn btn--primary' : 'btn btn--ghost',
        type: 'button',
        text: t('settings.updateReleasePage'),
        onclick: () => openReleasePage()
      })
    );
    wrapper.append(buttons);
    wrapper.append(el('span', { class: 'settings__hint', text: t('update.pageHint') }));
    return wrapper;
  }

  function render() {
    clear(body);
    for (const section of SECTIONS) {
      const group = el('section', { class: 'settings__group' }, [
        el('h3', { text: t(section.title) })
      ]);
      for (const rowInfo of section.rows) {
        if (rowInfo.type === 'check') group.append(checkFor(rowInfo));
        else if (rowInfo.type === 'update') group.append(updateBlock());
        else group.append(row(rowInfo.label, controlFor(rowInfo), rowInfo.hint));
      }
      body.append(group);
    }
    body.append(
      el('section', { class: 'settings__group' }, [
        el('h3', { text: t('settings.groupAbout') }),
        el('div', { class: 'settings__row' }, [
          el('span', { class: 'settings__label', text: t('settings.version') }),
          el('div', { class: 'settings__value' }, [
            el('span', { class: 'settings__note', text: state.update && state.update.current ? state.update.current : '' })
          ])
        ]),
        el('div', { class: 'settings__buttons' }, [
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: t('settings.aboutGithub'),
            // The repository is the one the update check asks, so the two can
            // never point at different projects.
            onclick: () => void api.shell.openExternal(repositoryUrl()).catch(() => {})
          }),
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: t('settings.aboutData'),
            onclick: () => void openDataFolder()
          })
        ])
      ])
    );
  }

  /**
   * The folder the settings and the logs live in.
   *
   * It is asked for by opening the settings file and then its folder, because
   * the window is not told any paths: the main process owns them, and a window
   * that never learns a path cannot be made to read one.
   */
  async function openDataFolder() {
    try {
      const target = await api.app.dataFolder();
      await api.shell.showItem(target);
    } catch (error) {
      onNotice?.(error.message, 'error');
    }
  }

  // ------------------------------------------------------------- the dialog

  function open() {
    state.open = true;
    overlay.hidden = false;
    render();
    body.querySelector('select, input')?.focus();
  }

  function close() {
    state.open = false;
    overlay.hidden = true;
  }

  function toggle(force) {
    const next = force === undefined ? !state.open : Boolean(force);
    if (next) open();
    else close();
  }

  /** Redraw from the file, unless somebody is typing in the form. */
  function refresh() {
    if (!state.open) return;
    if (overlay.contains(document.activeElement)) return;
    render();
  }

  // ------------------------------------------------------------ the updates

  async function checkUpdates({ force = false } = {}) {
    try {
      const next = await api.update.check({ force });
      applyUpdate(next);
      if ((next && next.phase) === 'current') onNotice?.(t('settings.updateCurrent', { version: next.version }));
    } catch (error) {
      onNotice?.(error.message, 'error');
    }
  }

  /**
   * Open the release page in the browser.
   *
   * The page is used whether or not a release was found: the address exists
   * either way, and "there is nothing there yet" is a thing a user may want to
   * see for themselves rather than be told.
   */
  function openReleasePage() {
    const url = state.update ? state.update.url || state.update.releasesUrl : '';
    if (!url) {
      onNotice?.(t('update.noPage'), 'error');
      return;
    }
    void api.shell.openExternal(url).catch((error) => onNotice?.(error.message, 'error'));
  }

  function applyUpdate(next) {
    if (!next) return;
    state.update = { ...(state.update || {}), ...next };
    if (state.open) render();
    renderPrompt();
  }

  /**
   * The offer of a new version, once per version per run.
   *
   * It is a window rather than a toast because it asks a question with two
   * answers, and a message that disappears after eight seconds is not a question.
   * Saying "later" is remembered for this run only: a version that is still new
   * after a restart is worth mentioning again.
   */
  function renderPrompt() {
    const update = state.update || {};
    if (update.phase !== 'available') {
      if (state.prompt) {
        state.prompt = false;
        updateOverlay.hidden = true;
      }
      return;
    }
    if (state.offered === update.version && !state.prompt) return;
    if (state.offered !== update.version) state.offered = update.version;
    state.prompt = true;
    updateOverlay.hidden = false;
    clear(updateBody);
    updateBody.append(
      el('p', {
        class: 'settings__note',
        text: t('update.available', { version: update.version, current: update.current || '' })
      })
    );
    if (update.notes) {
      updateBody.append(
        el('p', { class: 'settings__note', text: t('update.notes') }),
        el('pre', { class: 'update__notes', text: update.notes.slice(0, 1500) })
      );
    }
    if (update.message) updateBody.append(el('p', { class: 'settings__hint', text: update.message }));
    const buttons = el('div', { class: 'settings__buttons' });
    buttons.append(
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: t('update.releasePage'),
        onclick: () => openReleasePage()
      })
    );
    buttons.append(
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: t('update.later'),
        onclick: () => {
          state.prompt = false;
          updateOverlay.hidden = true;
        }
      })
    );
    updateBody.append(el('p', { class: 'settings__hint', text: t('update.pageHint') }));
    updateBody.append(buttons);
  }

  // ------------------------------------------------------------------ mount

  function mount() {
    clear(headActions);
    headActions.append(iconButton('close', t('settings.close'), () => close()));
    clear(updateHeadActions);
    updateHeadActions.append(iconButton('close', t('update.later'), () => {
      state.prompt = false;
      updateOverlay.hidden = true;
    }));
    // Clicking the dark area outside the panel closes it, like every other
    // surface in this window that covers the screen.
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });
    updateOverlay.addEventListener('pointerdown', (event) => {
      if (event.target === updateOverlay) {
        state.prompt = false;
        updateOverlay.hidden = true;
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });
    api.on('update:progress', (payload) => applyUpdate(payload));
    // The state may have been settled before this window was drawn: a check that
    // ran during startup would otherwise be announced to nobody.
    void api.update
      .state()
      .then((payload) => applyUpdate(payload))
      .catch(() => {});
  }

  return {
    mount,
    open,
    close,
    toggle,
    refresh,
    checkUpdates,
    isOpen: () => state.open,
    update: applyUpdate,
    state
  };
}