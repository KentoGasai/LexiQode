/**
 * A person told about a new version must be able to reach it.
 *
 * This is a network probe on purpose: it points the check at a public repository
 * that certainly has releases, so the outcome is a real offer rather than a stub
 * answering a stub. It runs by hand, not in the suite, and it fetched nothing
 * from the release: the whole update path is one request that reads a version, so
 * there is nothing else to fetch.
 *
 * What it measures, in the order a person would meet it: the window has no
 * download and no install to offer; a newer version is found and the offer
 * appears; the override says where to get it; and the window can actually reach
 * its browser - proved by the main process refusing a target that is not a page,
 * because the page it opens goes down that same channel. The click itself is not
 * performed: opening a browser is not something a probe should do to the person
 * running it.
 *
 * Run: node scripts/probe-update-offer.cjs [owner/name]
 */

const { connect, listTargets, startApp, waitForDom } = require('./probe-harness.cjs');

const PORT = Number(process.env.LEXIQODE_PROBE_PORT || 9344);
const REPO = process.argv[2] || 'cli/cli';

async function main() {
  const child = startApp({ port: PORT, tag: 'update-offer', onLine: (line) => console.log(`[app] ${line}`) });
  console.log(`isolated configuration: ${child.configDir}`);
  try {
    const target = await listTargets(PORT);
    const session = await connect(target.webSocketDebuggerUrl);
    await waitForDom(session);
    const report = await session.evaluate(`
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.lexiqode.update;
      const surface = {
        hasCheck: typeof api.check,
        hasState: typeof api.state,
        download: typeof api.download,
        install: typeof api.install
      };

      // Point the check at a repository that certainly has releases, and keep it
      // from running at startup so this is the only check in the run.
      await window.lexiqode.settings.update({ updates: { repo: ${JSON.stringify(REPO)}, checkOnStart: false } });
      const state = await api.check({ force: true });
      await sleep(600);

      const overlay = document.getElementById('update-overlay');
      const text = overlay.textContent.replace(/\\s+/g, ' ').trim();
      const buttons = [...overlay.querySelectorAll('button')].map((node) => node.textContent.trim());

      // The channel the override uses. A page is https, so it satisfies the same
      // guard that refuses this one - which is what makes the refusal evidence
      // that the channel works rather than evidence that it is missing.
      let refusal = '';
      try {
        await window.lexiqode.shell.openExternal('file:///not-a-page');
      } catch (error) {
        refusal = error.message;
      }

      // Slashes are not escaped in this template literal on purpose: a backslash
      // before a slash disappears when the literal is built, and it disappears
      // inside a regular expression too - which is how this first arrived as
      // "Invalid regular expression flags" rather than as a measurement.
      const page = String(state.url || state.page || '');
      return {
        surface,
        phase: state.phase,
        version: state.version || '',
        current: state.current || '',
        page,
        pageIsPublished: page.startsWith('https://'),
        promptVisible: !overlay.hidden,
        promptText: text.slice(0, 260),
        buttons,
        progressBars: overlay.querySelectorAll('.settings__progress').length,
        openExternalRefused: refusal
      };
    `);
    console.log(JSON.stringify(report, null, 2));

    const problems = [];
    if (report.surface.download !== 'undefined' || report.surface.install !== 'undefined') {
      problems.push('the window still offers a download or an install');
    }
    if (report.surface.hasCheck !== 'function' || report.surface.hasState !== 'function') {
      problems.push('the window cannot ask for the state or for a check');
    }
    if (report.phase !== 'available' || !report.version) problems.push('no newer release was offered');
    if (!report.promptVisible) problems.push('the offer was not put on the screen');
    if (!report.version || !report.promptText.includes(report.version)) {
      problems.push('the offer does not name the version');
    }
    if (!report.pageIsPublished) problems.push('the offer carries no page to visit');
    if (!report.buttons.some((label) => /release|выпуск/i.test(label))) problems.push('the offer has no way to reach the page');
    if (!/http/i.test(report.openExternalRefused)) problems.push('the browser channel did not answer at all');

    if (problems.length) {
      console.error(`the offer was not as expected: ${problems.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('the offer names the version, carries its page, and offers nothing that could replace this application');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exitCode = 1;
});