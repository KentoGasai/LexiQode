'use strict';

/**
 * Static checks over the window's own sources.
 *
 * The window has no compiler and no bundler, so a typo in a channel name, an
 * element id or an import path is not caught by anything: it produces an event
 * that is never delivered, a lookup that returns null, or a module that fails to
 * load and leaves part of the interface dead. These tests read the sources and
 * check those three contracts against the files they refer to.
 *
 * The innerHTML rule is the same one the extension had: model output, file names
 * and git subjects are text, and the only code allowed to produce markup is the
 * renderer that escapes its input first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const RENDERER = path.join(APP, 'src', 'renderer');
const JS = path.join(RENDERER, 'js');

const jsFiles = fs.readdirSync(JS).filter((name) => name.endsWith('.js'));
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const constants = fs.readFileSync(path.join(APP, 'src', 'shared', 'constants.js'), 'utf8');

test('the window has the sources it needs', () => {
  for (const required of ['main.js', 'ui.js', 'editor.js', 'explorer.js', 'chat.js', 'markdown.js', 'fuzzy.js']) {
    assert.ok(jsFiles.includes(required), `${required} is missing`);
  }
  assert.equal(fs.existsSync(path.join(RENDERER, 'css', 'app.css')), true);
});

test('every element the scripts look up exists in the markup', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const missing = [];
  for (const file of jsFiles) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!ids.has(match[1])) missing.push(`${file}: #${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `these ids are looked up but not in index.html: ${missing.join(', ')}`);
});

test('every channel the window subscribes to exists in the shared constants', () => {
  const declared = new Set([...constants.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((match) => match[1]));
  const used = new Set();
  for (const file of jsFiles) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const match of source.matchAll(/'([a-z]+:[a-z-]+)'/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 8, 'the window should name the channels it subscribes to');
  for (const channel of used) {
    assert.ok(declared.has(channel), `${channel} is used by the window but is not in constants.js`);
  }
});

test('every import resolves to a file that exists', () => {
  const missing = [];
  for (const file of jsFiles) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const target = match[1];
      if (!target.startsWith('.')) continue;
      const resolved = path.resolve(JS, target);
      if (!fs.existsSync(resolved)) missing.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], `unresolved imports: ${missing.join(', ')}`);
});

test('the markup loads the vendored bundles and the module entry point', () => {
  for (const reference of ['css/app.css', 'vendor/xterm/xterm.css', 'vendor/xterm/xterm.js', 'js/main.js']) {
    assert.ok(html.includes(reference), `index.html does not reference ${reference}`);
  }
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
});

test('the window is not allowed to reach the network', () => {
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
});

test('only the icon set and the markdown renderer produce markup', () => {
  const offenders = [];
  for (const file of jsFiles) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('innerHTML')) return;
      const allowed =
        file === 'ui.js' ||
        /innerHTML\s*=\s*value/.test(line) ||
        /innerHTML\s*=\s*renderMarkdown\(/.test(line) ||
        /innerHTML\s*=\s*icon\(/.test(line);
      if (!allowed) offenders.push(`${file}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `unexpected markup assignment: ${offenders.join(' | ')}`);
});

test('the settings form sends only the fields the core documents', () => {
  const source = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  // Only the patch object is inspected: a scan of the whole file would flag
  // `class:` on an element and prove nothing about the request.
  const start = source.indexOf('const patch = {');
  assert.notEqual(start, -1, 'chat.js should build one settings patch object');
  const end = source.indexOf('\n      };', start);
  assert.notEqual(end, -1, 'the settings patch should end with a closing brace');
  const patch = source.slice(start, end);
  assert.match(patch, /active_profile/);
  assert.match(patch, /profile:/);
  assert.match(patch, /agent:/);
  const sent = [...patch.matchAll(/(?:^|[{,\s])([a-z_]+):/g)].map((match) => match[1]);
  const known = new Set([
    'active_profile',
    'profile',
    'agent',
    'id',
    'base_url',
    'api_key',
    'model',
    // ModelProfile slots: the window the model accepts and the room an answer
    // needs. Both were already stored by the core and had no field in the form.
    'context_window',
    'max_output_tokens',
    'max_steps',
    'command_timeout',
    // AgentSettings: when the conversation is compacted.
    'compact_at',
    'auto_approve',
    'approve_writes',
    'approve_commands'
  ]);
  assert.ok(sent.length >= 4, 'the patch should name the fields it sends');
  for (const key of sent) {
    assert.ok(known.has(key), `chat.js sends an undocumented settings key: ${key}`);
  }
});

/**
 * The editor colours a file with the language Monaco knows it by.
 *
 * This used to be the file's own extension, and only files whose extension
 * happens to equal the language id - `.json`, `.css`, `.html` - were coloured.
 * Everything else, including every `.js`, `.ts`, `.py` and `.md`, opened as
 * plain text: no colours, no language service, and nothing thrown to say so.
 * The check is static because the failure is silent and the window has no
 * compiler; the live probes open real files and count the token colours.
 */
test('a file is coloured by a language id from the registry, not by its extension', () => {
  const source = fs.readFileSync(path.join(JS, 'editor.js'), 'utf8');
  assert.match(source, /monaco\.languages\.getLanguages\(\)/, 'the registry is the only authority');
  assert.match(source, /table\.filenames\.get\(name\)/, 'a name the registry knows wins over its extension');
  assert.match(source, /return table\.extensions\.get\(/, 'an extension is resolved through the registry');
  assert.doesNotMatch(
    source,
    /return known \? extension : 'plaintext'/,
    'the extension itself is not a language id: `.js` is not one, and that is what opened every script as text'
  );
});

/**
 * A file can be taken out of the message, and put back in from the tree.
 *
 * The two halves have to exist together: a chip without a cross is the state
 * this replaced - a file that appeared in the context by itself and could not be
 * removed - and a cross without a way to add a file back would make the
 * preference a one-way door.
 */
test('the message context can be edited from both ends', () => {
  const chat = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  const explorer = fs.readFileSync(path.join(JS, 'explorer.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
  assert.match(chat, /contextFiles: \[\]/, 'the panel should hold the files the user pinned');
  assert.match(chat, /function contextChip\(/, 'a file in the message is drawn as a chip with a control');
  assert.match(chat, /class: 'ctx__drop'/, 'the chip carries a cross');
  assert.match(chat, /files: contextFiles\(\)/, 'the pinned files are sent with the message');
  assert.match(explorer, /onToggleContext/, 'the tree can put a file into the context');
  assert.match(renderer, /isContextFile: \(path\)/, 'the tree asks the panel what is already in it');
});

/**
 * The theme has a button, and the button reaches all three of its states.
 *
 * The palette could switch between dark and light, and the settings file could
 * hold "follow the system", but nothing in the window showed which of the three
 * was in force or offered the third one: a machine whose system theme is dark
 * had no visible route to a light window.
 */
test('the theme button cycles through every theme and says what it will do', () => {
  const source = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
  assert.match(source, /const THEME_ORDER = \['dark', 'light', 'system'\]/);
  assert.match(source, /role: 'theme'/, 'the button is drawn as a status item');
  assert.match(source, /statusNodes\.theme\.textContent = t\('status\.theme'/, 'it names the current theme');
  assert.match(source, /next: themeName\(nextTheme\(choice\)\)/, 'and the theme the next click gives');
  assert.match(source, /case 'theme\.toggle':[\s\S]{0,120}cycleTheme\(\)/, 'the palette runs the same cycle');
});

/** A rule's body, so a CSS contract can be read without a browser. */
function cssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should be a rule in app.css`);
  return source.slice(start, source.indexOf('}', start));
}

/**
 * The settings need a button, not only a shortcut.
 *
 * They were reachable three ways - the File menu, the palette and `Ctrl+,` - and
 * none of them was visible, which for a settings dialog means most people never
 * find it. The button sits in the status bar beside the theme button.
 */
test('the settings have a button in the status bar', () => {
  const source = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
  assert.match(source, /role: 'settings'/, 'the status bar should carry a settings item');
  assert.match(source, /icon: 'settings'/, 'as an icon, so the bar does not gain a word');
  assert.match(source, /statusNodes\.settings,/, 'and the item has to be appended to the bar');
});

/**
 * A long model id may not squeeze the mode button out of its own label.
 *
 * The mode button lives in a container that scrolls, so that container can
 * shrink to nothing and clip it: reported from a running window, "Agent" was
 * rendered as "Ager" and the model pill covered the rest. The mode is now the
 * one thing on that row that cannot give way, and the model chooser - the only
 * thing whose text can be shortened without losing meaning - gives way first.
 */
test('the mode button is not the thing that shrinks, the model chooser is', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  assert.match(
    cssRule(css, '.modes'),
    /flex:\s*0 0 auto/,
    'the container of the mode button still shrinks, and it clips its own button when it does'
  );
  const host = cssRule(css, '.modelhost');
  assert.match(host, /min-width:/, 'the model chooser needs a floor to shrink to');
  assert.match(host, /max-width:/, 'and a limit on how much of the row it may take');
  assert.match(cssRule(css, '.modelbtn'), /width:\s*100%/, 'the chooser fills the box the layout gives it');
});