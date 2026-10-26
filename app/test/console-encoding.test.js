'use strict';

/**
 * Encoding is the difference between a usable terminal and one that shows a
 * Russian error message as `╤В╨░╨║`. The mapping is checked for the code pages a
 * Windows machine actually reports, and for the two ways it can degrade: a page
 * Node has no label for, and a page number the shell got wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { decoderFor } = require('../src/shared/console-encoding');

function decodes(codePage, bytes) {
  return decoderFor(codePage).decoder.decode(Uint8Array.from(bytes));
}

test('UTF-8 is used exactly when the shell reports UTF-8', () => {
  const encoding = decoderFor(65001);
  assert.equal(encoding.label, 'utf-8');
  assert.equal(encoding.exact, true);
  assert.equal(decodes(65001, [0xd0, 0xbf, 0xd1, 0x80, 0xd0, 0xb8, 0xd0, 0xb2, 0xd0, 0xb5, 0xd1, 0x82]), 'привет');
});

test('the Russian OEM page decodes Cyrillic that UTF-8 would maul', () => {
  // "привет" in CP866.
  const bytes = [0xaf, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2];
  assert.equal(decoderFor(866).label, 'ibm866');
  assert.equal(decodes(866, bytes), 'привет');
  assert.notEqual(decodes(65001, bytes), 'привет');
});

test('the Windows Cyrillic page decodes too', () => {
  const bytes = [0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];
  assert.equal(decoderFor(1251).label, 'windows-1251');
  assert.equal(decodes(1251, bytes), 'привет');
});

test('every Windows page from 1250 to 1258 is recognised', () => {
  for (let page = 1250; page <= 1258; page += 1) {
    assert.equal(decoderFor(page).label, `windows-${page}`);
    assert.equal(decoderFor(page).exact, true);
  }
});

test('a single-byte OEM page without a label falls back to a readable one', () => {
  const encoding = decoderFor(437);
  assert.equal(encoding.label, 'windows-1252');
  assert.equal(encoding.exact, false);
  assert.equal(encoding.codePage, 437, 'the report still names the page the shell used');
});

test('a code page from another family is decoded, not ignored', () => {
  assert.equal(decoderFor(932).label, 'shift_jis');
  assert.equal(decoderFor(936).label, 'gbk');
  assert.equal(decoderFor(949).label, 'euc-kr');
  assert.equal(decoderFor(950).label, 'big5');
});

test('a nonsensical code page falls back to UTF-8 and says so', () => {
  const encoding = decoderFor(999999);
  assert.equal(encoding.label, 'utf-8');
  assert.equal(encoding.exact, false);
});

test('a missing code page does not produce a broken decoder', () => {
  for (const value of [undefined, null, '', 'not-a-number']) {
    assert.equal(decoderFor(value).label, 'utf-8');
  }
});

test('a decoder is streaming, so a character split across chunks survives', () => {
  const { decoder } = decoderFor(65001);
  const bytes = Buffer.from('привет', 'utf8');
  const first = decoder.decode(bytes.subarray(0, 3), { stream: true });
  const second = decoder.decode(bytes.subarray(3), { stream: true });
  assert.equal(`${first}${second}`, 'привет');
});