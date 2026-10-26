'use strict';

/**
 * Turning what a user typed into a matcher, and applying it to lines.
 *
 * Kept out of the main process so the rules are testable directly: a
 * case-insensitive literal search, a regular expression and whole-word mode are
 * the same function with different flags, and the interesting behaviour - what
 * happens with an invalid pattern, or one that can match empty text - is decided
 * here rather than discovered in a hanging search.
 */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matcher for a query.
 *
 * `global` is always set: one object walks every line, so `matchLine` resets
 * `lastIndex` before each use instead of leaking state between files and
 * silently skipping matches.
 */
function buildQuery(query, options = {}) {
  if (typeof query !== 'string') throw new Error('a query is required');
  const { regex = false, caseSensitive = false, wholeWord = false } = options;
  if (!regex && query === '') throw new Error('a query is required');

  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    // A pattern that matches empty text would make the scan loop spin.
    if (regex && new RegExp(source).test('')) {
      throw new Error('that pattern can match empty text; anchor it to something');
    }
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch (error) {
    throw new Error(`invalid pattern: ${error.message}`);
  }
}

/** First match on a line, or null. */
function matchLine(line, matcher) {
  matcher.lastIndex = 0;
  const found = matcher.exec(line);
  if (!found) return null;
  return { column: found.index + 1, length: Math.max(1, found[0].length), text: found[0] };
}

/** Every match on a line, with the columns and lengths a view highlights. */
function matchLineAll(line, matcher) {
  const hits = [];
  matcher.lastIndex = 0;
  let found = matcher.exec(line);
  while (found) {
    hits.push({ column: found.index + 1, length: Math.max(1, found[0].length) });
    if (found[0] === '') matcher.lastIndex += 1;
    found = matcher.exec(line);
  }
  return hits;
}

/** Lines of a file, tolerating CRLF, LF, CR and a missing final newline. */
function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

/**
 * Scan one file's text. Stops at `maxMatches` so a single pathological file
 * cannot occupy the whole search; the caller reports the truncation.
 */
function scanText(text, matcher, { relativePath = '', maxMatches = 200, contextLines = 0 } = {}) {
  const lines = splitLines(text);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= maxMatches) return { matches, truncated: true };
    const line = lines[index];
    const hit = matchLine(line, matcher);
    if (!hit) continue;
    const entry = {
      path: relativePath,
      line: index + 1,
      column: hit.column,
      length: hit.length,
      text: line.length > 400 ? `${line.slice(0, 400)}…` : line
    };
    if (contextLines > 0) {
      entry.before = lines.slice(Math.max(0, index - contextLines), index).map((value) => value.slice(0, 400));
      entry.after = lines.slice(index + 1, index + 1 + contextLines).map((value) => value.slice(0, 400));
    }
    matches.push(entry);
  }
  return { matches, truncated: false };
}

module.exports = {
  buildQuery,
  escapeRegExp,
  matchLine,
  matchLineAll,
  scanText,
  splitLines
};