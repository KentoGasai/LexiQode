/*
 * Small helpers shared by the window's modules.
 *
 * Two habits here are deliberate.
 *
 * Text from anywhere except this file is inserted with `textContent`. The
 * window renders model output, file names, git subjects and terminal text, and
 * every one of them is text that something else chose; `innerHTML` is used only
 * for the icon set defined a few lines below and for the markdown renderer,
 * which escapes its input before it emits any tag.
 *
 * Long work is debounced or coalesced in one place instead of at each call
 * site, because a panel that re-renders on every keystroke is a panel that
 * flickers.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const ICONS = {
  files:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h6l2 2.5h5A1.5 1.5 0 0 1 20 7v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="6" r="2.4"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="12" r="2.4"/><path d="M7 8.4v7.2M9.4 6h3.1A2.5 2.5 0 0 1 15 8.5v1.2"/></svg>',
  spark:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z"/><path d="M18.5 16.5 19.2 19l2.3.7-2.3.8-.7 2.4-.7-2.4-2.3-.8 2.3-.7z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.4M12 18.6V21M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/></svg>',
  collapse:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 4v5H4M16 20v-5h4M4 9l5.5 5.5M20 15l-5.5-5.5"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 10 3 2-3 2M12.5 14.5H17"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 13 4.5 4.5L19 7"/></svg>',
  revert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9h9a5 5 0 0 1 0 10H8"/><path d="M8 5 4 9l4 4"/></svg>',
  branch:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4v16"/><circle cx="6" cy="8" r="2"/><path d="M6 12h6a4 4 0 0 0 4-4V6"/><circle cx="16" cy="4" r="2"/></svg>'
};

export function icon(name) {
  return ICONS[name] || '';
}

export function iconButton(name, title, onClick, extraClass = '') {
  return el('button', {
    class: `iconbtn ${extraClass}`.trim(),
    type: 'button',
    title,
    'aria-label': title,
    html: icon(name),
    onclick: onClick
  });
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A single toast per kind: a failing loop must not fill the screen. */
const activeToasts = new Map();
export function toast(kind, message, { timeout = 6000 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const key = `${kind}:${message}`;
  const existing = activeToasts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      existing.node.remove();
      activeToasts.delete(key);
    }, timeout);
    return;
  }
  const node = el('div', { class: 'toast', dataset: { kind }, text: message });
  host.append(node);
  const timer = setTimeout(() => {
    node.remove();
    activeToasts.delete(key);
  }, timeout);
  activeToasts.set(key, { node, timer });
}

/** A tiny emitter, so a module can react to another's change without imports. */
export function createBus() {
  const listeners = new Map();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) || []) {
        try {
          listener(payload);
        } catch (error) {
          console.error(`listener for ${event} failed`, error);
        }
      }
    }
  };
}