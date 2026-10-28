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

/** Source without its comments: a note about a mistake is not the mistake. */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Nothing waits on a browser prompt.
 *
 * Electron does not implement `window.prompt`: it returns null without showing
 * anything at all. Four features asked through it - creating a file, renaming one,
 * renaming a chat, switching a branch - and every one of them did nothing when it
 * was used, which was reported four times as four unrelated broken buttons. The
 * window asks in its own field now (see `ask.js`), and this is what keeps the next
 * one from being written by accident.
 */
test('the window never asks through window.prompt', () => {
  const offenders = [];
  for (const file of jsFiles) {
    const code = stripComments(fs.readFileSync(path.join(JS, file), 'utf8'));
    if (/window\.prompt\s*\(/.test(code)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these ask through window.prompt, which Electron never shows: ${offenders.join(', ')}`
  );
});

/**
 * The tree's two markers are drawn, because the font has no glyph for them.
 *
 * The disclosure marker was the character '▸' / '▾' and a folder was '▣'. The
 * window's own font contains none of the three, so every folder in the tree was
 * marked with an empty square - reported as "why are folders marked with squares".
 * The chevron is an icon that turns a quarter turn, and a folder is the same drawn
 * outline the sidebar's own tab uses.
 */
test('the tree draws its markers instead of typing them', () => {
  const code = stripComments(fs.readFileSync(path.join(JS, 'explorer.js'), 'utf8'));
  assert.match(code, /icon\('chevron'\)/, 'the disclosure marker is a drawn chevron');
  assert.match(code, /icon\('files'\)/, 'and a folder is a drawn outline');
  assert.doesNotMatch(code, /[▸▾▣]/, 'no glyph the font may not have');

  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  assert.match(css, /rotate\(-90deg\)/, 'the chevron points right while a folder is closed');
  assert.match(
    css,
    /\.tree__twisty\[data-open='true'\]/,
    'and turns down when it opens, so the direction says what will happen'
  );
});

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
    // AgentSettings: the hard ceiling on messages in one conversation.
    'max_history_messages',
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
 * Opening a file must not put it into the next message.
 *
 * The first version did: a preference offered the file in the editor by itself,
 * so somebody who opened a file to read it had to notice a chip and take it back
 * out before the message said what they had actually asked. The preference and
 * the machinery that kept a file out of the message are both gone; what remains
 * is one list that only the user writes to.
 */
test('a file enters the message only when the user puts it there', () => {
  const chat = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  assert.doesNotMatch(chat, /includeActiveFile/, 'the open file is offered by a preference again');
  assert.doesNotMatch(chat, /contextMuted/, 'a file taken out of the message is still remembered as muted');
  assert.match(chat, /function hasContextFile\(path\) \{\s*return state\.contextFiles\.includes\(path\);/);
  assert.match(chat, /file: '',\s*files: contextFiles\(\)/, 'the message should carry the pinned files and no open file');
  const settings = fs.readFileSync(path.join(APP, 'src', 'shared', 'constants.js'), 'utf8');
  assert.doesNotMatch(settings, /includeActiveFile/, 'the setting for the automatic file is still in the defaults');
});

/**
 * Running a file: a button, a command, and a shell to run it in.
 *
 * The button is the part that has to exist in the markup, the folder is what the
 * command has to move to first, and the panel has to be open before the command
 * is sent or the output lands somewhere nobody can see.
 */
test('the editor has a run button, and it runs the file in the shell', () => {
  const renderer = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
  assert.match(html, /id="editor-actions"/, 'index.html should have a place for the run button');
  assert.match(html, /id="editor-actions"[\s\S]{0,400}id="editor"/, 'the run button belongs above the editor');
  assert.match(renderer, /function renderEditorActions\(/, 'the button should be drawn by the window');
  assert.match(renderer, /class: 'iconbtn runbtn'/, 'the run button has a class of its own to be styled');
  assert.match(renderer, /icon: 'play'|icon\('play'\)/, 'the run button should use the play icon');
  assert.match(renderer, /case 'file\.run':[\s\S]{0,200}runActiveFile\(\)/, 'the palette and the menu should reach the same command');
  assert.match(renderer, /togglePanel\(true\);\s*terminal\.mount\(\);/, 'the panel must be open before the output arrives');
  assert.match(renderer, /await editor\.save\(file, \{ quiet: true \}\)/, 'the file must be saved before it is run');
  assert.match(renderer, /import \{ commandFor \} from '\.\/run\.js'/, 'the command comes from the shared module');
  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.editorhead__actions/, 'the run button needs a box that does not disturb the tabs');
  const ui = fs.readFileSync(path.join(JS, 'ui.js'), 'utf8');
  assert.match(ui, /play: '<svg/, 'the icon set has no play icon');
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
 * `hidden` has to be able to win.
 *
 * The browser's own `[hidden] { display: none }` loses to any author rule that
 * gives an element a display of its own, and two of those were reported together
 * as broken features: the spinner kept turning after the actions said "done", and
 * the Stop button never went away after a turn had finished, which is how a
 * working button looks dead. The rule that settles it has to come after the rules
 * it overrides, or it settles nothing.
 */
test('the stylesheet lets `hidden` beat the rules that give an element a display', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  const rule = css.indexOf('\n[hidden] {');
  assert.notEqual(rule, -1, 'app.css should say what `hidden` means');
  assert.ok(
    rule > css.indexOf('\n.spinner {'),
    'the spinner sets a display of its own, so the rule has to come after it'
  );
  assert.ok(rule > css.indexOf('\n.btn {'), 'and after the buttons');
  assert.match(css.slice(rule, rule + 40), /display:\s*none/);
});

/**
 * A number the core owns is never invented by the form.
 *
 * The step budget was filled in with 12 while the core's own default is 40, so a
 * form opened before the settings arrived showed 12 and saved 12 - and the agent
 * then ended every turn after a dozen steps, reported as "the model stops for no
 * reason". An absent value means "the core decides", which is what the form has
 * to send when the core has not told it anything.
 */
test('the settings form does not invent the values the core owns', () => {
  const source = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  assert.doesNotMatch(source, /max_steps \?\? \d+/, 'the step budget must come from the core');
  assert.match(source, /max_steps === undefined/, 'and be left empty when the core has not said');
  assert.match(source, /max_history_messages/, 'the message ceiling has a field of its own');
  assert.doesNotMatch(
    source,
    /compact_at: \(Number\(compactAt\.value\) \|\| 75\)/,
    'the compaction threshold may not be invented either'
  );
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

/**
 * The source control panel can reach the remote, and a commit can be opened.
 *
 * Three of the four things reported about this panel were the same shape: the
 * command existed nowhere, so the button that would have called it did not
 * exist either. A commit could be made and never pushed, a remote could never be
 * pulled, and a commit in the list was a label with no way to see what it
 * changed. Each of those is a chain - a service method, a channel, a preload
 * method, a control - and a break anywhere in it is invisible until someone
 * presses the button, so the whole chain is checked here.
 */
test('the source control panel can push, pull and fetch, and open a commit', () => {
  const panel = fs.readFileSync(path.join(JS, 'git-panel.js'), 'utf8');
  const preload = fs.readFileSync(path.join(APP, 'src', 'preload', 'preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(APP, 'src', 'main', 'ipc.js'), 'utf8');
  const service = fs.readFileSync(path.join(APP, 'src', 'main', 'git-service.js'), 'utf8');
  const editor = fs.readFileSync(path.join(JS, 'editor.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');

  for (const action of ['fetch', 'pull', 'push']) {
    assert.match(service, new RegExp(`async ${action}\\(`), `git-service has no ${action}`);
    assert.match(ipc, new RegExp(`CHANNELS\\.git\\.${action}`), `ipc does not register ${action}`);
    assert.match(
      preload,
      new RegExp(`${action}: \\(\\) => call\\(CHANNELS\\.git\\.${action}\\)`),
      `preload does not expose ${action}`
    );
    assert.match(panel, new RegExp(`button\\('${action}'`), `the panel has no ${action} button`);
  }

  assert.match(service, /async show\(/, 'git-service cannot show a commit');
  assert.match(ipc, /CHANNELS\.git\.show/, 'ipc does not register git:show');
  assert.match(preload, /show: \(hash\) => call\(CHANNELS\.git\.show, hash\)/, 'preload does not expose show');
  assert.match(editor, /async function openCommit\(/, 'the editor cannot open a commit');
  assert.match(
    renderer,
    /onOpenCommit: \(commit\) => void editor\.openCommit\(commit\)/,
    'the panel is not wired to the editor'
  );
  assert.match(panel, /onclick: \(\) => onOpenCommit\?\.\(entry\)/, 'a commit row is not clickable');
});

/**
 * A commit opens as a file list, and a file opens as a coloured diff.
 *
 * The first version of "open a commit" showed the whole patch as one document
 * of `+` and `-` lines, which is not how a commit is read: a commit is a set of
 * changes, one per file, and the file is what a person picks. The view is a
 * header and a list, and each file opens a diff drawn by Monaco's diff editor -
 * two documents compared, so an added line is green and a removed one is red.
 * The whole chain is checked here because a break anywhere in it is invisible
 * until someone clicks.
 */
test('a commit opens as a file list, and a file opens as a coloured diff', () => {
  const service = fs.readFileSync(path.join(APP, 'src', 'main', 'git-service.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(APP, 'src', 'main', 'ipc.js'), 'utf8');
  const preload = fs.readFileSync(path.join(APP, 'src', 'preload', 'preload.js'), 'utf8');
  const editor = fs.readFileSync(path.join(JS, 'editor.js'), 'utf8');
  const shared = fs.readFileSync(path.join(APP, 'src', 'shared', 'git.js'), 'utf8');

  assert.match(shared, /function parseCommitFiles\(/, 'the commit file list has no parser');
  assert.match(service, /async commitView\(/, 'git-service cannot read a commit as a view');
  assert.match(service, /async commitFile\(/, 'git-service cannot read one file of a commit');
  assert.match(ipc, /CHANNELS\.git\.commitView/, 'ipc does not register git:commit-view');
  assert.match(ipc, /CHANNELS\.git\.commitFile/, 'ipc does not register git:commit-file');
  assert.match(preload, /commitView: \(hash\) => call\(CHANNELS\.git\.commitView, hash\)/);
  assert.match(preload, /commitFile: \(hash, path\) => call\(CHANNELS\.git\.commitFile/);

  assert.match(editor, /createDiffEditor\(/, 'the diff is not drawn by Monaco\'s diff editor');
  assert.match(editor, /function renderCommitView\(/, 'the commit view is not drawn');
  assert.match(editor, /class: 'commitview__file'|className = 'commitview__file'/, 'the file list has no rows');
  assert.match(editor, /openCommitFile\(tab\.commit\.hash, file\.path\)/, 'a file row does not open its diff');
  assert.match(editor, /kind: 'commit'/, 'a commit is not a kind of tab');
  assert.match(editor, /kind: 'diff'/, 'a diff is not a kind of tab');
});

/**
 * A file the assistant changed is offered as a diff, the way Cursor shows it.
 *
 * The two sides come from the core (`tool_end.change`), not from the window
 * reading the file: a local write finishes before a read issued at `tool_start`
 * could return, so a window that tried to capture the "before" side itself would
 * find the file already changed and show an empty diff. The tool is the only
 * thing that knows both sides, so it reports them, and the window draws them.
 */
test('a file the assistant changed is offered as a diff', () => {
  const chat = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  const editor = fs.readFileSync(path.join(JS, 'editor.js'), 'utf8');
  const core = fs.readFileSync(path.join(APP, '..', 'core', 'lexiqode', 'agent', 'loop.py'), 'utf8');
  const tools = fs.readFileSync(path.join(APP, '..', 'core', 'lexiqode', 'agent', 'tools', 'fs.py'), 'utf8');

  assert.match(tools, /change=\{"path": context\.relative\(path\), "before": before, "after": content\}/);
  assert.match(tools, /change=\{"path": context\.relative\(path\), "before": text, "after": updated\}/);
  assert.match(core, /"change": result\.change/, 'the loop does not put the change on the event');
  assert.match(chat, /function recordFileChange\(row, payload\)/, 'the panel does not read the change');
  assert.match(chat, /payload\.change/, 'the panel does not read the change from the event');
  assert.match(chat, /function renderChanges\(/, 'the turn does not draw its changed files');
  assert.match(editor, /function openChangeDiff\(/, 'the editor cannot show a change it was handed');
});

/**
 * The change is a block of its own in the chat, opened in place.
 *
 * It was a chip inside the action row, which is behind two disclosures - the
 * step's action list and the row itself - so a person had to open two things to
 * find the one thing they came for. Reported as "you hid the changed file under
 * Actions". It is now a block of its own in the transcript, outside the action
 * group, that opens in place and shows only the lines that changed, with a way
 * into the editor beside it.
 */
test('the change is a block of its own in the chat, opened in place', () => {
  const chat = fs.readFileSync(path.join(JS, 'chat.js'), 'utf8');
  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');

  // Outside the action group: inserted into the turn, not into the tools node.
  assert.match(chat, /created\.node\.insertBefore\(node, created\.body\)/, 'the change block is not part of the turn');
  assert.doesNotMatch(chat, /group\.node\.append\(group\.changed\)/, 'the change block is still inside the action group');
  assert.match(chat, /class: 'changes'/, 'the change block has no class of its own');
  assert.match(chat, /class: 'change__toggle'/, 'a changed file has no row to open');
  assert.match(chat, /class: 'change__body', hidden: true/, 'the diff is not opened in place');
  assert.match(chat, /body\.hidden = !body\.hidden/, 'the row does not toggle its diff');
  // Only the changed lines, with the colours a diff uses.
  assert.match(chat, /function diffLines\(/, 'the change is not reduced to the lines that differ');
  assert.match(chat, /kind: 'add'/, 'added lines are not marked');
  assert.match(chat, /kind: 'del'/, 'removed lines are not marked');
  assert.match(chat, /dataset: \{ kind: row\.kind \}/, 'the lines carry no kind for the stylesheet');
  // A way into the editor, beside the change.
  assert.match(chat, /class: 'change__open'/, 'there is no way to open the file');
  assert.match(chat, /editor\?\.open\?\.\(path\)/, 'the open button does not open the file');
  assert.match(chat, /state\.changedFiles\.set\(/, 'the turn does not collect the files it changed');
  assert.match(chat, /state\.changedFiles\.clear\(\)/, 'the changed-file list is not reset per turn');

  assert.match(css, /\.changes \{/, 'the change block has no style');
  assert.match(css, /\.change__line\[data-kind="add"\]/, 'added lines have no colour');
  assert.match(css, /\.change__line\[data-kind="del"\]/, 'removed lines have no colour');
  assert.match(css, /\.change__open/, 'the open button has no style');
});

/**
 * The suggestion list has to fit inside the editor, or it is not shown.
 *
 * Monaco gives the widget a fixed 430px width and, with `fixedOverflowWidgets`,
 * positions it against the window: its own layout caps the width to the window,
 * not to the editor. With the assistant panel open on the right, the list runs
 * past the editor's edge and under that panel, and the part that is covered is
 * the signature. Reported as "the hints do not fit, sometimes the last one is
 * not visible". The width is published by `editor.js` as `--editor-width`,
 * because a percentage would resolve against the viewport, and the rule has to
 * be `!important` because Monaco writes its own window-based `max-width` inline.
 */
test('the suggestion list is capped to the editor it is drawn in', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  const widget = cssRule(css, '.monaco-editor .suggest-widget');
  assert.match(widget, /max-width:\s*var\(--editor-width/, 'the widget is capped to the editor, not the window');
  assert.match(widget, /max-height:\s*var\(--editor-height/, 'and to the editor\'s height, or a short editor cannot hold it');
  assert.match(widget, /!important/, 'Monaco writes its own max-width inline, so the rule has to win over it');
  const editor = fs.readFileSync(path.join(JS, 'editor.js'), 'utf8');
  assert.match(editor, /--editor-width/, 'the editor publishes its own width for the rule to read');
  assert.match(editor, /--editor-height/, 'and its own height');
  assert.match(editor, /clampSuggestWidget/, 'and moves the list back inside when its position would take it out');
  assert.match(editor, /SUGGEST_GAP/, 'and keeps it clear of the bottom edge, where the panel below would cover it');
});
