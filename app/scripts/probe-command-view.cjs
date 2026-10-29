/**
 * Is the command the assistant ran visible, whole, behind a disclosure?
 *
 * The tool row showed the command clipped to 120 characters. That is enough to
 * recognise a command and not enough to check or copy one: the end of a command
 * matters as much as the beginning. The row now carries the command in full, in
 * its own block, opened by the same disclosure that opens the arguments.
 *
 * This probe drives a real turn against a stub endpoint that asks for a
 * `run_command` with a command longer than the summary limit, then reads the row
 * and the block it opens. The command is run by the core, so what is measured is
 * the real path.
 *
 * Run: node scripts/probe-command-view.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9347);
const STUB_PORT = Number(process.env.LEXIQODE_STUB_PORT || 8795);

// Longer than the 120-character summary limit, and multi-line, so a clipped or
// flattened command is visible in the measurement rather than a matter of taste.
const COMMAND = [
  'echo "line one of the command"',
  'echo "line two of the command"',
  'echo "line three of the command"',
  'echo "line four of the command"',
  'echo "line five of the command"'
].join('\n');

function makeFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-command-view-'));
}

/** A stub endpoint that asks for one `run_command`, then answers. */
function startStub() {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const asked = body ? JSON.parse(body) : {};
      const messages = asked.messages || [];
      const sawToolResult = messages.some((message) => message.role === 'tool');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta) => response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      if (!sawToolResult) {
        send({ content: 'Running the command. ' });
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_command_1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({ command: COMMAND })
                      }
                    }
                  ]
                }
              }
            ]
          })}\n\n`
        );
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        send({ content: 'Done.' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const folder = makeFolder();
  const lines = [];
  const stub = await startStub();
  const child = startApp({ port: PORT, tag: 'command-view', onLine: (line) => lines.push(line) });
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
      return true;
    `);

    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.lexiqode.agent.saveProfile({
        active_profile: 'default',
        profile: { id: 'default', base_url: 'http://127.0.0.1:${STUB_PORT}/v1', api_key: 'stub', model: 'stub-model' },
        agent: { auto_approve: true, approve_writes: false, approve_commands: false }
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await window.lexiqode.agent.state().catch(() => null);
        if (state && state.profile && state.profile.model) break;
        await sleep(250);
      }
      return true;
    `);

    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const input = document.getElementById('composer-input');
      input.focus();
      input.value = 'run the command';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer-send').click();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(200);
        const stop = document.getElementById('composer-stop');
        const send = document.getElementById('composer-send');
        if (stop && getComputedStyle(stop).display === 'none' && send && !send.disabled) break;
      }
      return true;
    `);

    const measured = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = document.querySelector('.toolrow');
      const summary = document.querySelector('.toolrow__args');
      const result = {
        row: Boolean(row),
        // The one-line summary is allowed to clip: it is a row, not a document.
        summary: summary ? summary.textContent : null,
        summaryLength: summary ? summary.textContent.length : 0,
        // Before opening: the disclosure is closed, so the command is not shown.
        // \`details.open\` is the honest test - \`offsetParent\` is null for a closed
        // details *and* for a hidden ancestor, which is not the same question.
        detailsOpenBefore: row ? row.open : null,
        // The block is built with the row and lives in the DOM. Whether a closed
        // row shows it is a question about geometry, not about offsetParent:
        // a closed details still gives its children a layout box in some
        // engines, so the honest test is the rendered size.
        commandRectBefore: (() => {
          const block = document.querySelector('.toolrow__pre--command');
          if (!block) return null;
          const rect = block.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        })(),
        // The same question for the arguments block, which was there before this
        // change and is known to be hidden while the row is closed. If both
        // report a box, the box is not evidence of visibility and the test has to
        // be something else.
        argsRectBefore: (() => {
          const block = document.querySelector('.toolrow__pre:not(.toolrow__pre--command)');
          if (!block) return null;
          const rect = block.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        })(),
        // What the browser says about the row's own box while it is closed.
        rowRectBefore: (() => {
          if (!row) return null;
          const rect = row.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        })(),
        // The honest test of "is it on screen": ask the document what is painted
        // at the point where the block claims to be. A closed details reports a
        // box for its children but paints nothing there, so the element at that
        // point is something else - or nothing.
        paintedBefore: (() => {
          const block = document.querySelector('.toolrow__pre--command');
          if (!block) return null;
          const rect = block.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return 'no box';
          const hit = document.elementFromPoint(rect.left + 4, rect.top + 4);
          if (!hit) return 'nothing';
          return block.contains(hit) || hit === block ? 'the command block' : hit.className || hit.tagName;
        })()
      };
      if (row) {
        const head = row.querySelector('.toolrow__head');
        if (head) head.click();
        await sleep(300);
        result.detailsOpenAfter = row.open;
        const block = document.querySelector('.toolrow__pre--command');
        result.commandBlock = Boolean(block);
        result.commandVisible = block ? Boolean(block.offsetParent) : false;
        result.commandText = block ? block.textContent : null;
        result.commandLines = block ? block.textContent.split('\\n').length : 0;
        result.label = (() => {
          const labels = [...document.querySelectorAll('.toolrow__label')];
          return labels.map((node) => node.textContent);
        })();
        // The block must not be squeezed: a command is read line by line.
        result.blockHeight = block ? Math.round(block.getBoundingClientRect().height) : 0;
        result.blockWidth = block ? Math.round(block.getBoundingClientRect().width) : 0;
        result.rowWidth = row ? Math.round(row.getBoundingClientRect().width) : 0;
      }
      return result;
    `);
    console.log(`\n--- the command the assistant ran\n${JSON.stringify(measured, null, 2)}`);

    const problems = [];
    if (!measured.row) problems.push('no tool row appeared for the command the assistant ran');
    if (measured.row && measured.summaryLength > 130) {
      problems.push(`the one-line summary is ${measured.summaryLength} characters, so it is not clipped`);
    }
    if (measured.row && measured.detailsOpenBefore !== false) {
      problems.push('the row is open before anyone asked for it');
    }
    if (measured.row && measured.paintedBefore === 'the command block') {
      problems.push('the command is painted before the row is opened');
    }    if (measured.row && measured.detailsOpenAfter !== true) {
      problems.push('clicking the row did not open it');
    }
    if (measured.row && !measured.commandBlock) problems.push('the opened row has no command block');
    if (measured.row && measured.commandBlock && !measured.commandVisible) {
      problems.push('the command block is not on screen after opening the row');
    }
    if (measured.row && measured.commandText !== COMMAND) {
      problems.push('the command block does not show the command whole');
    }
    if (measured.row && measured.commandLines !== 5) {
      problems.push(`the command block shows ${measured.commandLines} lines, not 5`);
    }
    if (measured.row && !(measured.label || []).some((text) => /команд|command/i.test(text))) {
      problems.push('the command block is not labelled');
    }
    if (measured.row && measured.blockWidth > measured.rowWidth) {
      problems.push('the command block is wider than the row it sits in');
    }

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe command is shown whole, behind the row disclosure, with its lines kept');
  } finally {
    child.kill();
    stub.close();
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
