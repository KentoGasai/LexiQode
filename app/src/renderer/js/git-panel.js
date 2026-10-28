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
import { t } from './i18n.js';
import { menuPoint, openContextMenu } from './context-menu.js';

/**
 * The three remote actions, each with the words it needs.
 *
 * Written as literal keys so the dictionary test can see them: a key built from
 * a variable is invisible to that test, and a missing one shows the raw key in
 * the window instead of a sentence.
 */
const SYNC = {
  fetch: {
    label: 'git.fetch',
    hint: 'git.fetchHint',
    running: 'git.fetchRunning',
    done: 'git.fetchDone',
    failed: 'git.fetchFailed'
  },
  pull: {
    label: 'git.pull',
    hint: 'git.pullHint',
    running: 'git.pullRunning',
    done: 'git.pullDone',
    failed: 'git.pullFailed'
  },
  push: {
    label: 'git.push',
    hint: 'git.pushHint',
    running: 'git.pushRunning',
    done: 'git.pushDone',
    failed: 'git.pushFailed'
  }
};

export function createGitPanel({ api, onOpenDiff, onOpenCommit, onNotice, onOpenFolder }) {
  const host = document.getElementById('sidebar-body');
  const title = document.getElementById('sidebar-title');
  const actions = document.getElementById('sidebar-actions');

  let status = null;
  let commits = [];
  /** Which remote action is running, so its button can say so and refuse a second press. */
  let busy = '';
  const message = el('textarea', { rows: '2', placeholder: t('git.commitPlaceholder') });
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
          ? iconButton('revert', t('git.unstage'), (event) => {
              event.stopPropagation();
              void act(() => api.git.unstage([name]), t('git.unstagedNotice', { path: name }));
            })
          : iconButton('check', t('git.stage'), (event) => {
              event.stopPropagation();
              void act(() => api.git.stage([name]), t('git.stagedNotice', { path: name }));
            }),
        iconButton('close', t('git.discard'), (event) => {
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
      message: t('git.discardConfirm', { path }),
      detail: t('git.discardDetail'),
      danger: true,
      confirmLabel: t('git.discardAction')
    });
    if (confirmed) await act(() => api.git.discard([path]), t('git.discardedNotice', { path }));
  }

  async function commit() {
    const text = message.value.trim();
    if (!text) {
      toast('warn', t('git.commitNeedsMessage'));
      return;
    }
    if (!status || !status.staged.length) {
      toast('warn', t('git.nothingStaged'));
      return;
    }
    try {
      const result = await api.git.commit(text);
      if (!result.ok) {
        toast('error', (result.stderr || 'commit failed').trim().split('\n')[0]);
        return;
      }
      message.value = '';
      onNotice?.(t('git.committed', { count: status.staged.length }), 'ok');
      await refresh();
    } catch (error) {
      toast('error', error.message);
    }
  }

  /**
   * Fetch, pull or push, with the button that was pressed saying so.
   *
   * These are the three actions that talk to a remote, and each can take long
   * enough that a silent button reads as a broken one: the button is disabled
   * and relabelled while the command runs, and the first line of whatever git
   * said is shown either way. A refusal is not swallowed - "no upstream",
   * "rejected", "authentication failed" are the whole answer to why a push did
   * not happen, and hiding them behind a generic message is how a person
   * concludes the button does nothing.
   *
   * The keys are written out rather than built from the action's name, because a
   * key assembled at runtime is a key no test can see: a typo in it would show
   * the raw key in the window and nothing would fail.
   */
  async function sync(kind) {
    if (busy) return;
    const words = SYNC[kind];
    if (!words) return;
    busy = kind;
    render();
    try {
      const result = await api.git[kind]();
      const said = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n').filter(Boolean);
      if (result.ok) {
        onNotice?.(t(words.done), 'ok');
      } else {
        toast('error', said[0] || t(words.failed));
      }
      await refresh();
    } catch (error) {
      toast('error', error.message);
    } finally {
      busy = '';
      render();
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
            text: t('git.stageAll'),
            onclick: () =>
              void act(() => api.git.stage(entries.map((entry) => entry.path)), t('git.stagedAll'))
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

  /**
   * What the panel shows when there is no folder to read a repository from.
   *
   * git is asked inside the open folder, so with none open its own answer is a
   * sentence in English. The panel says it in the window's language and offers
   * the action that makes the panel work, instead of leaving the previous view
   * on screen as if the button had not been pressed.
   */
  function needsFolder() {
    return el('div', { class: 'list__empty list__empty--action' }, [
      el('div', { text: t('git.needsFolder') }),
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: t('view.openFolder'),
        onclick: () => onOpenFolder?.()
      })
    ]);
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
      const reason = status.reason || '';
      // "no folder is open" is the core's phrasing for a state the window has a
      // better answer to; anything else git said is passed through as it is.
      host.append(/no folder/i.test(reason) ? needsFolder() : el('div', { class: 'list__empty', text: reason || t('git.noRepo') }));
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
      el('span', { class: 'git__branch', text: status.branch || t('git.noBranch') }),
      el('span', {
        class: 'section__count',
        text: [status.ahead ? `↑${status.ahead}` : '', status.behind ? `↓${status.behind}` : '']
          .filter(Boolean)
          .join(' ')
      }),
      iconButton('branch', t('git.branchPrompt'), (event) => void switchBranch(event)),
      iconButton('refresh', t('git.refresh'), () => void refresh())
    ]);
    host.append(branch, syncRow(), el('div', { class: 'commit' }, [message]));

    const stagedEntries = status.entries.filter((entry) => status.staged.includes(entry.path) || entry.kind === 'staged');
    const changedEntries = status.entries.filter((entry) => !stagedEntries.includes(entry));
    const staged = group(t('git.staged'), stagedEntries, 'staged');
    const changed = group(t('git.changes'), changedEntries, 'unstaged');
    if (staged) host.append(staged);
    if (changed) host.append(changed);
    if (!stagedEntries.length && !changedEntries.length) {
      host.append(el('div', { class: 'list__empty', text: t('git.clean') }));
    }
    if (commits.length) {
      const section = el('div', { class: 'section' });
      section.append(el('div', { class: 'section__head' }, [el('span', { text: t('git.recentCommits') })]));
      for (const entry of commits) {
        // A commit is a button, not a label: the change behind it is the reason
        // the list is there, and a row that cannot be opened is a dead end.
        const row = el('button', {
          class: 'hit hit--button',
          type: 'button',
          title: t('git.openCommit', { hash: entry.short }),
          onclick: () => onOpenCommit?.(entry)
        }, [
          el('div', { class: 'hit__file', text: `${entry.short} · ${entry.author} · ${entry.when}` }),
          el('div', { class: 'hit__text', text: entry.subject })
        ]);
        section.append(row);
      }
      host.append(section);
    }
  }

  /**
   * The three actions that talk to a remote, on one row.
   *
   * They are grouped and labelled rather than hidden behind an icon, because
   * "push" and "pull" are the two things a person comes to this panel to do and
   * an unlabelled arrow is a guess. The one that is running says so and refuses
   * a second press, so a slow network cannot be mistaken for a dead button.
   */
  function syncRow() {
    const button = (kind) => {
      const words = SYNC[kind];
      return el('button', {
        class: 'btn btn--ghost git__sync',
        type: 'button',
        text: busy === kind ? t(words.running) : t(words.label),
        title: t(words.hint),
        disabled: Boolean(busy),
        onclick: () => void sync(kind)
      });
    };
    return el('div', { class: 'git__syncrow' }, [button('fetch'), button('pull'), button('push')]);
  }

  /**
   * Pick a branch from a menu, rather than typing its number.
   *
   * This was `window.prompt` with a numbered list, and Electron does not implement
   * `window.prompt`: it returned null without showing anything, so switching a
   * branch did nothing and read as broken. The menu also removes the counting: a
   * branch is chosen by its name.
   */
  async function switchBranch(event) {
    const result = await api.git.branches();
    if (!result.ok) {
      toast('error', result.error || 'could not list branches');
      return;
    }
    const list = result.branches;
    if (!list.length) {
      toast('info', t('git.noBranches'));
      return;
    }
    const point = event ? menuPoint(event) : { x: 0, y: 0 };
    openContextMenu({
      ...point,
      label: t('git.branchPrompt'),
      items: list.map((branch) => ({
        label: branch.current ? t('git.branchCurrent', { name: branch.name }) : branch.name,
        // The branch that is already checked out is shown, not offered: choosing it
        // would be a command that does nothing.
        run: branch.current
          ? () => {}
          : () => void act(() => api.git.checkout(branch.name), t('git.onBranch', { name: branch.name }))
      }))
    });
  }

  function mount() {
    title.textContent = t('view.git');
    clear(actions);
    actions.append(iconButton('refresh', t('git.refresh'), () => void refresh()));
    clear(host);
    host.append(el('div', { class: 'list__empty', text: t('git.reading') }));
    void refresh();
  }

  return { mount, refresh, get status() { return status; } };
}