/*
 * Source control.
 *
 * The panel reflects git rather than modelling it: it asks for status, renders
 * what came back, and re-asks after every action. Nothing is remembered between
 * refreshes, so a commit made in a terminal shows up here as soon as the panel
 * refreshes instead of being contradicted by stale state.
 *
 * Staged and unstaged changes are separate lists on purpose, because that is
 * what the index is, and a single list would hide the one thing a person checks
 * before committing: what is actually about to be committed.
 */

import { clear, el, iconButton, toast } from './ui.js';

export function createGitPanel({ api, onOpenDiff, onNotice }) {
  const host = document.getElementById('sidebar-body');
  const title = document.getElementById('sidebar-title');
  const actions = document.getElementById('sidebar-actions');

  let status = null;
  let commits = [];
  const message = el('textarea', { rows: '2', placeholder: 'Commit message (Ctrl+Enter to commit)' });
  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void commit();
    }
  });

  function row(entry, side) {
    const name = entry.path;
    const cut = name.lastIndexOf('/');
    const directory = cut === -1 ? '' : name.slice(0, cut + 1);
    const base = cut === -1 ? name : name.slice(cut + 1);
    const glyph = { staged: 'M', modified: 'M', untracked: 'U', conflicted: '!' }[entry.kind] || '?';
    const line = el('div', { class: 'git__row', title: `${name}${entry.renamedFrom ? ` (from ${entry.renamedFrom})` : ''}` }, [
      el('span', { class: 'git__status', dataset: { kind: entry.kind }, text: glyph }),
      el('span', { class: 'git__name' }, [
        directory ? el('span', { class: 'git__dir', text: directory }) : null,
        document.createTextNode(base)
      ]),
      el('span', { class: 'git__actions' }, [
        side === 'staged'
          ? iconButton('revert', 'Unstage', (event) => {
              event.stopPropagation();
              void act(() => api.git.unstage([name]), `unstaged ${name}`);
            })
          : iconButton('check', 'Stage', (event) => {
              event.stopPropagation();
              void act(() => api.git.stage([name]), `staged ${name}`);
            }),
        iconButton('close', 'Discard changes', (event) => {
          event.stopPropagation();
          void discard(name);
        })
      ])
    ]);
    line.addEventListener('click', () => onOpenDiff(name, { staged: side === 'staged' }));
    return line;
  }

  async function act(action, notice) {
    try {
      const result = await action();
      if (result && result.ok === false) {
        toast('error', (result.stderr || 'git refused that').trim().split('\n')[0]);
      } else if (notice) {
        onNotice?.(notice, 'ok');
      }
      await refresh();
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function discard(path) {
    const confirmed = await api.dialogs.confirm({
      message: `Discard changes in ${path}?`,
      detail: 'This cannot be undone: the file returns to its last committed state.',
      danger: true,
      confirmLabel: 'Discard'
    });
    if (confirmed) await act(() => api.git.discard([path]), `discarded changes in ${path}`);
  }

  async function commit() {
    const text = message.value.trim();
    if (!text) {
      toast('warn', 'a commit message is required');
      return;
    }
    if (!status || !status.staged.length) {
      toast('warn', 'nothing is staged');
      return;
    }
    try {
      const result = await api.git.commit(text);
      if (!result.ok) {
        toast('error', (result.stderr || 'commit failed').trim().split('\n')[0]);
        return;
      }
      message.value = '';
      onNotice?.(`committed ${status.staged.length} file(s)`, 'ok');
      await refresh();
    } catch (error) {
      toast('error', error.message);
    }
  }

  function group(label, entries, side) {
    if (!entries.length) return null;
    const section = el('div', { class: 'section' });
    const head = el('div', { class: 'section__head' }, [
      el('span', { text: label }),
      el('span', { class: 'section__count', text: String(entries.length) }),
      side === 'unstaged' && entries.length > 1
        ? el('button', {
            class: 'panel__tab',
            type: 'button',
            text: 'stage all',
            onclick: () => void act(() => api.git.stage(entries.map((entry) => entry.path)), 'staged everything')
          })
        : null
    ]);
    let open = true;
    const body = el('div');
    head.addEventListener('click', () => {
      open = !open;
      body.hidden = !open;
    });
    for (const entry of entries) body.append(row(entry, side));
    section.append(head, body);
    return section;
  }

  async function refresh() {
    if (!host.isConnected) return;
    clear(host);
    try {
      status = await api.git.status();
    } catch (error) {
      host.append(el('div', { class: 'list__empty', text: error.message }));
      return;
    }
    if (!status.repo) {
      host.append(
        el('div', { class: 'list__empty', text: status.reason || 'This folder is not a git repository.' })
      );
      return;
    }
    commits = [];
    try {
      const log = await api.git.log(12);
      commits = log.commits || [];
    } catch {
      commits = [];
    }
    render();
  }

  function render() {
    clear(host);
    const branch = el('div', { class: 'field' }, [
      el('span', { class: 'git__branch', text: status.branch || '(no branch)' }),
      el('span', {
        class: 'section__count',
        text: [status.ahead ? `↑${status.ahead}` : '', status.behind ? `↓${status.behind}` : '']
          .filter(Boolean)
          .join(' ')
      }),
      iconButton('branch', 'Switch branch', () => void switchBranch()),
      iconButton('refresh', 'Refresh', () => void refresh())
    ]);
    host.append(branch, el('div', { class: 'commit' }, [message])); 

    const stagedEntries = status.entries.filter((entry) => status.staged.includes(entry.path) || entry.kind === 'staged');
    const changedEntries = status.entries.filter((entry) => !stagedEntries.includes(entry));
    const staged = group('Staged', stagedEntries, 'staged');
    const changed = group('Changes', changedEntries, 'unstaged');
    if (staged) host.append(staged);
    if (changed) host.append(changed);
    if (!stagedEntries.length && !changedEntries.length) {
      host.append(el('div', { class: 'list__empty', text: 'Working tree clean.' }));
    }
    if (commits.length) {
      const section = el('div', { class: 'section' });
      section.append(el('div', { class: 'section__head' }, [el('span', { text: 'Recent commits' })]));
      for (const entry of commits) {
        section.append(
          el('div', { class: 'hit', title: entry.hash }, [
            el('div', { class: 'hit__file', text: `${entry.short} · ${entry.author} · ${entry.when}` }),
            el('div', { class: 'hit__text', text: entry.subject })
          ])
        );
      }
      host.append(section);
    }
  }

  async function switchBranch() {
    const result = await api.git.branches();
    if (!result.ok) {
      toast('error', result.error || 'could not list branches');
      return;
    }
    const list = result.branches;
    const answer = window.prompt(
      `Checkout which branch?\n\n${list.map((branch, index) => `${index + 1}. ${branch.name}${branch.current ? ' (current)' : ''}`).join('\n')}`,
      String(Math.max(1, list.findIndex((branch) => branch.current) + 1))
    );
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > list.length) return;
    const target = list[index - 1];
    if (target.current) return;
    await act(() => api.git.checkout(target.name), `on ${target.name}`);
  }

  function mount() {
    title.textContent = 'Source Control';
    clear(actions);
    actions.append(iconButton('refresh', 'Refresh status', () => void refresh()));
    clear(host);
    host.append(el('div', { class: 'list__empty', text: 'Reading git…' }));
    void refresh();
  }

  return { mount, refresh, get status() { return status; } };
}