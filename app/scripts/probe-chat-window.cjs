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
      if (stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Paced deliberately: a stub that answers instantly makes the whole turn
        // shorter than the probe's sampling interval, so the state *during* the
        // turn - thinking shown, tools running - could never be observed and a
        // panel that never opened the thinking block would pass.
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const send = (delta) =>
          response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        // A turn shaped like a real one: the model thinks, asks for a read-only
        // tool, reads the result and answers. The reasoning arrives on its own
        // field, which is what a reasoning model does and what the panel has to
        // fold away instead of printing as the answer.
        const usedTool = (asked.messages || []).some((message) => message.role === 'tool');
        if (!usedTool) {
          await pause(300);
          for (const piece of ['The question needs ', 'a look at the project ', 'before I answer.']) {
            send({ reasoning_content: piece });
            await pause(200);
          }
          send({ content: 'Let me look at the project first. ' });
          await pause(300);
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_probe_1',
                        type: 'function',
                        function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.md' }) }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`
          );
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          for (const piece of ['The listing is ', 'enough to answer.']) {
            send({ reasoning_content: piece });
            await pause(200);
          }
          for (const piece of ['The ', 'stub ', 'answered.']) {
            send({ content: piece });
            await pause(120);
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
      const mid = {
        reasoningOpenWhileThinking: null,
        reasoningLabelWhileThinking: '',
        toolsLabelWhileRunning: '(never seen)',
        toolsOpenWhileRunning: null
      };
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(80);
        const turn = [...document.querySelectorAll('.turn--assistant')].pop();
        const reasoning = turn ? turn.querySelector('details.reasoning') : null;
        if (reasoning && mid.reasoningOpenWhileThinking === null) {
          mid.reasoningOpenWhileThinking = reasoning.open;
          mid.reasoningLabelWhileThinking = reasoning
            .querySelector('summary')
            .textContent.replace(/\\s+/g, ' ')
            .trim();
        }
        const tools = turn ? turn.querySelector('details.tools') : null;
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
        if (/stub answered/.test(answered) && stop && stop.hidden) break;
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
        contextMeter: meter ? meter.textContent.replace(/\\s+/g, ' ').trim() : '(missing)',
        contextMeterTitle: meter ? meter.title : ''
      };
      // Read late: the status bar is written when the panel learns the profile,
      // and an earlier read measures the wrong moment.
      const modelItem = document.querySelector('.statusbar__item[data-role="model"]');
      steps.turn.statusbarModel = modelItem ? modelItem.textContent.trim() : '(no model item)';
      steps.turn.statusbar = statusbar();

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