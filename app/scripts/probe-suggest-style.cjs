/**
 * What does a suggestion row actually look like, in computed styles?
 *
 * The existing probe answers "does a list appear". This one answers "is the list
 * legible": the row's own line-height, font-size and height, and the same values
 * on the widget and on the editor, so an inherited value that breaks Monaco's
 * own geometry can be named instead of guessed.
 *
 * Run: node scripts/probe-suggest-style.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9339);

const CSS = '.column {\n  display: flex;\n}\n\n.column__inner {\n  color: #333;\n}\n';

const JAVASCRIPT = [
  'function addNumbers(left, right) {',
  '  const sum = left + right;',
  '  return sum;',
  '}',
  '',
  'module.exports = { addNumbers };',
  ''
].join('\n');

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-suggest-style-'));
  fs.writeFileSync(path.join(root, 'styles.css'), CSS, 'utf8');
  fs.writeFileSync(path.join(root, 'calc.js'), JAVASCRIPT, 'utf8');
  return root;
}

function keyFor(character) {
  const upper = character.toUpperCase();
  return { key: character, code: `Key${upper}`, vk: upper.charCodeAt(0), text: character };
}

async function press(session, character) {
  const described = keyFor(character);
  const common = {
    modifiers: 0,
    key: described.key,
    code: described.code,
    windowsVirtualKeyCode: described.vk,
    nativeVirtualKeyCode: described.vk
  };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: described.text, unmodifiedText: described.text, ...common });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(55);
}

const MEASURE = `
  const widget = document.querySelector('.suggest-widget');
  const row = widget ? widget.querySelector('.monaco-list-row') : null;
  const label = row ? row.querySelector('.label-name') : null;
  const detail = row ? row.querySelector('.details-label') : null;
  const read = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      lineHeight: style.lineHeight,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily.slice(0, 40),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      display: style.display,
      overflow: style.overflow,
      whiteSpace: style.whiteSpace
    };
  };
  const editor = window.monaco.editor.getEditors()[0];
  const main = row ? row.querySelector('.main') : null;
  const left = row ? row.querySelector('.left') : null;
  const right = row ? row.querySelector('.right') : null;
  const flex = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      display: style.display,
      flex: style.flex,
      flexGrow: style.flexGrow,
      flexShrink: style.flexShrink,
      flexBasis: style.flexBasis,
      position: style.position,
      width: Math.round(node.getBoundingClientRect().width),
      left: Math.round(node.getBoundingClientRect().left)
    };
  };
  return {
    main: flex(main),
    left: flex(left),
    right: flex(right),
    editor: read(document.querySelector('.monaco-editor')),
    widget: read(widget),
    row: read(row),
    label: read(label),
    detail: read(detail),
    rowText: row ? row.textContent.trim() : null,
    detailText: detail ? detail.textContent.trim() : null,
    labelRight: label ? Math.round(label.getBoundingClientRect().right) : null,
    detailLeft: detail ? Math.round(detail.getBoundingClientRect().left) : null,
    rowHtml: row ? row.innerHTML : null,
    editorLineHeight: editor ? editor.getOption(window.monaco.editor.EditorOption.lineHeight) : null,
    editorFontSize: editor ? editor.getOption(window.monaco.editor.EditorOption.fontSize) : null,
    editorFontFamily: editor ? editor.getOption(window.monaco.editor.EditorOption.fontFamily) : null,
    bodyLineHeight: getComputedStyle(document.body).lineHeight,
    editorContainerLineHeight: getComputedStyle(document.getElementById('editor')).lineHeight
  };
`;

async function main() {
  const folder = makeFolder();
  const lines = [];
  const child = startApp({ port: PORT, tag: 'suggest-style', onLine: (line) => lines.push(line) });
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
    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = [...document.querySelectorAll('.tree__row[data-kind="file"]')]
        .find((entry) => entry.dataset.path === 'calc.js');
      row.click();
      await sleep(1200);
      const editor = window.monaco.editor.getEditors()[0];
      editor.focus();
      const model = editor.getModel();
      const last = model.getLineCount();
      editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      return true;
    `);
    await press(session, '\n');
    await sleep(220);
    for (const character of 'addNum') await press(session, character);
    await sleep(700);
    const measured = await session.evaluate(MEASURE);
    console.log(JSON.stringify(measured, null, 2));
  } finally {
    child.kill();
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
