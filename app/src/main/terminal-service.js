'use strict';

/**
 * The terminal panel: a persistent shell per tab, driven through pipes rather
 * than a pseudo-console.
 *
 * Why pipes and not a real PTY: a PTY on Windows needs a native module compiled
 * against the build machine's toolchain, and an IDE that only builds where
 * Visual Studio is installed is worse than one whose terminal cannot run `vim`.
 * The consequence is stated in the UI rather than hidden: this is a command
 * console. Git, npm, python, pytest, builds and servers work, colours included;
 * full-screen interactive programs do not.
 *
 * Three facts about driving a shell over pipes were measured against a real
 * PowerShell rather than assumed, and each one shapes the code:
 *
 * 1. `-NoExit -Command -` keeps a session alive and executes lines as they
 *    arrive, so one process serves the whole tab and `cd` persists.
 * 2. A line holding a statement the parser cannot finish is silently discarded.
 *    The wrapper around a submitted command is therefore always a single line,
 *    and multi-line input goes through a temporary script file instead of being
 *    joined with `;`, which would change what a loop or a block means.
 * 3. `$?` inside the wrapper's `finally` block reports the `finally` block's own
 *    last command, not the user's, so the outcome is captured in a variable
 *    immediately after the command runs. Without that, a failed command reported
 *    success.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PRODUCT } = require('../shared/constants');
const { END, START, consume } = require('../shared/console-text');
const { decoderFor } = require('../shared/console-encoding');

const MAX_SESSIONS = 8;
const OUTPUT_ALERT_BYTES = 400 * 1024;

/** The report function the shell is taught at startup. */
function promptFunction() {
  return (
    "function global:__lx_prompt { param([string]$state = 'ok');" +
    " if (-not $state) { $state = 'ok' };" +
    ` Write-Output ([char]${START.charCodeAt(0)} + (Get-Location).Path + [char]${END.charCodeAt(0)} + $state) }`
  );
}

/**
 * Startup, as one line (see fact 2 above). Each risky step is guarded on its
 * own: an exception anywhere on the line would skip everything after it, and the
 * function that reports the prompt would never be defined.
 */
const PREAMBLE = [
  'chcp 65001 > $null 2>&1',
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
  "$ErrorActionPreference = 'Continue'",
  promptFunction(),
  // The report carries the code page the shell really has, so output is decoded
  // with what it actually wrote rather than what was hoped for.
  "__lx_prompt ('ready:' + [int][Console]::OutputEncoding.CodePage)"
].join('; ');

/** The same report for a POSIX shell. `\1` and `\2` are printf octal escapes. */
const POSIX_PROBE = "printf '\\1%s\\2%s\\n' \"$PWD\" \"$?\"";

let nextId = 1;
let scriptCounter = 0;

class TerminalService {
  constructor({ settings, onData, onExit }) {
    this.settings = settings;
    this.onData = onData;
    this.onExit = onExit;
    this.sessions = new Map();
  }

  defaultShell() {
    const configured = this.settings.get().terminal.shell;
    if (configured) return configured;
    if (process.platform === 'win32') return 'powershell.exe';
    return process.env.SHELL || '/bin/bash';
  }

  create({ cwd, title } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`at most ${MAX_SESSIONS} terminals at once`);
    const shell = this.defaultShell();
    const directory = cwd || os.homedir();
    const id = `t${nextId++}`;
    const shellIsPowerShell = isPowerShell(shell);
    // Everything that can throw is computed before the process exists: a failure
    // after `spawn` would leave a shell running with nothing tracking it.
    const label = title || `${path.basename(directory) || PRODUCT} (${shell})`;

    const child = spawn(shell, shellIsPowerShell ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] : ['-i', '-l'], {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', LEXIQODE_TERMINAL: '1' }
    });

    const session = {
      id,
      title: label,
      shell,
      cwd: directory,
      child,
      buffer: '',
      outputBytes: 0,
      exited: false,
      scripts: [],
      encoding: decoderFor(65001),
      // Pipes have no size to report; the UI asks and is told the truth.
      pty: false
    };
    this.sessions.set(id, session);

    child.stdout.on('data', (chunk) => this.#consume(session, chunk, false));
    child.stderr.on('data', (chunk) => this.#consume(session, chunk, true));
    child.on('error', (error) => {
      this.onData({ id, data: `\r\n\x1b[31m${error.message}\x1b[0m\r\n` });
    });
    child.on('close', (code) => {
      session.exited = true;
      for (const file of session.scripts) removeScript(file);
      this.sessions.delete(id);
      this.onExit({ id, code: code ?? -1 });
    });

    if (shellIsPowerShell) child.stdin.write(`${PREAMBLE}\n`);
    return { id, title: session.title, shell, cwd: directory, pty: false };
  }

  /**
   * Turn one raw chunk into visible output and prompt reports.
   *
   * Decoding happens here rather than in the parser because the code page can
   * change exactly once, when the shell's first report names it, and a streaming
   * decoder is needed anyway: a pipe splits multi-byte characters across chunks.
   */
  #consume(session, chunk, isError) {
    const text = session.encoding.decoder.decode(chunk, { stream: true });
    const { output, reports, rest } = consume(session.buffer, text);
    session.buffer = rest;

    for (const report of reports) {
      let status = report.status;
      if (status.startsWith('ready:')) {
        const codePage = Number(status.slice('ready:'.length));
        session.encoding = decoderFor(codePage);
        status = 'info';
      }
      session.cwd = report.cwd.trim() || session.cwd;
      // The report is sent by the wrapper's `finally`, so the script it belongs
      // to has finished. Scripts are removed in submission order - execution
      // order - so a command still queued keeps its file.
      if (session.scripts.length) removeScript(session.scripts.shift());
      this.onData({
        id: session.id,
        prompt: {
          cwd: session.cwd,
          status: status === 'ok' ? 'ok' : status === 'err' ? 'err' : 'info',
          encoding: session.encoding.label
        }
      });
    }

    if (!output) return;
    session.outputBytes += output.length;
    if (session.outputBytes > OUTPUT_ALERT_BYTES * 4) {
      this.onData({ id: session.id, data: '\r\n\x1b[33m(output truncated)\x1b[0m\r\n' });
      session.outputBytes = 0;
    }
    this.onData({ id: session.id, data: isError ? `\x1b[31m${output}\x1b[0m` : output });
  }

  /**
   * Run one command in the session.
   *
   * The wrapper is one line (fact 2) and captures the outcome before the report
   * runs (fact 3), so a command that failed is shown as failed and the console
   * keeps working after an error.
   */
  submit(id, command) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('that terminal is closed');
    const text = String(command ?? '').replace(/\r\n/g, '\n');
    const shellIsPowerShell = isPowerShell(session.shell);

    if (text.trim() === '') {
      session.child.stdin.write(shellIsPowerShell ? '__lx_prompt\n' : `${POSIX_PROBE}\n`);
      return { accepted: true };
    }
    if (/^\s*(exit|logout)\s*$/i.test(text)) {
      session.child.stdin.write('exit\n');
      return { accepted: true, closing: true };
    }
    if (!shellIsPowerShell) {
      session.child.stdin.write(`${text}\n${POSIX_PROBE}\n`);
      return { accepted: true };
    }

    const payload = text.includes('\n') ? `& ${quoteForPowerShell(writeScript(text, session))}` : text;
    session.child.stdin.write(
      `try { ${payload}; $__lx = if ($?) { 'ok' } else { 'err' } } catch { $__lx = 'err' } finally { __lx_prompt $__lx }\n`
    );
    return { accepted: true };
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('that terminal is closed');
    session.child.stdin.write(String(data));
    return { accepted: true };
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      shell: session.shell,
      cwd: session.cwd,
      pty: session.pty,
      encoding: session.encoding.label
    }));
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return { killed: false };
    for (const file of session.scripts) removeScript(file);
    try {
      session.child.stdin.end();
      session.child.kill();
    } catch {
      // Already gone.
    }
    this.sessions.delete(id);
    return { killed: true };
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

function isPowerShell(shell) {
  return /powershell|pwsh/i.test(String(shell));
}

/**
 * Put multi-line input in a file and return its path.
 *
 * Joining lines with `;` would look equivalent and is not: a block, a here-doc
 * or a loop body changes meaning or stops parsing. A file preserves exactly what
 * the user pasted and the shell runs it as one statement.
 */
function writeScript(text, session) {
  const file = path.join(os.tmpdir(), `lexiqode-command-${process.pid}-${scriptCounter++}.ps1`);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  session.scripts.push(file);
  return file;
}

/** PowerShell single-quoted literal; the only escape inside it is a doubled quote. */
function quoteForPowerShell(file) {
  return `'${String(file).replace(/'/g, "''")}'`;
}

function removeScript(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or the shell still holds it; either way nothing to do.
  }
}

module.exports = { TerminalService };