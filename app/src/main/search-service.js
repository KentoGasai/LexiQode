'use strict';

/**
 * Find in files.
 *
 * The search walks the folder itself rather than shelling out to a tool, so it
 * works in a folder that is not a repository and has nothing to install. Two
 * properties matter more than speed: it must be cancellable, because a user who
 * typed the wrong query should not wait for it to finish, and results arrive in
 * batches, because a search that finds ten thousand matches should show the
 * first hundred immediately instead of nothing until it is done.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { buildQuery, scanText } = require('../shared/search');
const { SKIP_ALWAYS: skipAlways, isExcluded, globToRegExp } = require('../shared/exclude');

const BATCH_FILES = 25;
const BATCH_INTERVAL_MS = 40;

class SearchService {
  constructor({ workspace, settings, onBatch, onDone }) {
    this.workspace = workspace;
    this.settings = settings;
    this.onBatch = onBatch;
    this.onDone = onDone;
    this.cancelled = new Set();
  }

  cancel(searchId) {
    this.cancelled.add(searchId);
    return { cancelled: true, searchId };
  }

  /**
   * Start a search. Returns immediately with the id the caller cancels with; the
   * work continues on the main process's own loop with `await` points, so a
   * cancel is noticed between files rather than after the whole tree.
   */
  start(searchId, request) {
    const query = request && typeof request.query === 'string' ? request.query : '';
    const matcher = buildQuery(query, {
      regex: Boolean(request.regex),
      caseSensitive: Boolean(request.caseSensitive),
      wholeWord: Boolean(request.wholeWord)
    });
    const root = this.workspace.require();
    const settings = this.settings.get();
    const maxResults = Math.max(1, Number(request.maxResults) || settings.files.maxSearchResults);
    const maxPerFile = Math.max(1, Number(request.maxPerFile) || 200);
    const include = Array.isArray(request.include) && request.include.length ? request.include : ['**/*'];
    const includePatterns = include.map((pattern) => globToRegExp(pattern));
    const sizeLimit = settings.files.maxFileSizeKb * 1024;
    const patterns = settings.files.exclude;
    const contextLines = Math.max(0, Math.min(5, Number(request.contextLines) || 0));

    this.cancelled.delete(searchId);
    const state = { filesScanned: 0, filesWithMatches: 0, total: 0, truncated: false, limitHit: false };

    void this.#run({
      searchId,
      root,
      matcher,
      maxResults,
      maxPerFile,
      includePatterns,
      sizeLimit,
      patterns,
      contextLines,
      state
    });

    return { searchId, started: true };
  }

  async #run(job) {
    const { searchId, root, matcher, maxResults, maxPerFile, includePatterns, sizeLimit, patterns, contextLines, state } =
      job;
    let batch = [];
    let lastFlush = Date.now();

    const flush = (force = false) => {
      if (!batch.length && !force) return;
      this.onBatch({ searchId, matches: batch, progress: { ...state } });
      batch = [];
      lastFlush = Date.now();
    };

    const stack = [''];
    try {
      while (stack.length) {
        if (this.cancelled.has(searchId)) {
          flush(true);
          this.onDone({ searchId, ...state, cancelled: true });
          return;
        }
        const relative = stack.pop();
        const absolute = relative ? path.join(root, relative) : root;
        let entries;
        try {
          entries = await fsp.readdir(absolute, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
          if (skipAlways.has(entry.name)) continue;
          if (entry.isDirectory()) {
            if (isExcluded(`${childRelative}/`, patterns)) continue;
            stack.push(childRelative);
            continue;
          }
          if (!entry.isFile()) continue;
          if (isExcluded(childRelative, patterns)) continue;
          if (!includePatterns.some((expression) => expression.test(childRelative))) continue;

          if (this.cancelled.has(searchId)) {
            flush(true);
            this.onDone({ searchId, ...state, cancelled: true });
            return;
          }

          state.filesScanned += 1;
          try {
            const info = await fsp.stat(path.join(root, childRelative));
            if (info.size > sizeLimit) continue;
            const raw = await fsp.readFile(path.join(root, childRelative));
            if (raw.subarray(0, Math.min(raw.length, 8192)).includes(0)) continue;
            const result = scanText(raw.toString('utf8'), matcher, {
              relativePath: childRelative,
              maxMatches: Math.min(maxPerFile, maxResults - state.total),
              contextLines
            });
            if (result.matches.length) {
              state.filesWithMatches += 1;
              state.total += result.matches.length;
              // Only the first match of a file is sent for an overview; all of
              // them are kept, because clicking a file has to reach the line.
              batch.push(...result.matches);
            }
            if (result.truncated) state.truncated = true;
          } catch {
            // Unreadable file (permissions, locked): skip, do not fail the search.
            continue;
          }

          if (state.total >= maxResults) {
            state.limitHit = true;
            flush(true);
            this.onDone({ searchId, ...state, cancelled: false });
            return;
          }
          if (batch.length >= 200 || Date.now() - lastFlush > BATCH_INTERVAL_MS) flush();
        }
      }
      flush(true);
      this.onDone({ searchId, ...state, cancelled: false });
    } catch (error) {
      flush(true);
      this.onDone({ searchId, ...state, cancelled: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

module.exports = { SearchService };