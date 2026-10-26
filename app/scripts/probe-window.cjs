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

const path = require('node:path');

const { APP, connect, listTargets, runChecks, startApp, startStub, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9333);
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');
const STUB_PORT = 8715;

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
        modeButtons: document.querySelectorAll('.modebtn').length,
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
      // The view is mounted by a queued draw that reads the open folder first,
      // so the field appears a moment after the key is pressed. Waiting for a
      // fixed moment measured that moment rather than the result.
      let field = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        field = document.querySelector('#sidebar-body input[type="text"]');
        if (field) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!field) {
        return {
          ran: false,
          reason: 'the search field was not mounted',
          title: document.getElementById('sidebar-title').textContent,
          body: document.getElementById('sidebar-body').textContent.slice(0, 120)
        };
      }
      field.value = 'lexiqode-core-ready';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      // How long a search takes is a property of the folder, not of the search:
      // this repository is four thousand files and takes about fifteen seconds
      // to reach the first hit, so a fixed sleep measured its own length. The
      // wait watches for the result, keeps going long enough for a cold run, and
      // reports the counter it saw while waiting.
      let waited = 0;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (document.querySelectorAll('.hit').length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        waited += 250;
      }
      const progressNode = document.querySelector('#sidebar-body [data-role="progress"]');
      return {
        ran: true,
        waitedMs: waited,
        progress: progressNode ? progressNode.textContent : '',
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
      // Presence in the DOM is not visibility: a popup inside a scrolling parent
      // is present and clipped to nothing. The geometry is what matters, and
      // hit-testing the centre proves it is the thing on top there.
      let geometry = null;
      if (list) {
        const rect = list.getBoundingClientRect();
        const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        geometry = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          onScreen: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight,
          hitTestInside: Boolean(centre && list.contains(centre)),
          parent: list.parentElement ? list.parentElement.tagName : null
        };
      }
      const state = {
        present: true,
        geometry,
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
  },
  {
    label: 'typing an endpoint and a key fetches the model list',
    expression: `
      const openSettings = () => document.querySelector('#chat-actions .iconbtn:nth-child(2)').click();
      let sheet = document.querySelector('#transcript .commit');
      if (!sheet) {
        openSettings();
        await new Promise((resolve) => setTimeout(resolve, 400));
        sheet = document.querySelector('#transcript .commit');
      }
      if (!sheet) return { ran: false, reason: 'the settings form did not open' };
      const rows = [...sheet.querySelectorAll('.field__row')];
      const controls = rows.map((row) => row.querySelector('input, select'));
      const endpoint = controls[1];
      const key = controls[2];
      endpoint.value = 'http://127.0.0.1:${STUB_PORT}/v1';
      endpoint.dispatchEvent(new Event('input', { bubbles: true }));
      key.value = 'stub-key';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      // Long enough for a slow endpoint to answer, and the scan area is watched
      // rather than a selector that could match another dropdown on the form.
      const scanArea = sheet.lastElementChild.previousElementSibling;
      let picker = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        picker = scanArea.querySelector('select.modelpick');
        if (picker) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return {
        ran: true,
        rowCount: rows.length,
        scanText: [...scanArea.querySelectorAll('.list__empty, .spinner')]
          .map((node) => node.textContent || '(spinner)')
          .join(' | ')
          .slice(0, 220),
        scanHtml: scanArea.innerHTML.slice(0, 200),
        hasPicker: Boolean(picker),
        options: picker ? [...picker.options].map((option) => option.value) : []
      };
    `
  }
];

async function main() {
  const stub = await startStub({ port: STUB_PORT });
  const rendererErrors = [];
  // The app runs with its own configuration directory, so nothing measured here
  // can read or write the settings of whoever runs the probe.
  const child = startApp({
    port: PORT,
    tag: 'window',
    onLine: (line) => {
      if (/error|refused|failed|violat/i.test(line)) rendererErrors.push(line.slice(0, 220));
    }
  });
  console.log(`isolated configuration: ${child.configDir}`);

  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    console.log(`attached to ${target.url}`);
    const ready = await waitForDom(session);
    console.log(`document ${ready.state} with ${ready.ids} ids`);
    await runChecks(session, CHECKS);
  } finally {
    child.kill();
    stub.close();
  }

  console.log('\n=== console noise from the app ===');
  console.log(rendererErrors.length ? [...new Set(rendererErrors)].slice(0, 20).join('\n') : '(none)');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});