'use strict';

/**
 * Tells the window when the open folder changes on disk.
 *
 * The tree was redrawn only after the window's own buttons - create, rename,
 * delete, save - which is not how a folder changes. A `git checkout` in the
 * terminal, a build, a file written by another editor, or the agent writing
 * through the core all happen outside this process, and the explorer went on
 * showing the folder as it had been when it was last read. A new file that does
 * not appear is read as the editor being broken, and the only recourse is the
 * Refresh button - the wrong way to discover that the file exists at all.
 *
 * The watch is recursive, because a project is a folder of folders. Bursts are
 * coalesced: a checkout or a build touches hundreds of paths in a second, and
 * one notification per burst is what a redraw wants. Paths that the tree and
 * search already ignore (`.git`, `node_modules`, build output) never reach the
 * window, so a busy repository does not redraw the tree at all.
 *
 * A watcher that cannot be created - an unwatchable folder, an exhausted handle
 * budget - is not a reason to fail the folder: it is reported once and the
 * window keeps its manual refresh.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isExcluded } = require('../shared/exclude');

const DEFAULT_DEBOUNCE_MS = 250;

class WorkspaceWatcher {
  #onChanged;

  #onProblem;

  #shouldIgnore;

  #debounceMs;

  #watcher = null;

  #root = '';

  #pending = new Set();

  #timer = null;

  constructor({ onChanged, onProblem, shouldIgnore, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    this.#onChanged = typeof onChanged === 'function' ? onChanged : () => {};
    this.#onProblem = typeof onProblem === 'function' ? onProblem : () => {};
    this.#shouldIgnore = typeof shouldIgnore === 'function' ? shouldIgnore : () => false;
    this.#debounceMs = Math.max(0, Number(debounceMs) || 0);
  }

  get root() {
    return this.#root;
  }

  /** Replace the ignore filter, for when the excluded folders change. */
  setIgnore(shouldIgnore) {
    this.#shouldIgnore = typeof shouldIgnore === 'function' ? shouldIgnore : () => false;
  }

  /** Watch one folder, replacing any previous watch. */
  watch(root) {
    this.stop();
    if (!root) return false;
    try {
      this.#watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        this.#record(eventType, filename);
      });
    } catch (error) {
      this.#onProblem(`the folder is not watched for changes: ${error.message}`);
      return false;
    }
    this.#watcher.on('error', (error) => {
      this.#onProblem(`watching the folder stopped: ${error.message}`);
      this.stop();
    });
    this.#root = path.resolve(root);
    return true;
  }

  stop() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending.clear();
    if (this.#watcher) {
      try {
        this.#watcher.close();
      } catch {
        // A watcher that is already gone is the state we wanted.
      }
      this.#watcher = null;
    }
    this.#root = '';
  }

  #record(eventType, filename) {
    if (typeof filename !== 'string' || !filename) {
      // No name: the platform said "something below the root changed". Reported
      // without a path, which the window treats as "re-read what is on screen".
      this.#schedule('');
      return;
    }
    const relative = filename.split(path.sep).join('/');
    if (this.#shouldIgnore(relative)) return;
    this.#schedule(relative);
  }

  #schedule(relative) {
    this.#pending.add(relative);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const paths = [...this.#pending];
      this.#pending.clear();
      this.#onChanged({ root: this.#root, paths });
    }, this.#debounceMs);
  }
}

/**
 * Whether a watched path is one the tree never shows.
 *
 * The same exclusion list as the tree and find-in-files, for the same reason:
 * a path the tree hides but that still makes it redraw is work nobody asked for.
 */
function ignoreFactory(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return (relative) => {
    if (!list.length) return false;
    // A directory event arrives as the directory itself, which the pattern for
    // its contents (`**/node_modules/**`) does not match; both are tried.
    return isExcluded(relative, list) || isExcluded(`${relative}/`, list);
  };
}

function createWorkspaceWatcher(options) {
  return new WorkspaceWatcher(options);
}

module.exports = { DEFAULT_DEBOUNCE_MS, WorkspaceWatcher, createWorkspaceWatcher, ignoreFactory };