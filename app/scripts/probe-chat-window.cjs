/**
 * The assistant, driven the way a person drives it: through the window.
 *
 * The other probes check the core directly or the window's own panels; this one
 * does what a user does and nothing else. It fills the settings form with a
 * working endpoint, saves it, types a message in the composer, sends it, and
 * waits for the answer to appear in the transcript - then reports every step, so
 * a fault can be attributed to the form, the save, the send or the rendering
 * instead of being described as "the assistant does not work".
 *
 * The endpoint is a stub that streams an OpenAI-compatible answer, so the result
 * does not depend on any outside service.
 *
 *   node scripts/probe-chat-window.cjs [workspace]
 *   $env:LEXIQODE_PROBE_EXE='...\LexiQode.exe'; node scripts/probe-chat-window.cjs
 */

const http = require('node:http');
const path = require('node:path');
const { APP, sleep, startApp, listTargets, connect, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9348);
const STUB_PORT = 8717;
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');
const MODELS = ['stub-model-a', 'stub-model-b', 'stub-model-c'];

/** An OpenAI-compatible endpoint: a model list, streaming and plain answers. */
function stub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      requests.push({ url: request.url, method: request.method });
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
      let stream = false;
      let asked = {};
      try {
        asked = JSON.parse(body);
        stream = Boolean(asked.stream);
      } catch {
        stream = false;
      }
      // What the request carried about reasoning. The switch beside the model is
      // only real if it reaches the wire, and this is the only place that can say
      // whether it did: the window can draw a convincing pill either way.
      if (requests.length) {
        requests[requests.length - 1].reasoning_effort =
          asked.reasoning_effort === undefined ? null : asked.reasoning_effort;
      }
      if (stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Paced deliberately: a stub that answers instantly makes the whole turn
        // shorter than the probe's sampling interval, so the state *during* the
        // turn - thinking shown, tools running - could never be observed and a
        // panel that never opened the thinking block would pass.
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const send = (delta) =>
          response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        /*
         * A turn shaped like a real one: the model thinks, asks for read-only
         * tools, reads the results and answers. The reasoning arrives on its own
         * field, which is what a reasoning model does and what the panel has to
         * fold away instead of printing as the answer.
         *
         * Three tool steps and then an answer, rather than one: that is what a
         * turn needs in order to run out of a small step budget, which is the only
         * way to see the note that says so and the button that carries on.
         */
        const messages = asked.messages || [];
        const assistantTurns = messages.filter((message) => message.role === 'assistant').length;
        // "slow" in the newest question makes every piece arrive late, which is
        // what gives a probe time to press Stop while a turn is really running.
        const lastUser = [...messages].reverse().find((message) => message.role === 'user');
        const slow = /slow/i.test(String((lastUser || {}).content || ''));
        const gap = slow ? 700 : 200;
        if (assistantTurns < 3) {
          await pause(300);
          for (const piece of ['The question needs ', 'a look at the project ', 'before I answer.']) {
            send({ reasoning_content: piece });
            await pause(gap);
          }
          send({ content: 'Let me look at the project first. ' });
          await pause(gap);
          /*
           * Twelve calls in one step, on purpose.
           *
           * The complaint was not that actions were drawn badly but that a long
           * list could not be read to its end: the expanded rows pushed the rest
           * of the turn out of the panel's reach. One call would never show that,
           * so the stub makes a step that fills the list.
           */
          const calls = Array.from({ length: 12 }, (_, index) => ({
            index,
            id: 'call_probe_' + (index + 1),
            type: 'function',
            function: {
              name: 'glob',
              arguments: JSON.stringify({ pattern: '*.md', note: 'probe row ' + (index + 1) })
            }
          }));
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { tool_calls: calls } }]
            })}\n\n`
          );
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          for (const piece of ['The listing is ', 'enough to answer.']) {
            send({ reasoning_content: piece });
            await pause(gap);
          }
          for (const piece of ['The ', 'stub ', 'answered.']) {
            send({ content: piece });
            await pause(slow ? 900 : 120);
          }
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
          );
          // A measured token count, so the meter in the composer has something
          // real to show rather than its own estimate.
          response.write(
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 }
            })}\n\n`
          );
        }
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'stub',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'The stub answered.' }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 }
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve({ server, requests })));
}

async function main() {
  const endpoint = `http://127.0.0.1:${STUB_PORT}/v1`;
  const { server, requests } = await stub();
  const noise = [];
  const child = startApp({
    port: PORT,
    tag: 'chat',
    onLine: (line) => {
      noise.push(line.slice(0, 220));
    }
  });
  console.log(`isolated configuration: ${child.configDir}`);
  console.log(`stub endpoint: ${endpoint}`);

  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);

    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const steps = {};
      const transcriptText = () => document.getElementById('transcript').textContent.replace(/\\s+/g, ' ').trim();
      const statusbar = () => document.getElementById('statusbar').textContent.replace(/\\s+/g, ' ').trim();

      // A folder to work in, because the assistant runs inside one.
      await window.lexiqode.workspace.open(${JSON.stringify(WORKSPACE)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await window.lexiqode.agent.status().catch(() => null);
        if (status && status.state === 'ready') break;
        await sleep(500);
      }
      steps.opened = { treeRows: document.querySelectorAll('.tree__row').length, statusbar: statusbar() };

      // The settings form, exactly as the header button opens it. The gear
      // toggles, so opening means clicking only when the form is not there.
      const gear = () => document.querySelector('#chat-actions .iconbtn:nth-child(2)');
      const form = () => document.querySelector('#transcript .commit');
      const openForm = async () => {
        if (!form()) gear().click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (form()) return true;
          await sleep(200);
        }
        return false;
      };
      const closeForm = async () => {
        if (form()) gear().click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!form()) return true;
          await sleep(200);
        }
        return false;
      };
      if (!(await openForm())) return { failed: 'the settings form did not open' };
      let sheet = document.querySelector('#transcript .commit');
      const controls = [...sheet.querySelectorAll('.field__row')].map((row) => row.querySelector('input, select'));
      const endpointField = controls[1];
      const keyField = controls[2];
      const modelField = controls[3];
      endpointField.value = ${JSON.stringify(endpoint)};
      endpointField.dispatchEvent(new Event('input', { bubbles: true }));
      keyField.value = 'stub-key';
      keyField.dispatchEvent(new Event('input', { bubbles: true }));
      let picker = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        picker = sheet.querySelector('select.modelpick');
        if (picker) break;
        await sleep(250);
      }
      steps.scan = {
        found: Boolean(picker),
        options: picker ? [...picker.options].map((option) => option.value) : [],
        area: [...sheet.querySelectorAll('.list__empty, .spinner')].map((node) => node.textContent || '(spinner)').join(' | ').slice(0, 160)
      };
      if (picker) {
        picker.value = 'stub-model-b';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        modelField.value = 'stub-model-b';
        modelField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      steps.beforeSave = { modelField: modelField.value };
      /*
       * A small step budget, on purpose.
       *
       * The note that says a turn ran out of steps - and the button that carries
       * on from it - only exists when a turn really hits the ceiling, so the probe
       * asks for a ceiling three steps away and the stub spends them.
       */
      const budgetField = sheet.querySelector('[data-role="maxSteps"]');
      steps.budgetField = {
        present: Boolean(budgetField),
        value: budgetField ? budgetField.value : '(no field)'
      };
      if (budgetField) {
        budgetField.value = '3';
        budgetField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const saveAndTest = [...sheet.querySelectorAll('.btn')].find((node) => node.className.includes('primary'));
      if (!saveAndTest) return { failed: 'the save button was not found', steps };
      saveAndTest.click();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await window.lexiqode.agent.state().catch(() => null);
        if (state && state.profile && state.profile.model) break;
        await sleep(250);
      }
      const afterSave = await window.lexiqode.agent.state().catch((error) => ({ error: error.message }));
      steps.afterSave = {
        modelFromCore: afterSave.profile ? afterSave.profile.model : null,
        baseUrlFromCore: afterSave.profile ? afterSave.profile.base_url : null,
        hasKey: afterSave.profile ? afterSave.profile.has_api_key : null,
        // What the core made of the budget the form was given.
        maxStepsFromCore: afterSave.agent ? afterSave.agent.max_steps : null,
        statusbar: statusbar(),
        modelField: modelField.value
      };

      // Re-open the form: can another model still be chosen after saving?
      await closeForm();
      await openForm();
      // The form is rendered from the profile the panel last learned, and that
      // arrives a moment after the save, so the wait is for the list rather than
      // for a fixed moment.
      let reopened = null;
      let secondPicker = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        reopened = document.querySelector('#transcript .commit');
        secondPicker = reopened ? reopened.querySelector('select.modelpick') : null;
        if (secondPicker) break;
        await sleep(250);
      }
      steps.reopenedForm = {
        open: Boolean(reopened),
        picker: Boolean(secondPicker),
        options: secondPicker ? [...secondPicker.options].map((option) => option.value) : [],
        scanArea: reopened
          ? [...reopened.querySelectorAll('.list__empty, .spinner')].map((node) => node.textContent || '(spinner)').join(' | ').slice(0, 160)
          : ''
      };
      if (reopened) {
        // Another model can be chosen from the reopened form, and the choice has
        // to reach the core: this is the step that was reported as impossible.
        if (secondPicker) {
          secondPicker.value = 'stub-model-c';
          secondPicker.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(2000);
          const afterPick = await window.lexiqode.agent.state().catch((error) => ({ error: error.message }));
          steps.reopenedForm.modelInCoreAfterPick = afterPick.profile ? afterPick.profile.model : null;
        }
      }
      await closeForm();

      // The message itself.
      const rawEvents = [];
      window.lexiqode.on('agent:event', (payload) => rawEvents.push(payload && payload.name));
      window.lexiqode.on('agent:status-changed', (payload) => rawEvents.push('status:' + (payload && payload.state)));
      const input = document.getElementById('composer-input');
      input.focus();
      input.value = 'answer me';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const send = document.getElementById('composer-send');
      steps.sendClicked = { disabled: send.disabled, text: send.textContent.trim() };
      send.click();
      // While the turn runs: the scratchpad is open and the tools line says it is
      // working. A folded-away thinking block that was never open is not the same
      // thing, and only a sample taken during the turn can tell them apart.
      //
      // Every assistant block of the turn is watched, not only the newest one: the
      // turn is drawn step by step, so the scratchpad and the tools of the first
      // step live in an earlier block than the answer being waited for.
      const mid = {
        reasoningOpenWhileThinking: null,
        reasoningLabelWhileThinking: '',
        toolsLabelWhileRunning: '(never seen)',
        toolsOpenWhileRunning: null,
        blocksSeen: 0
      };
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(80);
        const turns = [...document.querySelectorAll('.turn--assistant')];
        mid.blocksSeen = Math.max(mid.blocksSeen, turns.length);
        const reasoning = turns.map((turn) => turn.querySelector('details.reasoning')).find(Boolean);
        if (reasoning && mid.reasoningOpenWhileThinking === null) {
          mid.reasoningOpenWhileThinking = reasoning.open;
          mid.reasoningLabelWhileThinking = reasoning
            .querySelector('summary')
            .textContent.replace(/\\s+/g, ' ')
            .trim();
        }
        const tools = turns.map((turn) => turn.querySelector('details.tools')).find(Boolean);
        if (tools && mid.toolsLabelWhileRunning === '(never seen)') {
          mid.toolsLabelWhileRunning = tools
            .querySelector('summary')
            .textContent.replace(/\\s+/g, ' ')
            .trim();
          mid.toolsOpenWhileRunning = tools.open;
        }
        const stop = document.getElementById('composer-stop');
        if (mid.reasoningOpenWhileThinking !== null && stop && stop.hidden) break;
      }
      steps.midTurn = mid;
      // And the title bar's folder button, which is the way to change folder.
      const folderButton = document.getElementById('titlebar-folder');
      steps.folderButton = {
        present: Boolean(folderButton),
        label: folderButton ? folderButton.textContent.trim() : '',
        title: folderButton ? folderButton.title.split('\\n')[0] : ''
      };
      // The stop button is shown only while a turn runs, so it is the wait
      // condition that does not depend on the window's language: an earlier
      // version of this probe waited on the English word "working" and broke out
      // of the loop on its first pass.
      let answered = '';
      let body = null;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await sleep(400);
        const turns = [...document.querySelectorAll('.turn--assistant')];
        const turn = turns[turns.length - 1] || null;
        body = turn ? turn.querySelector('.turn__body') : null;
        answered = body ? body.textContent.replace(/\\s+/g, ' ').trim() : '';
        const stop = document.getElementById('composer-stop');
        // Waiting for "the turn is over" rather than for a particular answer: this
        // first turn is meant to run out of its three steps, so its last words are
        // a tool step's, not a conclusion. The answer is checked where it belongs,
        // after the "carry on" button has been pressed.
        if (stop && stop.hidden) break;
      }
      steps.turn = {
        rawEvents: rawEvents.slice(0, 40),
        assistantTurns: document.querySelectorAll('.turn--assistant').length,
        answer: answered.slice(0, 200),
        errors: [...document.querySelectorAll('.turn--error, .card--error')].map((node) => node.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200)),
        transcript: transcriptText().slice(0, 300)
      };
      // What the reader is looking at: the scratchpad folded above the answer,
      // the tools on one line, and how full the model's window is. Each of these
      // was reported as wrong, so each is measured rather than described.
      const finalTurn = [...document.querySelectorAll('.turn--assistant')].pop();
      const reasoning = finalTurn ? finalTurn.querySelector('details.reasoning') : null;
      const reasoningBody = reasoning ? reasoning.querySelector('.reasoning__body') : null;
      const tools = finalTurn ? finalTurn.querySelector('details.tools') : null;
      const meter = document.querySelector('.ctx--meter');
      steps.presentation = {
        reasoningTag: reasoning ? reasoning.tagName : '(missing)',
        reasoningCollapsedAfterTurn: reasoning ? !reasoning.open : null,
        reasoningLabel: reasoning
          ? reasoning.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim()
          : '',
        reasoningChars: reasoningBody ? reasoningBody.textContent.length : 0,
        reasoningAboveAnswer: reasoning && body
          ? Boolean(reasoning.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)
          : null,
        toolsTag: tools ? tools.tagName : '(missing)',
        toolsCollapsedAfterTurn: tools ? !tools.open : null,
        toolsLabel: tools ? tools.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim() : '',
        toolRows: finalTurn
          ? [...finalTurn.querySelectorAll('.toolrow')].map((row) => {
              const name = row.querySelector('.toolrow__name');
              const args = row.querySelector('.toolrow__args');
              const result = row.querySelector('.toolrow__pre');
              return {
                name: name ? name.textContent : '',
                args: args ? args.textContent : '',
                state: row.getAttribute('data-state'),
                resultChars: result ? result.textContent.length : 0
              };
            })
          : [],
        objectObjectInTurn: finalTurn ? finalTurn.textContent.includes('[object Object]') : null,
        transcriptNodes: document.getElementById('transcript').children.length,
        // The empty-state line used to stay on screen above the first answer.
        emptyStateShown: Boolean(document.querySelector('#transcript .list__empty')),
        contextMeter: meter ? meter.textContent.replace(/\\s+/g, ' ').trim() : '(missing)',
        contextMeterTitle: meter ? meter.title : ''
      };
      // Read late: the status bar is written when the panel learns the profile,
      // and an earlier read measures the wrong moment.
      const modelItem = document.querySelector('.statusbar__item[data-role="model"]');
      steps.turn.statusbarModel = modelItem ? modelItem.textContent.trim() : '(no model item)';
      steps.turn.statusbar = statusbar();

      // ------------------------------------------------- the turn, step by step
      // A turn that answers, calls a tool and answers again is three things, and
      // the panel draws each step as its own block. What matters is the order:
      // every later scratchpad has to come after the answer it follows, and an
      // answer already given has to survive the next step. Both were reported
      // wrong, so both are measured.
      const blocks = [...document.querySelectorAll('.turn--assistant')];
      const answerOf = (block) => {
        const body = block ? block.querySelector('.turn__body') : null;
        return body ? body.textContent.replace(/\\s+/g, ' ').trim() : '';
      };
      const secondThinking = blocks.length > 1 ? blocks[1].querySelector('details.reasoning') : null;
      const rowsBoxes = [...document.querySelectorAll('.tools__rows')];
      const rowsBox = rowsBoxes.length ? rowsBoxes[rowsBoxes.length - 1] : null;
      steps.stepsLayout = {
        blocks: blocks.length,
        answers: blocks.map(answerOf),
        perBlock: blocks.map((block) => ({
          reasoning: Boolean(block.querySelector('details.reasoning')),
          tools: block.querySelectorAll('.toolrow').length,
          answer: answerOf(block).slice(0, 80)
        })),
        secondThinkingAfterFirstAnswer:
          secondThinking && blocks[0]
            ? Boolean(blocks[0].compareDocumentPosition(secondThinking) & Node.DOCUMENT_POSITION_FOLLOWING)
            : null,
        stepLabels: [...document.querySelectorAll('.turn__meta')]
          .map((node) => node.textContent.replace(/\\s+/g, ' ').trim())
          .filter(Boolean),
        // A finished step must stop saying that it is working. Only the newest
        // block used to be finished off, so earlier answers kept a spinner.
        blocksStillWorking: blocks.filter((block) => block.querySelector('.turn__meta .spinner')).length,
        toolsBoxMaxHeight: rowsBox ? getComputedStyle(rowsBox).maxHeight : '(no tools box)'
      };

      /*
       * The list of actions, read the way the person who complained tried to read
       * it: is it contained, can it be scrolled to the end, and did the panel
       * leave it showing its newest row?
       */
      const transcriptBox = document.getElementById('transcript');
      steps.toolsBox = rowsBox
        ? {
            rows: rowsBox.querySelectorAll('.toolrow').length,
            clientHeight: rowsBox.clientHeight,
            scrollHeight: rowsBox.scrollHeight,
            scrollTop: rowsBox.scrollTop,
            scrollable: rowsBox.scrollHeight > rowsBox.clientHeight + 1,
            atEnd: rowsBox.scrollHeight - rowsBox.scrollTop - rowsBox.clientHeight < 8,
            transcriptAtEnd:
              transcriptBox.scrollHeight - transcriptBox.scrollTop - transcriptBox.clientHeight < 8
          }
        : null;

      // The reasoning switch: what it says, and what one click does to it and to
      // the core's profile. The window can draw a convincing pill whether or not
      // anything is saved, so the profile is read back and a second message is
      // sent, which is the only way to see the switch reach the wire.
      const reasonBtn = document.querySelector('.reasonbtn');
      steps.switch = {
        present: Boolean(reasonBtn),
        state: reasonBtn ? reasonBtn.getAttribute('data-state') : '(missing)',
        pressed: reasonBtn ? reasonBtn.getAttribute('aria-pressed') : '(missing)',
        title: reasonBtn ? reasonBtn.title : ''
      };
      if (reasonBtn) {
        const before = reasonBtn.getAttribute('aria-pressed');
        reasonBtn.click();
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await sleep(150);
          const now = document.querySelector('.reasonbtn');
          if (now && now.getAttribute('aria-pressed') !== before) break;
        }
        const after = document.querySelector('.reasonbtn');
        steps.switch.afterPressed = after ? after.getAttribute('aria-pressed') : '(missing)';
        steps.switch.afterState = after ? after.getAttribute('data-state') : '(missing)';
        const snapshot = await window.lexiqode.agent.state().catch((error) => ({ error: error.message }));
        steps.switch.coreReasoning = snapshot.profile ? snapshot.profile.reasoning : '(no profile)';

        const composer = document.getElementById('composer-input');
        composer.value = 'answer again';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const again = document.getElementById('composer-send');
        if (again) again.click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          await sleep(200);
          const stop = document.getElementById('composer-stop');
          const now = document.querySelectorAll('.turn--assistant').length;
          if (stop && stop.hidden && now > blocks.length) break;
        }
        steps.switch.blocksAfterSecondMessage = document.querySelectorAll('.turn--assistant').length;
      }

      // ------------------------------------------- the step limit, and stopping
      // Two things a reader has to be able to see: that a turn ended because its
      // budget ran out, with a way to carry on; and that pressing Stop did
      // something. Both were reported as broken, so both are measured here.
      const limitNotice = document.querySelector('.notice--stopped[data-reason="max_steps"]');
      steps.stepLimit = {
        notice: limitNotice ? limitNotice.textContent.trim().slice(0, 160) : '',
        hasContinue: limitNotice ? Boolean(limitNotice.querySelector('button')) : false
      };
      const beforeContinue = document.querySelectorAll('.turn--assistant').length;
      const continueButton = limitNotice ? limitNotice.querySelector('button') : null;
      if (continueButton) {
        continueButton.click();
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await sleep(150);
          const stop = document.getElementById('composer-stop');
          const now = document.querySelectorAll('.turn--assistant').length;
          if (stop && stop.hidden && now > beforeContinue) break;
        }
      }
      const afterContinue = [...document.querySelectorAll('.turn--assistant')];
      const lastTurn = afterContinue[afterContinue.length - 1] || null;
      const lastBody = lastTurn ? lastTurn.querySelector('.turn__body') : null;
      steps.continued = {
        pressed: Boolean(continueButton),
        blocks: afterContinue.length,
        answer: lastBody ? lastBody.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : ''
      };

      // Stopping, on a turn the stub paces slowly enough to catch in flight.
      const composerInput = document.getElementById('composer-input');
      composerInput.value = 'slow answer';
      composerInput.dispatchEvent(new Event('input', { bubbles: true }));
      const sendAgain = document.getElementById('composer-send');
      if (sendAgain) sendAgain.click();
      const stopping = { clicked: false, label: '', disabled: null };
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await sleep(40);
        const stop = document.getElementById('composer-stop');
        if (stop && getComputedStyle(stop).display !== 'none' && !stop.disabled) {
          stop.click();
          stopping.clicked = true;
          break;
        }
      }
      const stoppingNow = document.getElementById('composer-stop');
      stopping.label = stoppingNow ? stoppingNow.textContent.trim() : '';
      stopping.disabled = stoppingNow ? stoppingNow.disabled : null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(100);
        const stop = document.getElementById('composer-stop');
        const send = document.getElementById('composer-send');
        if (stop && getComputedStyle(stop).display === 'none' && send && !send.disabled) break;
      }
      const stoppedNotice = document.querySelector('.notice--stopped[data-reason="cancelled"]');
      const sendAfterStop = document.getElementById('composer-send');
      const stopAfterStop = document.getElementById('composer-stop');
      steps.stopping = {
        clicked: stopping.clicked,
        labelWhileStopping: stopping.label,
        disabledWhileStopping: stopping.disabled,
        notice: stoppedNotice ? stoppedNotice.textContent.trim().slice(0, 140) : '',
        stopButtonDisplay: stopAfterStop ? getComputedStyle(stopAfterStop).display : '(missing)',
        sendEnabled: sendAfterStop ? !sendAfterStop.disabled : null,
        visibleSpinners: [...document.querySelectorAll('.spinner')].filter(
          (node) => getComputedStyle(node).display !== 'none'
        ).length
      };

      // ---------------------------------------------------------------- chats
      // A chat is a document in the core: a second one opens in a second tab, the
      // first stays where it was, and switching back restores its transcript.
      const tabs = () =>
        [...document.querySelectorAll('#chat-tabs .chattab')].map((tab) => ({
          id: tab.dataset.id,
          label: (tab.querySelector('.chattab__label') || {}).textContent || '',
          active: tab.classList.contains('chattab--active')
        }));
      const savedChats = async () => {
        const listed = await window.lexiqode.agent.conversations();
        return {
          current: listed.current,
          conversations: listed.conversations.map((row) => ({
            id: row.id,
            title: row.title,
            messages: row.messages
          }))
        };
      };
      steps.chatsBefore = { tabs: tabs(), ...(await savedChats()) };

      const addTab = document.querySelector('#chat-tabs .chattabs__add');
      if (addTab) addTab.click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(250);
        if (tabs().length === 2 && !document.getElementById('transcript').textContent.trim()) break;
      }
      steps.afterNewChat = {
        tabs: tabs(),
        transcriptEmpty: !document.getElementById('transcript').textContent.trim(),
        ...(await savedChats())
      };

      const firstTab = document.querySelector('#chat-tabs .chattab');
      if (firstTab) firstTab.click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(250);
        if (/stub answered/i.test(document.getElementById('transcript').textContent)) break;
      }
      const prefs = await window.lexiqode.settings.get();
      steps.afterSwitchingBack = {
        tabs: tabs(),
        previousAnswerRestored: /stub answered/i.test(document.getElementById('transcript').textContent),
        savedInSettings: (prefs.session && prefs.session.chats) || [],
        activeInSettings: (prefs.session && prefs.session.activeChat) || ''
      };

      // ------------------------------------------------- the file context menu
      // The right-click menu is drawn by the window, not by a browser prompt.
      const row = document.querySelector('.tree__row');
      if (row) {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 80 }));
        await sleep(250);
        const menu = document.querySelector('.ctxmenu');
        steps.contextMenu = {
          present: Boolean(menu),
          items: menu
            ? [...menu.querySelectorAll('.ctxmenu__item')].map((item) => item.textContent.trim())
            : [],
          hasReveal: menu
            ? [...menu.querySelectorAll('.ctxmenu__item')].some((item) =>
                /проводник|Explorer/i.test(item.textContent)
              )
            : false
        };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(150);
        steps.contextMenu.closedWithEscape = !document.querySelector('.ctxmenu');
      }

      // The theme is switchable from the window, not only from the command
      // palette: the form has a selector, and choosing from it repaints the
      // document while the form is still open.
      const themeBefore = document.documentElement.dataset.theme;
      await openForm();
      await sleep(300);
      const selects = [...document.querySelectorAll('#transcript .commit select.langpick')];
      const themeSelect = selects[1];
      steps.theme = {
        before: themeBefore,
        selectors: selects.length,
        options: themeSelect ? [...themeSelect.options].map((option) => option.value) : [],
        labels: themeSelect ? [...themeSelect.options].map((option) => option.textContent.trim()) : []
      };
      if (themeSelect) {
        const wanted = themeBefore === 'dark' ? 'light' : 'dark';
        themeSelect.value = wanted;
        themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(150);
          if (document.documentElement.dataset.theme === wanted) break;
        }
        steps.theme.wanted = wanted;
        steps.theme.afterChoosing = document.documentElement.dataset.theme;
        // Put the window back the way it was found.
        themeSelect.value = themeBefore;
        themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
      }
      await closeForm();
      return steps;
    `);

    console.log(`\n--- steps\n${JSON.stringify(report, null, 2)}`);

    /*
     * What this probe now insists on, rather than only describing.
     *
     * Every one of these is a way the panel has actually been wrong: an answer
     * erased by the step that followed it, a later scratchpad drawn above an
     * earlier answer, a switch that changed nothing on the wire, and an action
     * list that could not be read to the end.
     */
    const problems = [];
    const layout = report.stepsLayout || {};
    const toggle = report.switch || {};
    const calls = requests.filter((entry) => entry.url.endsWith('/chat/completions'));
    const firstCall = calls[0] || {};
    const lastCall = calls[calls.length - 1] || {};

    if (layout.blocks < 2) {
      problems.push(`the stub's two-step turn was drawn as ${layout.blocks} block(s)`);
    }
    if (layout.secondThinkingAfterFirstAnswer !== true) {
      problems.push("the second step's thinking does not come after the first step's answer");
    }
    if (!/project first/.test(layout.answers && layout.answers[0] ? layout.answers[0] : '')) {
      problems.push("the first step's answer is not in the transcript");
    }
    if (!layout.blocks || layout.blocks < 3) {
      problems.push('the three tool steps of the first turn are not three blocks');
    }
    if (layout.toolsBoxMaxHeight === 'none' || layout.toolsBoxMaxHeight === '(no tools box)') {
      problems.push('the action list is not contained, so a long step pushes the turn out of reach');
    }
    if (layout.blocksStillWorking) {
      problems.push(`${layout.blocksStillWorking} finished step(s) still say they are working`);
    }
    const box = report.toolsBox;
    if (!box) {
      problems.push('the step\'s actions are not on the page at all');
    } else {
      if (box.rows < 12) problems.push(`only ${box.rows} of the step's 12 actions were drawn`);
      if (!box.scrollable) {
        problems.push('twelve actions fit without scrolling, so this probe proves nothing about a long list');
      }
      if (!box.atEnd) {
        problems.push('the list of actions is not left showing its newest row');
      }
      if (!box.transcriptAtEnd) {
        problems.push('the transcript is not left at the end of the turn');
      }
      if (box.clientHeight > 400) {
        problems.push(`the list of actions is ${box.clientHeight}px tall, which is not a ceiling`);
      }
    }

    const limit = report.stepLimit || {};
    if (!limit.notice) problems.push('a turn that ran out of steps said nothing about it');
    if (!limit.hasContinue) problems.push('the step-limit note offers no way to carry on');
    const budget = report.afterSave || {};
    if (budget.maxStepsFromCore !== 3) {
      problems.push(`the budget the form was given reached the core as ${budget.maxStepsFromCore}`);
    }
    const continued = report.continued || {};
    if (!continued.pressed) {
      problems.push('the "carry on" button was never there to press');
    } else if (!/stub answered/.test(continued.answer || '')) {
      problems.push(`carrying on produced no answer: ${JSON.stringify(continued.answer)}`);
    }

    const stopping = report.stopping || {};
    if (!stopping.clicked) problems.push('the stop button was never on screen while a turn was running');
    if (!/стоп|останавл|stop/i.test(stopping.labelWhileStopping || '')) {
      problems.push(`the stop button does not say it is stopping: ${JSON.stringify(stopping.labelWhileStopping)}`);
    }
    if (!stopping.disabledWhileStopping) problems.push('the stop button stays pressable while stopping');
    if (!stopping.notice) problems.push('nothing in the transcript says the turn was stopped');
    if (stopping.stopButtonDisplay !== 'none') {
      problems.push('the stop button stays on screen after a turn has finished');
    }
    if (stopping.sendEnabled !== true) problems.push('the composer does not come back after stopping');
    if (stopping.visibleSpinners) {
      problems.push(`${stopping.visibleSpinners} spinner(s) are still turning after the turn ended`);
    }
    if (!toggle.present) problems.push('there is no reasoning switch beside the model');
    if (toggle.pressed !== 'true') problems.push(`the reasoning switch starts as ${toggle.pressed}, not on`);
    if (toggle.afterPressed !== 'false' || toggle.afterState !== 'off') {
      problems.push('clicking the switch does not turn reasoning off on screen');
    }
    if (toggle.coreReasoning !== false) problems.push("the switch never reached the core's profile");
    if (firstCall.reasoning_effort) {
      problems.push(`reasoning on sent reasoning_effort=${firstCall.reasoning_effort}, which changes nothing`);
    }
    if (lastCall.reasoning_effort !== 'none') {
      problems.push(`reasoning off sent reasoning_effort=${lastCall.reasoning_effort}, not "none"`);
    }

    if (problems.length) {
      console.error(`\n${problems.length} failed expectation(s):`);
      for (const line of problems) console.error(`  - ${line}`);
      process.exitCode = 1;
    } else {
      console.log(
        '\nthe turn is drawn step by step, the earlier answer survives, and the reasoning switch reaches the wire'
      );
    }
  } finally {
    child.kill();
    server.close();
    await sleep(800);
  }

  console.log('\n=== what the application logged ===');
  // Every line the core produces is forwarded to the application's own output,
  // and it is the only place a provider problem is stated. Filtering it hid the
  // answer once already.
  const interesting = noise.filter(
    (line) => /^\[agent\]/.test(line) || /error|refused|failed|Traceback|provider/i.test(line)
  );
  console.log(interesting.length ? [...new Set(interesting)].slice(0, 40).join('\n') : '(none)');
  console.log('\n=== what the stub endpoint was asked for ===');
  console.log(requests.length ? JSON.stringify(requests, null, 2) : '(the endpoint was never called)');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});