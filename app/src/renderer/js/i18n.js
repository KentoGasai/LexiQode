/*
 * The window's translations.
 *
 * The dictionary arrives from the main process over one call rather than being
 * fetched by the page, so the list of languages and the files behind them live
 * in one place. Two ways of using it, deliberately:
 *
 * * `t('key')` for text the code builds - labels, tooltips, messages with values.
 * * `data-i18n` attributes for text that is already in the markup, applied in one
 *   pass, so static labels do not need a line of JavaScript each.
 *
 * A missing key returns the key itself. That looks wrong on purpose: a visible
 * `settings.endpoint` in the interface is a bug report that a silent English
 * fallback would hide, and a test compares the two dictionaries key by key so it
 * cannot happen by accident.
 */

let messages = {};
let language = 'en';
let available = ['en'];
let detected = '';

export function initI18n(payload) {
  if (!payload || typeof payload !== 'object') return current();
  messages = payload.messages && typeof payload.messages === 'object' ? payload.messages : {};
  language = typeof payload.language === 'string' ? payload.language : 'en';
  available = Array.isArray(payload.available) ? payload.available : [language];
  detected = typeof payload.detected === 'string' ? payload.detected : '';
  applyStaticTranslations();
  return current();
}

export function current() {
  return { language, available: [...available], detected };
}

/** Translate a key, replacing `{name}` placeholders with the given values. */
export function t(key, params) {
  const template = messages[key];
  if (typeof template !== 'string') return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/** Text already in the markup, marked with `data-i18n*` attributes. */
export function applyStaticTranslations(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of root.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
}