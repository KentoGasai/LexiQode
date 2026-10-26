'use strict';

/**
 * A pipe delivers arbitrary chunk boundaries, so every case here is about a
 * marker that arrives in pieces. Getting this wrong is not subtle in use: the
 * prompt either freezes at the folder the session started in, or control
 * characters leak into the panel as visible garbage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { START, END, consume } = require('../src/shared/console-text');

const marker = (cwd, status) => `${START}${cwd}${END}${status}\r\n`;

test('output before a marker is returned and the marker becomes a report', () => {
  const result = consume('', `hello\r\n${marker('C:/work', 'ok')}`);
  assert.equal(result.output, 'hello\r\n');
  assert.deepEqual(result.reports, [{ cwd: 'C:/work', status: 'ok' }]);
  assert.equal(result.rest, '');
});

test('a marker split across two chunks is held back, not printed', () => {
  const first = consume('', `${START}C:/wo`);
  assert.equal(first.output, '');
  assert.equal(first.reports.length, 0);
  assert.equal(first.rest, `${START}C:/wo`);

  const second = consume(first.rest, `rk${END}ok\r\n`);
  assert.equal(second.output, '');
  assert.deepEqual(second.reports, [{ cwd: 'C:/work', status: 'ok' }]);
  assert.equal(second.rest, '');
});

test('a marker whose status word has not arrived yet is also held back', () => {
  const first = consume('', `${START}C:/work${END}o`);
  assert.equal(first.reports.length, 0);
  assert.equal(first.output, '');
  const second = consume(first.rest, 'k\r\n');
  assert.deepEqual(second.reports, [{ cwd: 'C:/work', status: 'ok' }]);
});

test('several markers in one chunk are all reported, in order', () => {
  const result = consume('', `${marker('C:/a', 'ok')}${marker('C:/b', 'err')}`);
  assert.deepEqual(result.reports, [
    { cwd: 'C:/a', status: 'ok' },
    { cwd: 'C:/b', status: 'err' }
  ]);
  assert.equal(result.output, '');
});

test('output between two markers is preserved in place', () => {
  const result = consume('', `${marker('C:/a', 'ok')}result line\r\n${marker('C:/a', 'ok')}`);
  assert.equal(result.output, 'result line\r\n');
  assert.equal(result.reports.length, 2);
});

test('text with no marker at all is output and is not buffered', () => {
  const result = consume('', 'just output\n');
  assert.equal(result.output, 'just output\n');
  assert.equal(result.rest, '');
  assert.equal(result.reports.length, 0);
});

test('a lone start character at the end of a chunk waits for the rest', () => {
  const result = consume('', `text${START}`);
  assert.equal(result.output, 'text');
  assert.equal(result.rest, START);
});

test('a real control character in output is not confused with a marker', () => {
  // A file name with a stray \u0002 must not be able to forge a report: it has
  // no start marker and no newline-terminated status, so it stays output.
  const result = consume('', 'a\u0002b\n');
  assert.equal(result.output, 'a\u0002b\n');
  assert.equal(result.reports.length, 0);
});
