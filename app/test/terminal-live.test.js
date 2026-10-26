'use strict';

/**
 * The terminal, driven for real against a real shell.
 *
 * This is the one assumption in the app that cannot be settled by reading code:
 * whether a PowerShell started with `-NoExit -Command -` keeps a session alive
 * when its standard input is a pipe, executes each line as it arrives, and lets
 * `cd` persist. The unit tests cover how the report is parsed; this covers that
 * a shell actually reports.
 *
 * Skipped where PowerShell does not exist, so the suite stays honest on Linux
 * and macOS rather than passing while testing nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { TerminalService } = require('../src/main/terminal-service');
const { loadSettings } = require('../src/shared/settings');

const isWindows = process.platform === 'win32';

function waitFor(predicate, { timeout = 15000, interval = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('timed out waiting for the shell'));
      }
    }, interval);
  });
}

test('a piped PowerShell session survives, runs commands and keeps its folder', { skip: !isWindows }, async (t) => {
  const events = [];
  const service = new TerminalService({
    settings: { get: () => loadSettings(undefined) },
    onData: (event) => events.push(event),
    onExit: (event) => events.push({ exit: event })
  });

  const start = os.tmpdir();
  const session = service.create({ cwd: start });
  t.after(() => service.killAll());
  assert.equal(session.pty, false);

  const prompts = () => events.filter((event) => event.prompt);
  await waitFor(() => prompts().length >= 1);
  // The first report is the startup one: it carries the code page the shell
  // ended up with, which is what the reader decodes the rest of the session
  // with, and it is reported as informational rather than as a command outcome.
  assert.equal(prompts()[0].prompt.status, 'info');
  assert.equal(typeof prompts()[0].prompt.encoding, 'string');
  assert.ok(prompts()[0].prompt.encoding.length > 0);

  // A command's output and a fresh report both have to come back.
  const before = prompts().length;
  service.submit(session.id, 'Write-Output "lexiqode-hello"');
  await waitFor(() => events.some((event) => typeof event.data === 'string' && event.data.includes('lexiqode-hello')));
  await waitFor(() => prompts().length > before);

  // `cd` has to persist, which is the whole reason for a session over pipes.
  const cwdBefore = prompts().at(-1).prompt.cwd;
  service.submit(session.id, 'Set-Location $env:TEMP\\..');
  const moved = await waitFor(() => {
    const last = prompts().at(-1).prompt;
    return last.cwd && last.cwd !== cwdBefore ? last : null;
  });
  assert.notEqual(moved.cwd, cwdBefore);

  // A failing command must still report, or the console would look dead.
  const beforeFailure = prompts().length;
  service.submit(session.id, 'Get-Item C:\\definitely-not-here-lexiqode');
  await waitFor(() => prompts().length > beforeFailure);
  assert.equal(prompts().at(-1).prompt.status, 'err');
});

test('a command that is only whitespace refreshes the prompt without failing', { skip: !isWindows }, async (t) => {
  const events = [];
  const service = new TerminalService({
    settings: { get: () => loadSettings(undefined) },
    onData: (event) => events.push(event),
    onExit: () => {}
  });
  const session = service.create({ cwd: os.tmpdir() });
  t.after(() => service.killAll());

  await waitFor(() => events.filter((event) => event.prompt).length >= 1);
  const before = events.filter((event) => event.prompt).length;
  service.submit(session.id, '   ');
  await waitFor(() => events.filter((event) => event.prompt).length > before);
  assert.equal(events.at(-1).prompt.status, 'ok');
});