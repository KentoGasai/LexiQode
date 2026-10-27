/**
 * The window's own features, exercised the way a person uses them.
 *
 * Everything here is checked through the interface rather than through the
 * modules: a key is pressed, a row is right-clicked, a chip's cross is clicked,
 * and then the window is asked what the result is. That is the only way to know
 * that a control is reachable at all - each of these features was added because
 * something could not be done from the interface, and a module-level test would
 * have passed just as happily with no button on screen.
 *
 * It covers: a shell opening with the folder, the model beside the mode, a file
 * being taken out of and put back into the next message, the theme button, the
 * settings dialog and its write path, and what the update check reports.
 *
 * Run: node scripts/probe-app-features.cjs [folder]
 */

const path = require('node:path');

const { APP, connect, listTargets, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9339);
const WORKSPACE = process.argv[2] || path.resolve(APP, '..');
/** A file that exists in this repository, two folders deep. */
const SAMPLE = 'app/src/renderer/js/explorer.js';

async function main() {
  const child = startApp({ port: PORT, tag: 'features' });
  console.log(`isolated configuration: ${child.configDir}`);
  let report = null;
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    console.log(`attached to ${target.url}`);
    await waitForDom(session);
    report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const q = (selector) => document.querySelector(selector);
      const qa = (selector) => [...document.querySelectorAll(selector)];
      const text = (selector) => qa(selector).map((node) => node.textContent.trim());
      const out = {};

      // A folder, the way the window opens one: through the same bridge the
      // welcome screen and the menu use.
      const first = q('.activity__item');
      if (first) first.click();
      await sleep(300);
      await window.lexiqode.workspace.open(${JSON.stringify(WORKSPACE)});
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (q('.tree__row')) break;
        await sleep(250);
      }
      // The tier above is what mounts the shell, so this is where it may have
      // happened by now; the checks below give it a moment either way.
      await sleep(2500);

      out.terminal = {
        panelVisible: !q('#panel').hidden,
        sessions: await window.lexiqode.terminal.list()
      };

      // Open one file, so there is something in the editor and in the context.
      const opened = new Set();
      for (let depth = 1; depth < ${JSON.stringify(SAMPLE)}.split('/').length; depth += 1) {
        const folder = ${JSON.stringify(SAMPLE)}.split('/').slice(0, depth).join('/');
        const row = qa('.tree__row[data-kind="folder"]').find((entry) => entry.dataset.path === folder);
        if (!row) break;
        if (!opened.has(folder)) {
          opened.add(folder);
          row.click();
          await sleep(400);
        }
      }
      const fileRow = qa('.tree__row[data-kind="file"]').find(
        (entry) => entry.dataset.path === ${JSON.stringify(SAMPLE)}
      );
      if (fileRow) fileRow.click();
      await sleep(1200);

      // ------------------------------------------------ the model beside the mode
      const modes = q('#composer-modes');
      const modelHost = q('#composer-model');
      out.composer = {
        modeButton: text('#composer-modes .modebtn'),
        modelHost: Boolean(modelHost),
        immediatelyAfterTheMode: Boolean(modes && modelHost && modes.nextElementSibling === modelHost),
        control: modelHost ? (modelHost.querySelector('select') ? 'select' : modelHost.querySelector('.modelnone') ? 'placeholder' : 'none') : 'missing',
        text: modelHost ? modelHost.textContent.trim() : '',
        title: modelHost ? (modelHost.querySelector('select, .modelnone') || {}).title || '' : ''
      };

      // --------------------------------------------- taking a file out of a message
      // Only the chips that carry a cross count as being in the message: the
      // "add a file" button shares their class, and counting it would make an
      // empty row look like a full one.
      const chips = () =>
        qa('#composer-context .ctx')
          .filter((node) => node.querySelector('.ctx__drop'))
          .map((node) => node.textContent.trim());
      out.context = { before: chips(), addButtonBefore: Boolean(q('#composer-context .ctx--add')) };
      const drop = q('#composer-context .ctx__drop');
      if (drop) drop.click();
      await sleep(250);
      out.context.afterDrop = chips();
      const add = q('#composer-context .ctx--add');
      out.context.addButton = Boolean(add);
      if (add) add.click();
      await sleep(250);
      out.context.afterAdd = chips();

      // And from the tree's own menu: the same file, pinned and unpinned.
      const rowAgain = qa('.tree__row[data-kind="file"]').find(
        (entry) => entry.dataset.path === ${JSON.stringify(SAMPLE)}
      );
      if (rowAgain) {
        rowAgain.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 260 }));
        await sleep(250);
        out.context.menu = text('.ctxmenu__item');
        // The labels follow the window's language, so both spellings are accepted.
        const toggle = qa('.ctxmenu__item').find((item) => /context|контекст/i.test(item.textContent));
        out.context.menuLabel = toggle ? toggle.textContent.trim() : '';
        if (toggle) toggle.click();
        await sleep(250);
        out.context.afterMenu = chips();
      }

      // ------------------------------------------------------------- the theme button
      const theme = q('#statusbar .statusbar__item[data-role="theme"]');
      out.theme = {
        present: Boolean(theme),
        firstInTheStatusbar: Boolean(theme && q('#statusbar').firstElementChild === theme),
        text: theme ? theme.textContent.trim() : '',
        title: theme ? theme.title : '',
        applied: document.documentElement.dataset.theme,
        choice: theme ? theme.dataset.choice : ''
      };
      if (theme) {
        const seen = [];
        for (let click = 0; click < 3; click += 1) {
          theme.click();
          await sleep(300);
          seen.push({ text: theme.textContent.trim(), applied: document.documentElement.dataset.theme, choice: theme.dataset.choice });
        }
        out.theme.clicks = seen;
      }

      // ---------------------------------------------------------- the settings dialog
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
      await sleep(500);
      const overlay = q('#settings-overlay');
      const fontSizeRow = qa('#settings-body .settings__row').find((row) =>
        /font size|размер шрифта/i.test(row.querySelector('.settings__label').textContent)
      );
      out.settings = {
        opened: !overlay.hidden,
        groups: text('#settings-body .settings__group h3'),
        controls: qa('#settings-body select, #settings-body input, #settings-body textarea').length,
        updateBlock: qa('#settings-body .settings__update').length,
        versionLine: text('#settings-body .settings__update .settings__note')
      };
      if (fontSizeRow) {
        const input = fontSizeRow.querySelector('input[type="number"]');
        const before = (await window.lexiqode.settings.get()).appearance.fontSize;
        input.value = String(before === 15 ? 16 : 15);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
        const after = (await window.lexiqode.settings.get()).appearance.fontSize;
        // Put it back: this window keeps its own settings, but a probe that
        // leaves a changed value behind is a probe that reports on itself next
        // time it runs.
        input.value = String(before);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
        out.settings.fontSize = { before, after, restored: (await window.lexiqode.settings.get()).appearance.fontSize };
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      out.settings.closed = overlay.hidden;

      // ------------------------------------------------------------------ the updates
      const update = await window.lexiqode.update.state();
      out.updates = {
        current: update.current,
        repo: update.repo,
        phase: update.phase,
        message: update.message || ''
      };
      return out;
    `);
  } finally {
    child.kill();
  }

  console.log(JSON.stringify(report, null, 2));

  // What has to be true for the run to count as a pass.
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const session = report && report.terminal && report.terminal.sessions ? report.terminal.sessions[0] : null;
  // The folder the probe was pointed at, whatever it is called: a probe that
  // hard-codes a directory name breaks the day somebody renames it.
  const expectedFolder = path.basename(WORKSPACE);
  expect(report && report.terminal.panelVisible, 'the panel did not open with the folder');
  expect(session && /powershell/i.test(session.shell), 'no PowerShell session was started for the folder');
  expect(
    session && session.cwd && session.cwd.replace(/\\/g, '/').endsWith(expectedFolder),
    `the shell is not in the opened folder (${session ? session.cwd : 'no session'})`
  );
  expect(report && report.composer.immediatelyAfterTheMode, 'the model control is not next to the mode button');
  expect(report && report.composer.control !== 'missing' && report.composer.control !== 'none', 'no model control was drawn');
  expect(report && report.context.before.length >= 1, 'the open file was not offered with the message');
  expect(report && report.context.before.some((line) => line.includes('×')), 'the file chip has no way to remove it');
  expect(report && report.context.afterDrop.length === 0, 'removing the file from the message did not work');
  expect(report && report.context.addButton, 'after removing it there is no way to put the file back');
  expect(report && report.context.afterAdd.length === 1, 'pinning the file back did not work');
  expect(report && report.context.menuLabel, 'the tree menu has no context entry');
  expect(report && report.context.afterMenu.length === 0, 'the tree menu did not take the file out again');
  expect(report && report.theme.present && report.theme.firstInTheStatusbar, 'the theme button is not in the bottom left corner');
  expect(report && report.theme.clicks && new Set(report.theme.clicks.map((entry) => entry.choice)).size === 3, 'the theme button does not reach all three choices');
  expect(report && report.settings.opened, 'Ctrl+, did not open the settings');
  expect(report && report.settings.controls >= 20, 'the settings dialog drew almost no controls');
  expect(report && report.settings.updateBlock === 1, 'the settings have no updates section');
  expect(report && report.settings.fontSize && report.settings.fontSize.after !== report.settings.fontSize.before, 'a setting changed in the dialog was not saved');
  expect(report && report.settings.fontSize && report.settings.fontSize.restored === report.settings.fontSize.before, 'the probe left the setting changed');
  expect(report && report.settings.closed, 'Escape did not close the settings');
  expect(report && report.updates.current && report.updates.repo, 'the update check does not know its own version and repository');

  if (failures.length) {
    console.error(`\n${failures.length} failed expectation(s):`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nall expectations held');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});