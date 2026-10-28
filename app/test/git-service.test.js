'use strict';

/**
 * The git service, against a real repository and a real remote.
 *
 * The panel's four reported failures - a commit that cannot be pushed, a remote
 * that cannot be pulled, a commit whose change cannot be seen - were all in this
 * file's neighbourhood, and none of them is visible from a parser test: the
 * parser was right, the commands were missing. So these tests build a temporary
 * repository with a bare remote beside it and run the service the way the window
 * does, because "the command exists" and "the command does the thing" are
 * different claims and only the second one is worth making.
 *
 * git is required to be on PATH. The application cannot do anything without it,
 * and a test that skipped when git was missing would be a test that never ran on
 * the machine it was written for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { GitService, findGit } = require('../src/main/git-service.js');

/** Run git in a folder and return its stdout, failing loudly if it refuses. */
function git(cwd, args) {
  return execFileSync(findGit(), args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
  });
}

/**
 * A working repository with a bare remote it already tracks.
 *
 * The remote is a folder, not a URL, so the test needs no network and no
 * credentials: what is being checked is that the service runs the right command
 * and reads its answer, not that GitHub is reachable.
 */
function makeRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-git-'));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(work);
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(work, ['init', '--initial-branch=main']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(work, 'readme.txt'), 'first\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'first commit']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '--set-upstream', 'origin', 'main']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, work, remote };
}

/** The workspace the service asks for a folder, as the main process provides it. */
function workspaceFor(folder) {
  return { current: () => ({ root: folder }), require: () => folder };
}

test('a commit is pushed to the remote it tracks', async (t) => {
  const { work, remote } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  fs.writeFileSync(path.join(work, 'readme.txt'), 'first\nsecond\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'second commit']);

  const pushed = await service.push();
  assert.equal(pushed.ok, true, pushed.stderr);

  // The remote is the authority: the commit is there, not merely reported as sent.
  const onRemote = git(remote, ['log', '--format=%s', '-n1']).trim();
  assert.equal(onRemote, 'second commit');
});

test('a branch with no upstream is pushed and starts tracking one', async (t) => {
  const { work, remote } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  git(work, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'work\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'feature work']);

  const pushed = await service.push();
  assert.equal(pushed.ok, true, pushed.stderr);
  assert.equal(git(remote, ['log', '--format=%s', 'feature', '-n1']).trim(), 'feature work');
  assert.equal(git(work, ['rev-parse', '--abbrev-ref', 'feature@{upstream}']).trim(), 'origin/feature');
});

test('a pull brings a commit made on the remote into the working tree', async (t) => {
  const { work, remote } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  // A second clone stands in for another machine pushing to the same remote.
  const other = path.join(path.dirname(work), 'other');
  git(path.dirname(work), ['clone', remote, other]);
  git(other, ['config', 'user.name', 'Other']);
  git(other, ['config', 'user.email', 'other@example.invalid']);
  fs.writeFileSync(path.join(other, 'from-elsewhere.txt'), 'hello\n', 'utf8');
  git(other, ['add', '.']);
  git(other, ['commit', '-m', 'from elsewhere']);
  git(other, ['push', 'origin', 'main']);

  const pulled = await service.pull();
  assert.equal(pulled.ok, true, pulled.stderr);
  assert.equal(fs.existsSync(path.join(work, 'from-elsewhere.txt')), true);
});

test('a fetch reports the divergence without changing the working tree', async (t) => {
  const { work, remote } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  const other = path.join(path.dirname(work), 'other');
  git(path.dirname(work), ['clone', remote, other]);
  git(other, ['config', 'user.name', 'Other']);
  git(other, ['config', 'user.email', 'other@example.invalid']);
  fs.writeFileSync(path.join(other, 'ahead.txt'), 'x\n', 'utf8');
  git(other, ['add', '.']);
  git(other, ['commit', '-m', 'ahead']);
  git(other, ['push', 'origin', 'main']);

  const fetched = await service.fetch();
  assert.equal(fetched.ok, true, fetched.stderr);

  const status = await service.status();
  assert.equal(status.behind, 1, 'the branch is one behind after a fetch');
  assert.equal(fs.existsSync(path.join(work, 'ahead.txt')), false, 'a fetch does not touch the working tree');
});

test('a commit is shown as the change it introduced', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  fs.writeFileSync(path.join(work, 'readme.txt'), 'first\nsecond\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'second commit']);
  const hash = git(work, ['rev-parse', 'HEAD']).trim();

  const shown = await service.show(hash);
  assert.equal(shown.ok, true, shown.error);
  assert.match(shown.text, /\+second/, 'the added line is in the diff');
  assert.doesNotMatch(shown.text, /second commit/, 'the commit header is not part of the change');
  assert.ok(shown.parsed.hunks.length >= 1, 'the diff is parsed into hunks');
});

test('the first commit of a repository can be shown, though it has no parent', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });
  const first = git(work, ['rev-list', '--max-parents=0', 'HEAD']).trim();

  const shown = await service.show(first);
  assert.equal(shown.ok, true, shown.error);
  assert.match(shown.text, /\+first/, 'the first commit shows the file it added');
});

test('a push with no remote is refused with git\'s own words, not a crash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-git-noremote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'only commit']);

  const service = new GitService({ workspace: workspaceFor(root) });
  const pushed = await service.push();
  assert.equal(pushed.ok, false, 'a push with nowhere to go is a refusal');
  assert.ok(pushed.stderr.trim().length > 0, 'and it says why');
});

test('a commit is read as a header and the files it changed', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  fs.writeFileSync(path.join(work, 'readme.txt'), 'first\nsecond\n', 'utf8');
  fs.writeFileSync(path.join(work, 'added.txt'), 'new\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'a change with two files']);
  const hash = git(work, ['rev-parse', 'HEAD']).trim();

  const view = await service.commitView(hash);
  assert.equal(view.ok, true, view.error);
  assert.equal(view.commit.subject, 'a change with two files');
  assert.equal(view.commit.author, 'Test');
  assert.equal(view.commit.short, hash.slice(0, 7));
  const byPath = Object.fromEntries(view.files.map((file) => [file.path, file.status]));
  assert.equal(byPath['readme.txt'], 'M', 'the modified file is reported as modified');
  assert.equal(byPath['added.txt'], 'A', 'the new file is reported as added');
});

test('a file in a commit is read as the two sides a diff editor compares', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  fs.writeFileSync(path.join(work, 'readme.txt'), 'first\nsecond\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'add a line']);
  const hash = git(work, ['rev-parse', 'HEAD']).trim();

  const file = await service.commitFile(hash, 'readme.txt');
  assert.equal(file.ok, true, file.error);
  assert.equal(file.before, 'first\n', 'the before side is the file as it was');
  assert.equal(file.after, 'first\nsecond\n', 'the after side is the file as it became');
  assert.equal(file.binary, false);
});

test('a file added by a commit has an empty before side, not an error', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  fs.writeFileSync(path.join(work, 'brand-new.txt'), 'hello\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'add a file']);
  const hash = git(work, ['rev-parse', 'HEAD']).trim();

  const file = await service.commitFile(hash, 'brand-new.txt');
  assert.equal(file.ok, true, file.error);
  assert.equal(file.before, '', 'a file that did not exist before is an empty document');
  assert.equal(file.after, 'hello\n');
});

test('the first commit of a repository can be read as a view, though it has no parent', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });
  const first = git(work, ['rev-list', '--max-parents=0', 'HEAD']).trim();

  const view = await service.commitView(first);
  assert.equal(view.ok, true, view.error);
  assert.equal(view.commit.subject, 'first commit');
  assert.equal(view.files.length, 1);
  assert.equal(view.files[0].status, 'A');

  const file = await service.commitFile(first, 'readme.txt');
  assert.equal(file.ok, true, file.error);
  assert.equal(file.before, '', 'the first commit has no parent, so the before side is empty');
  assert.equal(file.after, 'first\n');
});

test('git is found even when the window cannot see it on PATH', () => {
  // A GUI application does not inherit the PATH a terminal has, so a git that
  // works in the shell beside the window can be invisible to the window. The
  // panel then said "this folder is not a git repository" about a folder that
  // plainly is one - wrong, and certain about it.
  const found = findGit();
  assert.ok(found, 'a git must be found on a machine that has one');
  const probe = execFileSync(found, ['--version'], { encoding: 'utf8' });
  assert.match(probe, /^git version /);
});

test('a folder that is not a repository says so, and is not confused with a missing git', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiqode-plain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new GitService({ workspace: workspaceFor(root) });

  const detection = await service.detect();
  assert.equal(detection.repo, false);
  assert.equal(detection.reason, 'this folder is not a git repository');
  assert.notEqual(detection.reason, 'git is not available', 'git is installed here');
});

test('a repository is detected as one', async (t) => {
  const { work } = makeRepository(t);
  const service = new GitService({ workspace: workspaceFor(work) });

  const detection = await service.detect();
  assert.equal(detection.repo, true, detection.reason);
  assert.equal(detection.reason, '');
  assert.equal(path.resolve(detection.topLevel), path.resolve(work));
});
