/**
 * Real screenshots of the running application, for the README.
 *
 * These are not mockups: the script starts the application, opens a project,
 * drives the interface the way a person does - clicks a tree row, presses
 * Ctrl+Shift+F, right-clicks a file, sends a message to the assistant - and
 * captures the window over the DevTools protocol. Everything in the pictures is
 * a state the application reached by itself.
 *
 * What is deliberately not in them:
 *
 * * The user's own project. A demonstration project is generated in a temporary
 *   folder, with its own git history, so no personal path, file name or branch
 *   appears in a screenshot that will be published.
 * * The user's own endpoint and key. The assistant answers through a local stub
 *   that speaks the OpenAI-compatible protocol, and the settings shown carry a
 *   placeholder model id.
 * * The real configuration. The window is started with an isolated settings and
 *   data directory, exactly as the probes do - which is also why this can run
 *   while the application is open.
 *
 *   node scripts/capture-screenshots.cjs
 *   $env:LEXIQODE_PROBE_EXE='...\LexiQode.exe'; node scripts/capture-screenshots.cjs
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { sleep, startApp, listTargets, connect, waitForDom } = require('./probe-harness.cjs');

const APP = path.resolve(__dirname, '..');
const OUT = path.resolve(APP, '..', 'docs', 'screenshots');
/** The social preview GitHub shows when the repository is linked. */
const SOCIAL = path.resolve(APP, '..', 'docs', 'social-preview.png');
const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9353);
const STUB_PORT = 8718;
const VIEWPORT = { width: 1440, height: 900 };
const SOCIAL_VIEWPORT = { width: 1280, height: 640 };

const FILES = {
  'README.md':
    '# Acme service\n\nA small HTTP service used by the operations team.\n\n' +
    '## Running it\n\n```\nnpm start\n```\n',
  'package.json': '{\n  "name": "acme-service",\n  "version": "1.4.2",\n  "private": true\n}\n',
  'src/server.js':
    'const { createRouter } = require("./router");\n' +
    'const { formatOrder } = require("./util/format");\n\n' +
    'function createServer() {\n' +
    '  const router = createRouter();\n\n' +
    '  router.get("/orders/:id", (request, response) => {\n' +
    '    const order = store.orders.get(request.params.id);\n' +
    '    response.json(formatOrder(order));\n' +
    '  });\n\n' +
    '  return router;\n' +
    '}\n\n' +
    'module.exports = { createServer };\n',
  'src/router.js':
    'function createRouter() {\n' +
    '  const routes = [];\n\n' +
    '  return {\n' +
    '    get(path, handler) {\n' +
    '      routes.push({ method: "GET", path, handler });\n' +
    '      return this;\n' +
    '    },\n' +
    '    match(method, path) {\n' +
    '      return routes.find((route) => route.method === method && route.path === path);\n' +
    '    }\n' +
    '  };\n' +
    '}\n\n' +
    'module.exports = { createRouter };\n',
  'src/util/format.js':
    '/** One line per order, for the operations page. */\n' +
    'function formatOrder(order) {\n' +
    '  if (!order) return { id: null, total: 0, status: "unknown" };\n' +
    '  return {\n' +
    '    id: order.id,\n' +
    '    total: Number(order.total.toFixed(2)),\n' +
    '    status: order.status || "new"\n' +
    '  };\n' +
    '}\n\n' +
    'module.exports = { formatOrder };\n'
};

/** A project to photograph: files, a git history, and one pending change. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-demo-'));
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'demo@example.com');
    git('config', 'user.name', 'Demo');
    git('add', '-A');
    git('commit', '-q', '-m', 'Import the service as it stands');
    // One unstaged edit and one untracked file, so the source-control view has
    // something to show rather than an empty list.
    fs.appendFileSync(
      path.join(root, 'src', 'util', 'format.js'),
      '\nfunction formatOrders(orders) {\n  return orders.map(formatOrder);\n}\n\n' +
        'module.exports = { formatOrder, formatOrders };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, 'src', 'metrics.js'),
      'const counters = new Map();\n\nfunction count(name) {\n  counters.set(name, (counters.get(name) || 0) + 1);\n}\n\n' +
        'module.exports = { count, counters };\n',
      'utf8'
    );
  } catch (error) {
    console.log(`(the demonstration project has no git history: ${error.message})`);
  }

  /**
   * A drive letter instead of a path through the user's profile.
   *
   * A temporary folder lives under `C:\Users\<someone>\AppData\Local\Temp`, and
   * that name appears in the window's title bar, in every file path in the
   * editor and in every terminal prompt - so a screenshot taken there publishes
   * the name of the person who took it. `subst` mounts the same folder as `L:`
   * without administrator rights, and the whole picture then reads as a project
   * at the root of a drive.
   */
  for (const letter of ['L', 'M', 'N', 'P']) {
    if (fs.existsSync(`${letter}:\\`)) continue;
    try {
      execFileSync('subst', [`${letter}:`, root], { stdio: 'ignore' });
      return { path: `${letter}:\\`, mounted: `${letter}:` };
    } catch {
      // Try the next letter; the plain path is still usable, just noisier.
    }
  }
  console.log('(no free drive letter: the screenshots will show the temporary path)');
  return { path: root, mounted: '' };
}

/**
 * An endpoint that answers like a model, so the assistant screenshots show a
 * real turn: reasoning, one tool call, then an answer with token accounting.
 */
function stub() {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      if (request.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'gpt-5' }, { id: 'claude-sonnet-4-5' }, { id: 'qwen3-coder' }].map((row) => row)
          })
        );
        return;
      }
      let asked = {};
      try {
        asked = JSON.parse(body);
      } catch {
        asked = {};
      }
      if (!asked.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'stub',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          })
        );
        return;
      }

      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const send = (delta) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      const usedTool = (asked.messages || []).some((message) => message.role === 'tool');

      if (!usedTool) {
        for (const piece of [
          'The order formatter is the interesting part here, ',
          'so I will look at how it is called before answering.'
        ]) {
          send({ reasoning_content: piece });
          await pause(220);
        }
        send({ content: 'Reading how orders are formatted. ' });
        await pause(220);
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_demo_1',
                      type: 'function',
                      function: {
                        name: 'grep',
                        arguments: JSON.stringify({ pattern: 'formatOrder', glob: '*.js' })
                      }
                    }
                  ]
                }
              }
            ]
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
        );
      } else {
        for (const piece of ['Now I can answer with the call sites in hand.']) {
          send({ reasoning_content: piece });
          await pause(200);
        }
        for (const piece of [
          'Three places call it: ',
          '`createServer` in `src/server.js`, and the two tests. ',
          'If you are changing the shape of an order, ',
          'the formatter is the single place to change - ',
          'but `total` is rounded there, so anything that compares money must read the formatted value.'
        ]) {
          send({ content: piece });
          await pause(90);
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 6144, completion_tokens: 210, total_tokens: 6354 }
          })}\n\n`
        );
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

/** Read a PNG's dimensions, so a capture that produced nothing is caught here. */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const project = makeProject();
  const server = await stub();
  const child = startApp({ port: PORT, tag: 'shots', onLine: () => {} });
  console.log(`demonstration project: ${project.path}`);
  console.log(`isolated configuration: ${child.configDir}`);

  const shots = [];
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);

    const viewport = (size) =>
      session.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false
      });

    const shot = async (name, { into = OUT, size = VIEWPORT } = {}) => {
      await viewport(size);
      await sleep(600);
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      const buffer = Buffer.from(data, 'base64');
      const file = path.join(into, `${name}.png`);
      fs.writeFileSync(file, buffer);
      const dimensions = pngSize(buffer);
      shots.push({ name, bytes: buffer.length, ...(dimensions || {}) });
      console.log(
        `  ${name}.png  ${dimensions ? `${dimensions.width}x${dimensions.height}` : 'NOT A PNG'}  ` +
          `${(buffer.length / 1024).toFixed(0)} KB`
      );
      return file;
    };

    const run = (expression) => session.evaluate(expression);
    const settle = (ms = 700) => sleep(ms);
    /**
     * Wait for notifications to clear before a capture.
     *
     * A toast from the step that set the picture up is not part of the picture:
     * the first attempt at these screenshots had "started a new conversation"
     * across the composer, which reads as an unfinished window.
     */
    const quiet = async (budget = 9000) => {
      const until = Date.now() + budget;
      while (Date.now() < until) {
        const visible = await run(`return document.querySelectorAll('.toast').length > 0;`);
        if (!visible) return true;
        await sleep(400);
      }
      return false;
    };
    /**
     * Make sure the assistant pane is on screen.
     *
     * Its activity button toggles the pane, so a step that clicked it to *look*
     * at the assistant can leave it hidden - which is how a set of screenshots
     * ends up with the product's main feature missing from most of the frames.
     */
    const showAssistant = async () => {
      const visible = await run(`
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        if (document.getElementById('chat').hidden) {
          const items = [...document.querySelectorAll('.activity__item')];
          if (items[3]) items[3].click();
          await sleep(900);
        }
        return !document.getElementById('chat').hidden;
      `);
      if (!visible) console.log('  ! the assistant pane could not be shown');
      return visible;
    };
    /** The bottom panel is part of some pictures and clutter in others. */
    const hideTerminal = async () => {
      await run(`
        if (!document.getElementById('panel').hidden) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
        }
        return true;
      `);
      await settle(600);
    };

    // ---------------------------------------------------------------- opening
    // The published screenshots are in English: the window follows the system
    // language, and this machine's is Russian, which would have made the whole
    // set read as a translation of an English product.
    await run(`
      await window.lexiqode.settings.update({ appearance: { language: 'en' } });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return true;
    `);
    await run(`
      await window.lexiqode.workspace.open(${JSON.stringify(project.path)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelectorAll('.tree__row').length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return true;
    `);
    await settle(1500);

    // The assistant is configured through the window's own form, with the stub.
    await run(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sheet = () => document.querySelector('#transcript .commit');
      const gear = () => document.querySelector('#chat-actions .iconbtn:nth-child(2)');
      if (!sheet()) gear().click();
      for (let attempt = 0; attempt < 40 && !sheet(); attempt += 1) await sleep(250);
      const controls = [...sheet().querySelectorAll('.field__row')].map((row) => row.querySelector('input, select'));
      controls[1].value = 'http://127.0.0.1:${STUB_PORT}/v1';
      controls[1].dispatchEvent(new Event('input', { bubbles: true }));
      controls[2].value = 'demo-key';
      controls[2].dispatchEvent(new Event('input', { bubbles: true }));
      let picker = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        picker = sheet().querySelector('select.modelpick');
        if (picker) break;
        await sleep(250);
      }
      if (picker) {
        picker.value = 'gpt-5';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        controls[3].value = 'gpt-5';
        controls[3].dispatchEvent(new Event('input', { bubbles: true }));
      }
      const save = [...sheet().querySelectorAll('.btn')].find((node) => node.className.includes('primary'));
      save.click();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await window.lexiqode.agent.state().catch(() => null);
        if (state && state.profile && state.profile.model) break;
        await sleep(250);
      }
      await sleep(500);
      return true;
    `);
    await settle(1200);

    // A conversation to photograph, tabs and all.
    await run(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const input = document.getElementById('composer-input');
      input.focus();
      input.value = 'Where is an order formatted, and what should I know before changing it?';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer-send').click();
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await sleep(400);
        const stop = document.getElementById('composer-stop');
        const text = document.getElementById('transcript').textContent;
        if (/Three places call it/.test(text) && stop && stop.hidden) break;
      }
      return true;
    `);
    await settle(900);

    // ------------------------------------------------------------------ shots
    // The assistant in the state a turn leaves behind: folded thinking above the
    // answer, the tools on one line, the context gauge under the composer. Taken
    // while the turn is still the live one, because a chat restored from disk
    // shows the text of each step without the tool rows that produced it.
    await run(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sheet = document.querySelector('#transcript .commit');
      if (sheet) {
        const gear = document.querySelector('#chat-actions .iconbtn:nth-child(2)');
        gear.click();
        await sleep(400);
      }
      // A file with something in it, two folders deep, as an editor looks in use.
      for (const folder of ['src', 'src/util']) {
        const row = [...document.querySelectorAll('.tree__row[data-kind="folder"]')].find(
          (entry) => entry.dataset.path === folder
        );
        if (row) {
          row.click();
          await sleep(500);
        }
      }
      const file = [...document.querySelectorAll('.tree__row[data-kind="file"]')].find(
        (entry) => entry.dataset.path === 'src/server.js'
      );
      if (file) file.click();
      await sleep(1400);
      return true;
    `);
    await quiet();
    await settle(400);
    await showAssistant();
    await shot('02-assistant');
    await shot('01-editor');

    // A second chat in a second tab, then back to the first: what a chat looks
    // like after it is reopened, which is the state a reader of the repository
    // will be in most of the time.
    await run(`
      const add = document.querySelector('#chat-tabs .chattabs__add');
      if (add) add.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const first = document.querySelector('#chat-tabs .chattab');
      if (first) first.click();
      await new Promise((resolve) => setTimeout(resolve, 1600));
      return true;
    `);
    await quiet();
    await showAssistant();
    await shot('02b-restored-chat');

    await run(`
      const tabs = document.querySelectorAll('#chat-tabs .chattab');
      if (tabs.length) {
        tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1180, clientY: 90 }));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    `);
    await quiet();
    await showAssistant();
    await shot('03-chat-tabs');
    await run(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    `);

    // 4. The file tree's own menu, where the pointer is.
    await run(`
      const row = [...document.querySelectorAll('.tree__row')].find((entry) => entry.dataset.path === 'src/util/format.js')
        || document.querySelector('.tree__row[data-kind="file"]');
      if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    `);
    await quiet();
    await shot('04-file-menu');
    await run(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    `);

    // 5. Find in files.
    await run(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
      let field = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        field = document.querySelector('#sidebar-body input[type="text"]');
        if (field) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      field.value = 'formatOrder';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.querySelectorAll('.hit').length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return true;
    `);
    await settle(800);
    await quiet();
    await shot('05-search');

    // 6. Source control, with the pending change the demo project has.
    await run(`
      const items = [...document.querySelectorAll('.activity__item')];
      if (items[2]) items[2].click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.querySelectorAll('.git__row').length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // A diff of the modified file, if the panel offers one.
      const row = document.querySelector('.git__row');
      if (row) {
        row.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return true;
    `);
    await settle(900);
    await quiet();
    await shot('06-source-control');

    // 7. The terminal, with output in it.
    await run(`
      if (document.getElementById('panel').hidden) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
      }
      let field = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        field = document.querySelector('.terminal__field');
        if (field) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (field) {
        field.value = 'node --version; Get-ChildItem src';
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 3500));
      return true;
    `);
    await quiet();
    await shot('07-terminal');

    // 8. The agent settings form: endpoint, model, window, compaction, theme.
    await run(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const items = [...document.querySelectorAll('.activity__item')];
      // The assistant's own button toggles the panel, so it is clicked only when
      // the panel is closed - clicking it while it is open hides the thing the
      // screenshot is of.
      if (document.getElementById('chat').hidden && items[3]) {
        items[3].click();
        await sleep(800);
      }
      const gear = document.querySelector('#chat-actions .iconbtn:nth-child(2)');
      if (!document.querySelector('#transcript .commit') && gear) gear.click();
      await sleep(1000);
      return true;
    `);
    await settle(600);
    await quiet();
    await shot('08-agent-settings');

    // 9. The same window in the light theme.
    await run(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const selects = [...document.querySelectorAll('#transcript .commit select.langpick')];
      const theme = selects[1];
      if (theme) {
        theme.value = 'light';
        theme.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await sleep(500);
      const gear = document.querySelector('#chat-actions .iconbtn:nth-child(2)');
      // The form is open: clicking the gear closes it, which is what this shot
      // wants - the panel and the light window, not the form again.
      if (gear && document.querySelector('#transcript .commit')) gear.click();
      const items = [...document.querySelectorAll('.activity__item')];
      if (items[0]) items[0].click();
      await sleep(1300);
      return true;
    `);
    await settle(900);
    await quiet();
    await shot('09-light-theme');

    // The Russian interface, for the Russian README, and the social card.
    await run(`
      await window.lexiqode.settings.update({ appearance: { language: 'ru' } });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return true;
    `);
    await settle(1200);
    await quiet();
    await showAssistant();
    await shot('ru-01-editor');
    await run(`
      const items = [...document.querySelectorAll('.activity__item')];
      if (items[3]) items[3].click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return true;
    `);
    await settle(900);
    await quiet();
    await showAssistant();
    await shot('ru-02-assistant');

    // The card GitHub shows when the repository is linked: English, the dark
    // theme, the assistant with a real turn in it, and no terminal competing for
    // attention. Captured at the size that page asks for.
    await run(`
      await window.lexiqode.settings.update({ appearance: { language: 'en', theme: 'dark' } });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return true;
    `);
    await hideTerminal();
    await showAssistant();
    await run(`
      const items = [...document.querySelectorAll('.activity__item')];
      if (items[0]) items[0].click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return true;
    `);
    await quiet();
    await viewport(SOCIAL_VIEWPORT);
    await sleep(800);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SOCIAL, Buffer.from(data, 'base64'));
    const socialSize = pngSize(fs.readFileSync(SOCIAL));
    console.log(
      `  social-preview.png  ${socialSize.width}x${socialSize.height}  ` +
        `${(fs.statSync(SOCIAL).size / 1024).toFixed(0)} KB`
    );
    await session.send('Emulation.clearDeviceMetricsOverride');
  } finally {
    child.kill();
    server.close();
    await sleep(900);
    if (project.mounted) {
      try {
        execFileSync('subst', [project.mounted, '/D'], { stdio: 'ignore' });
      } catch {
        // The mount outlives the run at worst; the folder is removed anyway.
      }
    }
    fs.rmSync(project.path, { recursive: true, force: true });
  }

  const small = shots.filter((entry) => entry.bytes < 20000);
  console.log(
    `\n${shots.length} screenshots in ${OUT}` +
      (small.length ? `; suspiciously small: ${small.map((entry) => entry.name).join(', ')}` : '')
  );
}

main().catch((error) => {
  console.error(`capture failed: ${error.message}`);
  process.exitCode = 1;
});