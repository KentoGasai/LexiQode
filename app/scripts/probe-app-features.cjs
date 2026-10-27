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

const fs = require('node:fs');
const os = require('node:os');
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
  const shot = path.join(os.tmpdir(), 'lexiqode-app-features.png');
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
      /*
       * Wait for the shell rather than assume a delay.
       *
       * The panel opens after the agent has been started and the transcript
       * redrawn, and how long that takes depends on the machine: a fixed sleep
       * reports the moment before it happened, which looks exactly like the
       * feature being broken.
       */
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const sessions = await window.lexiqode.terminal.list().catch(() => []);
        if (!q('#panel').hidden && sessions.length) break;
        await sleep(400);
      }

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
      const modeButton = modes ? modes.querySelector('.modebtn') : null;
      out.composer = {
        modeButton: text('#composer-modes .modebtn'),
        modelHost: Boolean(modelHost),
        immediatelyAfterTheMode: Boolean(modes && modelHost && modes.nextElementSibling === modelHost),
        control: modelHost ? (modelHost.querySelector('select') ? 'select' : modelHost.querySelector('.modelnone') ? 'placeholder' : 'none') : 'missing',
        text: modelHost ? modelHost.textContent.trim() : '',
        title: modelHost ? (modelHost.querySelector('select, .modelnone') || {}).title || '' : '',
        selected: modelHost && modelHost.querySelector('select') ? modelHost.querySelector('select').selectedOptions[0].text : ''
      };
      /**
       * The two panels, measured against each other.
       *
       * This is the check for the bug where the mode button read "Ager": the
       * container that holds it scrolls, so a long model id beside it squeezed
       * the container and the rest of the word was clipped away. A container
       * whose content is wider than its box is that bug, whether it shows.
       */
      if (modes && modeButton && modelHost) {
        const modeBox = modeButton.getBoundingClientRect();
        const modelBox = modelHost.getBoundingClientRect();
        out.composer.geometry = {
          modeLabel: modeButton.textContent.trim(),
          modeWidth: Math.round(modeBox.width),
          modelWidth: Math.round(modelBox.width),
          gap: Math.round(modelBox.left - modeBox.right),
          overlaps: modelBox.left < modeBox.right - 0.5,
          modeContainer: Math.round(modes.clientWidth),
          modeContent: Math.round(modes.scrollWidth),
          clipped: modes.scrollWidth > modes.clientWidth + 1
        };

        /*
         * The same measurement with the longest id an endpoint can hand us.
         *
         * This window has no profile saved, so what is drawn is the placeholder
         * and the pressure on the row is small; the reported bug showed up with a
         * model named by url. The long label is fed through the same element in
         * the same place, because the squeeze that clipped "Agent" into "Ager" is
         * a property of the row's layout, not of where the text came from.
         */
        const longId = 'gpt://b1gpudfqh473jggh7tjp/deepseek-v4.1-flash/latest';
        const picker = modelHost.querySelector('select');
        if (picker) {
          picker.options[0].text = longId;
        } else {
          const standIn = document.createElement('select');
          standIn.className = 'modelbtn';
          standIn.append(new Option(longId, longId));
          modelHost.replaceChildren(standIn);
        }
        await sleep(250);
        const wideModeBox = modeButton.getBoundingClientRect();
        const wideModelBox = modelHost.getBoundingClientRect();
        out.composer.longModel = {
          modeLabel: modeButton.textContent.trim(),
          modeWidth: Math.round(wideModeBox.width),
          modelWidth: Math.round(wideModelBox.width),
          gap: Math.round(wideModelBox.left - wideModeBox.right),
          overlaps: wideModelBox.left < wideModeBox.right - 0.5,
          clipped: modes.scrollWidth > modes.clientWidth + 1
        };
      }

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
      // The button first: the dialog being reachable from a key is not the same
      // thing as it being reachable from the window.
      const settingsButton = q('#statusbar .statusbar__item[data-role="settings"]');
      out.settingsButton = {
        present: Boolean(settingsButton),
        title: settingsButton ? settingsButton.title : '',
        icon: Boolean(settingsButton && settingsButton.querySelector('svg')),
        inTheStatusbar: Boolean(settingsButton && settingsButton.parentElement === q('#statusbar')),
        afterTheThemeButton: Boolean(
          settingsButton && settingsButton.previousElementSibling && settingsButton.previousElementSibling.dataset.role === 'theme'
        )
      };
      if (settingsButton) {
        settingsButton.click();
        await sleep(500);
        out.settingsButton.opened = !q('#settings-overlay').hidden;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        out.settingsButton.closedByEscape = q('#settings-overlay').hidden;
      }

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
        versionLine: text('#settings-body .settings__update .settings__note'),
        // The updates section offers one thing: the page. A download or an
        // install button here is what this measurement exists to catch.
        updateButtons: qa('#settings-body .settings__update button').map((button) => button.textContent.trim())
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
    /*
     * A picture of the row itself.
     *
     * A layout defect is something to look at: the numbers above say whether a
     * box is clipped, and the picture says whether the row reads well. The
     * notifications are cleared first, because a toast sits over exactly this
     * corner of the window and the subject of the picture is the layout.
     */
    const clip = await session.evaluate(`
      for (const toast of document.querySelectorAll('.toast')) toast.remove();
      const box = document.getElementById('composer').getBoundingClientRect();
      return { x: Math.max(0, Math.floor(box.x) - 4), y: Math.max(0, Math.floor(box.y) - 4),
               width: Math.ceil(box.width) + 8, height: Math.ceil(box.height) + 8, scale: 2 };
    `);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(shot, Buffer.from(data, 'base64'));
  } finally {
    child.kill();
  }

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nscreenshot: ${shot}`);

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
  expect(
    report && report.composer.geometry && report.composer.geometry.overlaps === false,
    'the model chooser is drawn over the mode button'
  );
  expect(
    report && report.composer.geometry && report.composer.geometry.clipped === false,
    `the mode button is clipped by its own container (${report && report.composer.geometry ? `${report.composer.geometry.modeContainer}px of ${report.composer.geometry.modeContent}px` : 'no measurement'})`
  );
  expect(
    report && report.composer.geometry && report.composer.geometry.modeLabel.length >= 3,
    'the mode button does not show its label'
  );
  const longModel = report && report.composer ? report.composer.longModel : null;
  expect(Boolean(longModel), 'the long model id case was not measured');
  expect(longModel && longModel.overlaps === false, 'a long model id draws the chooser over the mode button');
  expect(longModel && longModel.clipped === false, 'a long model id clips the mode button');
  expect(longModel && longModel.modeLabel.length >= 3, 'a long model id leaves the mode button without its label');
  expect(longModel && longModel.modelWidth <= 180, `the model chooser grew past its limit (${longModel ? longModel.modelWidth : '?'}px)`);
  expect(report && report.settingsButton.present, 'there is no button for the settings');
  expect(report && report.settingsButton.icon, 'the settings button has no icon');
  expect(report && report.settingsButton.inTheStatusbar, 'the settings button is not in the status bar');
  expect(report && report.settingsButton.opened, 'clicking the settings button did not open the settings');
  expect(report && report.settingsButton.closedByEscape, 'Escape did not close the settings opened from the button');
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
      expect(
        report && report.settings.updateButtons.some((label) => /выпуск|release/i.test(label)),
        'the updates section has no way to reach the release page'
      );
      expect(
        report && !report.settings.updateButtons.some((label) => /скачать|download|установ|install/i.test(label)),
        'the updates section still offers to download or install, which this application does not do'
      );
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