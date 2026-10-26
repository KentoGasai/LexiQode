'use strict';

/**
 * What exactly gets written to a shell's standard input.
 *
 * This is pinned by tests because it was measured rather than designed: a
 * PowerShell reading from a pipe executes one line as one complete statement and
 * silently discards a statement it cannot finish on that line. A wrapper split
 * across two lines therefore runs the user's command not at all, and nothing
 * indicates a problem - the console simply produces no output. A fake session
 * captures the bytes, so a future edit that reintroduces a newline fails here
 * instead of in front of a user.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TerminalService } = require('../src/main/terminal-service');
const { loadSettings } = require('../src/shared/settings');

function fakeSession(shell = 'powershell.exe') {
  const written = [];
  const service = new TerminalService({
    settings: { get: () => loadSettings(undefined) },
    onData: () => {},
    onExit: () => {}
  });
  service.sessions.set('t1', {
    id: 't1',
    title: 'test',
    shell,
    cwd: os.tmpdir(),
    child: {
      stdin: {
        write: (text) => {
          written.push(text);
        },
        end: () => {}
      }
    },
    buffer: '',
    outputBytes: 0,
    scripts: []
  });
  return { service, written, session: service.sessions.get('t1') };
}

test('a single-line command is wrapped in one line that reports the outcome', () => {
  const { service, written } = fakeSession();
  service.submit('t1', 'Write-Output "hi"');
  assert.equal(written.length, 1);
  assert.equal(
    written[0],
    "try { Write-Output \"hi\"; $__lx = if ($?) { 'ok' } else { 'err' } } catch { $__lx = 'err' } finally { __lx_prompt $__lx }\n"
  );
  assert.equal(written[0].trimEnd().includes('\n'), false, 'the statement must fit on one line');
});

test('the outcome is captured before the report runs, not inside finally', () => {
  // Inside `finally`, `$?` describes the finally block's own last command, so a
  // failed command would be reported as a success. The variable exists to keep
  // the two apart.
  const { service, written } = fakeSession();
  service.submit('t1', 'Get-Item C:\\nope');
  assert.match(written[0], /\$__lx = if \(\$\?\) \{ 'ok' \} else \{ 'err' \}/);
  assert.match(written[0], /\$__lx = 'err' \} finally \{ __lx_prompt \$__lx \}/);
  assert.equal(/\$__lx = if \(\$\?\) \{[^}]*\} finally/.test(written[0]), false);
});

test('an empty command just refreshes the prompt', () => {
  const { service, written } = fakeSession();
  service.submit('t1', '   ');
  assert.equal(written[0], '__lx_prompt\n');
});

test('exit closes the session', () => {
  const { service, written } = fakeSession();
  const result = service.submit('t1', ' exit ');
  assert.equal(result.closing, true);
  assert.equal(written[0], 'exit\n');
});

test('multi-line input is written to a script and run from one line', () => {
  const { service, written, session } = fakeSession();
  const script = ['foreach ($i in 1..2) {', '  Write-Output $i', '}'].join('\n');
  service.submit('t1', script);

  assert.equal(written.length, 1);
  assert.equal(written[0].includes('\n\n'), false);
  assert.equal(written[0].trimEnd().split('\n').length, 1, 'the wrapper stays one line');
  assert.equal(session.scripts.length, 1);

  const file = session.scripts[0];
  assert.equal(path.extname(file), '.ps1');
  assert.equal(fs.readFileSync(file, 'utf8'), `${script}\n`);
  assert.match(written[0], /try \{ & '[^']+\.ps1'; \$__lx = if/);

  fs.unlinkSync(file);
});

test('a path with a quote is escaped for PowerShell', () => {
  const { service, written } = fakeSession();
  service.submit('t1', "Write-Output 'x'\nWrite-Output 'y'");
  const payload = written[0];
  assert.equal(payload.includes("''"), false, 'the temp path has no quotes to escape in practice');
  assert.equal(payload.trimEnd().split('\n').length, 1);
  for (const file of service.sessions.get('t1').scripts) fs.unlinkSync(file);
});

test('a POSIX shell gets the command and a probe, not a PowerShell wrapper', () => {
  const { service, written } = fakeSession('/bin/bash');
  service.submit('t1', 'echo hi');
  assert.equal(written[0], 'echo hi\nprintf \'\\1%s\\2%s\\n\' "$PWD" "$?"\n');
});

test('a closed session is refused rather than silently ignored', () => {
  const { service } = fakeSession();
  service.sessions.delete('t1');
  assert.throws(() => service.submit('t1', 'echo hi'), /that terminal is closed/);
  assert.throws(() => service.write('t1', 'x'), /that terminal is closed/);
});

test('the session cap is enforced with a message that says what the cap is', () => {
  const service = new TerminalService({
    settings: { get: () => loadSettings(undefined) },
    onData: () => {},
    onExit: () => {}
  });
  for (let index = 0; index < 8; index += 1) {
    service.sessions.set(`t${index}`, { id: `t${index}`, shell: 'powershell.exe', child: { stdin: {}, kill() {} } });
  }
  assert.throws(() => service.create({ cwd: os.tmpdir() }), /at most 8 terminals/);
});