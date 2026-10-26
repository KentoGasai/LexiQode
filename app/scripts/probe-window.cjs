/**
 * Start the real application and interrogate the real window.
 *
 * Everything else in this project is verified by unit tests, which say nothing
 * about whether the window actually renders: a missing id, an import that does
 * not resolve, a content security policy that blocks Monaco's worker, or a
 * preload that fails to expose the bridge all pass every unit test and produce a
 * white rectangle. This launches the app with the DevTools protocol enabled,
 * asks the page what it built, and clicks through the interface the way a person
 * would - tree, editor, terminal - printing what each step produced.
 *
 * It is a smoke test, not a test suite: it asserts the presence of things that
 * must exist for the app to be usable at all.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9333);
// The dev runtime by default; a packaged bundle is checked by pointing this at
// its own executable, which is how the packaged layout (and the core it ships
// beside itself) gets verified rather than assumed.
const ELECTRON = process.env.LEXIQODE_PROBE_EXE || path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const ELECTRON_ARGS = process.env.LEXIQODE_PROBE_EXE ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`];
const ELECTRON_CWD = process.env.LEXIQODE_PROBE_EXE ? path.dirname(ELECTRON) : APP;
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listTargets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('app://'));
      if (page) return page;
    } catch {
      // The port is not open yet.
    }
    await sleep(500);
  }
  throw new Error('the window never appeared on the debugging port');
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an async expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'the page threw');
    }
    return result.result.value;
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not attach to the window')), { once: true });
  });
  return new Session(socket);
}

/**
 * Wait for the window to finish booting.
 *
 * A target appears on the debugging port the moment it is created, which is
 * before the markup exists. Attaching instantly and evaluating there reports an
 * empty body and no elements - a measurement of the wrong moment that looks
 * exactly like a broken window. Parsing is not enough either: the activity bar,
 * the status bar and the mode buttons are built by the window's own bootstrap,
 * so those are what the wait actually waits for.
 */
async function waitForDom(session) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await session.evaluate(
      `return {
         state: document.readyState,
         ids: document.querySelectorAll('[id]').length,
         activity: document.querySelectorAll('.activity__item').length,
         status: document.querySelectorAll('.statusbar__item').length,
         modes: document.querySelectorAll('.modebtn').length
       };`
    );
    if (ready.state !== 'loading' && ready.activity > 0 && ready.status > 0 && ready.modes > 0) return ready;
    await sleep(250);
  }
  throw new Error('the window never finished booting');
}

const CHECKS = [
  {
    label: 'the page and its bridge',
    expression: `
      const chat = document.getElementById('chat');
      return {
        title: document.title,
        theme: document.documentElement.dataset.theme,
        bridge: typeof window.lexiqode,
        channels: Array.isArray(window.lexiqode.events) ? window.lexiqode.events.length : -1,
        activityItems: document.querySelectorAll('.activity__item').length,
        statusItems: document.querySelectorAll('.statusbar__item').length,
        modeButtons: document.querySelectorAll('.mode').length,
        chatPanel: chat ? 'present' : 'missing',
        chatVisible: chat ? !chat.hidden : null,
        asideCount: document.querySelectorAll('aside').length,
        idsRendered: document.querySelectorAll('[id]').length,
        bootFailed: document.body.textContent.includes('could not start'),
        // Started with no folder: the welcome screen should be what is showing,
        // and nothing should have been opened on the user's behalf.
        welcomeVisible: !document.getElementById('welcome').hidden,
        welcomeTitle: document.getElementById('welcome').textContent.slice(0, 60),
        folderOpenedByItself: Boolean(await window.lexiqode.workspace.current()),
        bodyClasses: document.body.className || '(none)'
      };
    `
  },
  {
    label: 'the folder was opened into the tree',
    expression: `
      // The layout is restored from the last session, so whichever view was
      // last used is the one that is showing. Switching to the explorer is part
      // of the check, not a workaround: it is the same click a user makes.
      const first = document.querySelector('.activity__item');
      if (first) first.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await window.lexiqode.workspace.open(${JSON.stringify(WORKSPACE)});
      // Opening a folder also starts the agent and reads git, so the tree is
      // rendered after those; waiting a fixed short time measures the wrong
      // moment and reports an empty tree that is merely late.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.querySelectorAll('.tree__row').length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return {
        root: (await window.lexiqode.workspace.current()).name,
        treeRows: document.querySelectorAll('.tree__row').length,
        folders: document.querySelectorAll('.tree__row[data-kind="folder"]').length,
        sidebarTitle: document.getElementById('sidebar-title').textContent,
        indexed: (await window.lexiqode.workspace.index()).length
      };
    `
  },
  {
    label: 'a file opens in the editor',
    expression: `
      const folders = [...document.querySelectorAll('.tree__row[data-kind="folder"]')];
      for (const folder of folders.slice(0, 3)) {
        folder.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      const file = document.querySelector('.tree__row[data-kind="file"]');
      if (!file) return { opened: false, reason: 'no file row was rendered' };
      file.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        opened: true,
        path: file.dataset.path,
        tabs: document.querySelectorAll('.tab').length,
        tabLabel: document.querySelector('.tab__label') ? document.querySelector('.tab__label').textContent : '',
        monaco: Boolean(document.querySelector('.monaco-editor')),
        lines: document.querySelectorAll('.view-line').length,
        cursor: [...document.querySelectorAll('.statusbar__item')].map((node) => node.textContent).slice(-1)[0]
      };
    `
  },
  {
    label: 'search finds text in the project',
    expression: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const field = document.querySelector('#sidebar-body input[type="text"]');
      if (!field) return { ran: false, reason: 'the search field was not mounted' };
      field.value = 'lexiqode-core-ready';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return {
        ran: true,
        hits: document.querySelectorAll('.hit').length,
        first: document.querySelector('.hit__text') ? document.querySelector('.hit__text').textContent.slice(0, 60) : ''
      };
    `
  },
  {
    label: 'the terminal panel starts a shell',
    expression: `
      // The panel's visibility is part of the restored layout, so it is read
      // rather than assumed: toggling a panel that is already open closes it.
      if (document.getElementById('panel').hidden) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.querySelector('.terminal__field')) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // If the panel was already open but empty, opening it again is what mounts
      // the terminal; the app itself does this on start, so this path only
      // covers a layout that some other sequence left inconsistent.
      if (!document.querySelector('.terminal__field')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (document.querySelector('.terminal__field')) break;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      const field = document.querySelector('.terminal__field');
      if (!field) return { started: false, reason: 'the terminal input was not rendered' };
      field.value = 'Write-Output "window-probe"';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return {
        started: true,
        panelVisible: !document.getElementById('panel').hidden,
        prompt: document.querySelector('.terminal__prompt') ? document.querySelector('.terminal__prompt').textContent : '',
        sawOutput: document.getElementById('panel-body').textContent.includes('window-probe')
      };
    `
  },
  {
    label: 'the agent answers about itself',
    expression: `
      const status = await window.lexiqode.agent.status();
      const state = await window.lexiqode.agent.state().catch((error) => ({ error: error.message }));
      return {
        status: status.state,
        detail: status.detail,
        python: status.python && status.python.version ? status.python.version : String(status.python),
        profileReady: state.profile_ready,
        modes: Array.isArray(state.modes) ? state.modes.map((mode) => mode.id) : state.error
      };
    `
  },
  {
    label: 'the mode is a dropdown that lists the modes with icons',
    expression: `
      const button = document.querySelector('.modebtn');
      if (!button) return { present: false, reason: 'no mode button was rendered' };
      const label = button.querySelector('.modebtn__label');
      const iconCount = button.querySelectorAll('svg').length;
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const list = document.querySelector('.modelist');
      const items = list ? [...list.querySelectorAll('.modelist__item')] : [];
      const state = {
        present: true,
        closedLabel: label ? label.textContent : '',
        iconsInButton: iconCount,
        expanded: button.getAttribute('aria-expanded'),
        itemCount: items.length,
        items: items.map((item) => ({
          label: item.querySelector('.modelist__label').textContent,
          hint: item.querySelector('.modelist__hint').textContent.slice(0, 40),
          icons: item.querySelectorAll('svg').length,
          selected: item.getAttribute('aria-selected')
        }))
      };
      // Choosing the second mode must be reflected in the button, and the list
      // must close behind it.
      if (items[1]) items[1].click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      state.afterChoosing = {
        label: document.querySelector('.modebtn__label').textContent,
        listClosed: !document.querySelector('.modelist'),
        expanded: document.querySelector('.modebtn').getAttribute('aria-expanded')
      };
      return state;
    `
  },
  {
    label: 'the settings form',
    expression: `
      document.querySelector('#chat-actions .iconbtn:nth-child(2)').click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const sheet = document.querySelector('#transcript .commit');
      if (!sheet) return { open: false };
      return {
        open: true,
        fields: [...sheet.querySelectorAll('.field__row')].length,
        labels: [...sheet.querySelectorAll('.field__row > span')].slice(0, 8).map((node) => node.textContent),
        hasLanguageSelect: [...sheet.querySelectorAll('select')].length > 0,
        scanText: sheet.querySelector('.list__empty') ? sheet.querySelector('.list__empty').textContent.slice(0, 70) : ''
      };
    `
  }
];

async function main() {
  const child = spawn(ELECTRON, ELECTRON_ARGS, {
    cwd: ELECTRON_CWD,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', LEXIQODE_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const rendererErrors = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const collect = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/error|refused|failed|violat/i.test(line)) rendererErrors.push(line.trim().slice(0, 220));
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  try {
    const target = await listTargets();
    const session = await connect(target.webSocketDebuggerUrl);
    console.log(`attached to ${target.url}`);
    const ready = await waitForDom(session);
    console.log(`document ${ready.state} with ${ready.ids} ids`);
    for (const check of CHECKS) {
      try {
        const value = await session.evaluate(check.expression);
        console.log(`\n--- ${check.label}\n${JSON.stringify(value, null, 2)}`);
      } catch (error) {
        console.log(`\n--- ${check.label}\nFAILED: ${error.message}`);
      }
    }
  } finally {
    child.kill();
  }

  console.log('\n=== console noise from the app ===');
  console.log(rendererErrors.length ? [...new Set(rendererErrors)].slice(0, 20).join('\n') : '(none)');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});