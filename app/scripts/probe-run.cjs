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
 * It checks two separate things, because they fail separately: that the output
 * *arrives* (the event stream carries it) and that it is *painted* (the terminal's
 * rows contain it). A panel with no terminal in it receives text and shows none of
 * it, which is what "the Run button does nothing" turned out to be.
 *
 * Run it alone: two probes at once open two windows, and a window behind another
 * has its frames throttled.
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
      out.ids = [];
      window.lexiqode.on('terminal:data', (payload) => {
        if (!payload) return;
        if (payload.data) out.output.push(String(payload.data));
        // Which session the text belongs to, because a shell that answers in a
        // session nobody is looking at is indistinguishable from a dead one.
        if (payload.data && out.ids[out.ids.length - 1] !== payload.id) out.ids.push(payload.id);
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
      out.sessionIds = (await window.lexiqode.terminal.list().catch(() => [])).map((entry) => ({
        id: entry.id,
        cwd: entry.cwd,
        alive: entry.alive
      }));
      out.tabs = qa('#panel-tabs .panel__tab').map((tab) => ({
        text: tab.textContent.trim(),
        selected: tab.getAttribute('aria-selected')
      }));
      out.panelVisible = !q('#panel').hidden;
      out.text = out.output.join('').replace(/\\u001b\\[[0-9;]*m/g, '').trim();
      /*
       * The terminal paints on its own schedule, and that schedule is a frame.
       *
       * Reading the DOM in the same tick as the last chunk of output measures the
       * moment before the frame, and a window behind another one gets its frames
       * throttled - which is why this waits for the text instead of for a fixed
       * moment. (Two probes started at once occlude each other: run them one at a
       * time.)
       */
      out.paintWaitedMs = 0;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const rows = q('#panel-body .xterm-rows');
        if (rows && rows.textContent.includes(${JSON.stringify(MARKER)})) break;
        await sleep(200);
        out.paintWaitedMs += 200;
      }

      /*
       * Whether any of that is on screen.
       *
       * The output arriving and the output being painted are two different
       * things, and the difference is invisible to every check that only watches
       * the event stream: a terminal that was disposed, re-parented or opened
       * while its panel had no size keeps receiving text and draws none of it,
       * so the panel is blank and the person sees "nothing happened".
       */
      const host = q('#panel-body .terminal');
      const screen = q('#panel-body .xterm-screen');
      const rows = q('#panel-body .xterm-rows');
      out.paint = {
        host: Boolean(host),
        xterm: Boolean(q('#panel-body .xterm')),
        screen: Boolean(screen),
        rowsPresent: Boolean(rows),
        // The whole buffer, because the shell's answer is at the bottom of it and
        // a preview of the top would report a working terminal as empty.
        paintedAll: rows ? rows.textContent.replace(/\\s+/g, ' ').trim() : '',
        painted: rows ? rows.textContent.replace(/\\s+/g, ' ').trim().slice(-240) : '',
        hostHeight: host ? Math.round(host.getBoundingClientRect().height) : 0,
        panelHeight: Math.round((q('#panel') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
        body: q('#panel-body') ? q('#panel-body').innerHTML.slice(0, 300) : '',
        terminalGlobal: typeof window.Terminal,
        terminalVersion: window.Terminal ? String(window.Terminal.version || '') : '',
        fitGlobal: typeof window.FitAddon,
        // Every element that looks like a terminal, wherever it is: the question
        // is not only whether xterm drew something, but where it drew it.
        census: qa('.terminal, .xterm, [class*="xterm"]').slice(0, 12).map((node) => ({
          cls: String(node.className),
          connected: node.isConnected,
          parent: node.parentElement ? (node.parentElement.id || String(node.parentElement.className)) : null,
          children: node.childElementCount,
          text: String(node.textContent || '').trim().slice(0, 60)
        }))
      };

      return out;
    `);

    console.log(JSON.stringify(report, null, 2));
    const text = String(report.text || '');
    const problems = [];
    if (report.error) problems.push(report.error);
    if (!report.button || !report.button.present) problems.push('there is no run button in the editor');
    if (!text.includes(`${MARKER}:42`)) problems.push('the script did not run, or its output never arrived');
    if (!report.panelVisible) problems.push('the output landed in a panel nobody can see');
    // Nothing on screen is the failure a person actually reports, so it is
    // checked separately from the output having arrived.
    if (!report.paint || !report.paint.rowsPresent) {
      problems.push('the panel has no terminal on screen at all');
    } else if (!String(report.paint.paintedAll).includes(`${MARKER}:42`)) {
      problems.push('the output arrived but was never painted, so the shell looks empty');
    }
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