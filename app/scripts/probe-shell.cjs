/**
 * A direct measurement of what a shell does with a piped standard input.
 *
 * Written because the terminal design depends on an assumption that is easy to
 * state and easy to get wrong: whether a persistent shell can be driven through
 * pipes. Rather than trusting a memory of how PowerShell's `-Command -` behaves,
 * this starts each candidate invocation, sends two lines, and prints exactly what
 * came back - including the byte length, so a silent shell is unambiguous.
 */

const { spawn } = require('node:child_process');

const candidates = [
  {
    label: 'powershell -NoExit -Command -',
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'],
    lines: ['Write-Output "first"', 'Write-Output "second"']
  },
  {
    label: 'powershell -Command - (no -NoExit)',
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-Command', '-'],
    lines: ['Write-Output "first"', 'Write-Output "second"']
  },
  {
    label: 'cmd /Q /K',
    command: 'cmd.exe',
    args: ['/Q', '/K'],
    lines: ['echo first', 'cd /d %TEMP% & cd']
  }
];

function measure(candidate) {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, candidate.args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let exited = null;
    let wroteAt = 0;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      exited = code;
    });
    child.on('error', (error) => {
      stderr += `spawn error: ${error.message}`;
    });

    const timers = [];
    candidate.lines.forEach((line, index) => {
      timers.push(
        setTimeout(() => {
          wroteAt = Date.now();
          try {
            child.stdin.write(`${line}\r\n`);
          } catch (error) {
            stderr += `write error: ${error.message}`;
          }
        }, 700 + index * 900)
      );
    });
    timers.push(
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }, 700 + candidate.lines.length * 900 + 2500)
    );

    setTimeout(() => {
      for (const timer of timers) clearTimeout(timer);
      resolve({
        label: candidate.label,
        aliveAfterWrites: exited === null,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        writesAccepted: wroteAt > 0,
        stdout: stdout.slice(0, 400),
        stderr: stderr.slice(0, 200)
      });
    }, 700 + candidate.lines.length * 900 + 3000);
  });
}

async function main() {
  for (const candidate of candidates) {
    const result = await measure(candidate);
    console.log(`--- ${result.label}`);
    console.log(`    still running after the writes: ${result.aliveAfterWrites}`);
    console.log(`    stdout: ${result.stdoutBytes} bytes, stderr: ${result.stderrBytes} bytes`);
    console.log(`    stdout begins: ${JSON.stringify(result.stdout)}`);
    if (result.stderr) console.log(`    stderr begins: ${JSON.stringify(result.stderr)}`);
  }
}

void main();