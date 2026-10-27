/**
 * The explorer creates files and folders, renames them, and points its markers.
 *
 * Four features in this window asked for a name through `window.prompt`, and
 * Electron does not implement it: it returns null without showing anything, so the
 * "+" buttons and Rename did nothing at all and were reported as broken buttons.
 * The name is typed in the tree now, and whether that works cannot be seen by
 * reading: it has to be typed, pressed Enter on and looked for on disk.
 *
 * The folder markers are checked in the same pass, because they were reported in
 * the same breath: the disclosure used to be the character '▸' / '▾' and a folder
 * '▣', and the window's font has none of the three, so folders were marked with
 * empty squares. What has to be true now is that the marker is drawn and that it
 * points right while a folder is closed and down while it is open.
 *
 * Run it alone: two probes at once open two windows, and a window behind another
 * has its frames throttled.
 *
 * Run: node scripts/probe-explorer-create.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9356);
const FILE_NAME = 'typed-by-the-probe.txt';
const FOLDER_NAME = 'made-by-the-probe';
const RENAMED = 'renamed-by-the-probe.txt';

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-tree-'));
  fs.writeFileSync(path.join(root, 'keep.txt'), 'x\n', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
  return root;
}

async function main() {
  const folder = makeFolder();
  const child = startApp({ port: PORT, tag: 'tree' });
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

      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (qa('.tree__row').length) break;
        await sleep(250);
      }

      const actions = () => qa('#sidebar-actions .iconbtn');
      const rowNames = () => qa('.tree__row .tree__label').map((node) => node.textContent);

      // Type into the field the tree drew, then press Enter on it.
      const type = async (name) => {
        const input = q('#sidebar-body .tree__input');
        if (!input) return false;
        input.focus();
        input.value = name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      };
      const waitForRow = async (name) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await sleep(150);
          if (rowNames().includes(name)) return true;
        }
        return false;
      };

      // The markers: drawn, and pointing the way the folder will move.
      const folderRow = qa('.tree__row').find((row) => row.dataset.kind === 'folder');
      const twisty = folderRow ? folderRow.querySelector('.tree__twisty') : null;
      const svg = twisty ? twisty.querySelector('svg') : null;
      out.markers = {
        twistyText: twisty ? twisty.textContent : '(no twisty)',
        drawn: Boolean(svg),
        closedTransform: svg ? getComputedStyle(svg).transform : '',
        closedFlag: twisty ? twisty.dataset.open : '',
        folderIconDrawn: folderRow ? Boolean(folderRow.querySelector('.tree__icon svg')) : false,
        folderIconText: folderRow ? folderRow.querySelector('.tree__icon').textContent : ''
      };
      if (folderRow) {
        folderRow.click();
        await sleep(700);
        const opened = qa('.tree__row').find((row) => row.dataset.path === folderRow.dataset.path);
        const openedTwisty = opened ? opened.querySelector('.tree__twisty') : null;
        const openedSvg = openedTwisty ? openedTwisty.querySelector('svg') : null;
        out.markers.openTransform = openedSvg ? getComputedStyle(openedSvg).transform : '';
        out.markers.openFlag = openedTwisty ? openedTwisty.dataset.open : '';
      }

      // Create a file from the toolbar, the way a person does it.
      out.before = rowNames();
      actions()[0].click();
      await sleep(250);
      out.fileField = await type(${JSON.stringify(FILE_NAME)});
      out.fileRowAppeared = await waitForRow(${JSON.stringify(FILE_NAME)});

      // And a folder.
      actions()[1].click();
      await sleep(250);
      out.folderField = await type(${JSON.stringify(FOLDER_NAME)});
      out.folderRowAppeared = await waitForRow(${JSON.stringify(FOLDER_NAME)});

      // Rename the file in place, from its own menu.
      const fileRow = qa('.tree__row').find((row) => row.dataset.path === ${JSON.stringify(FILE_NAME)});
      out.fileRowFound = Boolean(fileRow);
      if (fileRow) {
        fileRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 70, clientY: 120 }));
        await sleep(300);
        const items = qa('.ctxmenu__item');
        out.menuItems = items.map((node) => node.textContent.trim());
        const renameItem = items.find((node) => /переимен|rename/i.test(node.textContent));
        out.renameOffered = Boolean(renameItem);
        if (renameItem) {
          renameItem.click();
          await sleep(250);
          const field = q('#sidebar-body .tree__input');
          out.renameFieldValue = field ? field.value : '(no field)';
          out.renameTyped = await type(${JSON.stringify(RENAMED)});
          out.renameRowAppeared = await waitForRow(${JSON.stringify(RENAMED)});
        }
      }
      out.after = rowNames();
      out.toasts = qa('.toast').map((node) => node.textContent);
      return out;
    `);

    console.log(JSON.stringify(report, null, 2));

    const problems = [];
    const markers = report.markers || {};
    if (!markers.drawn) problems.push('the folder marker is not drawn at all');
    if (markers.twistyText) {
      problems.push(`the folder marker is still a character: ${JSON.stringify(markers.twistyText)}`);
    }
    if (!/matrix\(0(\.\d+)?,\s*-1/.test(markers.closedTransform || '')) {
      problems.push(`a closed folder does not point right: ${markers.closedTransform}`);
    }
    if (markers.openFlag !== 'true' || !/matrix\(1,\s*0,\s*0,\s*1/.test(markers.openTransform || '')) {
      problems.push(`opening a folder does not turn its marker: ${markers.openTransform}`);
    }
    if (!markers.folderIconDrawn || markers.folderIconText) {
      problems.push('a folder is still marked by a character rather than a drawn outline');
    }
    if (!report.fileField) problems.push('clicking "new file" drew no field to type in');
    if (!report.fileRowAppeared) problems.push('the created file never appeared in the tree');
    if (!report.folderField) problems.push('clicking "new folder" drew no field to type in');
    if (!report.folderRowAppeared) problems.push('the created folder never appeared in the tree');
    if (!report.renameOffered) problems.push('the row menu offers no rename');
    if (report.renameFieldValue !== FILE_NAME) {
      problems.push(`the rename field did not start with the current name: ${report.renameFieldValue}`);
    }
    if (!report.renameRowAppeared) problems.push('the renamed file never appeared in the tree');

    // The tree is the view; the disk is the truth.
    if (!fs.existsSync(path.join(folder, FILE_NAME)) && !fs.existsSync(path.join(folder, RENAMED))) {
      problems.push('no file was ever written');
    }
    if (!fs.existsSync(path.join(folder, FOLDER_NAME))) problems.push('the folder was never created on disk');
    if (!fs.existsSync(path.join(folder, RENAMED))) problems.push('the file was never renamed on disk');
    if (fs.existsSync(path.join(folder, FILE_NAME))) problems.push('the old name survived the rename');

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      '\nthe "+" buttons create what was typed, rename happens in place, and the folder markers point the way VSCode does'
    );
  } finally {
    child.kill();
    await sleep(400);
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