/**
 * Does the editor suggest anything while code is being written?
 *
 * The question is not answerable from the sources. Monaco suggests from two
 * places: a language service, which runs in a worker and knows what `addNumbers`
 * takes and returns, and a document-word provider, which suggests words that
 * appear elsewhere in the same file. The first cannot work unless the worker the
 * editor asks for exists, and a worker that fails to start is silent - the window
 * then looks exactly like an editor that simply has nothing to suggest.
 *
 * So this probe types into a real window and reads the widget a person would see,
 * and separately asks for the TypeScript worker directly, because those two can
 * disagree: the service may be dead while the word provider still answers.
 *
 * Nothing of the repository is touched: the probe writes two small files into a
 * temporary folder and opens that folder.
 *
 * Run: node scripts/probe-editor-suggest.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, startApp, waitForDom } = require('./probe-harness.cjs');

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
  return root;
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
    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const q = (selector) => document.querySelector(selector);
      const qa = (selector) => [...document.querySelectorAll(selector)];
      const out = {};

      // A settle delay, so a failure cannot be blamed on opening a file in the
      // first milliseconds of the window's life unless that is really the cause.
      await sleep(${Number(process.env.LEXIQODE_PROBE_SETTLE_MS || 0)});
      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (q('.tree__row')) break;
        await sleep(250);
      }

      out.monaco = window.monaco ? window.monaco.version : 'not loaded';

      /* Open a file from the tree, the way a person does. */
      const openFromTree = async (name) => {
        const row = qa('.tree__row[data-kind="file"]').find((entry) => entry.dataset.path === name);
        if (!row) return false;
        row.click();
        await sleep(1200);
        return true;
      };

      /*
       * Type a prefix and read what the widget offers.
       *
       * \`editor.trigger\` is the editor's own entry point for keystrokes, so the
       * suggestion arrives the way a typed letter makes it arrive rather than by
       * a provider being called by hand.
       */
      const suggestionsFor = async (typed) => {
        const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
        const editor = editors[0];
        if (!editor) return { error: 'no editor instance' };
        editor.focus();
        const model = editor.getModel();
        if (!model) return { error: 'no model' };
        // At the end of the file, where the module's own names are in scope.
        const last = model.getLineCount();
        editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
        editor.trigger('probe', 'type', { text: '\\n' + typed });
        await sleep(800);
        const before = q('.suggest-widget');
        if (!before || !before.classList.contains('visible')) {
          editor.trigger('probe', 'editor.action.triggerSuggest', {});
          await sleep(800);
        }
        const widget = q('.suggest-widget');
        return {
          visible: Boolean(widget && widget.classList.contains('visible')),
          rows: widget ? qa('.suggest-widget .monaco-list-row').map((row) => row.textContent.trim()).slice(0, 12) : [],
          language: model.getLanguageId()
        };
      };

      out.openedJavaScript = await openFromTree('calc.js');
      out.javascript = await suggestionsFor('addNum');

      out.openedPython = await openFromTree('calc.py');
      out.python = await suggestionsFor('calc');

      /*
       * Diagnostics, which only a language service produces.
       *
       * The marker set is the honest answer to "is the service running": word
       * suggestions appear without any service at all, so the widget alone cannot
       * tell the two apart.
       */
      await sleep(1500);
      out.markers = window.monaco.editor.getModelMarkers({}).map((marker) => ({
        resource: String(marker.resource && marker.resource.path || ''),
        severity: marker.severity,
        message: String(marker.message).slice(0, 120)
      })).slice(0, 6);

      return out;
    `);
    console.log(JSON.stringify(report, null, 2));

    console.log(`\nmonaco: ${report.monaco}`);
    console.log(`markers from the service: ${(report.markers || []).length}`);
    console.log(`javascript suggestions: ${report.javascript.rows.length}`);
    console.log(`python suggestions: ${report.python.rows.length}`);
    const workerNoise = lines.filter((line) => /worker/i.test(line) && /error|fail|not found|could not/i.test(line));
    if (workerNoise.length) {
      console.log('\nwhat the window said about the worker:');
      for (const line of workerNoise.slice(0, 6)) console.log(`  ${line.slice(0, 300)}`);
    }

    /*
     * The expectations, stated so this is a check rather than a report.
     *
     * A language service is what produces the markers: word suggestions appear
     * without any service at all, so the widget alone cannot tell a working
     * service from a dead one. A service that fails to start says nothing in the
     * window, which is exactly how it went unnoticed.
     */
    const loadFailures = lines.filter((line) => /failed to load/i.test(line)).length;
    const problems = [];
    if (report.javascript.language !== 'javascript') problems.push(`calc.js opened as ${report.javascript.language}`);
    if (report.python.language !== 'python') problems.push(`calc.py opened as ${report.python.language}`);
    if (!report.javascript.rows.length) problems.push('no suggestion was offered for addNum in a .js file');
    if (!report.python.rows.length) problems.push('no suggestion was offered for calc in a .py file');
    if (!(report.markers || []).length) problems.push('the language service reported nothing at all, so it is not running');
    if (loadFailures) problems.push(`a worker failed to load (${loadFailures} line(s) in the window output)`);

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe editor suggests from the document and from a running language service');
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