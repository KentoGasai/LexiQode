'use strict';

/**
 * Everything the window is allowed to do to the folder the user opened.
 *
 * The rules live here rather than in the renderer because this is the side that
 * has the filesystem: every path is resolved against the open folder and refused
 * if it escapes (see `path-guard`), binary files are reported as binary instead
 * of being decoded into replacement characters, and line endings are remembered
 * per file so saving a CRLF file does not silently convert it to LF - a
 * one-character change that turns into a whole-file diff in a review.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  assertSimpleName,
  looksBinaryBuffer,
  likelyBinaryByName,
  resolveInside,
  toRelative
} = require('../shared/path-guard');
const { SKIP_ALWAYS, isExcluded } = require('../shared/exclude');

class WorkspaceService {
  constructor({ settings }) {
    this.settings = settings;
    this.root = '';
    this._index = null;
    this.listeners = new Set();
  }

  /**
   * Subscribe to folder changes; returns the unsubscribe function.
   *
   * Listeners rather than one callback assigned through the constructor, and
   * named exactly as `SettingsStore` names it, because the main process
   * registers this the same way it registers the settings listener. An earlier
   * version kept the callback in a property called `onChange`, so the line that
   * looked like a subscription (`workspace.onChange(fn)`) called the default
   * no-op instead of registering anything: the window was never told that a
   * folder had opened, and every panel went on showing the previous state while
   * the folder itself was open in this process.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notify() {
    const value = this.current();
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // One listener that throws must not stop the others, and it must never
        // break the folder switch that has already happened.
      }
    }
  }

  /** The open folder, or a refusal. Every operation starts here. */
  require() {
    if (!this.root) throw new Error('no folder is open');
    return this.root;
  }

  current() {
    return this.root ? { root: this.root, name: path.basename(this.root) || this.root } : null;
  }

  async open(folder) {
    const resolved = path.resolve(folder);
    const info = await fsp.stat(resolved);
    if (!info.isDirectory()) throw new Error(`${resolved} is not a folder`);
    this.root = resolved;
    this._index = null;
    this.#notify();
    return this.current();
  }

  close() {
    this.root = '';
    this._index = null;
    this.#notify();
  }

  excludes() {
    return this.settings.get().files.exclude;
  }

  /** Immediate children of a directory, folders first, then by name. */
  async list(relative = '.') {
    const root = this.require();
    const directory = resolveInside(root, relative);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const patterns = this.excludes();
    const items = [];
    for (const entry of entries) {
      if (SKIP_ALWAYS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const rel = toRelative(root, absolute);
      if (entry.isDirectory() && isExcluded(`${rel}/`, patterns)) continue;
      let size = 0;
      let mtime = 0;
      if (entry.isFile()) {
        try {
          const info = await fsp.stat(absolute);
          size = info.size;
          mtime = info.mtimeMs;
        } catch {
          // A file that vanished between readdir and stat is simply skipped.
          continue;
        }
      }
      items.push({
        name: entry.name,
        path: rel,
        directory: entry.isDirectory(),
        symlink: entry.isSymbolicLink(),
        size,
        mtime
      });
    }
    items.sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return items;
  }

  /**
   * Read a file as text.
   *
   * `eol` and `hadFinalNewline` travel with the text so that saving can put back
   * exactly what was there. `binary` short-circuits a decode that would produce
   * mojibake, and a size limit keeps a multi-gigabyte log from being read into
   * the editor by an accidental click.
   */
  async read(relative) {
    const root = this.require();
    const file = resolveInside(root, relative);
    const info = await fsp.stat(file);
    if (info.isDirectory()) throw new Error(`${relative} is a folder`);

    const limit = this.settings.get().files.maxFileSizeKb * 1024;
    if (info.size > limit) {
      return { path: toRelative(root, file), tooLarge: true, size: info.size, limit };
    }

    const buffer = await fsp.readFile(file);
    if (likelyBinaryByName(file) || looksBinaryBuffer(buffer)) {
      return { path: toRelative(root, file), binary: true, size: info.size };
    }

    const text = buffer.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return {
      path: toRelative(root, file),
      size: info.size,
      mtime: info.mtimeMs,
      eol,
      hadFinalNewline: /(\r\n|\n|\r)$/.test(text),
      text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    };
  }

  /** Write text, converting back to the file's own line ending. */
  async write(relative, text, options = {}) {
    const root = this.require();
    const file = resolveInside(root, relative);
    let body = String(text);
    const settings = this.settings.get();
    if (settings.editor.trimTrailingWhitespace) {
      body = body.replace(/[ \t]+$/gm, '');
    }
    if (options.eol === '\r\n') body = body.replace(/\n/g, '\r\n');
    if (options.hadFinalNewline && !/(\r\n|\n)$/.test(body) && body !== '') {
      body += options.eol === '\r\n' ? '\r\n' : '\n';
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body, 'utf8');
    this._index = null;
    return { path: toRelative(root, file), size: Buffer.byteLength(body, 'utf8') };
  }

  async createFile(parentRelative, name) {
    const root = this.require();
    assertSimpleName(name);
    const parent = resolveInside(root, parentRelative || '.');
    const file = resolveInside(root, path.join(toRelative(root, parent), name));
    // `wx` fails instead of truncating: creating a file must never empty an
    // existing one, which is what a plain write would do.
    const handle = await fsp.open(file, 'wx');
    await handle.close();
    this._index = null;
    return { path: toRelative(root, file), name, directory: false };
  }

  async createFolder(parentRelative, name) {
    const root = this.require();
    assertSimpleName(name);
    const parent = resolveInside(root, parentRelative || '.');
    const folder = resolveInside(root, path.join(toRelative(root, parent), name));
    await fsp.mkdir(folder);
    this._index = null;
    return { path: toRelative(root, folder), name, directory: true };
  }

  async rename(relative, newName) {
    const root = this.require();
    assertSimpleName(newName);
    const source = resolveInside(root, relative);
    const target = path.join(path.dirname(source), newName);
    if (fs.existsSync(target)) throw new Error(`${newName} already exists`);
    await fsp.rename(source, target);
    this._index = null;
    return { from: toRelative(root, source), to: toRelative(root, target), name: newName };
  }

  /** Move a file or folder to the desktop's own recycle bin, never unlink. */
  async remove(relative, trash) {
    const root = this.require();
    const target = resolveInside(root, relative);
    if (target === root) throw new Error('refusing to delete the open folder');
    await trash(target);
    this._index = null;
    return { removed: toRelative(root, target) };
  }

  /**
   * Every file in the folder, for the quick-open picker.
   *
   * Cached until something writes, because the picker is opened repeatedly and a
   * large repository makes this walk expensive. Bounded, so a pathological tree
   * cannot exhaust memory before the first keystroke.
   */
  async index({ limit = 20000 } = {}) {
    if (this._index) return this._index;
    const root = this.require();
    const patterns = this.excludes();
    const files = [];
    const stack = [''];
    while (stack.length && files.length < limit) {
      const relative = stack.pop();
      const absolute = relative ? path.join(root, relative) : root;
      let entries;
      try {
        entries = await fsp.readdir(absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SKIP_ALWAYS.has(entry.name)) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (isExcluded(`${childRelative}/`, patterns)) continue;
          stack.push(childRelative);
        } else if (entry.isFile()) {
          if (isExcluded(childRelative, patterns)) continue;
          files.push(childRelative);
          if (files.length >= limit) break;
        }
      }
    }
    files.sort();
    this._index = files;
    return files;
  }

  stat(relative) {
    const root = this.require();
    const target = resolveInside(root, relative);
    const info = fs.statSync(target);
    return {
      path: toRelative(root, target),
      directory: info.isDirectory(),
      size: info.size,
      mtime: info.mtimeMs
    };
  }
}

module.exports = { WorkspaceService };