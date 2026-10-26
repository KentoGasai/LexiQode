/*
 * The right-click menu.
 *
 * What a right-click did before this file existed: it asked the question in a
 * `window.prompt` - "choose an action" followed by a numbered list - which is
 * technically a menu and practically not one. A browser prompt cannot be
 * dismissed by clicking away, cannot carry a dangerous action in red, cannot
 * show what is unavailable, and blocks the window while it is open.
 *
 * One menu exists at a time, and it closes on a click anywhere, on Escape, on a
 * scroll and on a resize. The position is clamped to the window so a right-click
 * near the bottom edge does not open a menu the user cannot reach.
 */

import { el } from './ui.js';

let current = null;

export function closeContextMenu() {
  if (!current) return;
  const { node, onKey, onPointer, onResize } = current;
  current = null;
  node.remove();
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPointer, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', onResize);
}

/**
 * Open a menu at a point, with the items it was given.
 *
 * An item is `{ label, run, danger, disabled }` or `{ separator: true }`.
 * `run` is awaited, so an action that talks to the main process keeps the menu
 * closed while it works instead of reopening on a stray event.
 */
export function openContextMenu({ x = 0, y = 0, items = [], label = '' } = {}) {
  closeContextMenu();
  const node = el('div', { class: 'ctxmenu', role: 'menu', 'aria-label': label });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      node.append(el('div', { class: 'ctxmenu__separator' }));
      continue;
    }
    node.append(
      el('button', {
        class: `ctxmenu__item${item.danger ? ' ctxmenu__item--danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: Boolean(item.disabled),
        text: item.label,
        onclick: () => {
          closeContextMenu();
          const result = item.run ? item.run() : undefined;
          if (result && typeof result.catch === 'function') result.catch(() => {});
        }
      })
    );
  }
  if (!node.childElementCount) return null;

  document.body.append(node);
  const size = node.getBoundingClientRect();
  node.style.left = `${Math.max(4, Math.min(Math.round(x), window.innerWidth - size.width - 4))}px`;
  node.style.top = `${Math.max(4, Math.min(Math.round(y), window.innerHeight - size.height - 4))}px`;

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContextMenu();
    }
  };
  const onPointer = (event) => {
    if (!node.contains(event.target)) closeContextMenu();
  };
  const onResize = () => closeContextMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);

  current = { node, onKey, onPointer, onResize };
  const first = node.querySelector('.ctxmenu__item:not([disabled])');
  first?.focus();
  return node;
}

/** A pointer position from a mouse event, for the callers that have one. */
export function menuPoint(event) {
  return { x: event.clientX, y: event.clientY };
}