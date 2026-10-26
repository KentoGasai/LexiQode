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