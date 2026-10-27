'use strict';

/**
 * The command that runs a file.
 *
 * This is the one part of the run button that can be wrong without anyone
 * noticing until they press it: a path quoted for the wrong shell, a `cd` that is
 * missing, an interpreter invented for a language this application knows nothing
 * about. Each of those produces a command that fails in the terminal for a reason
 * that looks like the file's fault, so the strings are pinned here.
 *
 * The module is a window module (an ES module), so it is imported the way the
 * window imports it rather than by rewriting it for Node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.resolve(__dirname, '..', 'src', 'renderer', 'js', 'run.js')).href;

let runPromise = null;
function run() {
  if (!runPromise) runPromise = import(MODULE);
  return runPromise;
}

const WINDOWS = 'win32';

test('a JavaScript file is run by node, in the folder the shell assumes', async () => {
  const { commandFor } = await run();
  const plan = commandFor('C:\\work\\src\\app.js', { shell: 'powershell.exe', root: 'C:\\work', platform: WINDOWS });
  assert.equal(plan.interpreter, 'node');
  assert.equal(plan.relative, 'src/app.js');
  assert.equal(plan.command, "Set-Location -LiteralPath 'C:\\work'; node 'src/app.js'");
});

test('a file outside the open folder is named as it is', async () => {
  const { commandFor } = await run();
  const plan = commandFor('C:\\other\\tool.py', { shell: 'powershell.exe', root: 'C:\\work', platform: WINDOWS });
  assert.equal(plan.relative, '');
  assert.equal(plan.command, "Set-Location -LiteralPath 'C:\\work'; python 'C:\\other\\tool.py'");
});

test('a path with a space survives every shell it can be sent to', async () => {
  const { commandFor } = await run();
  const powershell = commandFor('C:\\my work\\a b.js', { shell: 'powershell.exe', root: 'C:\\my work', platform: WINDOWS });
  assert.equal(powershell.command, "Set-Location -LiteralPath 'C:\\my work'; node 'a b.js'");
  const cmd = commandFor('C:\\my work\\a b.js', { shell: 'cmd.exe', root: 'C:\\my work', platform: WINDOWS });
  assert.equal(cmd.command, 'cd /d "C:\\my work" && node "a b.js"');
  const posix = commandFor('/home/me/my work/a b.js', { shell: '/bin/bash', root: '/home/me/my work', platform: 'linux' });
  assert.equal(posix.command, "cd '/home/me/my work' && node 'a b.js'");
});

test('a quote in a name is escaped for the shell that receives it', async () => {
  const { commandFor } = await run();
  const powershell = commandFor("C:\\work\\it's.js", { shell: 'powershell.exe', root: 'C:\\work', platform: WINDOWS });
  assert.match(powershell.command, /node 'it''s\.js'$/);
  const posix = commandFor("/home/me/it's.js", { shell: '/bin/bash', root: '/home/me', platform: 'linux' });
  assert.equal(posix.command, "cd '/home/me' && node 'it'\\''s.js'");
});

test('an empty shell setting means the platform default', async () => {
  const { commandFor, shellKind } = await run();
  assert.equal(shellKind('', WINDOWS), 'powershell');
  assert.equal(shellKind('', 'linux'), 'posix');
  assert.equal(shellKind('C:\\Windows\\System32\\cmd.exe', WINDOWS), 'cmd');
  assert.equal(shellKind('/bin/bash', 'linux'), 'posix');
});

test('every language this application runs has its own interpreter', async () => {
  const { commandFor } = await run();
  const cases = [
    ['a.js', 'node'],
    ['a.mjs', 'node'],
    ['a.cjs', 'node'],
    ['a.py', 'python'],
    ['a.sh', 'bash']
  ];
  for (const [file, interpreter] of cases) {
    const plan = commandFor(file, { shell: 'powershell.exe', platform: WINDOWS });
    assert.equal(plan && plan.interpreter, interpreter, `${file} should be run by ${interpreter}`);
  }
  // Shell scripts get their own interpreter, not the one that happens to be able
  // to load them.
  assert.match(commandFor('deploy.ps1', { shell: 'powershell.exe', platform: WINDOWS }).command, /powershell -NoProfile -ExecutionPolicy Bypass -File/);
  assert.match(commandFor('build.bat', { shell: 'powershell.exe', platform: WINDOWS }).command, /cmd \/c/);
  assert.match(commandFor('build.cmd', { shell: 'powershell.exe', platform: WINDOWS }).command, /cmd \/c/);
});

test('a language this application cannot run is refused, not guessed at', async () => {
  const { commandFor } = await run();
  assert.equal(commandFor('Gemfile.rb', { shell: 'powershell.exe', platform: WINDOWS }), null);
  assert.equal(commandFor('Main.java', { shell: 'powershell.exe', platform: WINDOWS }), null);
  assert.equal(commandFor('LICENSE', { shell: 'powershell.exe', platform: WINDOWS }), null);
  assert.equal(commandFor('.gitignore', { shell: 'powershell.exe', platform: WINDOWS }), null);
  assert.equal(commandFor('', { shell: 'powershell.exe', platform: WINDOWS }), null);
  assert.equal(commandFor(undefined), null);
});

test('the extension is read however it is spelled', async () => {
  const { commandFor } = await run();
  assert.equal(commandFor('SCRIPT.PY', { shell: 'powershell.exe', platform: WINDOWS }).interpreter, 'python');
  assert.equal(commandFor('C:\\work\\App.JS', { shell: '/bin/bash', root: 'C:\\work', platform: 'linux' }).interpreter, 'node');
});