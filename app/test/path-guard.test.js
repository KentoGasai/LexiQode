'use strict';

/**
 * The path guard is the only thing standing between a string the renderer sent
 * and the filesystem, so it is tested the way it can fail: by spelling traversal
 * in the ways a person or a program actually would.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isInside, resolveInside, toRelative, assertSimpleName, likelyBinaryByName, looksBinaryBuffer } = require(
  '../src/shared/path-guard'
);

const ROOT = path.resolve('C:/work/project');

test('a folder contains itself and what is under it', () => {
  assert.equal(isInside(ROOT, ROOT), true);
  assert.equal(isInside(ROOT, path.join(ROOT, 'src', 'a.js')), true);
  assert.equal(isInside(ROOT, path.join(ROOT, '..', 'project2')), false);
  assert.equal(isInside('', ROOT), false);
});

test('traversal is judged by where it lands, not by how it was written', () => {
  assert.equal(resolveInside(ROOT, 'src/a.js'), path.join(ROOT, 'src', 'a.js'));
  assert.equal(resolveInside(ROOT, './src/../src/a.js'), path.join(ROOT, 'src', 'a.js'));
  assert.throws(() => resolveInside(ROOT, '../secrets.txt'), /outside the open folder/);
  assert.throws(() => resolveInside(ROOT, 'src/../../secrets.txt'), /outside the open folder/);
  assert.throws(() => resolveInside(ROOT, 'C:/Windows/system32/cmd.exe'), /outside the open folder/);
});

test('an absolute path inside the folder is accepted', () => {
  assert.equal(resolveInside(ROOT, path.join(ROOT, 'a.txt')), path.join(ROOT, 'a.txt'));
});

test('missing arguments are refused rather than defaulted', () => {
  assert.throws(() => resolveInside('', 'a.txt'), /no folder is open/);
  assert.throws(() => resolveInside(ROOT, ''), /a path is required/);
  assert.throws(() => resolveInside(ROOT, undefined), /a path is required/);
});

test('relative paths use forward slashes so the renderer sees one spelling', () => {
  assert.equal(toRelative(ROOT, path.join(ROOT, 'src', 'deep', 'a.js')), 'src/deep/a.js');
});

test('a name has to be one segment and one the filesystem accepts', () => {
  assert.equal(assertSimpleName('notes.md'), 'notes.md');
  assert.equal(assertSimpleName('a b.txt'), 'a b.txt');
  assert.throws(() => assertSimpleName(''), /a name is required/);
  assert.throws(() => assertSimpleName('a/b.txt'), /path separator/);
  assert.throws(() => assertSimpleName('a\\b.txt'), /path separator/);
  assert.throws(() => assertSimpleName('..'), /not allowed/);
  assert.throws(() => assertSimpleName('a:b'), /filesystem rejects/);
  assert.throws(() => assertSimpleName('a\u0000b'), /filesystem rejects/);
});

test('binary detection does not call an svg binary', () => {
  assert.equal(likelyBinaryByName('logo.png'), true);
  assert.equal(likelyBinaryByName('app.exe'), true);
  assert.equal(likelyBinaryByName('logo.svg'), false);
  assert.equal(likelyBinaryByName('main.js'), false);
  assert.equal(likelyBinaryByName('LICENSE'), false);
});

test('a NUL byte marks a file as binary even without a telling extension', () => {
  assert.equal(looksBinaryBuffer(Buffer.from('plain text\n')), false);
  assert.equal(looksBinaryBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x01])), true);
  assert.equal(looksBinaryBuffer(Buffer.alloc(0)), false);
});

test('only the first few kilobytes are inspected', () => {
  const buffer = Buffer.concat([Buffer.from('x'.repeat(9000)), Buffer.from([0])]);
  assert.equal(looksBinaryBuffer(buffer), false);
});