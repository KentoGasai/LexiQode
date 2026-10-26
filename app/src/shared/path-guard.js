'use strict';

/**
 * Keeping file operations inside the folder the user opened.
 *
 * The renderer sends paths, and a renderer is the part of a program that a bad
 * paste, a relative path inside a file, or a future bug can put arbitrary
 * strings into. Every path crossing into the main process goes through here:
 * resolve first, then refuse anything that escapes the root. `..` is not
 * filtered as text - it is resolved and then compared, so `a/../../b` is judged
 * by where it actually lands rather than by how it was spelled.
 */

const path = require('node:path');

/** True when `target` is the root itself or lives under it. */
function isInside(root, target) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve `target` (absolute or root-relative) and refuse escapes. */
function resolveInside(root, target) {
  if (!root) throw new Error('no folder is open');
  if (typeof target !== 'string' || target === '') throw new Error('a path is required');
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new Error(`refusing to touch a path outside the open folder: ${target}`);
  }
  return resolved;
}

/** A path the UI shows and the renderer sends back. Forward slashes always. */
function toRelative(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/');
}

/** Reject anything that cannot be one path segment. */
function assertSimpleName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('a name is required');
  if (name.includes('/') || name.includes('\\')) throw new Error('a name cannot contain a path separator');
  if (name === '.' || name === '..') throw new Error('that name is not allowed');
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    throw new Error('that name contains characters the filesystem rejects');
  }
  return name;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.avif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.o', '.a', '.lib', '.pdb',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.mkv',
  '.wav', '.flac', '.sqlite', '.db', '.pyc', '.node', '.asar', '.dmg', '.iso'
]);

/** Formats that look binary by extension but are text in practice. */
const TEXTUAL_EXCEPTIONS = new Set(['.svg']);

function likelyBinaryByName(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (TEXTUAL_EXCEPTIONS.has(ext)) return false;
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * A NUL byte in the first few kilobytes is the cheapest reliable signal that a
 * file is not text. Extensions alone lie: extensionless binaries and text files
 * with odd names both exist.
 */
function looksBinaryBuffer(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of window) if (byte === 0) return true;
  return false;
}

module.exports = {
  isInside,
  resolveInside,
  toRelative,
  assertSimpleName,
  likelyBinaryByName,
  looksBinaryBuffer
};