'use strict';

/**
 * Which paths a folder walk ignores.
 *
 * Both the file tree, the quick-open index and find-in-files have to agree on
 * this, and disagreement is user-visible: a file that the tree hides but search
 * still returns looks like a bug in search. The patterns are the usual
 * `**`-aware globs, translated to a regular expression once per call.
 */

const path = require('node:path');

/** Translate one glob into a regular expression over forward-slash paths. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, '\u0000SLASH\u0000')
    .replace(/\*\*/g, '\u0000ALL\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000SLASH\u0000/g, '(?:.*/)?')
    .replace(/\u0000ALL\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

/** Directories never worth walking, whatever the settings say. */
const SKIP_ALWAYS = new Set(['.git']);

function isExcluded(relativePath, patterns) {
  const normalised = String(relativePath).split(path.sep).join('/');
  return (patterns || []).some((pattern) => {
    try {
      if (globToRegExp(pattern).test(normalised)) return true;
      // A directory pattern also excludes what is under it, which is what a
      // person writing `**/node_modules/**` means.
      const directory = pattern.replace(/\/\*\*$/, '');
      return directory !== pattern && globToRegExp(`${directory}/**`).test(normalised);
    } catch {
      return false;
    }
  });
}

module.exports = { SKIP_ALWAYS, globToRegExp, isExcluded };