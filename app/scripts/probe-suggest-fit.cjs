/**
 * Does the suggestion list stay inside the editor it belongs to?
 *
 * The list is drawn with `fixedOverflowWidgets`, so Monaco positions it against
 * the window rather than against the editor: its own layout caps the width to
 * the *window*, not to the editor. With the assistant panel open on the right,
 * a list that starts at the caret and runs 430px to the right therefore ends up
 * under that panel, and the part a person needs - the signature - is the part
 * that is covered. Reported as "the last hint is not visible".
 *
 * This probe opens a file, types a prefix that produces a long list, and reads
 * the widget's rectangle against the editor's rectangle and against whatever is
 * painted at the widget's right edge. It runs twice: once at the default window
 * size and once with the window narrowed, because the failure only appears when
 * the editor is narrower than the list wants to be.
 *
 * Run: node scripts/probe-suggest-fit.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9341);

const CSS = [
  '.column {',
  '  display: flex;',
  '}',
  '',
  '.column__inner {',
  '  color: #333;',
  '}',
  '',
  '.column__title {',
  '  font-weight: 600;',
  '}',
  '',
  '.card {',
  '  border: 1px solid #ccc;',
  '}',
  '',
  // Enough lines to fill the editor, so the caret can be put at the bottom of
  // the visible area - which is where the list has nowhere to go and the panel
  // below covers it.
  ...Array.from({ length: 60 }, (_, index) => `.filler-${index} {\n  margin: ${index}px;\n}\n`),
  ''
].join('\n');

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-suggest-fit-'));
  fs.writeFileSync(path.join(root, 'styles.css'), CSS, 'utf8');
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
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: described.text,
    unmodifiedText: described.text,
    ...common
  });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(55);
}

/**
 * The widget's rectangle, the editor's rectangle, and what is painted at the
 * widget's right edge and at the middle of its last row.
 */
const MEASURE = `
  const widget = document.querySelector('.suggest-widget');
  const editorNode = document.getElementById('editor');
  const rows = widget ? [...widget.querySelectorAll('.monaco-list-row')] : [];
  const rect = widget ? widget.getBoundingClientRect() : null;
  const editorRect = editorNode ? editorNode.getBoundingClientRect() : null;
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastRect = lastRow ? lastRow.getBoundingClientRect() : null;
  const at = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return 'nothing';
    if (widget && widget.contains(hit)) return 'the widget itself';
    return hit.id || hit.className || hit.tagName;
  };
  const ancestry = [];
  for (let node = widget; node && node !== document.body; node = node.parentElement) {
    ancestry.push(node.id || node.className || node.tagName);
  }
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    ancestry,
    editorWidthVar: editorNode ? getComputedStyle(editorNode).getPropertyValue('--editor-width') : null,
    editorHeightVar: editorNode ? getComputedStyle(editorNode).getPropertyValue('--editor-height') : null,
    widgetWidthVar: widget ? getComputedStyle(widget).getPropertyValue('--editor-width') : null,
    widgetMaxWidth: widget ? getComputedStyle(widget).maxWidth : null,
    widgetMaxHeight: widget ? getComputedStyle(widget).maxHeight : null,
    editor: editorRect ? {
      left: Math.round(editorRect.left),
      right: Math.round(editorRect.right),
      top: Math.round(editorRect.top),
      bottom: Math.round(editorRect.bottom),
      width: Math.round(editorRect.width),
      height: Math.round(editorRect.height)
    } : null,
    widget: rect ? {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    } : null,
    rows: rows.length,
    lastRow: lastRect ? {
      top: Math.round(lastRect.top),
      bottom: Math.round(lastRect.bottom),
      left: Math.round(lastRect.left),
      right: Math.round(lastRect.right)
    } : null,
    overflowsEditorRight: rect && editorRect ? Math.round(rect.right - editorRect.right) : null,
    overflowsEditorBottom: rect && editorRect ? Math.round(rect.bottom - editorRect.bottom) : null,
    paintedAtWidgetRight: rect ? at(rect.right - 3, rect.top + Math.min(10, rect.height / 2)) : null,
    paintedAtLastRow: lastRect ? at(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2) : null,
    // The bottom edge is where a panel below the editor covers the list, so what
    // is painted there is the question the report is really asking.
    paintedAtWidgetBottom: rect ? at(rect.left + rect.width / 2, rect.bottom - 3) : null,
    paintedAtLastRowBottom: lastRect ? at(lastRect.left + lastRect.width / 2, lastRect.bottom - 2) : null,
    panel: (() => {
      const node = document.getElementById('panel');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), hidden: node.hidden };
    })(),
    statusbar: (() => {
      const node = document.getElementById('statusbar');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
    })()
  };
`;

async function measureAt(session, label) {
  await session.evaluate(`
    const editor = window.monaco.editor.getEditors()[0];
    editor.focus();
    const model = editor.getModel();
    // The caret goes to the last line and the view is scrolled to the bottom, so
    // the list is drawn with the whole panel below it and nowhere to go - which
    // is the reported case, not a caret near the top of a short file.
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    editor.revealLine(last);
    return true;
  `);
  await press(session, '\n');
  await sleep(220);
  for (const character of 'col') await press(session, character);
  await sleep(800);
  const measured = await session.evaluate(MEASURE);
  console.log(`\n--- ${label}\n${JSON.stringify(measured, null, 2)}`);
  return measured;
}

async function main() {
  const folder = makeFolder();
  const lines = [];
  const child = startApp({ port: PORT, tag: 'suggest-fit', onLine: (line) => lines.push(line) });
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
        .find((entry) => entry.dataset.path === 'styles.css');
      row.click();
      await sleep(1200);
      return true;
    `);

    const wide = await measureAt(session, 'default window');

    // Narrow the window so the editor is smaller than the list wants to be.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(600);
    const narrow = await measureAt(session, 'narrow window (900px)');

    /*
     * The reported case: a short editor, so the list is drawn below the caret
     * with nowhere to go and the panel below covers its last rows. A short
     * window is the honest way to reproduce it - the panel keeps its height and
     * the editor is what gives way.
     */
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(600);
    const shortWindow = await measureAt(session, 'short window (520px)');

    const problems = [];
    for (const [label, measured] of [['default', wide], ['narrow', narrow], ['short', shortWindow]]) {
      if (!measured.widget) {
        problems.push(`${label}: no suggestion list appeared`);
        continue;
      }
      /*
       * A widget with no rows is Monaco saying "nothing to suggest", not a list
       * that was clipped - and in a very narrow editor it says that on purpose,
       * because a 168px list is not worth showing. Only the geometry of a list
       * that actually has rows is this probe's business; the default window is
       * where "a list must appear" is required, and it is required there.
       */
      if (!measured.rows) {
        if (label === 'default') problems.push(`${label}: no suggestions appeared at all`);
        continue;
      }
      if (measured.overflowsEditorRight > 0) {
        problems.push(`${label}: the list runs ${measured.overflowsEditorRight}px past the editor's right edge`);
      }
      if (measured.overflowsEditorBottom > 0) {
        problems.push(`${label}: the list runs ${measured.overflowsEditorBottom}px past the editor's bottom edge`);
      }
      if (measured.widget && measured.editor && measured.widget.bottom > measured.editor.bottom - 2) {
        problems.push(
          `${label}: the list ends at ${measured.widget.bottom}, flush with the editor's bottom ${measured.editor.bottom}, so the panel below covers its last row`
        );
      }
      if (measured.widget && measured.editor && measured.widget.height > measured.editor.height) {
        problems.push(
          `${label}: the list is ${measured.widget.height}px tall in a ${measured.editor.height}px editor, so it cannot fit`
        );
      }
      if (measured.paintedAtWidgetRight && measured.paintedAtWidgetRight !== 'the widget itself') {
        problems.push(`${label}: the right of the list is painted under ${measured.paintedAtWidgetRight}`);
      }
      if (measured.paintedAtLastRow && measured.paintedAtLastRow !== 'the widget itself') {
        problems.push(`${label}: the last row is painted under ${measured.paintedAtLastRow}`);
      }
      if (measured.paintedAtWidgetBottom && measured.paintedAtWidgetBottom !== 'the widget itself') {
        problems.push(`${label}: the bottom of the list is painted under ${measured.paintedAtWidgetBottom}`);
      }
      if (measured.paintedAtLastRowBottom && measured.paintedAtLastRowBottom !== 'the widget itself') {
        problems.push(`${label}: the last row's bottom is painted under ${measured.paintedAtLastRowBottom}`);
      }
    }

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe list stays inside the editor, and its last row is painted');
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
