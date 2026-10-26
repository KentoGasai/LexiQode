/*
 * The file tree.
 *
 * The tree is built lazily: a folder's children are read when it is first
 * opened and cached until something changes inside it. A large repository is
 * then cheap to show, and the cost of a folder the user never opens is never
 * paid. The cache is invalidated wholesale on a write, which is the honest
 * choice - a file can be created by a shell command or the agent, and a tree
 * that guesses wrong looks broken.
 */

import { clear, el, formatBytes, iconButton, toast } from './ui.js';

const FILE_ICONS = [
  ['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.ts', 'ts'], ['.tsx', 'ts'],
  ['.json', '{}'], ['.md', 'md'], ['.css', '#'], ['.html', '<>'], ['.py', 'py'],
  ['.yml', 'y'], ['.yaml', 'y'], ['.toml', 'c'], ['.sh', '$'], ['.ps1', '>_'],
  ['.sql', 'db'], ['.rs', 'rs'], ['.go', 'go'], ['.java', 'j'], ['.cs', 'c#'],
  ['.txt', 'tx'], ['.svg', 'sv'], ['.xml', '<>']
];

function fileIcon(name) {
  const lower = name.toLowerCase();
  for (const [suffix, glyph] of FILE_ICONS) if (lower.endsWith(suffix)) return glyph;
  return '·';
}

export function createExplorer({ api, onOpen, onNotice, activePath }) {
  const host = document.getElementById('sidebar-body');
  const actions = document.getElementById('sidebar-actions');
  const tree = el('div', { class: 'tree' });
  /** relative path -> children (null until read) */
  const cache = new Map();
  const expanded = new Set(['']);
  let root = null;
  let currentActive = activePath || '';

  function invalidate() {
    cache.clear();
  }

  async function children(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const items = await api.workspace.tree(relative);
    cache.set(relative, items);
    return items;
  }

  async function refresh({ keepExpanded = true } = {}) {
    root = await api.workspace.current();
    clear(host);
    if (!root) {
      host.append(el('div', { class: 'list__empty', text: 'No folder is open. Use File ▸ Open Folder.' }));
      renderActions();
      return;
    }
    if (!keepExpanded) expanded.clear().add('');
    tree.replaceChildren();
    host.append(tree);
    renderActions();
    await renderLevel('', tree, 0);
  }

  function renderActions() {
    clear(actions);
    if (!root) return;
    actions.append(
      iconButton('plus', 'New file', () => create('file')),
      iconButton('plus', 'New folder', () => create('folder')),
      iconButton('refresh', 'Refresh', () => refresh({ keepExpanded: true })),
      iconButton('collapse', 'Collapse all', async () => {
        expanded.clear();
        expanded.add('');
        await refresh();
      })
    );
  }

  async function renderLevel(relative, container, depth) {
    let items = [];
    try {
      items = await children(relative);
    } catch (error) {
      container.append(el('div', { class: 'list__empty', text: error.message }));
      return;
    }
    if (!items.length && depth === 0) {
      container.append(el('div', { class: 'list__empty', text: 'This folder is empty.' }));
      return;
    }
    for (const item of items) {
      const isOpen = expanded.has(item.path);
      const row = el('div', {
        class: 'tree__row',
        dataset: {
          path: item.path,
          kind: item.directory ? 'folder' : 'file',
          active: String(item.path === currentActive)
        },
        style: { paddingLeft: `${6 + depth * 12}px` },
        title: item.directory ? item.path : `${item.path} · ${formatBytes(item.size)}`,
        onclick: (event) => handleClick(event, item)
      });
      row.append(
        el('span', { class: 'tree__twisty', text: item.directory ? (isOpen ? '▾' : '▸') : '' }),
        el('span', { class: 'tree__icon', text: item.directory ? '▣' : fileIcon(item.name) }),
        el('span', { class: 'tree__label', text: item.name })
      );
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        void handleContext(item);
      });
      container.append(row);
      if (item.directory && isOpen) {
        const nested = el('div');
        container.append(nested);
        await renderLevel(item.path, nested, depth + 1);
      }
    }
  }

  async function handleClick(event, item) {
    if (item.directory) {
      if (expanded.has(item.path)) expanded.delete(item.path);
      else expanded.add(item.path);
      await refresh();
      return;
    }
    onOpen(item.path, event.altKey ? { beside: true } : {});
  }

  async function handleContext(item) {
    const choices = item.directory
      ? ['New file', 'New folder', 'Rename', 'Reveal in Explorer', 'Delete']
      : ['Open', 'Rename', 'Reveal in Explorer', 'Delete'];
    const answer = window.prompt(`${item.path}\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}`, '1');
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > choices.length) return;
    const choice = choices[index - 1];
    try {
      if (choice === 'Open') onOpen(item.path);
      else if (choice === 'New file') await create('file', item.path);
      else if (choice === 'New folder') await create('folder', item.path);
      else if (choice === 'Rename') await rename(item.path, item.name);
      else if (choice === 'Reveal in Explorer') await api.workspace.reveal(item.path);
      else if (choice === 'Delete') await remove(item.path);
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function create(kind, parent = '') {
    const target = parent || (currentActive.includes('/') ? currentActive.slice(0, currentActive.lastIndexOf('/')) : '');
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name', '');
    if (!name) return;
    try {
      const created = kind === 'file'
        ? await api.workspace.createFile(target, name)
        : await api.workspace.createFolder(target, name);
      invalidate();
      expanded.add(created.path);
      await refresh();
      if (!created.directory) onOpen(created.path);
      onNotice?.(`created ${created.path}`);
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function rename(path, current) {
    const name = window.prompt('Rename', current);
    if (!name || name === current) return;
    try {
      const result = await api.workspace.rename(path, name);
      invalidate();
      await refresh();
      onNotice?.(`renamed to ${result.to}`);
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function remove(path) {
    const confirmed = await api.dialogs.confirm({
      message: `Move ${path} to the recycle bin?`,
      detail: 'The item can be restored from the recycle bin.',
      danger: true,
      confirmLabel: 'Move to bin'
    });
    if (!confirmed) return;
    try {
      await api.workspace.remove(path);
      invalidate();
      await refresh();
      onNotice?.(`removed ${path}`);
    } catch (error) {
      toast('error', error.message);
    }
  }

  function setActive(path) {
    currentActive = path || '';
    for (const row of tree.querySelectorAll('.tree__row')) {
      row.dataset.active = String(row.dataset.path === currentActive);
    }
  }

  /** Every file, for the quick-open picker. */
  async function files() {
    if (!root) return [];
    try {
      return await api.workspace.index();
    } catch (error) {
      toast('error', error.message);
      return [];
    }
  }

  /** Open the folders leading to a file, so a revealed file is visible. */
  async function reveal(path) {
    if (!path || !path.includes('/')) return;
    const parts = path.split('/').slice(0, -1);
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      expanded.add(prefix);
    }
    setActive(path);
    await refresh();
  }

  return { refresh, files, invalidate, setActive, reveal, get root() { return root; } };
}