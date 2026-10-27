'use strict';

/**
 * The script that starts the application.
 *
 * It was reported as "does not work, so I build every time", and both causes were
 * mechanical rather than subtle: it preferred a bundle in `dist\` over the sources,
 * so an edit looked as though it had done nothing, and it passed an empty
 * `-ArgumentList` to `Start-Process`, which Windows PowerShell refuses before a
 * window can appear. Neither is visible by reading the script once, and the third
 * failure - a call operator that waits for the window to close - made the terminal
 * look hung. All three are pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const SCRIPT = path.join(APP, '..', 'scripts', 'run-app.ps1');
const source = fs.readFileSync(SCRIPT, 'utf8');
/**
 * The script without its comments.
 *
 * The comments name the mistakes that were fixed - `& $electron .`, the empty
 * argument list - on purpose, because the next person to touch this file should not
 * have to rediscover them. A check for the mistake therefore has to read the code
 * alone.
 */
const code = source
  .split(/\r?\n/)
  .filter((line) => !/^\s*[#<]/.test(line))
  .join('\n');

test('the sources are what starts by default', () => {
  assert.match(source, /\[switch\]\$Bundle/, 'a built bundle needs a switch of its own');
  assert.match(source, /Write-Host 'Starting from the sources'/, 'and the sources are the default');
  assert.ok(
    source.indexOf('if ($Bundle)') < source.indexOf("Write-Host 'Starting from the sources'"),
    'the bundle has to be decided before the default path, or it wins by falling through'
  );
});

test('nothing is invoked in a way that waits for the window to close', () => {
  assert.doesNotMatch(code, /&\s*\$electron/, 'the call operator waits for the process to exit');
  assert.match(code, /Start-Process @start/, 'processes are started, not called');
});

test('an empty argument list is never passed to Start-Process', () => {
  assert.match(code, /\$list\.Count -gt 0/, 'Start-Process rejects an empty ArgumentList');
  assert.doesNotMatch(code, /-ArgumentList \$\w+\s*[\r\n]/, 'the list goes through the one splat');
});

test('the deployed copy is what a deploy starts', () => {
  assert.match(
    source,
    /Starting the deployed copy \$installedExe/,
    'a deploy that never runs the folder it wrote proves nothing about it'
  );
});