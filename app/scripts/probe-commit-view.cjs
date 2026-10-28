/**
 * Does a commit open as a file list, and does a file open as a coloured diff?
 *
 * The panel listed commits and clicking one did nothing, so the history was
 * readable but the change behind each line was not. The fix is a commit view -
 * a header and the files the commit touched - and, behind each file, a diff
 * drawn by Monaco's diff editor rather than a document full of `+` and `-`
 * lines. Both halves are checked here against a real repository, because "the
 * command exists" and "the change is on screen" are different claims.
 *
 * Run: node scripts/probe-commit-view.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9342);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'Probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid'
    }
  });
}

/** A repository with one commit that adds a file and one that changes it. */
function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-commit-view-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Probe']);
  git(root, ['config', 'user.email', 'probe@example.invalid']);
  fs.writeFileSync(path.join(root, 'app.js'), 'function greet(name) {\n  return "hi " + name;\n}\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add a greeting']);
  fs.writeFileSync(
    path.join(root, 'app.js'),
    'function greet(name) {\n  return "hello " + name;\n}\n\nfunction farewell(name) {\n  return "bye " + name;\n}\n',
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'change the greeting and add notes']);
  return root;
}

async function main() {
  const folder = makeRepository();
  const lines = [];
  const child = startApp({ port: PORT, tag: 'commit-view', onLine: (line) => lines.push(line) });
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

    // Open the source control panel the way a person does: the activity button.
    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const item = [...document.querySelectorAll('.activity__item')]
        .find((node) => (node.title || '').toLowerCase().includes('source control'));
      if (item) item.click();
      await sleep(1200);
      return Boolean(document.querySelector('.git__row, .list__empty'));
    `);

    const panel = await session.evaluate(`
      return {
        commits: [...document.querySelectorAll('.hit--button')].map((node) => node.textContent.trim()),
        syncButtons: [...document.querySelectorAll('.git__sync')].map((node) => node.textContent.trim())
      };
    `);
    console.log(`\n--- source control panel\n${JSON.stringify(panel, null, 2)}`);

    // Click the newest commit and read the view it opens.
    const opened = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = document.querySelector('.hit--button');
      if (!row) return { clicked: false };
      row.click();
      await sleep(1200);
      const view = document.querySelector('.editor__commit');
      return {
        clicked: true,
        visible: Boolean(view && !view.hidden),
        subject: view ? (view.querySelector('.commitview__subject') || {}).textContent : null,
        meta: view ? (view.querySelector('.commitview__meta') || {}).textContent : null,
        files: view
          ? [...view.querySelectorAll('.commitview__file')].map((node) => ({
              badge: (node.querySelector('.commitview__badge') || {}).textContent,
              kind: (node.querySelector('.commitview__badge') || {}).dataset?.kind,
              name: (node.querySelector('.commitview__name') || {}).textContent
            }))
          : []
      };
    `);
    console.log(`\n--- commit view\n${JSON.stringify(opened, null, 2)}`);

    // Click the first file and read the diff editor.
    const diff = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const file = document.querySelector('.commitview__file');
      if (!file) return { clicked: false };
      file.click();
      await sleep(1500);
      const host = document.querySelector('.editor__diff');
      const editors = window.monaco.editor.getDiffEditors ? window.monaco.editor.getDiffEditors() : [];
      const diffEditor = editors[0];
      const model = diffEditor ? diffEditor.getModel() : null;
      return {
        clicked: true,
        visible: Boolean(host && !host.hidden),
        original: model && model.original ? model.original.getValue() : null,
        modified: model && model.modified ? model.modified.getValue() : null,
        // The coloured part: Monaco marks added and removed lines with these
        // classes, and their presence is what "a coloured diff" means.
        addedLines: host ? host.querySelectorAll('.line-insert, .char-insert').length : 0,
        removedLines: host ? host.querySelectorAll('.line-delete, .char-delete').length : 0
      };
    `);
    console.log(`\n--- file diff\n${JSON.stringify(diff, null, 2)}`);

    const problems = [];
    if (!panel.syncButtons.length) problems.push('the panel has no fetch/pull/push buttons');    if (!panel.commits.length) problems.push('the panel lists no commits');
    if (!opened.clicked) problems.push('a commit row could not be clicked');
    if (opened.clicked && !opened.visible) problems.push('clicking a commit opened no commit view');
    if (opened.clicked && !opened.files.length) problems.push('the commit view lists no files');
    if (opened.clicked && !opened.files.some((file) => file.kind === 'modified')) {
      problems.push('the changed file is not marked as modified');
    }
    if (opened.clicked && !opened.files.some((file) => file.kind === 'added')) {
      problems.push('the added file is not marked as added');
    }
    if (!diff.clicked) problems.push('a file in the commit could not be clicked');
    if (diff.clicked && !diff.visible) problems.push('clicking a file opened no diff');
    if (diff.clicked && diff.original === diff.modified) problems.push('the diff compares a file with itself');
    if (diff.clicked && !diff.addedLines) problems.push('the diff has no added lines marked');
    if (diff.clicked && !diff.removedLines) problems.push('the diff has no removed lines marked');

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\na commit opens as a file list, and a file opens as a coloured diff');
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
