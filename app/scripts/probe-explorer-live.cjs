/**
 * The explorer follows the disk, and a right-click opens a real menu.
 *
 * Two faults are checked here, both of the kind that only appear in a running
 * window.
 *
 * The tree used to be redrawn only after the window's own buttons. A file
 * created by a build, a `git checkout`, another editor or the agent through the
 * core never appeared, and the only way to see it was the Refresh button - which
 * is the wrong way to find out that a file exists. This probe writes a file from
 * outside the application and waits for the tree to show it.
 *
 * A right-click used to open a browser prompt with a numbered list. What it has
 * to be is a menu: it appears where the pointer is, offers the actions of an
 * editor, and closes on Escape.
 *
 * The folder it works in is a temporary directory of its own, so the probe never
 * writes into the project it was pointed at.
 *
 *   node scripts/probe-explorer-live.cjs
 *   $env:LEXIQODE_PROBE_EXE='...\LexiQode.exe'; node scripts/probe-explorer-live.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, startApp, listTargets, connect, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9351);

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-explorer-'));
  fs.writeFileSync(path.join(folder, 'first.txt'), 'first\n', 'utf8');
  const noise = [];
  const child = startApp({
    port: PORT,
    tag: 'explorer',
    onLine: (line) => noise.push(line.slice(0, 200))
  });
  console.log(`isolated configuration: ${child.configDir}`);
  console.log(`folder under test: ${folder}`);

  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);

    const setup = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.lexiqode.workspace.open(${JSON.stringify(folder)});
      const rows = () =>
        [...document.querySelectorAll('.tree__row')].map((row) => row.dataset.path);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (rows().length) break;
        await sleep(250);
      }
      return { rows: rows() };
    `);
    console.log(`\n--- the folder is shown\n${JSON.stringify(setup, null, 2)}`);

    // A file written by something that is not this window.
    fs.writeFileSync(path.join(folder, 'written-from-outside.txt'), 'x\n', 'utf8');

    const afterWrite = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = () =>
        [...document.querySelectorAll('.tree__row')].map((row) => row.dataset.path);
      const started = Date.now();
      let appeared = false;
      // No Refresh is pressed: the point is that nothing has to be pressed.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (rows().includes('written-from-outside.txt')) {
          appeared = true;
          break;
        }
        await sleep(250);
      }
      return { appeared, waitedMs: Date.now() - started, rows: rows() };
    `);
    console.log(`\n--- a file created outside the application\n${JSON.stringify(afterWrite, null, 2)}`);

    // The context menu, on a file this time.
    const menu = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = [...document.querySelectorAll('.tree__row')].find(
        (entry) => entry.dataset.path === 'first.txt'
      );
      if (!row) return { failed: 'the file row is not in the tree' };
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }));
      await sleep(250);
      const node = document.querySelector('.ctxmenu');
      if (!node) return { open: false };
      const items = [...node.querySelectorAll('.ctxmenu__item')].map((item) => item.textContent.trim());
      const box = node.getBoundingClientRect();
      const blocked = node.querySelectorAll('.ctxmenu__item[disabled]').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(150);
      return {
        open: true,
        items,
        disabled: blocked,
        insideWindow:
          box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
        atPointer: Math.abs(box.left - 80) < 40 && Math.abs(box.top - 90) < 40,
        closedWithEscape: !document.querySelector('.ctxmenu')
      };
    `);
    console.log(`\n--- the right-click menu on a file\n${JSON.stringify(menu, null, 2)}`);

    // Empty space: the folder's own menu.
    const rootMenu = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const host = document.getElementById('sidebar-body');
      host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 400 }));
      await sleep(250);
      const node = document.querySelector('.ctxmenu');
      const items = node
        ? [...node.querySelectorAll('.ctxmenu__item')].map((item) => item.textContent.trim())
        : [];
      if (node) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { open: Boolean(node), items };
    `);
    console.log(`\n--- the right-click menu on empty space\n${JSON.stringify(rootMenu, null, 2)}`);
  } finally {
    child.kill();
    await sleep(800);
    fs.rmSync(folder, { recursive: true, force: true });
  }

  console.log('\n=== what the application logged ===');
  const interesting = noise.filter((line) => /error|refused|failed|Traceback|\[workspace\]/i.test(line));
  console.log(interesting.length ? [...new Set(interesting)].slice(0, 20).join('\n') : '(none)');
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});