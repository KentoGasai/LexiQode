/*
 * What to type into the shell to run a file.
 *
 * This is a deliberate table of interpreters rather than a guess, and it lives in
 * the window because the window is what builds the button, the hint it carries
 * and the line that is sent. It is a module so that the string can be tested
 * without opening a window (`app/test/run.test.js`).
 *
 * Three decisions are made here.
 *
 * 1. A file whose language has no interpreter in this table is not run at all.
 *    Inventing one - `python` for a `.rb`, or `node` for something whose shebang
 *    cannot be read - would run the wrong thing on somebody's machine, and a
 *    wrong run is worse than a refusal with a reason.
 *
 * 2. The line begins by moving to the folder the shell started in. A terminal is
 *    persistent, so a `cd` typed earlier is still in force; without the move,
 *    `node src/app.js` would fail with "cannot find module" while the file is
 *    right there.
 *
 * 3. Quoting follows the shell that will receive the line. A path with a space is
 *    ordinary everywhere, and PowerShell, `cmd` and POSIX shells each spell it
 *    differently - PowerShell additionally wants the call operator, or the path
 *    is printed as a string instead of being executed.
 */

/** The interpreter for a file, by its extension. */
export const INTERPRETERS = {
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python',
  '.sh': 'bash'
};

/**
 * Which platform this window is on.
 *
 * The window and the tests disagree about how to find that out - the browser has
 * `navigator`, Node has `process` - so the decision is made in one place and both
 * callers can pass it in explicitly, which is what the tests do.
 */
function detectPlatform() {
  if (typeof navigator !== 'undefined' && navigator.userAgent) return navigator.userAgent;
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  return '';
}

/** Shells that are genuinely a different language, and not a PowerShell. */
export function shellKind(shell, platform = detectPlatform()) {
  const value = String(shell || '').toLowerCase();
  if (value.includes('cmd.exe') || value === 'cmd') return 'cmd';
  if (/powershell|pwsh/.test(value)) return 'powershell';
  if (value) return 'posix';
  // An empty setting means the platform's own default, which is what the terminal
  // service starts: PowerShell on Windows, the user's shell elsewhere.
  return /win/i.test(String(platform)) ? 'powershell' : 'posix';
}

/** One path, quoted for one shell. */
export function quote(value, kind) {
  const text = String(value);
  if (kind === 'powershell') return `'${text.replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** A path relative to the folder, when it is inside that folder. */
export function relativeTo(path, root) {
  if (!root) return '';
  const normalise = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  const file = normalise(path);
  const base = normalise(root);
  if (!base || file === base) return '';
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : '';
}

/**
 * The command that runs `path`, or null when this application has no business
 * running it at all.
 *
 * `root` is the folder the shell is in, `shell` the configured one; both are
 * optional, and a missing root simply means the command is not prefixed with a
 * move.
 */
export function commandFor(path, { shell = '', root = '', platform } = {}) {
  const file = String(path || '');
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = file.slice(dot).toLowerCase();
  const kind = shellKind(shell, platform === undefined ? detectPlatform() : platform);

  /**
   * A script is run by a nested PowerShell with an explicit policy: the current
   * session's policy is the user's business and may well forbid it, and that
   * refusal would look like the script being broken.
   */
  if (extension === '.ps1') return plan({ interpreter: 'powershell -NoProfile -ExecutionPolicy Bypass -File', file, root, kind, extension });
  if (extension === '.bat' || extension === '.cmd') return plan({ interpreter: 'cmd /c', file, root, kind, extension });
  const interpreter = INTERPRETERS[extension];
  if (!interpreter) return null;
  return plan({ interpreter, file, root, kind, extension });
}

/**
 * The finished plan: the line to send, and what the button says about it.
 *
 * A file inside the open folder is named relative to it, so the line stays short
 * enough to read and still works when it is copied out of the terminal. A file
 * from outside the folder is used as it is.
 */
function plan({ interpreter, file, root, kind, extension }) {
  const relative = relativeTo(file, root);
  const target = relative || file;
  const parts = [];
  if (root) {
    if (kind === 'powershell') parts.push(`Set-Location -LiteralPath ${quote(root, kind)}`);
    else if (kind === 'cmd') parts.push(`cd /d ${quote(root, kind)}`);
    else parts.push(`cd ${quote(root, kind)}`);
  }
  parts.push(`${interpreter} ${quote(target, kind)}`);
  // PowerShell separates statements with `;`, the other two with `&&`, which also
  // means the command is not run at all when the move fails.
  const command = parts.join(kind === 'powershell' ? '; ' : ' && ');
  return { extension, interpreter, file, relative, shell: kind, command };
}
