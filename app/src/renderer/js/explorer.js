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
import { t } from './i18n.js';
import { menuPoint, openContextMenu } from './context-menu.js';

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

  /**
   * Draw the tree.
   *
   * `force` re-reads what is on screen instead of trusting the cache. It is what
   * a user asking for a refresh means, and it matters because this tree is not
   * the only thing that writes: the agent edits files through the core, a shell
   * command in the terminal creates them, and neither goes through this module -
   * so its own writes cannot be the only trigger for a re-read.
   */
  async function refresh({ keepExpanded = true, force = false } = {}) {
    const next = await api.workspace.current();
    // A cache of one folder's children is worthless for another folder, and
    // this is the only place that notices the difference: the tree was drawn
    // from the previous folder's cached listing after a folder switch, so
    // opening a repository showed whatever had been open before it.
    if (force || (next ? next.root : null) !== (root ? root.root : null)) {
      invalidate();
      if ((next ? next.root : null) !== (root ? root.root : null) || !keepExpanded) {
        expanded.clear();
        expanded.add('');
      }
    }
    root = next;
    document.getElementById('sidebar-title').textContent = t('view.explorer');
    clear(host);
    if (!root) {
      host.append(el('div', { class: 'list__empty', text: t('explorer.noFolder') }));
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
      iconButton('plus', t('explorer.newFile'), () => create('file')),
      iconButton('plus', t('explorer.newFolder'), () => create('folder')),
      iconButton('refresh', t('explorer.refresh'), () => refresh({ force: true })),
      iconButton('collapse', t('explorer.collapse'), async () => {
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
      container.append(el('div', { class: 'list__empty', text: t('explorer.empty') }));
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
        // The container below has its own menu for empty space; a row must not
        // open both.
        event.stopPropagation();
        openRowMenu(item, menuPoint(event));
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

  /** The absolute path of a row, for the two "copy path" actions. */
  function absolute(relative) {
    const base = root ? root.root : '';
    const separator = api.platform === 'win32' ? '\\' : '/';
    return `${base}${separator}${String(relative).split('/').join(separator)}`;
  }

  async function copy(text, note) {
    try {
      await api.clipboard.write(text);
      onNotice?.(t(note, { value: text }));
    } catch (error) {
      toast('error', error.message);
    }
  }

  /**
   * A right-click on a row: what can be done with this file or folder.
   *
   * Ordered the way the actions are used rather than the way they are
   * implemented: open, look at it on disk, take its path, then the operations
   * that change it, with the one that destroys something last and red.
   */
  function openRowMenu(item, point) {
    const items = item.directory
      ? [
          { label: t('explorer.newFile'), run: () => create('file', item.path) },
          { label: t('explorer.newFolder'), run: () => create('folder', item.path) },
          { separator: true },
          { label: t('explorer.reveal'), run: () => api.workspace.reveal(item.path) },
          { label: t('explorer.copyPath'), run: () => copy(absolute(item.path), 'explorer.copiedPath') },
          {
            label: t('explorer.copyRelativePath'),
            run: () => copy(item.path, 'explorer.copiedRelativePath')
          },
          { separator: true },
          { label: t('explorer.rename'), run: () => rename(item.path, item.name) },
          { label: t('explorer.delete'), danger: true, run: () => remove(item.path) }
        ]
      : [
          { label: t('explorer.open'), run: () => onOpen(item.path) },
          { label: t('explorer.openBeside'), run: () => onOpen(item.path, { beside: true }) },
          { separator: true },
          { label: t('explorer.reveal'), run: () => api.workspace.reveal(item.path) },
          { label: t('explorer.copyPath'), run: () => copy(absolute(item.path), 'explorer.copiedPath') },
          {
            label: t('explorer.copyRelativePath'),
            run: () => copy(item.path, 'explorer.copiedRelativePath')
          },
          { separator: true },
          { label: t('explorer.rename'), run: () => rename(item.path, item.name) },
          { label: t('explorer.delete'), danger: true, run: () => remove(item.path) }
        ];
    openContextMenu({ ...point, items, label: item.path });
  }

  /** A right-click on the empty part of the tree: about the folder itself. */
  function openRootMenu(point) {
    if (!root) return;
    openContextMenu({
      ...point,
      label: root.root,
      items: [
        { label: t('explorer.newFile'), run: () => create('file', '') },
        { label: t('explorer.newFolder'), run: () => create('folder', '') },
        { separator: true },
        { label: t('explorer.revealFolder'), run: () => api.workspace.reveal('') },
        { label: t('explorer.copyPath'), run: () => copy(root.root, 'explorer.copiedPath') },
        { separator: true },
        { label: t('explorer.refresh'), run: () => refresh({ force: true }) }
      ]
    });
  }

  async function create(kind, parent = '') {
    const target = parent || (currentActive.includes('/') ? currentActive.slice(0, currentActive.lastIndexOf('/')) : '');
    const name = window.prompt(kind === 'file' ? t('explorer.newFileName') : t('explorer.newFolderName'), '');
    if (!name) return;
    try {
      const created = kind === 'file'
        ? await api.workspace.createFile(target, name)
        : await api.workspace.createFolder(target, name);
      invalidate();
      expanded.add(created.path);
      await refresh();
      if (!created.directory) onOpen(created.path);
      onNotice?.(t('explorer.created', { path: created.path }));
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function rename(path, current) {
    const name = window.prompt(t('explorer.renamePrompt'), current);
    if (!name || name === current) return;
    try {
      const result = await api.workspace.rename(path, name);
      invalidate();
      await refresh();
      onNotice?.(t('explorer.renamed', { path: result.to }));
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function remove(path) {
    const confirmed = await api.dialogs.confirm({
      message: t('explorer.deleteConfirm', { path }),
      detail: t('explorer.deleteDetail'),
      danger: true,
      confirmLabel: t('explorer.deleteAction')
    });
    if (!confirmed) return;
    try {
      await api.workspace.remove(path);
      invalidate();
      await refresh();
      onNotice?.(t('explorer.removed', { path }));
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

  /**
   * The empty part of the sidebar: the folder itself, not a file in it.
   *
   * Bound to the container rather than to each drawing of the tree, because the
   * tree is rebuilt on every refresh and a listener per render would accumulate.
   */
  host.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!event.target || event.target.closest('.tree__row')) return;
    openRootMenu(menuPoint(event));
  });

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