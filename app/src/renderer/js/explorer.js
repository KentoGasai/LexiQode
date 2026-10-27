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

import { clear, el, formatBytes, icon, iconButton, toast } from './ui.js';
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

export function createExplorer({ api, onOpen, onNotice, activePath, onToggleContext, isContextFile }) {
  const host = document.getElementById('sidebar-body');
  const actions = document.getElementById('sidebar-actions');
  const tree = el('div', { class: 'tree', dataset: { level: '' } });
  /** relative path -> children (null until read) */
  const cache = new Map();
  const expanded = new Set(['']);
  let root = null;
  let currentActive = activePath || '';
  /** True while a name is being typed in the tree. */
  let editing = false;
  /** A redraw that arrived while a name was being typed; it runs afterwards. */
  let pending = false;

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
    /*
     * A name being typed wins over a redraw.
     *
     * The tree is redrawn whenever the disk changes - the agent writes a file, a
     * build runs, or this module's own write is noticed a moment later - and a
     * redraw throws away the row being edited, field and all. That is what broke
     * Rename: the field was created, and the file event caused by the creation
     * itself arrived and wiped it, so the row went back to looking untouched. The
     * redraw is remembered and run as soon as the field is gone: nothing is lost,
     * it is only late.
     */
    if (editing) {
      pending = true;
      return;
    }
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

  /**
   * Do `work` with the tree protected from redraws, then catch up.
   *
   * Anything that changed on disk while the field was open is drawn afterwards,
   * which is what the pending flag above is for.
   */
  async function whileEditing(work) {
    editing = true;
    try {
      return await work();
    } finally {
      editing = false;
      if (pending) {
        pending = false;
        void refresh({ force: true });
      }
    }
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
        /*
         * A drawn chevron, not a glyph.
         *
         * The disclosure marker used to be the character '▸'/'▾' and the folder
         * marker '▣'. None of the three exists in the font the window renders tree
         * rows with, so all of them came out as empty squares: "why are folders
         * marked with squares" was the report, and the squares were missing
         * glyphs. The chevron points right while a folder is closed and down while
         * it is open - the direction says which way the folder will move - and the
         * folder is the same drawn outline the sidebar's own tab uses.
         */
        el('span', {
          class: 'tree__twisty',
          dataset: { open: String(item.directory ? isOpen : false) },
          html: item.directory ? icon('chevron') : ''
        }),
        item.directory
          ? el('span', { class: 'tree__icon', html: icon('files') })
          : el('span', { class: 'tree__icon', text: fileIcon(item.name) }),
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
        // The level is labelled so that a new item can be put inside this folder
        // without searching the whole tree for it. `levelFor` reads it back.
        const nested = el('div', { dataset: { level: item.path } });
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
   *
   * "Add to the assistant's context" sits beside Open, because it is an action
   * on the file the user is looking at and the composer's own row only ever
   * showed the file that happens to be in the editor.
   */
  function openRowMenu(item, point) {
    const attached = !item.directory && Boolean(isContextFile && isContextFile(item.path));
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
          {
            label: attached ? t('explorer.removeContext') : t('explorer.addContext'),
            run: () => onToggleContext && onToggleContext(item.path)
          },
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

  /** The element that holds the children of a folder, or null while it is closed. */
  function levelFor(relative) {
    if (!relative) return tree;
    for (const node of tree.querySelectorAll('[data-level]')) {
      if (node.dataset.level === relative) return node;
    }
    return null;
  }

  /** How deep a folder is, so a new row is indented like its neighbours. */
  function depthOf(relative) {
    return relative ? relative.split('/').length : 0;
  }

  /**
   * Read one typed name out of `input`, then hand it to `settle`.
   *
   * Enter takes the name, Escape abandons it, and moving the focus somewhere else
   * counts as abandoning: a field that stays in edit mode because the pointer
   * moved is a field that blocks the tree behind it.
   */
  function readName(input, settle) {
    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      settle(value);
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value.trim());
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish('');
      }
    });
    input.addEventListener('blur', () => finish(''));
  }

  /**
   * Create a file or a folder, with the name typed where it will appear.
   *
   * `window.prompt` is not implemented by Electron, so this used to do nothing at
   * all: the "+" button was pressed and no window, no field and no file ever
   * appeared. The field is drawn in the tree instead - on top of the folder's own
   * listing, the way a tree editor does it - which also keeps the name beside the
   * folder it is going into.
   */
  async function create(kind, parent = '') {
    if (!root) return;
    const folder = parent || (currentActive.includes('/') ? currentActive.slice(0, currentActive.lastIndexOf('/')) : '');
    // A closed folder is opened first: a new item inside a folder nobody can see
    // is a creation that looks like nothing happened.
    if (folder && !expanded.has(folder)) {
      expanded.add(folder);
      await refresh();
    }
    const container = levelFor(folder);
    if (!container) return;
    const input = el('input', {
      class: 'tree__input',
      type: 'text',
      value: '',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: t(kind === 'file' ? 'explorer.newFileName' : 'explorer.newFolderName')
    });
    const row = el(
      'div',
      {
        class: 'tree__row tree__row--editing',
        style: { paddingLeft: `${6 + depthOf(folder) * 12}px` }
      },
      [el('span', { class: 'tree__twisty' }), el('span', { class: 'tree__icon' }), input]
    );
    container.insertBefore(row, container.firstChild);
    const name = await whileEditing(
      () =>
        new Promise((resolve) => {
          readName(input, (value) => {
            row.remove();
            resolve(value);
          });
          input.focus();
        })
    );
    if (!name) return;
    try {
      const created = kind === 'file'
        ? await api.workspace.createFile(folder, name)
        : await api.workspace.createFolder(folder, name);
      invalidate();
      if (created.directory) expanded.add(created.path);
      await refresh();
      if (!created.directory) onOpen(created.path);
      onNotice?.(t('explorer.created', { path: created.path }));
    } catch (error) {
      toast('error', error.message);
    }
  }

  /** Rename in place: the field takes the row's label, and the name stays visible. */
  async function rename(path, current) {
    const row = [...tree.querySelectorAll('.tree__row')].find((node) => node.dataset.path === path);
    const label = row ? row.querySelector('.tree__label') : null;
    if (!row || !label) return;
    const input = el('input', {
      class: 'tree__input',
      type: 'text',
      value: current,
      spellcheck: 'false',
      autocomplete: 'off',
      title: t('explorer.renamePrompt')
    });
    label.replaceWith(input);
    const name = await whileEditing(
      () =>
        new Promise((resolve) => {
          readName(input, (value) => {
            input.replaceWith(label);
            resolve(value);
          });
          input.focus();
          input.select();
        })
    );
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