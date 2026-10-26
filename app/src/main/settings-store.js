'use strict';

/**
 * The app's settings file, read once and written atomically.
 *
 * Every write goes to a temporary file that is then renamed over the target, so
 * a crash mid-write leaves the previous settings intact instead of a truncated
 * JSON file that would make the next start fall back to defaults and lose the
 * user's layout. Readers get the in-memory value, which is already sanitised by
 * the shared loader, so nothing downstream has to defend against a bad file.
 */

const fs = require('node:fs');
const path = require('node:path');

const { applyPatch, loadSettings, rememberFolder, sanitise } = require('../shared/settings');

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.listeners = new Set();
    this.value = this.#read();
  }

  #read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return loadSettings(JSON.parse(raw));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        // A malformed file is worth knowing about, but it must not stop the app
        // from starting: defaults are a usable answer.
        console.warn(`settings: ${this.file} could not be read (${error.message}); using defaults`);
      }
      return loadSettings(undefined);
    }
  }

  #write() {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.file);
  }

  #emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.value);
      } catch {
        // A listener that throws must not break the write that just succeeded.
      }
    }
  }

  get() {
    return this.value;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a partial update from the UI and return the whole settings object. */
  update(patch) {
    this.value = applyPatch(this.value, patch);
    this.#write();
    this.#emit();
    return this.value;
  }

  /** Move a folder to the front of the recent list. */
  rememberFolder(folder) {
    this.value = rememberFolder(this.value, folder);
    this.#write();
    this.#emit();
    return this.value;
  }

  /** What to restore on the next start: the folder and the open tabs. */
  setSession(session) {
    this.value = sanitise({ ...this.value, session });
    this.#write();
    this.#emit();
    return this.value;
  }
}

module.exports = { SettingsStore };