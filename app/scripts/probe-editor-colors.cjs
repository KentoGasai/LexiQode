/**
 * Open files of several kinds in the real window and count the colours.
 *
 * This exists because the failure it looks for is silent. A file opened with the
 * wrong language still has its text, its line numbers and its tabs; nothing
 * throws, and only the colours are missing. The mistake that produced it - the
 * file's own extension used as the language id, so `.js` was never a language
 * Monaco knew - passed every unit test for as long as it existed.
 *
 * Each check is something that has to be true of a working editor: the model
 * gets the language id the registry knows, and the editor paints more than one
 * token colour. `tokenClasses` is the load-bearing number: a coloured file is
 * drawn with several `mtk` classes, an uncoloured one with one.
 *
 * Run: node scripts/probe-editor-colors.cjs [folder]
 */

const path = require('node:path');

const { APP, connect, listTargets, runChecks, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9337);
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');

/** A file per language family, with the id Monaco is expected to give it. */
const FILES = [
  ['app/src/renderer/js/explorer.js', 'javascript'],
  ['app/src/renderer/css/app.css', 'css'],
  ['app/src/renderer/index.html', 'html'],
  ['app/package.json', 'json'],
  ['core/lexiqode/version.py', 'python'],
  ['scripts/build-app.ps1', 'powershell'],
  ['README.md', 'markdown']
];

/** How many token colours a file must use to count as coloured. */
const MIN_TOKEN_CLASSES = 3;

const CHECKS = [
  {
    label: 'the language registry the editor has',
    expression: `
      const monaco = window.monaco;
      if (!monaco) return { hasMonaco: false };
      const languages = monaco.languages.getLanguages();
      const ids = languages.map((entry) => entry.id);
      const extensions = new Map();
      for (const entry of languages) {
        for (const extension of entry.extensions || []) extensions.set(extension, entry.id);
      }
      return {
        hasMonaco: true,
        languageCount: languages.length,
        knows: {
          js: ids.includes('javascript'),
          python: ids.includes('python'),
          markdown: ids.includes('markdown'),
          powershell: ids.includes('powershell')
        },
        // The mapping that matters: the extension and the language id are not
        // the same word, which is exactly what the broken version assumed.
        exts: Object.fromEntries(
          ['.js', '.py', '.md', '.ps1', '.ts', '.yml'].map((key) => [key, extensions.get(key) || null])
        )
      };
    `
  },
  {
    label: 'each file: its language, its tokens and its colours',
    expression: `
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const first = document.querySelector('.activity__item');
      if (first) first.click();
      await sleep(400);
      await window.lexiqode.workspace.open(${JSON.stringify(WORKSPACE)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelectorAll('.tree__row').length) break;
        await sleep(250);
      }

      const rows = (kind) => [...document.querySelectorAll('.tree__row[data-kind="' + kind + '"]')];
      // A folder row toggles, so each one is clicked exactly once per run: a
      // second click would close the branch the next file is looked for in.
      const opened = new Set();
      const expand = async (wanted) => {
        const parts = wanted.split('/');
        for (let depth = 1; depth < parts.length; depth += 1) {
          const folder = parts.slice(0, depth).join('/');
          if (opened.has(folder)) continue;
          const row = rows('folder').find((entry) => entry.dataset.path === folder);
          if (!row) return false;
          row.click();
          opened.add(folder);
          await sleep(450);
        }
        return true;
      };

      const report = [];
      for (const [file, expected] of ${JSON.stringify(FILES)}) {
        const expanded = await expand(file);
        const row = rows('file').find((entry) => entry.dataset.path === file);
        if (!row) {
          report.push({ file, expected, expanded, opened: false });
          continue;
        }
        row.click();
        // A language's tokenizer is loaded on demand, so this waits for the
        // colouring rather than for the text: a fixed sleep reports the moment
        // the file appeared, and under load that is a moment before the
        // tokenizer arrived - which looks exactly like the bug being searched
        // for. The wait is bounded, and what it gave up on is reported.
        const monaco = window.monaco;
        let model = null;
        let spans = [];
        let classes = [];
        for (let attempt = 0; attempt < 40; attempt += 1) {
          model = monaco.editor.getModels().find((entry) => entry.uri.path.endsWith('/' + file));
          spans = [...document.querySelectorAll('.view-lines .view-line span[class*="mtk"]')];
          classes = [...new Set(spans.map((span) => span.className))];
          if (model && model.getLanguageId() === expected && classes.length >= ${MIN_TOKEN_CLASSES}) break;
          await sleep(250);
        }
        const colours = [...new Set(spans.map((span) => getComputedStyle(span).color))];
        report.push({
          file,
          expected,
          opened: true,
          language: model ? model.getLanguageId() : '(no model)',
          tokenSpans: spans.length,
          tokenClasses: classes.length,
          ok: Boolean(model) && model.getLanguageId() === expected && classes.length >= ${MIN_TOKEN_CLASSES},
          classes: classes.slice(0, 10),
          colours: colours.slice(0, 5)
        });
      }
      return report;
    `
  }
];

async function main() {
  const child = startApp({ port: PORT, tag: 'colours' });
  console.log(`isolated configuration: ${child.configDir}`);
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    console.log(`attached to ${target.url}`);
    await waitForDom(session);
    await runChecks(session, [CHECKS[0]]);
    // `runChecks` prints; this is the part that decides whether the run passed,
    // because a silently uncoloured editor is exactly what it is looking for.
    const report = await session.evaluate(`${CHECKS[1].expression}`);
    console.log(`\n--- each file: its language, its tokens and its colours\n${JSON.stringify(report, null, 2)}`);
    const bad = (Array.isArray(report) ? report : []).filter((entry) => entry.ok !== true);
    console.log(`\n${report.length - bad.length}/${report.length} files arrived coloured and in the right language`);
    if (bad.length) {
      console.log(`not coloured: ${bad.map((entry) => `${entry.file} (${entry.language || 'not opened'})`).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});