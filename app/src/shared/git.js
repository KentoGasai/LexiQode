'use strict';

/**
 * Reading git's machine formats.
 *
 * `--porcelain=v2` is used rather than the human output because the human output
 * is localised (a translated git renames its status words) and because porcelain
 * v2 states renames, upstream divergence and conflicts explicitly instead of
 * implying them through column positions. Parsing lives here, away from the
 * process that runs git, so every branch of it is tested with literal fixtures.
 */

const RECORD_SEPARATOR = '\u001f';

/** `git status --porcelain=v2 --branch` */
function parseStatus(stdout) {
  const status = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    initial: false,
    entries: [],
    staged: [],
    modified: [],
    untracked: [],
    conflicted: []
  };
  if (!stdout) return status;

  const kindOf = (indexCode, worktreeCode) => {
    if (indexCode === '?' && worktreeCode === '?') return 'untracked';
    const conflicted =
      indexCode === 'U' ||
      worktreeCode === 'U' ||
      (indexCode === 'A' && worktreeCode === 'A') ||
      (indexCode === 'D' && worktreeCode === 'D');
    if (conflicted) return 'conflicted';
    if (indexCode !== '.' && indexCode !== ' ') return 'staged';
    return 'modified';
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length).trim();
      status.detached = status.branch === '(detached)';
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      status.initial = line.slice('# branch.oid '.length).trim() === '(initial)';
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    if (line.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = line.split(' ');
      const xy = fields[1] || '..';
      status.entries.push({
        path: fields.slice(8).join(' '),
        kind: kindOf(xy[0], xy[1]),
        index: xy[0],
        worktree: xy[1]
      });
      continue;
    }
    if (line.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const fields = line.split(' ');
      const xy = fields[1] || '..';
      const [target, from] = fields.slice(9).join(' ').split('\t');
      status.entries.push({
        path: target,
        renamedFrom: from || '',
        kind: kindOf(xy[0], xy[1]),
        index: xy[0],
        worktree: xy[1]
      });
      continue;
    }
    if (line.startsWith('u ')) {
      const fields = line.split(' ');
      status.entries.push({
        path: fields.slice(10).join(' '),
        kind: 'conflicted',
        index: 'U',
        worktree: 'U'
      });
      continue;
    }
    if (line.startsWith('? ')) {
      status.entries.push({ path: line.slice(2), kind: 'untracked', index: '?', worktree: '?' });
      continue;
    }
    // '! ' marks an ignored path, which the UI does not list.
  }

  // The two-column status is not a single choice. `MM` means the file differs
  // from HEAD in the index *and* differs again in the working tree, so it
  // belongs in both lists; collapsing it into one hides half the truth from the
  // person deciding what to stage next.
  for (const entry of status.entries) {
    if (entry.kind === 'untracked') {
      status.untracked.push(entry.path);
      continue;
    }
    if (entry.kind === 'conflicted') {
      status.conflicted.push(entry.path);
      continue;
    }
    if (entry.index !== '.' && entry.index !== ' ') status.staged.push(entry.path);
    if (entry.worktree !== '.' && entry.worktree !== ' ') status.modified.push(entry.path);
  }
  return status;
}

/** `git log --pretty=format:%H<sep>%an<sep>%ar<sep>%s%x1e` */
function parseLog(stdout) {
  if (!stdout) return [];
  return stdout
    .split('\u001e')
    .map((record) => record.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, author, when, subject] = record.split(RECORD_SEPARATOR);
      return {
        hash: hash || '',
        short: (hash || '').slice(0, 7),
        author: author || '',
        when: when || '',
        subject: subject || ''
      };
    });
}

/** `git branch --format=%(refname:short)<sep>%(HEAD)<sep>%(upstream:short)` */
function parseBranches(stdout) {
  if (!stdout) return [];
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, head, upstream] = line.split(RECORD_SEPARATOR);
      return { name: name || '', current: (head || '').trim() === '*', upstream: upstream || '' };
    });
}

/** A unified diff split into hunks, which is what a diff view needs. */
function parseDiff(stdout) {
  if (!stdout) return { header: '', hunks: [] };
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  return { header: header.join('\n'), hunks };
}

module.exports = { parseStatus, parseLog, parseBranches, parseDiff };