'use strict';

/**
 * The direction a boundary moves.
 *
 * The chat sits against the right edge and the terminal panel against the
 * bottom, so dragging their handles towards the middle of the window is what
 * makes them bigger. That sign was wrong once and made the chat shrink as it was
 * being enlarged, which is why the arithmetic lives in a function with tests
 * rather than inline in a pointer handler no test can reach.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextSize } = require('../src/renderer/js/split.js');

test('a panel anchored on the left grows when its handle moves right', () => {
  assert.equal(nextSize({ origin: 260, delta: 40, min: 140, max: 900 }), 300);
  assert.equal(nextSize({ origin: 260, delta: -40, min: 140, max: 900 }), 220);
});

test('a panel anchored on the right grows when its handle moves left', () => {
  const chat = { origin: 420, delta: -60, invert: true, min: 260, max: 1400 };
  assert.equal(nextSize(chat), 480);
  assert.equal(nextSize({ ...chat, delta: 60 }), 360);
});

test('a panel anchored at the bottom grows when its handle moves up', () => {
  const panel = { origin: 220, delta: -60, invert: true, min: 60, max: 900 };
  assert.equal(nextSize(panel), 280);
  assert.equal(nextSize({ ...panel, delta: 60 }), 160);
});

test('a boundary never leaves its bounds, however far the pointer goes', () => {
  assert.equal(nextSize({ origin: 260, delta: 5000, min: 140, max: 900 }), 900);
  assert.equal(nextSize({ origin: 260, delta: -5000, min: 140, max: 900 }), 140);
  assert.equal(nextSize({ origin: 420, delta: -5000, invert: true, min: 260, max: 1400 }), 1400);
  assert.equal(nextSize({ origin: 420, delta: 5000, invert: true, min: 260, max: 1400 }), 260);
});

test('a fractional size is rounded, not left as a fraction of a pixel', () => {
  assert.equal(nextSize({ origin: 260.4, delta: 0, min: 0, max: 900 }), 260, 'down, below a half');
  assert.equal(nextSize({ origin: 260.6, delta: 0, min: 0, max: 900 }), 261, 'up, above a half');
  assert.equal(nextSize({ origin: 260.3, delta: 0.5, min: 0, max: 900 }), 261, 'the sum is what rounds');
});

test('a size that is already inside its bounds is left alone', () => {
  assert.equal(nextSize({ origin: 420, delta: 0, min: 260, max: 1400 }), 420);
});