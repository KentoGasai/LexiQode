/**
 * Press Run, and watch the file actually run.
 *
 * Everything else about the run button can be checked by reading: the command it
 * builds, the class it carries, the panel it opens first. What cannot is whether
 * the code reaches a shell and comes back as output on screen - which is the
 * whole feature, and the part that fails in ways a unit test cannot see: a quoted
 * path a shell rejects, a working directory the shell is not in, a session that
 * was never started because the panel was closed.
 *
 * So this probe writes a small script into a temporary folder, opens that folder
 * in a real window, opens the file, presses the button and waits for the number
 * the script prints. Nothing of the repository is used or touched.
 *
 * Run: node scripts/probe-run.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9335);
/** What the script prints, and what the probe waits for. */
const MARKER = 'lexiqode-run-ok';
const SCRIPT = [
  '// Printed by the run probe: the answer, and the folder it ran in.',
  `console.log('${MARKER}:' + (6 * 7));`,
  "console.log('cwd:' + process.cwd());",
  ''
].join('\n');

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-run-'));
  fs.writeFileSync(path.join(root, 'run-check.js'), SCRIPT, 'utf8');
  return root;
}

async function main() {
  const folder = makeFolder();
  const child = startApp({ port: PORT, tag: 'run' });
  console.log(`folder under test: ${folder}`);
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);
    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const q = (selector) => document.querySelector(selector);
      const qa = (selector) => [...document.querySelectorAll(selector)];
      const out = { output: [] };

      // Everything the shell says, gathered from the moment the window opens.
      window.lexiqode.on('terminal:data', (payload) => {
        if (payload && payload.data) out.output.push(String(payload.data));
      });

      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (qa('.tree__row').length) break;
        await sleep(250);
      }

      // The row for the file, clicked the way a person opens it.
      const row = qa('.tree__row[data-kind="file"]').find((entry) => entry.dataset.path === 'run-check.js');
      if (!row) return { error: 'the script did not appear in the tree', output: out.output };
      row.click();
      await sleep(1200);

      const button = q('#editor-actions .runbtn');
      out.button = { present: Boolean(button), title: button ? button.title : '' };
      if (!button) return { ...out, error: 'there is no run button' };

      // A shell of its own should not be needed: the folder was opened with one,
      // and the button has to work with it rather than start a second.
      const before = (await window.lexiqode.terminal.list().catch(() => [])).length;
      out.sessionsBefore = before;
      button.click();

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (out.output.join('').includes(${JSON.stringify(MARKER)})) break;
        await sleep(250);
      }
      out.sessionsAfter = (await window.lexiqode.terminal.list().catch(() => [])).length;
      out.panelVisible = !q('#panel').hidden;
      out.text = out.output.join('').replace(/\\u001b\\[[0-9;]*m/g, '').trim();
      return out;
    `);

    console.log(JSON.stringify(report, null, 2));
    const text = String(report.text || '');
    const problems = [];
    if (report.error) problems.push(report.error);
    if (!report.button || !report.button.present) problems.push('there is no run button in the editor');
    if (!text.includes(`${MARKER}:42`)) problems.push('the script did not run, or its output never arrived');
    if (!report.panelVisible) problems.push('the output landed in a panel nobody can see');
    // The command itself is echoed into the console buffer rather than into the
    // shell's output, so it is read from the button that sent it.
    if (!report.button || !/node .*run-check\.js/.test(report.button.title || '')) {
      problems.push('the button does not send the file to an interpreter');
    }
    // The script reports the directory it ran in, which is the folder the shell
    // was started in: `node run-check.js` only works from there.
    if (text.includes(`${MARKER}:42`) && !/cwd:.*lexiqode-run-/i.test(text)) {
      problems.push('the script ran, but not from the folder that was opened');
    }

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe run button sent the file to the shell, and the shell printed what the file says');
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