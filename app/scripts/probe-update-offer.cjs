/**
 * Does the window offer a download when a newer release exists?
 *
 * This one is a network probe on purpose: it points the update check at a public
 * repository with releases and expects a newer one, so it needs GitHub to be
 * reachable. It is run by hand, not by the suite, and it never downloads
 * anything - it stops at the offer.
 *
 * Run: node scripts/probe-update-offer.cjs [owner/name]
 */

const { connect, listTargets, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9341);
const REPO = process.argv[2] || 'cli/cli';

async function main() {
  const child = startApp({ port: PORT, tag: 'update-offer' });
  console.log(`isolated configuration: ${child.configDir}`);
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);
    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // Point the check at a repository that certainly has releases.
      await window.lexiqode.settings.update({ updates: { repo: ${JSON.stringify(REPO)}, checkOnStart: false } });
      const state = await window.lexiqode.update.check({ force: true });
      await sleep(600);
      const overlay = document.getElementById('update-overlay');
      return {
        phase: state.phase,
        version: state.version,
        asset: state.asset ? state.asset.name : null,
        message: state.message || '',
        promptVisible: !overlay.hidden,
        promptText: overlay.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
        buttons: [...overlay.querySelectorAll('button')].map((node) => node.textContent.trim()),
        progressBars: overlay.querySelectorAll('.settings__progress').length
      };
    `);
    console.log(JSON.stringify(report, null, 2));
    const ok =
      report.promptVisible &&
      report.phase === 'available' &&
      report.promptText.includes(report.version || '') &&
      report.buttons.length >= 2;
    if (!ok) {
      console.error('the offer was not shown as expected');
      process.exitCode = 1;
      return;
    }
    console.log('the offer was shown, with the version and a way to act on it');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});