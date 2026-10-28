/**
 * Does a file the assistant changed show up as a diff, the way Cursor shows it?
 *
 * The tool row said "write_file src/app.js" and nothing else: the one thing a
 * person wants to check before trusting a turn - what actually changed - was not
 * on screen. The window now reads the file before the tool runs and again after,
 * and offers the two as a coloured diff behind a chip in the row.
 *
 * This probe drives a real turn against a stub endpoint that asks for a
 * `write_file`, then reads the chip and the diff it opens. The file is written
 * by the core, so what is measured is the real path, not a simulation of it.
 *
 * Run: node scripts/probe-agent-change.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { connect, listTargets, sleep, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9343);
const STUB_PORT = Number(process.env.LEXIQODE_STUB_PORT || 8791);

const ORIGINAL = 'function greet(name) {\n  return "hi " + name;\n}\n';
const WRITTEN = 'function greet(name) {\n  return "hello " + name;\n}\n\nfunction farewell(name) {\n  return "bye " + name;\n}\n';

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-agent-change-'));
  fs.writeFileSync(path.join(root, 'app.js'), ORIGINAL, 'utf8');
  return root;
}

/**
 * A stub endpoint that asks for one `write_file`, then answers.
 *
 * The first request of a turn gets the tool call; the request that carries the
 * tool's result gets a plain answer, so the turn ends instead of looping.
 */
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
        send({ content: 'I will update the greeting. ' });
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write_1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'app.js', content: WRITTEN })
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
  const child = startApp({ port: PORT, tag: 'agent-change', onLine: (line) => lines.push(line) });
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

    // Point the core at the stub, the way the settings form does.
    const configured = await session.evaluate(`
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
    console.log(`configured: ${configured}`);

    // Send a message and wait for the turn to finish.
    await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const input = document.getElementById('composer-input');
      input.focus();
      input.value = 'update the greeting';
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
      const block = document.querySelector('.changes');
      const toggle = document.querySelector('.change__toggle');
      const openButton = document.querySelector('.change__open');
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const result = {
        block: Boolean(block),
        // The block must not be inside the action group: that is the whole
        // report - "you hid the changed file under Actions".
        insideActions: Boolean(block && block.closest('.tools')),
        blockVisible: visible(block),
        label: (document.querySelector('.changes__label') || {}).textContent || null,
        path: (document.querySelector('.change__path') || {}).textContent || null,
        stat: (document.querySelector('.change__stat') || {}).textContent || null,
        hasOpenButton: Boolean(openButton),
        openLabel: openButton ? openButton.textContent : null,
        // Before opening: the diff is not on screen yet.
        diffHiddenBefore: (() => {
          const body = document.querySelector('.change__body');
          return body ? body.hidden : null;
        })()
      };
      if (toggle) {
        toggle.click();
        await sleep(300);
        const body = document.querySelector('.change__body');
        result.diffHiddenAfter = body ? body.hidden : null;
        result.lines = [...document.querySelectorAll('.change__line')].map((node) => ({
          kind: node.dataset.kind,
          text: (node.querySelector('.change__text') || {}).textContent
        }));
        result.added = result.lines.filter((line) => line.kind === 'add').length;
        result.removed = result.lines.filter((line) => line.kind === 'del').length;
        result.context = result.lines.filter((line) => line.kind === 'ctx').length;
      }
      if (openButton) {
        openButton.click();
        await sleep(1200);
        const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
        const model = editors[0] ? editors[0].getModel() : null;
        result.openedInEditor = model ? model.uri.path.replace(/^\\//, '') : null;
        result.editorText = model ? model.getValue().slice(0, 40) : null;
      }
      return result;
    `);
    console.log(`\n--- the change the assistant made\n${JSON.stringify(measured, null, 2)}`);

    const onDisk = fs.readFileSync(path.join(folder, 'app.js'), 'utf8');
    const problems = [];
    if (!measured.block) problems.push('no change block appeared for the file the assistant wrote');
    if (measured.block && measured.insideActions) problems.push('the change block is still inside the action group');
    if (measured.block && !measured.blockVisible) problems.push('the change block is not on screen');
    if (measured.block && measured.path !== 'app.js') problems.push(`the block names ${measured.path}, not app.js`);
    if (measured.block && measured.diffHiddenBefore !== true) problems.push('the diff is open before anyone asked for it');
    if (measured.block && measured.diffHiddenAfter !== false) problems.push('clicking the row did not open the diff in place');
    if (measured.block && !measured.added) problems.push('the diff marks no added lines');
    if (measured.block && !measured.removed) problems.push('the diff marks no removed lines');
    if (measured.block && !measured.context) problems.push('the diff shows no context around the change');
    if (measured.block && !measured.hasOpenButton) problems.push('there is no way to open the file');
    if (measured.block && measured.openedInEditor !== 'app.js') {
      problems.push(`the open button opened ${measured.openedInEditor}, not app.js`);
    }
    if (onDisk !== WRITTEN) problems.push('the file on disk is not what the tool wrote');

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nthe change is a block of its own in the chat, opened in place, with a way into the editor');
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
