/**
 * Drive the real TerminalService and print every event with a timestamp.
 *
 * The first live test never reported why it did not finish, because the test
 * runner's output was piped through a command that buffers to end of stream and
 * the spawned shells kept the process alive. This prints as it goes and exits
 * deliberately, so the sequence - shell started, preamble executed, prompt
 * reported, command output, folder changed - is visible instead of inferred.
 */

const os = require('node:os');

const { TerminalService } = require('../src/main/terminal-service');
const { loadSettings } = require('../src/shared/settings');

const started = Date.now();
const stamp = () => `+${String(Date.now() - started).padStart(5)}ms`;

/**
 * The console this probe prints into is itself a legacy-code-page console, so
 * looking at Russian text here cannot tell correct decoding from broken
 * decoding. Counting the character classes can: correctly decoded Cyrillic is
 * letters, and wrongly decoded Cyrillic is box-drawing characters.
 */
const verdict = (text) => {
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const box = (text.match(/[\u2500-\u257f]/g) || []).length;
  return `cyrillic=${cyrillic} box-drawing=${box}`;
};

const service = new TerminalService({
  settings: { get: () => loadSettings(undefined) },
  onData: (event) => {
    if (event.prompt) {
      console.log(`${stamp()} REPORT status=${event.prompt.status} encoding=${event.prompt.encoding} cwd=${event.prompt.cwd}`);
    } else {
      console.log(`${stamp()} OUTPUT ${verdict(event.data)} ${JSON.stringify(event.data.slice(0, 90))}`);
    }
  },
  onExit: (event) => console.log(`${stamp()} EXIT code=${event.code}`)
});

console.log(`${stamp()} starting a session in ${os.tmpdir()}`);
const session = service.create({ cwd: os.tmpdir() });
console.log(`${stamp()} session ${session.id} shell=${session.shell}`);

const steps = [
  [1500, () => service.submit(session.id, 'Write-Output "hello-from-probe"')],
  [4000, () => service.submit(session.id, 'Set-Location C:\\Windows; Get-Location')],
  [6500, () => service.submit(session.id, 'Get-Item C:\\definitely-not-here-lexiqode')],
  [9000, () => service.submit(session.id, '   ')],
  [
    11000,
    () => {
      console.log(`${stamp()} killing the session`);
      console.log(`${stamp()} kill result ${JSON.stringify(service.kill(session.id))}`);
    }
  ],
  [
    13000,
    () => {
      console.log(`${stamp()} remaining sessions: ${service.list().length}`);
      console.log(`${stamp()} done`);
      process.exit(0);
    }
  ]
];

for (const [delay, action] of steps) setTimeout(action, delay);