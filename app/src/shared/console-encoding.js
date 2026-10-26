'use strict';

/**
 * Decoding what a Windows shell printed.
 *
 * A shell spawned from a graphical application has no console to inherit, so it
 * writes its standard output in a legacy code page - on a Russian Windows that
 * is CP866, on a Western one CP1252 - and reading those bytes as UTF-8 turns
 * every non-ASCII character into replacement noise. `chcp 65001` is attempted
 * first, and it usually works, but "usually" is why the shell also reports the
 * code page it actually ended up with and the reader follows that report instead
 * of assuming.
 *
 * Only the labels Node can decode itself are used. Anything else falls back to
 * UTF-8, which is the right answer for the modern shells and the least wrong one
 * elsewhere - and the fallback is reported rather than hidden.
 */

const EXACT_LABELS = new Map([
  [65001, 'utf-8'],
  [866, 'ibm866'],
  [20866, 'koi8-r'],
  [21866, 'koi8-u'],
  [874, 'windows-874'],
  [932, 'shift_jis'],
  [936, 'gbk'],
  [949, 'euc-kr'],
  [950, 'big5'],
  [10000, 'macintosh'],
  [1200, 'utf-16le'],
  [1201, 'utf-16be'],
  [28591, 'iso-8859-1'],
  [28592, 'iso-8859-2'],
  [28595, 'iso-8859-5'],
  [28597, 'iso-8859-7'],
  [28599, 'iso-8859-9'],
  [28605, 'iso-8859-15']
]);

for (let page = 1250; page <= 1258; page += 1) EXACT_LABELS.set(page, `windows-${page}`);

/**
 * Single-byte OEM pages Node has no label for. CP850 and CP852 differ from
 * CP1252 in a handful of box-drawing and accented positions; reading them as
 * CP1252 keeps text readable, which matters far more than those glyphs being
 * exact.
 */
const APPROXIMATE_LABELS = new Map([
  [437, 'windows-1252'],
  [850, 'windows-1252'],
  [858, 'windows-1252'],
  [860, 'windows-1252'],
  [863, 'windows-1252'],
  [865, 'windows-1252'],
  [852, 'windows-1250']
]);

/**
 * The decoder to use for a code page the shell reported.
 *
 * @param {number|string} codePage
 * @returns {{label: string, codePage: number, exact: boolean, decoder: TextDecoder}}
 */
function decoderFor(codePage) {
  const page = Number(codePage);
  const exact = EXACT_LABELS.get(page);
  const approximate = APPROXIMATE_LABELS.get(page);
  const candidates = [];
  if (exact) candidates.push({ label: exact, isExact: true });
  if (approximate) candidates.push({ label: approximate, isExact: false });
  candidates.push({ label: 'utf-8', isExact: false });

  for (const candidate of candidates) {
    try {
      return {
        label: candidate.label,
        codePage: Number.isFinite(page) ? page : 0,
        exact: candidate.isExact,
        decoder: new TextDecoder(candidate.label, { fatal: false })
      };
    } catch {
      // This Node build does not ship that legacy encoding; try the next one.
    }
  }
  // Unreachable in practice: UTF-8 always exists.
  return { label: 'utf-8', codePage: 0, exact: false, decoder: new TextDecoder('utf-8') };
}

module.exports = { APPROXIMATE_LABELS, EXACT_LABELS, decoderFor };