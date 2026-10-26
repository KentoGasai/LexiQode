/**
 * The four things that were reported as broken, measured on the real window.
 *
 * Each check reproduces one complaint exactly as it was described - press the
 * button, open the folder, drag the boundary - and prints what the application
 * actually did, so a fix can be shown to change the number rather than the
 * screen. Run it the same way as the other probe:
 *
 *   node scripts/probe-interactions.cjs            (development runtime)
 *   $env:LEXIQODE_PROBE_EXE='...\LexiQode.exe'; node scripts/probe-interactions.cjs
 *
 * It launches with **no folder**, because that is the state the reports start
 * from, and opens one from inside the page.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP, sleep, startApp, startStub, listTargets, connect, waitForDom, runChecks } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9344);
const STUB_PORT = 8716;
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');

/**
 * A throwaway folder for the one check that writes a file.
 *
 * The probe is normally pointed at a real project, and a check that proves
 * "save all" works must edit something and save it. Editing the caller's
 * checkout would be unacceptable, so that check opens its own empty folder.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-probe-scratch-'));

/** Close the rail item by index and report what the sidebar shows afterwards. */
const sideBarAfter = `
  const rail = [...document.querySelectorAll('.activity__item')];
  const report = (name) => ({
    name,
    title: document.getElementById('sidebar-title').textContent,
    hidden: document.getElementById('sidebar').hidden,
    text: document.getElementById('sidebar-body').textContent.replace(/\\s+/g, ' ').trim().slice(0, 140),
    rows: document.querySelectorAll('#sidebar-body .tree__row').length,
    gitRows: document.querySelectorAll('#sidebar-body .git__row').length,
    fields: document.querySelectorAll('#sidebar-body input, #sidebar-body select').length
  });
  const out = [];
  for (const [index, name] of [[1, 'search'], [2, 'git']]) {
    rail[index].click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    out.push(report(name));
  }
  rail[0].click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return out;
`;

const CHECKS = [
  {
    label: 'without a folder: what the rail buttons do',
    expression: `
      const chatState = document.getElementById('chat-state');
      return {
        railTitles: [...document.querySelectorAll('.activity__item')].map((node) => node.title),
        welcomeVisible: !document.getElementById('welcome').hidden,
        chatLabel: chatState.textContent,
        chatDot: document.getElementById('chat-dot').dataset.state,
        sidebar: await (async () => { ${sideBarAfter} })()
      };
    `
  },
  {
    label: 'after opening a folder: does the window follow',
    expression: `
      const chatState = document.getElementById('chat-state');
      // Does the window even hear about the folder it asked for? A panel that
      // shows the previous view is explained either by a missing event or by a
      // handler that ignores it, and those two need different fixes.
      const seen = [];
      window.lexiqode.on('workspace:changed', (payload) => seen.push(payload ? payload.root : null));
      await window.lexiqode.workspace.open(${JSON.stringify(WORKSPACE)});
      let agent = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        agent = await window.lexiqode.agent.status().catch((error) => ({ error: error.message }));
        if (agent && agent.state === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      return {
        workspaceEvents: seen,
        treeRows: document.querySelectorAll('#sidebar-body .tree__row').length,
        statusbar: document.getElementById('statusbar').textContent.replace(/\\s+/g, ' ').trim(),
        chatLabel: chatState.textContent,
        chatDot: document.getElementById('chat-dot').dataset.state,
        agentFromMain: agent && { state: agent.state, detail: (agent.detail || '').slice(0, 90), python: agent.python && agent.python.version },
        sidebar: await (async () => { ${sideBarAfter} })()
      };
    `
  },
  {
    label: 'does the repository get recognised',
    expression: `
      const status = await window.lexiqode.git.status();
      const branch = [...document.querySelectorAll('.statusbar__item')]
        .map((node) => node.textContent)
        .find((text) => text && text.includes(status.branch || '\\u0000'));
      return {
        repo: status.repo,
        branch: status.branch,
        reason: status.reason || null,
        entries: (status.entries || []).length,
        statusbarBranch: branch || '(the status bar does not show the branch)'
      };
    `
  },
  {
    label: 'dragging a boundary, in the direction a person drags',
    expression: `
      const measure = () => ({
        sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
        chat: Math.round(document.getElementById('chat').getBoundingClientRect().width),
        panel: Math.round(document.getElementById('panel').getBoundingClientRect().height)
      });
      const drag = async (id, dx, dy) => {
        const handle = document.getElementById(id);
        const before = measure();
        const rect = handle.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const fire = (type, atX, atY) => {
          try {
            handle.dispatchEvent(new PointerEvent(type, {
              bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, buttons: 1,
              clientX: atX, clientY: atY
            }));
          } catch (error) {
            // A synthetic pointer cannot always be captured; the handler has
            // already recorded the drag by then, which is all this measures.
          }
        };
        fire('pointerdown', x, y);
        fire('pointermove', x + dx / 2, y + dy / 2);
        fire('pointermove', x + dx, y + dy);
        fire('pointerup', x + dx, y + dy);
        await new Promise((resolve) => setTimeout(resolve, 350));
        return { before, after: measure() };
      };
      if (document.getElementById('panel').hidden) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const sidebarRight = await drag('sidebar-resizer', 60, 0);
      const chatLeft = await drag('chat-resizer', -80, 0);
      const panelUp = await drag('panel-resizer', 0, -60);
      return {
        sidebarDraggedRight: sidebarRight,
        chatDraggedLeft: chatLeft,
        panelDraggedUp: panelUp,
        verdict: {
          sidebarGrowsWhenDraggedRight: sidebarRight.after.sidebar > sidebarRight.before.sidebar,
          chatGrowsWhenDraggedLeft: chatLeft.after.chat > chatLeft.before.chat,
          panelGrowsWhenDraggedUp: panelUp.after.panel > panelUp.before.panel
        }
      };
    `
  },
  {
    label: 'saving an endpoint makes the assistant usable',
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
      const model = controls[3];
      endpoint.value = 'http://127.0.0.1:${STUB_PORT}/v1';
      endpoint.dispatchEvent(new Event('input', { bubbles: true }));
      key.value = 'stub-key';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const picker = sheet.querySelector('select.modelpick');
      if (picker) {
        picker.value = 'stub-model-a';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const save = [...sheet.querySelectorAll('.btn')].find((node) => node.textContent.trim().length && node.className.includes('primary'));
      if (save) save.click();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const chatState = document.getElementById('chat-state');
      return {
        ran: true,
        modelField: model ? model.value : '(no model field)',
        listOptions: picker ? [...picker.options].map((option) => option.value) : [],
        chatLabel: chatState.textContent,
        chatDot: document.getElementById('chat-dot').dataset.state,
        agent: await window.lexiqode.agent.status().catch((error) => ({ error: error.message }))
      };
    `
  },
  {
    label: 'the Ctrl+K chord reaches the window, and save all lands on disk',
    expression: `
      const chord = (second) => {
        const send = (key) =>
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
          );
        send('k');
        send(second);
      };
      // A latch that never clears would swallow the next shortcut, so the first
      // thing checked is that an unrelated two-key sequence leaves the window
      // working: Ctrl+K then Ctrl+Shift+E, which selects the explorer.
      chord('e');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterUnrelatedChord = document.getElementById('sidebar-title').textContent;

      // It writes into its own folder: nothing here touches the caller's project.
      await window.lexiqode.workspace.open(${JSON.stringify(SCRATCH)});
      await new Promise((resolve) => setTimeout(resolve, 800));
      await window.lexiqode.workspace.createFile('', 'chord.txt');
      // The explorer is drawn when its view is mounted, not when the folder
      // changes, so the new file appears after switching to it - the same click
      // a person would make.
      document.querySelectorAll('.activity__item')[0].click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      let row = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        row = document.querySelector('.tree__row[data-path="chord.txt"]');
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!row) {
        return {
          ran: false,
          reason: 'the file was not listed in the tree',
          afterUnrelatedChord,
          diagnostics: {
            root: await window.lexiqode.workspace.current().catch(() => null),
            listed: await window.lexiqode.workspace
              .tree('')
              .then((items) => items.map((item) => item.name))
              .catch((error) => error.message),
            title: document.getElementById('sidebar-title').textContent,
            rows: [...document.querySelectorAll('.tree__row')].map((node) => node.dataset.path).slice(0, 8),
            sidebarText: document.getElementById('sidebar-body').textContent.replace(/\s+/g, ' ').trim().slice(0, 120)
          }
        };
      }
      row.click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (window.monaco && window.monaco.editor.getModels().some((model) => model.uri.path.endsWith('chord.txt'))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const model = window.monaco && window.monaco.editor.getModels().find((entry) => entry.uri.path.endsWith('chord.txt'));
      if (!model) return { ran: false, reason: 'Monaco did not open the file', afterUnrelatedChord };

      model.setValue('typed by the probe\\n');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const dirtyBefore = document.querySelectorAll('.tab__dirty').length;
      chord('s');
      await new Promise((resolve) => setTimeout(resolve, 800));
      const onDisk = await window.lexiqode.workspace.readFile('chord.txt');
      return {
        ran: true,
        afterUnrelatedChord,
        dirtyBefore,
        dirtyAfter: document.querySelectorAll('.tab__dirty').length,
        savedText: String(onDisk.text || '').trim()
      };
    `
  }
];

async function main() {
  const stub = await startStub({ port: STUB_PORT });
  const noise = [];
  const child = startApp({
    port: PORT,
    tag: 'interactions',
    onLine: (line) => { if (/error|refused|failed|violat/i.test(line)) noise.push(line.slice(0, 200)); }
  });
  // The app under test runs with its own configuration, so nothing here can
  // touch the settings of whoever runs it.
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
    // The application still holds the scratch folder for a moment after it is
    // asked to close, so the removal waits for it rather than racing it.
    await sleep(1200);
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true });
    } catch {
      console.log(`note: the scratch folder was left behind: ${SCRATCH}`);
    }
  }

  console.log('\n=== console noise from the app ===');
  console.log(noise.length ? [...new Set(noise)].slice(0, 15).join('\n') : '(none)');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});