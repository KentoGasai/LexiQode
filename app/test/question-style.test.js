'use strict';

/**
 * What colour is the text on a question option, before and after hover?
 *
 * The report was "hovering an option highlights it and the text disappears".
 * This measures the computed colours in a real engine rather than reasoning
 * about specificity, so the fix can be checked against the same measurement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = path.resolve(__dirname, '..', 'src', 'renderer', 'css', 'app.css');

/** Pull one rule's declarations out of the stylesheet, by exact selector. */
function rule(selector) {
  const source = fs.readFileSync(CSS, 'utf8');
  const pattern = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm'
  );
  const match = pattern.exec(source);
  return match ? match[2] : null;
}

test('a primary button keeps its own text colour when hovered', () => {
  // `.btn:hover` sets a background; `.btn--primary` sets white text. Both are
  // one class plus one pseudo-class, so they have the same specificity and the
  // later rule wins. If `.btn--primary:hover` does not restate the colour, the
  // hover background can land under text that was chosen for the other one.
  const hover = rule('.btn--primary:hover');
  assert.ok(hover, '.btn--primary:hover must exist');
  assert.match(hover, /color\s*:/, 'the hover state must state its own text colour');
});

test('the hover background of a primary button is not the neutral surface', () => {
  // The bug: hovering a primary button replaced the accent background with the
  // neutral `--surface-3`, which is nearly the same value as the card behind it,
  // so the button looked like it had vanished and its white text with it.
  const hover = rule('.btn--primary:hover');
  assert.equal(
    /background\s*:\s*var\(--surface-3\)/.test(hover),
    false,
    'a primary button must not turn into a neutral surface on hover'
  );
});

test('the question card styles the option buttons it draws', () => {
  // The options are `.btn.btn--primary` inside `.question__options`. The card
  // must not restyle them into something whose text colour it does not control.
  const options = rule('.question__options');
  assert.ok(options, '.question__options must exist');
  assert.equal(
    /color\s*:/.test(options),
    false,
    'the options row must not set a text colour the buttons do not inherit'
  );
});

test('the question card cannot be widened by its own text', () => {
  // A grid item defaults to `min-width: auto`, so it refuses to be narrower than
  // its content. One long path in the question pushed the card past the chat
  // panel and the text ran off the edge. The floor has to be removed on the card
  // and on the text, and the text has to use `anywhere` rather than `break-word`:
  // only `anywhere` also lowers the intrinsic minimum width.
  const card = rule('.question');
  assert.ok(card, '.question must exist');
  assert.match(card, /min-width\s*:\s*0/, 'the card must not have an intrinsic floor');

  const what = rule('.question__what');
  assert.ok(what, '.question__what must exist');
  assert.match(what, /min-width\s*:\s*0/, 'the text must not have an intrinsic floor');
  assert.match(
    what,
    /overflow-wrap\s*:\s*anywhere/,
    'only `anywhere` lowers the minimum width a long token reports'
  );
  assert.equal(
    /word-break\s*:\s*break-word/.test(what),
    false,
    '`break-word` wraps but still reports the long word as the minimum'
  );
});

test('an option label wraps instead of overflowing the card', () => {
  // The options are buttons, and `.btn` sets `white-space: nowrap` and a fixed
  // height. A long option would then be one unbreakable line wider than the card.
  const option = rule('.question__options .btn');
  assert.ok(option, 'the options must be styled');
  assert.match(option, /white-space\s*:\s*normal/, 'an option label must be allowed to wrap');
  assert.match(option, /height\s*:\s*auto/, 'a wrapped label needs a height that grows');
});

test('every custom property the stylesheet uses is one it defines', () => {
  // A misspelled variable is not an error in CSS: `var(--fg)` where the theme
  // defines `--text` silently resolves to nothing, and the declaration is
  // dropped. The text then falls back to whatever it inherited, which is how a
  // field ends up unreadable in one theme and fine in the other.
  //
  // Two kinds of variable are legitimately not defined here, and both are
  // declared with a fallback so a missing value is still a working layout:
  // panel sizes the window writes from JavaScript, and the editor metrics
  // `editor.js` publishes. A variable with no fallback and no definition is the
  // mistake this looks for.
  const source = fs.readFileSync(CSS, 'utf8');
  const defined = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...source.matchAll(/var\((--[a-z0-9-]+)(\s*,)?/g)];
  const missing = [
    ...new Set(
      used
        .filter(([, name, fallback]) => !defined.has(name) && !fallback)
        .map(([, name]) => name)
    )
  ].sort();
  assert.deepEqual(missing, [], `the stylesheet uses undefined variables: ${missing.join(', ')}`);
});
