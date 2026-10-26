/**
 * What bytes does a redirected PowerShell actually write?
 *
 * The shell answered "65001" when asked for its output code page, and still sent
 * bytes that decoded as garbage, so the reported code page is not the truth
 * about the stream. This sends a string whose encodings are all known and prints
 * the raw hex, which settles the question by measurement: whichever candidate
 * encoding produces the expected three characters is the one to use.
 */

const { spawn } = require('node:child_process');

// "При" - chosen so the three candidate encodings are easy to tell apart.
const EXPECTED = 'При';
const CANDIDATES = {
  'utf-8': Buffer.from(EXPECTED, 'utf8'),
  ibm866: Buffer.from([0x8f, 0xe0, 0xa8]),
  'windows-1251': Buffer.from([0xcf, 0xf0, 0xe8])
};

const SHELLS = ['powershell.exe', 'pwsh.exe'];

function hex(buffer) {
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function probe(shell) {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'], { windowsHide: true });
    const chunks = [];
    let failed = '';

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      failed += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failed += `spawn error: ${error.message}`;
    });

    setTimeout(() => {
      child.stdin.write("Write-Output ('CP=' + [int][Console]::OutputEncoding.CodePage)\n");
      child.stdin.write("Write-Output ([string]([char]0x041F + [char]0x0440 + [char]0x0438))\n");
    }, 700);

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve({ shell, bytes: Buffer.concat(chunks), failed });
    }, 3200);
  });
}

async function main() {
  for (const shell of SHELLS) {
    const result = await probe(shell);
    console.log(`--- ${shell}`);
    if (result.failed) {
      console.log(`    unavailable: ${result.failed.split('\n')[0].slice(0, 120)}`);
      continue;
    }
    console.log(`    raw: ${hex(result.bytes)}`);
    console.log(`    as text: ${JSON.stringify(result.bytes.toString('utf8').replace(/\r/g, ''))}`);
    for (const [label, expected] of Object.entries(CANDIDATES)) {
      const found = result.bytes.indexOf(expected);
      console.log(`    ${label.padEnd(14)} ${found === -1 ? 'no match' : `match at ${found}`}`);
    }
  }
}

void main();