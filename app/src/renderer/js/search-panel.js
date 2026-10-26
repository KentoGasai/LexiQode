/*
 * Find in files.
 *
 * Results arrive in batches while the search is still running, so the list is
 * built incrementally and the header keeps saying how much has been looked at.
 * A search is cancellable at any moment: typing a wrong query and waiting for it
 * to finish is the single most annoying thing a search box can do.
 */

import { clear, debounce, el } from './ui.js';
import { t } from './i18n.js';

export function createSearchPanel({ api, bus, onOpen, onNotice, onOpenFolder }) {
  const host = document.getElementById('sidebar-body');
  const title = document.getElementById('sidebar-title');
  const actions = document.getElementById('sidebar-actions');

  const state = {
    query: '',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    include: '',
    running: false,
    results: [],
    byFile: new Map(),
    progress: null,
    searchId: 0
  };

  const input = el('input', {
    type: 'text',
    placeholder: t('search.field'),
    spellcheck: 'false',
    oninput: () => {
      state.query = input.value;
      schedule();
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') run();
      if (event.key === 'Escape') cancel();
    }
  });
  const includeInput = el('input', {
    type: 'text',
    placeholder: t('search.include'),
    spellcheck: 'false',
    oninput: () => {
      state.include = includeInput.value;
      schedule();
    }
  });
  const list = el('div');
  const summary = el('div', { class: 'list__empty', text: t('search.idle') });

  const options = [
    { key: 'caseSensitive', label: 'Aa', title: t('search.matchCase') },
    { key: 'wholeWord', label: 'ab', title: t('search.wholeWord') },
    { key: 'regex', label: '.*', title: t('search.regex') }
  ].map((option) =>
    el('button', {
      class: 'panel__tab',
      type: 'button',
      title: option.title,
      text: option.label,
      onclick: () => toggle(option.key)
    })
  );

  const optionsRow = el('div', { class: 'field__row' }, [
    ...options,
    el('span', { class: 'composer__spacer' }),
    el('span', { dataset: { role: 'progress' }, text: '' })
  ]);

  const fields = el('div', { class: 'field' }, [
    el('div', { class: 'field__row' }, [input]),
    el('div', { class: 'field__row' }, [includeInput]),
    optionsRow
  ]);

  function toggle(key) {
    state[key] = !state[key];
    for (let index = 0; index < options.length; index += 1) {
      const name = ['caseSensitive', 'wholeWord', 'regex'][index];
      options[index].setAttribute('aria-selected', String(state[name]));
    }
    schedule();
  }

  function progressText() {
    if (!state.progress) return state.running ? t('search.running') : '';
    const { filesScanned, total, limitHit } = state.progress;
    const parts = [
      total === 1 ? t('search.matchesOne', { count: total }) : t('search.matches', { count: total }),
      t('search.files', { count: filesScanned })
    ];
    if (limitHit) parts.push(t('search.limit'));
    return parts.join(' · ');
  }

  function renderProgress() {
    optionsRow.querySelector('[data-role="progress"]').textContent = progressText();
  }

  function cancel() {
    if (!state.running) return;
    void api.search.cancel(state.searchId).catch(() => {});
    state.running = false;
    renderProgress();
  }

  const schedule = debounce(() => run(), 260);

  async function run() {
    cancel();
    state.results = [];
    state.byFile = new Map();
    state.progress = null;
    clear(list);
    const query = state.query.trim();
    if (!query) {
      list.append(summary);
      renderProgress();
      return;
    }
    const searchId = ++state.searchId;
    state.searchId = searchId;
    state.running = true;
    renderProgress();
    try {
      await api.search.start(searchId, {
        query,
        regex: state.regex,
        caseSensitive: state.caseSensitive,
        wholeWord: state.wholeWord,
        include: state.include.trim() ? [state.include.trim()] : undefined
      });
    } catch (error) {
      state.running = false;
      renderProgress();
      onNotice?.(error.message, 'error');
    }
  }

  bus.on('search:batch', (payload) => {
    if (!payload || payload.searchId !== state.searchId) return;
    state.progress = payload.progress || state.progress;
    for (const match of payload.matches || []) {
      state.results.push(match);
      if (!state.byFile.has(match.path)) state.byFile.set(match.path, []);
      state.byFile.get(match.path).push(match);
    }
    renderResults();
    renderProgress();
  });

  bus.on('search:done', (payload) => {
    if (!payload || payload.searchId !== state.searchId) return;
    state.running = false;
    state.progress = payload;
    renderResults();
    renderProgress();
    if (payload.error) onNotice?.(payload.error, 'error');
  });

  function renderResults() {
    clear(list);
    if (!state.results.length) {
      list.append(el('div', { class: 'list__empty', text: state.running ? t('search.running') : t('search.none') }));
      return;
    }
    for (const [path, matches] of state.byFile) {
      const section = el('div', { class: 'section' });
      const head = el('div', { class: 'section__head' }, [
        el('span', { text: path }),
        el('span', { class: 'section__count', text: String(matches.length) })
      ]);
      let open = true;
      const body = el('div');
      head.addEventListener('click', () => {
        open = !open;
        body.hidden = !open;
      });
      section.append(head, body);
      for (const match of matches.slice(0, 40)) {
        const text = el('div', { class: 'hit__text' });
        const before = match.text.slice(0, Math.max(0, match.column - 1));
        const hit = match.text.slice(match.column - 1, match.column - 1 + match.length);
        const after = match.text.slice(match.column - 1 + match.length);
        text.append(document.createTextNode(before), el('mark', { text: hit }), document.createTextNode(after));
        const row = el('div', { class: 'hit', title: `${path}:${match.line}` }, [
          el('div', { class: 'hit__file', text: t('search.line', { line: match.line }) }),
          text,
          el('div', { class: 'hit__line', text: `:${match.line}` })
        ]);
        row.addEventListener('click', () =>
          onOpen(match.path, { line: match.line, column: match.column, length: match.length, highlight: true })
        );
        body.append(row);
      }
      if (matches.length > 40) {
        body.append(
          el('div', { class: 'list__empty', text: t('search.more', { count: matches.length - 40 }) })
        );
      }
      list.append(section);
    }
  }

  /**
   * What a view shows when there is no folder to work in.
   *
   * The core refuses to search outside a folder. Without this the view fell back
   * to the explorer, so pressing Search looked like a dead button: the sidebar
   * kept showing the file tree and nothing said why. One sentence and the one
   * button that fixes it is the honest answer.
   */
  function needsFolder(messageKey) {
    return el('div', { class: 'list__empty list__empty--action' }, [
      el('div', { text: t(messageKey) }),
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: t('view.openFolder'),
        onclick: () => onOpenFolder?.()
      })
    ]);
  }

  async function mount() {
    title.textContent = t('view.search');
    clear(actions);
    clear(host);
    const root = await api.workspace.current().catch(() => null);
    if (!root) {
      cancel();
      host.append(needsFolder('search.needsFolder'));
      return;
    }
    host.append(fields, list);
    list.append(summary);
    renderProgress();
    input.focus();
    input.select();
  }

  function unmount() {
    cancel();
  }

  return { mount, unmount, run, focus: () => input.focus() };
}