'use strict';

/**
 * The one line the transcript shows for a tool call.
 *
 * The regression this exists for is not a crash: the panel rendered every tool
 * row as `read_file [object Object]`, because the arguments arrive as an object
 * and were concatenated into a string. It looked like a working row and said
 * nothing about what the agent touched, which is the kind of fault that survives
 * a whole release.
 *
 * The module under test is the window's own copy, imported dynamically because
 * the renderer directory is an ES module package.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = '../src/renderer/js/tool-arguments.js';

test('tool call summaries', async (t) => {
  const { describeArguments, formatTokens } = await import(MODULE);

  await t.test('an object of arguments never becomes [object Object]', () => {
    const rendered = describeArguments('read_file', { path: 'core/lexiqode/config.py' });
    assert.equal(rendered, 'core/lexiqode/config.py');
    assert.doesNotMatch(rendered, /\[object/i);
  });

  await t.test('the interesting field comes first, whatever order it was sent in', () => {
    assert.equal(describeArguments('glob', { limit: 50, pattern: '**/*.py' }), '**/*.py limit=50');
    assert.equal(
      describeArguments('run_command', { command: 'python -m pytest -q', cwd: 'core' }),
      'python -m pytest -q cwd=core'
    );
  });

  await t.test('a line range reads as part of the file it belongs to', () => {
    assert.equal(
      describeArguments('read_file', { path: 'app.js', start_line: 10, end_line: 40 }),
      'app.js:10-40'
    );
    assert.equal(describeArguments('read_file', { path: 'app.js', end_line: 40 }), 'app.js:1-40');
  });

  await t.test('a field holding a document is measured, not printed', () => {
    const rendered = describeArguments('write_file', { path: 'a.js', content: 'x'.repeat(5000) });
    assert.equal(rendered, 'a.js content=5000 chars');
    assert.ok(rendered.length < 40, 'the row must stay one line');
  });

  await t.test('unknown tools fall back to their own field names', () => {
    assert.equal(describeArguments('mystery', { alpha: 1, beta: 'two' }), 'alpha=1 beta=two');
    assert.equal(
      describeArguments('mystery', { nested: { a: 1 }, list: [1, 2] }),
      'nested={…} list=[…]'
    );
  });

  await t.test('nothing to say is the empty string, not punctuation', () => {
    assert.equal(describeArguments('read_file', {}), '');
    assert.equal(describeArguments('read_file', null), '');
    assert.equal(describeArguments('read_file', undefined), '');
    assert.equal(describeArguments('read_file', { path: '' }), '');
    assert.equal(describeArguments('read_file', []), '');
  });

  await t.test('a long value is clipped to the limit it was given', () => {
    const rendered = describeArguments('grep', { pattern: 'y'.repeat(400) }, { limit: 40 });
    assert.ok(rendered.length <= 40, `${rendered.length} characters`);
    assert.ok(rendered.endsWith('…'));
  });

  await t.test('token counts are grouped so they can be read at a glance', () => {
    assert.equal(formatTokens(128000), '128 000');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(12500), '12 500');
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(undefined), '0');
    assert.equal(formatTokens(-5), '0');
    assert.equal(formatTokens(1234.6), '1 235');
  });
});

test('the command a call ran, whole', async (t) => {
  const { commandOf, describeArguments } = await import(MODULE);

  await t.test('a command is returned unclipped, unlike the one-line summary', () => {
    // The summary clips at 120 characters, which is right for a row and wrong
    // for the thing the reader opened the row to see: a truncated command cannot
    // be checked and cannot be copied.
    const command = `cd core && python -m pytest tests -q ${'--verbose '.repeat(30)}`.trim();
    assert.ok(command.length > 120, 'the fixture must be longer than the summary limit');
    assert.equal(commandOf('run_command', { command }), command);
    assert.ok(describeArguments('run_command', { command }).length <= 120);
  });

  await t.test('a multi-line command keeps its lines', () => {
    const command = 'cd core\npython -m pytest tests -q\ncd ..';
    assert.equal(commandOf('run_command', { command }), command);
  });

  await t.test('every other tool has no command', () => {
    assert.equal(commandOf('read_file', { path: 'a.txt' }), '');
    assert.equal(commandOf('write_file', { path: 'a.txt', content: 'x' }), '');
    assert.equal(commandOf('grep', { pattern: 'x' }), '');
  });

  await t.test('a missing or malformed command is empty, not "undefined"', () => {
    assert.equal(commandOf('run_command', {}), '');
    assert.equal(commandOf('run_command', null), '');
    assert.equal(commandOf('run_command', undefined), '');
    assert.equal(commandOf('run_command', { command: 42 }), '');
    assert.equal(commandOf('run_command', { command: '   ' }), '');
  });

  await t.test('a command sent as a bare string is still a command', () => {
    assert.equal(commandOf('run_command', 'ls -la'), 'ls -la');
  });
});