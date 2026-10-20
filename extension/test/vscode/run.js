/**
 * Runs inside a real editor extension host.
 *
 * Launched by `scripts/test-in-editor.ps1` as:
 *
 *     VSCodium.exe --extensionDevelopmentPath=<extension>
 *                  --extensionTestsPath=<this file> <workspace>
 *
 * Nothing here is simulated: the editor loads the extension, activates it and
 * registers its commands, the panel asks the extension to start the Python core,
 * and the core really spawns, prints its handshake and answers on its port. The
 * host exits with 0 on success and a non-zero code when `run` throws.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vscode = require('vscode');

const MANIFEST_COMMANDS = [
  'lexiqode.openChat',
  'lexiqode.inlineEdit',
  'lexiqode.newSession',
  'lexiqode.cancelTurn',
  'lexiqode.restartCore',
  'lexiqode.setApiKey',
  'lexiqode.showCoreLog',
  'lexiqode.showCoreInfo',
];

function runtimeDescriptorPath() {
  const override = (process.env.LEXIQODE_RUNTIME_FILE ?? '').trim();
  if (override) {
    return override;
  }
  return path.join(process.env.LEXIQODE_CONFIG_DIR ?? '', 'core-runtime.json');
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
  });
}

async function waitFor(predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch {
      // keep waiting: the file may not exist yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function run() {
  const report = [];
  const step = (name, detail) => {
    report.push(`  ok   ${name}${detail ? ` - ${detail}` : ''}`);
  };

  // 1. The editor found and activated the extension.
  const extension = vscode.extensions.getExtension('lexiqode.lexiqode');
  assert.ok(extension, 'the extension must be visible to the editor');
  await extension.activate();
  assert.strictEqual(extension.isActive, true, 'activate() must finish');
  step('extension activated', `v${extension.packageJSON.version}`);

  // 2. Every contributed command is registered.
  const registered = await vscode.commands.getCommands(true);
  const missing = MANIFEST_COMMANDS.filter((id) => !registered.includes(id));
  assert.deepStrictEqual(missing, [], `these commands are not registered: ${missing.join(', ')}`);
  step('commands registered', String(MANIFEST_COMMANDS.length));

  // 3. The settings schema reaches the editor with the documented defaults.
  const config = vscode.workspace.getConfiguration('lexiqode');
  assert.strictEqual(config.get('maxSteps'), 40);
  assert.strictEqual(config.get('autoApproveWrites'), false);
  assert.strictEqual(config.get('autoApproveCommands'), false);
  assert.strictEqual(config.get('showDiffs'), true);
  step('settings schema', 'defaults as documented');

  // 4. No core before the user asks for one: opening the editor is inert.
  const descriptor = runtimeDescriptorPath();
  assert.strictEqual(fs.existsSync(descriptor), false, 'no core may run before the panel asks');
  step('no core before use');

  // 5. Starting the core really spawns it: handshake on stdout, port, token.
  await vscode.commands.executeCommand('lexiqode.restartCore');
  const live = await waitFor(() => {
    if (!fs.existsSync(descriptor)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    return parsed.base_url ? parsed : undefined;
  }, 'the core runtime descriptor');
  step('core spawned', `pid ${live.pid} on port ${live.port}`);

  const health = await getJson(`${live.base_url}/api/health`);
  assert.strictEqual(health.ok, true, 'the core must answer its health probe');
  assert.strictEqual(health.product, 'LexiQode');
  assert.strictEqual(health.protocol, 1);
  assert.strictEqual(
    path.resolve(health.workspace).toLowerCase(),
    path.resolve(live.workspace).toLowerCase(),
    'the core must serve the workspace the editor opened'
  );
  step('handshake and health', `${health.product} ${health.version}, protocol ${health.protocol}`);

  // 6. The port is not a back door: a call without the token is refused.
  const unauthorised = await new Promise((resolve) => {
    const request = http.request(
      { hostname: '127.0.0.1', port: live.port, path: '/api/state', method: 'GET' },
      (response) => resolve(response.statusCode)
    );
    request.on('error', () => resolve(0));
    request.end();
  });
  assert.strictEqual(unauthorised, 401, `an unauthenticated call must be refused, got ${unauthorised}`);
  step('unauthenticated request refused', '401');

  // 7. The agent view can be revealed without the editor reporting a failure.
  await vscode.commands.executeCommand('workbench.view.extension.lexiqode');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  step('agent view revealed');

  console.log('\nIn-editor verification passed:\n' + report.join('\n') + '\n');
}

module.exports = { run };