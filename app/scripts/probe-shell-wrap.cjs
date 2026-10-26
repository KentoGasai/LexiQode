/**
 * Which exact text makes a piped PowerShell execute a command?
 *
 * The session reports its prompt correctly, but commands submitted through the
 * `try { ... } finally { report }` wrapper produced nothing, so the wrapper
 * itself is under test here. Each form is sent to a fresh shell and the raw
 * bytes that come back are printed, including the times they arrived - a shell
 * that answers only when its input ends looks identical to a silent shell if the
 * arrival times are not shown.
 */

const { spawn } = require('node:child_process');

const FORMS = [
  { label: 'A plain line', send: ['Write-Output "A"' ] },
  { label: 'B one-line try/finally', send: ['try { Write-Output "B" } finally { Write-Output "Bdone" }'] },
  { label: 'C two-line try/finally', send: ['try { Write-Output "C"', ' } finally { Write-Output "Cdone" }'] },
  { label: 'D one-line wrapper', send: ['try { Write-Output "D" } finally { Write-Output "Ddone" }'] },
  { label: 'E newline-terminated block', send: ['try {\n  Write-Output "E"\n} finally {\n  Write-Output "Edone"\n}'] },
  { label: 'F with a trailing blank line', send: ['try { Write-Output "F" } finally { Write-Output "Fdone" }', ''] }
];

function probe(form) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'], {
      windowsHide: true
    });
    const started = Date.now();
    let out = '';
    const arrivals = [];

    child.stdout.on('data', (chunk) => {
      arrivals.push(`+${Date.now() - started}ms ${JSON.stringify(chunk.toString('utf8'))}`);
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      arrivals.push(`+${Date.now() - started}ms ERR ${JSON.stringify(chunk.toString('utf8'))}`);
    });
    child.on('error', (error) => arrivals.push(`spawn error: ${error.message}`));

    const payload = form.send.map((line) => `${line}\r\n`).join('');
    setTimeout(() => {
      try {
        child.stdin.write(payload);
      } catch (error) {
        arrivals.push(`write error: ${error.message}`);
      }
    }, 600);

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve({ label: form.label, arrivals, out });
    }, 4000);
  });
}

async function main() {
  for (const form of FORMS) {
    const result = await probe(form);
    const printed = result.out.replace(/\r/g, '');
    console.log(`--- ${result.label}`);
    console.log(`    output: ${JSON.stringify(printed)}`);
    for (const arrival of result.arrivals) console.log(`    ${arrival}`);
  }
}

void main();