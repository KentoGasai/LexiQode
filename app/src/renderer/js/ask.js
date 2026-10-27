/*
 * Asking for one line of text.
 *
 * Electron does not implement `window.prompt`: it returns null without showing
 * anything at all. Every place that used it - creating a file, renaming one,
 * renaming a chat, choosing a branch - therefore did nothing whatsoever, and
 * "the + button does not work" was the report. This is the window's own field:
 * one input, Enter to accept, Escape to abandon, and a click outside counts as
 * abandoning too, so nothing is created because the pointer moved.
 *
 * The tree asks inside the tree instead (see `explorer.js`): a name belongs next
 * to the thing being named. This dialog is for the names that have no row to sit
 * in, such as the title of a chat.
 */

import { el } from './ui.js';
import { t } from './i18n.js';

export function askText({ title, value = '', placeholder = '', confirm = '' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'ask__input',
      type: 'text',
      value,
      placeholder,
      spellcheck: 'false',
      autocomplete: 'off'
    });
    const box = el('div', { class: 'ask__box' }, [
      el('div', { class: 'ask__title', text: title }),
      input,
      el('div', { class: 'ask__row' }, [
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('ask.cancel'),
          onclick: () => settle(null)
        }),
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: confirm || t('ask.confirm'),
          onclick: () => settle(input.value)
        })
      ])
    ]);
    const overlay = el(
      'div',
      { class: 'ask', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      [box]
    );

    let done = false;
    function settle(value) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      const text = value === null ? '' : String(value).trim();
      resolve(text || null);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        settle(input.value);
      }
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) settle(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}