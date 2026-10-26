/**
 * Exercise the Gitea publishing script against a stub server.
 *
 * The publishing path is the one piece of this repository that cannot be tested
 * by unit tests: it is an HTTP conversation with somebody else's server. This
 * writes the smallest server that behaves like Gitea - a version endpoint, a
 * user endpoint that requires the token, a package upload and a package listing -
 * and runs the real script against it, so the request shapes and the error
 * handling are checked rather than assumed.
 *
 * It also asserts that the token never appears in the script's output, which is
 * the failure that matters most here and the one a human reviewer would miss.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'publish-gitea.ps1');
const PORT = 8714;
const TOKEN = 'probe-token-value-9f2c';

const uploads = [];

const server = http.createServer((request, response) => {
  const authorised = (request.headers.authorization || '') === `token ${TOKEN}`;
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const reply = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload ?? {}));
  };

  if (url.pathname === '/api/v1/version') return reply(200, { version: '1.22.0-stub' });
  if (url.pathname === '/api/v1/user') {
    if (!authorised) return reply(401, { message: 'token required' });
    return reply(200, { login: 'probe-owner' });
  }
  if (url.pathname.startsWith('/api/packages/')) {
    if (!authorised) return reply(401, { message: 'token required' });
    if (request.method === 'PUT') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploads.push({ path: url.pathname, bytes: Buffer.concat(chunks).length });
        reply(201, { ok: true });
      });
      return undefined;
    }
    return reply(200, [{ version: '0.0.9', file_count: 2 }]);
  }
  return reply(404, { message: 'no such endpoint' });
});

function runPublish(args, env = {}) {
  try {
    const stdout = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}${error.message}` };
  }
}

function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${PORT}`;

  // With `--serve-only` this file is just a stub server, which is how the script
  // is diagnosed by hand: a hang inside PowerShell is impossible to read from a
  // synchronous child process.
  if (process.argv.includes('--serve-only')) {
    console.log(`stub listening on ${base}`);
    return;
  }

  const check1 = runPublish(['-Server', base, '-Check', '-Token', TOKEN, '-Owner', 'probe-owner']);
  check('a reachable server and a valid token are reported', check1.ok && /accepted for probe-owner/.test(check1.output), check1.output.trim().split('\n').pop());

  const badToken = runPublish(['-Server', base, '-Check', '-Token', 'wrong-token', '-Owner', 'probe-owner']);
  check('a refused token fails with the status, not a stack trace', !badToken.ok && /refused the token \(HTTP 401\)/.test(badToken.output));

  const list = runPublish(['-Server', base, '-List', '-Owner', 'probe-owner', '-Token', TOKEN]);
  check('a listing is printed', list.ok && /0\.0\.9/.test(list.output), list.output.trim().split('\n').pop());

  const bundle = path.join(os.tmpdir(), 'lexiqode-probe-bundle.zip');
  fs.writeFileSync(bundle, Buffer.alloc(2048, 7));
  const upload = runPublish(['-Server', base, '-Owner', 'probe-owner', '-Token', TOKEN, '-Version', '9.9.9', '-File', bundle]);
  check('an upload succeeds and reports its digest', upload.ok && /published/.test(upload.output) && /[0-9a-f]{64}/.test(upload.output));
  check('the upload reached the registry with the right path', uploads.length === 1 && uploads[0].path === '/api/packages/probe-owner/generic/lexiqode/9.9.9/lexiqode-probe-bundle.zip', uploads.map((entry) => entry.path).join(', '));
  check('the whole file was sent', uploads[0] && uploads[0].bytes === 2048, `${uploads[0] ? uploads[0].bytes : 0} bytes`);

  const combined = [check1, badToken, list, upload].map((entry) => entry.output).join('\n');
  check('the token never appears in any output', !combined.includes(TOKEN));
  check('a missing token is refused before any request', !runPublish(['-Server', base, '-Owner', 'probe-owner', '-File', bundle]).ok);

  fs.unlinkSync(bundle);
  server.close();
}

void main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});