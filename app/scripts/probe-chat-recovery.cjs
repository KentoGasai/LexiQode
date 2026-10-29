/**
 * The two ways a turn used to stop for no visible reason, measured in the window.
 *
 * Both were reported from real chats and both are only visible end to end: the
 * core has to notice, the event list has to forward it, the panel has to draw it,
 * and the turn has to end rather than hang.
 *
 * * **A loop that never repeats itself twice in a row.** The guard counted
 *   consecutive identical calls, so a model that ran the same command, did
 *   something unrelated and ran it again was never caught - one command ran
 *   twenty-three times in a single stored turn and no notice was ever drawn. The
 *   stub reproduces exactly that shape: the same read of the same unchanged file,
 *   interleaved with reads of other paths, whose results differ.
 * * **An answer that carries nothing.** Two stored chats end with an `assistant`
 *   message whose content is empty and which calls no tool. That was treated as
 *   the answer, so the turn ended and the window showed nothing at all. The stub
 *   answers with an empty completion, and the probe waits for the ending to be
 *   published instead of silence.
 *
 * Run it alone: two probes at once open two windows and a window behind another
 * has its frames throttled.
 *
 * Run: node scripts/probe-chat-recovery.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { sleep, startApp, listTargets, connect, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9362);
const STUB_PORT = 8723;
const MODELS = ['stub-model'];
/** The file the stub reads over and over: its content never changes. */
const LOOP_FILE = 'loop.txt';

function makeFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-recovery-'));
  fs.writeFileSync(path.join(root, LOOP_FILE), 'the same bytes every time\n', 'utf8');
  return root;
}

/**
 * An endpoint that plays the two failing turns.
 *
 * Which one it plays is decided by the question, so the probe can drive them in
 * order in one window. The loop scenario never answers: the model in the reported
 * chat never stopped by itself, and a stub that eventually answers would hide the
 * very thing being measured.
 */
function stub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      if (request.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id })) }));
        return;
      }
      if (!request.url.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let asked = {};
      try {
        asked = JSON.parse(body);
      } catch {
        asked = {};
      }
      requests.push({ messages: (asked.messages || []).length, stream: Boolean(asked.stream) });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const messages = asked.messages || [];
      const textOf = (message) => String((message && message.content) || '');
      // The *newest* question decides the scenario: the probe drives both turns in
      // one conversation, and reading the first one would replay the loop for the
      // second turn - which is exactly what the first run of this probe did.
      const newestUser = textOf([...messages].reverse().find((message) => message.role === 'user'));
      const assistantTurns = messages.filter((message) => message.role === 'assistant').length;

      if (/empty/i.test(newestUser)) {
        // No text, no tool call - what the provider sends when the completion
        // carries nothing at all, which is the shape of the stalled chats.
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else if (/loop/i.test(newestUser)) {
        const call =
          assistantTurns % 2 === 0
            ? { path: LOOP_FILE }
            : { path: `missing-${assistantTurns}.txt` };
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${assistantTurns}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: JSON.stringify(call) }
                  }
                ]
              }
            }
          ]
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: 'The stub answered.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve({ server, requests })));
}

async function main() {
  const endpoint = `http://127.0.0.1:${STUB_PORT}/v1`;
  const folder = makeFolder();
  const { server } = await stub();
  const child = startApp({ port: PORT, tag: 'recovery' });
  console.log(`folder under test: ${folder}`);
  console.log(`stub endpoint: ${endpoint}`);

  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);

    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = {};

      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await window.lexiqode.agent.status().catch(() => null);
        if (status && status.state === 'ready') break;
        await sleep(500);
      }

      // The profile, through the form the header opens - the same path a person
      // takes, because a probe that writes settings behind the window's back
      // cannot say whether the window reads them.
      const gear = () => document.querySelector('#chat-actions .iconbtn:nth-child(2)');
      const form = () => document.querySelector('#transcript .commit');
      if (!form()) gear().click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (form()) break;
        await sleep(200);
      }
      const sheet = form();
      if (!sheet) return { failed: 'the settings form did not open' };
      const controls = [...sheet.querySelectorAll('.field__row')].map((row) => row.querySelector('input, select'));
      const endpointField = controls[1];
      const keyField = controls[2];
      endpointField.value = ${JSON.stringify(endpoint)};
      endpointField.dispatchEvent(new Event('input', { bubbles: true }));
      keyField.value = 'stub-key';
      keyField.dispatchEvent(new Event('input', { bubbles: true }));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (sheet.querySelector('select.modelpick')) break;
        await sleep(250);
      }
      const picker = sheet.querySelector('select.modelpick');
      if (picker) {
        picker.value = 'stub-model';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        controls[3].value = 'stub-model';
        controls[3].dispatchEvent(new Event('input', { bubbles: true }));
      }
      const save = sheet.querySelector('[data-role="save"], .btn--primary');
      if (!save) return { failed: 'the save button was not found' };
      save.click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!form()) break;
        await sleep(200);
      }

      // Every event the core publishes, so the ending can be checked against what
      // the window was actually told rather than against its drawing alone.
      const events = [];
      window.lexiqode.on('agent:event', (payload) => {
        if (!payload || !payload.name) return;
        events.push({ name: payload.name, data: payload.data || {} });
        // Read on the event, not on a timer. A turn whose every step is instant
        // had already spent four retries by the time a 200 ms poll looked at the
        // list, so a count taken then measures the poll, not the detector.
        if (payload.name === 'repeated_call' && out.loop && out.loop.rowsOnEvent === undefined) {
          out.loop.rowsOnEvent = rowsFor(${JSON.stringify(LOOP_FILE)});
        }
      });
      const of = (name) => events.filter((entry) => entry.name === name);
      const send = async (text) => {
        const input = document.getElementById('composer-input');
        input.focus();
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('composer-send').click();
      };
      const waitFor = async (check, attempts = 300) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (check()) return true;
          await sleep(200);
        }
        return false;
      };
      const stopNotice = (reason) => document.querySelector('.notice--stopped[data-reason="' + reason + '"]');
      const rowsFor = (name) =>
        [...document.querySelectorAll('.toolrow')].filter((row) => row.textContent.includes(name)).length;

      // ---------------------------------------------------------------- the loop
      events.length = 0;
      // Declared before the turn so the event listener has somewhere to write the
      // row count at the moment the call is noticed.
      out.loop = {};
      await send('loop: read the same file');
      const firstNotice = await waitFor(() => of('repeated_call').length > 0, 200);
      out.loop.noticed = firstNotice;
      out.loop.reason = (of('repeated_call')[0] || { data: {} }).data.reason || '';
      out.loop.timesAtNotice = (of('repeated_call')[0] || { data: {} }).data.times || 0;
      const ended = await waitFor(() => Boolean(stopNotice('repeated')), 400);
      out.loop.ended = ended;
      out.loop.retries = of('repeat_retry').length;
      out.loop.turnEnd = (of('turn_end').slice(-1)[0] || { data: {} }).data.stopped || '';
      out.loop.rowsAtEnd = rowsFor(${JSON.stringify(LOOP_FILE)});
      out.loop.noticeText = stopNotice('repeated') ? stopNotice('repeated').textContent.trim().slice(0, 160) : '';
      out.loop.sendEnabledAfter = !document.getElementById('composer-send').disabled;

      // --------------------------------------------------------------- the empty
      events.length = 0;
      await send('empty: answer me');
      const emptyEnded = await waitFor(() => Boolean(stopNotice('empty_answer') || stopNotice('truncated_answer')), 200);
      out.empty = {
        ended: emptyEnded,
        retries: of('empty_answer_retry').length,
        endings: of('empty_answer').length,
        turnEnd: (of('turn_end').slice(-1)[0] || { data: {} }).data.stopped || '',
        reason: (of('empty_answer')[0] || { data: {} }).data.finish_reason || '',
        noticeText: (stopNotice('empty_answer') || { textContent: '' }).textContent.trim().slice(0, 200),
        sendEnabledAfter: !document.getElementById('composer-send').disabled
      };
      out.empty.errorShown = Boolean(document.querySelector('.message--error, .error'));
      return out;
    `);

    console.log(JSON.stringify(report, null, 2));

    const problems = [];
    const loop = report.loop || {};
    if (!loop.noticed) problems.push('the loop was never noticed');
    if (loop.reason !== 'no-progress') {
      problems.push(`the loop was noticed for the wrong reason: ${JSON.stringify(loop.reason)}`);
    }
    if (loop.timesAtNotice !== 3) {
      problems.push(`the notice came after ${loop.timesAtNotice} identical results instead of 3`);
    }
    if (loop.rowsOnEvent !== 3) {
      problems.push(`the repeated call had run ${loop.rowsOnEvent} times when it was noticed, not 3`);
    }
    if (!loop.ended) problems.push('the turn never ended: the guard does not stop the loop');
    if (loop.turnEnd !== 'repeated') problems.push(`the turn ended as ${JSON.stringify(loop.turnEnd)}`);
    if (!loop.noticeText) problems.push('the window said nothing about why the turn stopped');
    if (!loop.sendEnabledAfter) problems.push('the composer stayed disabled after the turn ended');

    const empty = report.empty || {};
    if (!empty.ended) problems.push('an empty answer ended the turn in silence again');
    if (empty.retries < 1) problems.push('the model was never asked again after answering with nothing');
    if (empty.endings < 1) problems.push('the ending was never published');
    if (!empty.turnEnd) problems.push('the turn published no ending at all');
    if (!empty.noticeText) problems.push('the window showed no reason for the empty answer');
    if (!empty.sendEnabledAfter) problems.push('the composer stayed disabled after the empty answer');

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      '\nthe loop was caught by its unchanged result and ended visibly, and an empty answer is retried and then explained'
    );
  } finally {
    child.kill();
    server.close();
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