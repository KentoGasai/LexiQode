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