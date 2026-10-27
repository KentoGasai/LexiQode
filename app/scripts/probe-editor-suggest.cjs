/**
 * Does the editor suggest anything while a person is typing?
 *
 * The question is not answerable from the sources, and it was answered wrongly
 * once by a probe that looked convincing. That probe typed a prefix through the
 * editor's own command and then, if no list had appeared, asked for the list by
 * name (`editor.action.triggerSuggest`) before reading it - so it reported
 * suggestions that existed only because it had asked. A person typing saw
 * nothing, and the measurement agreed with the code instead of the person.
 *
 * So this probe types with real key events, through the same input path a
 * keyboard uses, and reads the widget *without* asking for it. What it finds
 * automatically is the honest answer to the question; the asked-for list is
 * measured separately, because a widget that only appears on request is a
 * different, lesser feature and must be named as such rather than conflated.
 *
 * It also reads the widget's geometry and what is painted at its centre: a list
 * that exists in the DOM, is marked visible and is nevertheless covered by
 * something else is exactly how "the hints do not appear" happens while every
 * DOM-based check passes.
 *
 * Nothing of the repository is touched: two small files are written into a
 * temporary folder and that folder is opened.
 *
 * Run: node scripts/probe-editor-suggest.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9338);

/** A file with enough shape for a language service to have something to say. */
const JAVASCRIPT = [
  'function addNumbers(left, right) {',
  '  const sum = left + right;',
  '  return sum;',
  '}',
  '',
  'function reportTotal(items) {',
  '  const total = items.reduce((running, item) => running + item.amount, 0);',
  '  return addNumbers(total, 1);',
  '}',
  '',
  '// A name that does not exist, so a language service has something to report.',
  'const broken = missingFunctionEntirely(1, 2);',
  '',
  'module.exports = { addNumbers, reportTotal };',
  ''
].join('\n');

/** The same shape in a language Monaco only tokenises, with no service at all. */
const PYTHON = [
  'def calculate_total(items):',
  '    total = 0',
  '    for item in items:',
  '        total += item',
  '    return total',
  '',
  '',
  'def report_total():',
  '    return calculate_total([])',
  ''
].join('\n');

/** A folder of its own, so nothing in the repository is touched. */
function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-suggest-'));
  fs.writeFileSync(path.join(root, 'calc.js'), JAVASCRIPT, 'utf8');
  fs.writeFileSync(path.join(root, 'calc.py'), PYTHON, 'utf8');
  /*
   * The rest of the table below, written so the probe can say where suggestions
   * can exist and where they cannot. A language Monaco tokenises has no service
   * and suggests only words already in the file, so an *empty* file of such a
   * language has nothing to offer at all - which is not a defect and must not be
   * reported as one either.
   */
  fs.writeFileSync(path.join(root, 'styles.css'), '.column {\n  display: flex;\n}\n\n.column__inner {\n  color: #333;\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'page.html'), '<div class="card">\n  <span class="card__title"></span>\n</div>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'notes.md'), '# Заметки\n\nThe calculation of totals is described here, in order.\n', 'utf8');
  fs.writeFileSync(path.join(root, 'setup.ps1'), 'param($Path)\n\nfunction Get-Summary {\n  param([string]$Name)\n  return $Name\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'fresh.py'), '', 'utf8');
  return root;
}

/**
 * Every file worth asking about, and what may honestly be expected of it.
 *
 * `suggests` is the expectation: true means a list must appear while typing.
 * A file whose language has neither a service nor any word in it yet is marked
 * false, and the probe then only reports what happened instead of failing on a
 * feature that does not exist anywhere.
 */
const FILES = [
  { file: 'calc.js', language: 'javascript', typed: 'addNum', suggests: true, why: 'the TypeScript service knows the module' },
  { file: 'calc.py', language: 'python', typed: 'calc', suggests: true, why: 'the name is already in the file' },
  { file: 'styles.css', language: 'css', typed: 'col', suggests: true, why: 'the CSS service knows the selectors' },
  { file: 'page.html', language: 'html', typed: 'car', suggests: true, why: 'the HTML service knows the classes' },
  { file: 'notes.md', language: 'markdown', typed: 'calc', suggests: true, why: 'the word is already in the file' },
  { file: 'setup.ps1', language: 'powershell', typed: 'Summ', suggests: true, why: 'the name is already in the file' },
  { file: 'fresh.py', language: 'python', typed: 'def', suggests: false, why: 'an empty file of a language with no service' }
];

/**
 * The keyboard, as Chromium sees it.
 *
 * Only the keys this probe needs are described. A letter carries the code of its
 * *upper*-case key, which is what a real keyboard reports, while the text is the
 * lower-case letter - so the character arrives exactly as a keystroke delivers it.
 */
function keyFor(character) {
  if (character === '\n') return { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
  if (character === '.') return { key: '.', code: 'Period', vk: 190, text: '.' };
  const upper = character.toUpperCase();
  const shifted = /[A-Z]/.test(character);
  return {
    key: character,
    code: `Key${upper}`,
    vk: upper.charCodeAt(0),
    text: character,
    modifiers: shifted ? 8 : 0
  };
}

async function press(session, character) {
  const described = keyFor(character);
  const common = {
    modifiers: described.modifiers || 0,
    key: described.key,
    code: described.code,
    windowsVirtualKeyCode: described.vk,
    nativeVirtualKeyCode: described.vk
  };
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: described.text,
    unmodifiedText: described.text,
    ...common
  });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(55);
}

/** A key that inserts nothing: Escape, or Ctrl+Space. */
async function pressRaw(session, { key, code, vk, modifiers = 0 }) {
  const common = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(120);
}

/**
 * What is on screen, read from the page rather than assumed by this file.
 *
 * `covered` is the part that matters: it asks the document which element is
 * painted at the middle of the widget, so a list that is present and visible but
 * hidden behind another element is reported as covered rather than as working.
 */
const MEASURE = `
  const widget = document.querySelector('.suggest-widget');
  const rows = widget
    ? [...widget.querySelectorAll('.monaco-list-row')].map((row) => row.textContent.trim()).slice(0, 12)
    : [];
  const rect = widget ? widget.getBoundingClientRect() : null;
  let covered = null;
  if (rect && rect.width > 4 && rect.height > 4) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(10, rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    covered = hit
      ? widget.contains(hit)
        ? 'the widget itself'
        : (hit.id || hit.className || hit.tagName)
      : 'nothing';
  }
  const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
  const editor = editors[0];
  const model = editor ? editor.getModel() : null;
  return {
    visible: Boolean(widget && widget.classList.contains('visible')),
    rows,
    rect: rect ? {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    } : null,
    covered,
    language: model ? model.getLanguageId() : '',
    tail: model ? model.getValue().slice(-24) : ''
  };
`;

/** Open a file from the tree, the way a person does, and leave the caret at its end. */
function openAndPlaceCaret(name) {
  return `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const row = [...document.querySelectorAll('.tree__row[data-kind="file"]')]
      .find((entry) => entry.dataset.path === ${JSON.stringify(name)});
    if (!row) return false;
    row.click();
    await sleep(1200);
    const editor = window.monaco.editor.getEditors()[0];
    if (!editor) return false;
    editor.focus();
    const model = editor.getModel();
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    return true;
  `;
}

/** Type a prefix into the open file and report both the free and the asked-for list. */
async function suggestionsFor(session, typed) {
  // Close anything left open by the previous file, so a stale widget cannot be
  // read as this file's answer.
  await pressRaw(session, { key: 'Escape', code: 'Escape', vk: 27 });
  await session.evaluate(`
    const editor = window.monaco.editor.getEditors()[0];
    editor.focus();
    const model = editor.getModel();
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    return true;
  `);
  await press(session, '\n');
  await sleep(220);
  for (const character of typed) await press(session, character);
  await sleep(700);
  const automatic = await session.evaluate(MEASURE);

  // Only when the list did not come by itself: ask for it, so the two answers can
  // be told apart instead of being averaged into one misleading "it works".
  let requested = null;
  if (!automatic.visible) {
    await pressRaw(session, { key: ' ', code: 'Space', vk: 32, modifiers: 2 });
    await sleep(700);
    requested = await session.evaluate(MEASURE);
  }
  return { automatic, requested };
}

async function main() {
  const folder = makeFolder();
  const lines = [];
  const child = startApp({ port: PORT, tag: 'suggest', onLine: (line) => lines.push(line) });
  console.log(`folder under test: ${folder}`);
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);
    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('.tree__row')) break;
        await sleep(250);
      }
      return Boolean(document.querySelector('.tree__row'));
    `);
    const monacoVersion = await session.evaluate(
      'return window.monaco ? window.monaco.version : "not loaded";'
    );

    /*
     * Every file in the table, opened the way a person opens it, typed into with
     * real keys. A file that cannot be opened is reported as such and the run
     * continues: the value of this probe is the whole picture.
     */
    const results = [];
    for (const entry of FILES) {
      const opened = await session.evaluate(openAndPlaceCaret(entry.file));
      if (!opened) {
        results.push({ ...entry, opened: false });
        continue;
      }
      const measured = await suggestionsFor(session, entry.typed);
      results.push({ ...entry, opened: true, ...measured });
    }

    // Diagnostics, which only a language service produces. Word suggestions
    // appear without any service at all, so the widget alone cannot tell a
    // running service from a dead one.
    await sleep(1500);
    const markers = await session.evaluate(`
      return window.monaco.editor.getModelMarkers({}).map((marker) => ({
        resource: String((marker.resource && marker.resource.path) || ''),
        message: String(marker.message).slice(0, 120)
      })).slice(0, 6);
    `);

    console.log(JSON.stringify({ monaco: monacoVersion, results, markers }, null, 2));

    console.log(`\nmonaco: ${monacoVersion}`);
    console.log('file          language    while typing        asked for   painted under        first rows');
    for (const result of results) {
      if (!result.opened) {
        console.log(`${result.file.padEnd(13)} -           did not open`);
        continue;
      }
      const automatic = result.automatic.visible ? `${result.automatic.rows.length} row(s)` : 'nothing';
      const asked = result.requested ? `${result.requested.rows.length} row(s)` : '-';
      console.log(
        `${result.file.padEnd(13)} ${String(result.automatic.language).padEnd(11)} ` +
          `${automatic.padEnd(19)} ${asked.padEnd(11)} ${String(result.automatic.covered).padEnd(20)} ` +
          `${result.automatic.rows.slice(0, 3).join(', ')}`
      );
    }
    console.log(`markers from the service: ${markers.length}`);

    const workerNoise = lines.filter(
      (line) => /worker/i.test(line) && /error|fail|not found|could not/i.test(line)
    );
    if (workerNoise.length) {
      console.log('\nwhat the window said about the worker:');
      for (const line of workerNoise.slice(0, 6)) console.log(`  ${line.slice(0, 300)}`);
    }

    /*
     * The expectations, stated so this is a check rather than a report.
     *
     * The first one is the whole point: a list must appear while someone types,
     * with nothing asked for. A widget that is present but covered fails too,
     * because to the person looking at the window that is indistinguishable from
     * absent.
     *
     * A failed worker load is reported and counted, and only fails the run when
     * the run also lacked suggestions or diagnostics - which is the case it
     * matters in. It is otherwise known to appear intermittently in both the
     * development and the packaged layout while every feature still answers,
     * because Monaco abandons a worker it started and starts another; failing on
     * it would make this check flicker rather than measure.
     */
    const loadFailures = lines.filter((line) => /failed to load/i.test(line)).length;
    const problems = [];
    for (const result of results) {
      if (!result.opened) {
        problems.push(`${result.file} could not be opened from the tree`);
        continue;
      }
      if (result.automatic.language !== result.language) {
        problems.push(`${result.file} opened as ${result.automatic.language}`);
      }
      if (!result.suggests) continue;
      if (!result.automatic.visible) problems.push(`no suggestion appeared while typing in ${result.file}`);
      if (!result.automatic.rows.length) problems.push(`the list was empty while typing in ${result.file}`);
      if (result.automatic.covered && result.automatic.covered !== 'the widget itself') {
        problems.push(`the list in ${result.file} is painted under ${result.automatic.covered}`);
      }
    }
    if (!markers.length) problems.push('the language service reported nothing at all, so it is not running');
    if (loadFailures && !markers.length) {
      problems.push(`a worker failed to load (${loadFailures} line(s)) and nothing took its place`);
    }
    if (loadFailures) console.log(`note: a worker failed to load ${loadFailures} time(s) while everything still answered`);

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe list appears by itself while typing, and the service is running');
  } finally {
    child.kill();
    // The window watches this folder while it is open: a refusal to remove it now
    // is expected and is not a probe failure.
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      console.log(`(the temporary folder could not be removed yet: ${folder})`);
    }
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});