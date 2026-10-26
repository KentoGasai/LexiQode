/**
 * The chat protocol, measured end to end.
 *
 * The window renders whatever the core emits, so the field names in those events
 * are a contract. Rather than reading the emitter and hoping, this starts a
 * minimal OpenAI-compatible endpoint, points the real core at it, sends a real
 * message and prints every event with its exact payload.
 *
 * It also settles a second question that would otherwise be guessed: what the
 * core does when no model is configured, which is the state a new install is in.
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const CORE = path.resolve(__dirname, '..', '..', 'core');
const PORT = 8712;

const stub = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (!request.url.endsWith('/chat/completions')) {
      response.writeHead(404).end('{}');
      return;
    }
    let wantsStream = false;
    try {
      wantsStream = Boolean(JSON.parse(body).stream);
    } catch {
      wantsStream = false;
    }
    if (wantsStream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const piece of ['Reading ', 'the ', 'workspace.']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'stub',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Reading the workspace.' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 }
      })
    );
  });
});

function startCore(env) {
  const child = spawn('python', ['-m', 'lexiqode', 'serve', process.cwd(), '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: CORE, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env }
  });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the core did not report an address')), 25000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith('lexiqode-core-ready')) {
          clearTimeout(timer);
          resolve({ child, connection: JSON.parse(line.slice('lexiqode-core-ready'.length).trim()) });
        }
        index = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
  });
}

async function call(connection, method, route, body) {
  const response = await fetch(`${connection.base_url}${route}`, {
    method,
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Follow /api/events and print each frame until `until` says to stop. */
async function follow(connection, until, label) {
  const controller = new AbortController();
  const response = await fetch(`${connection.base_url}/api/events?token=${encodeURIComponent(connection.token)}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const type = /(?:^|\n)event:\s*(.+)/.exec(frame);
        const data = /(?:^|\n)data:\s*(.+)/.exec(frame);
        if (data) {
          let parsed = data[1];
          try {
            parsed = JSON.parse(data[1]);
          } catch {
            // Leave it as text.
          }
          const name = type ? type[1].trim() : 'message';
          seen.push({ name, payload: parsed });
          console.log(`  ${label} <- ${name} ${JSON.stringify(parsed).slice(0, 200)}`);
        }
        split = buffer.indexOf('\n\n');
      }
      if (until(seen)) break;
    }
  } catch {
    // Aborted on purpose.
  } finally {
    controller.abort();
  }
  return seen;
}

async function main() {
  await new Promise((resolve) => stub.listen(PORT, '127.0.0.1', resolve));
  console.log(`stub endpoint on http://127.0.0.1:${PORT}/v1`);

  console.log('\n=== with a configured endpoint ===');
  const configured = await startCore({
    LEXIQODE_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
    LEXIQODE_API_KEY: 'stub-key',
    LEXIQODE_MODEL: 'stub-model'
  });
  console.log(`core: ${configured.connection.base_url}`);
  const state = await call(configured.connection, 'GET', '/api/state');
  console.log(`state: ${JSON.stringify(state).slice(0, 400)}`);
  // The settings form asks this before anything is saved, which is the whole
  // point of the override fields: the endpoint worth asking about is the one
  // being typed, not the one already stored.
  const models = await call(configured.connection, 'POST', '/api/models', {
    base_url: `http://127.0.0.1:${PORT}/v1`,
    api_key: 'probe-key'
  });
  console.log(`models from typed fields -> ${JSON.stringify(models).slice(0, 200)}`);
  const following = follow(
    configured.connection,
    (seen) => seen.some((event) => event.name === 'assistant_text'),
    'event'
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const started = await call(configured.connection, 'POST', '/api/chat', { message: 'hi', mode: 'ask' });
  console.log(`chat -> ${JSON.stringify(started)}`);
  const events = await following;
  console.log(`event names: ${[...new Set(events.map((event) => event.name))].join(', ')}`);
  console.log(`history: ${JSON.stringify(await call(configured.connection, 'GET', '/api/history')).slice(0, 300)}`);
  configured.child.kill();

  console.log('\n=== with no model configured ===');
  const bare = await startCore({
    LEXIQODE_CONFIG_DIR: path.join(process.env.TEMP || '/tmp', 'lx-probe-empty')
  });
  console.log(`state: ${JSON.stringify(await call(bare.connection, 'GET', '/api/state')).slice(0, 300)}`);
  const bareModels = await call(bare.connection, 'POST', '/api/models', {
    base_url: `http://127.0.0.1:${PORT}/v1`,
    api_key: 'probe-key'
  });
  console.log(`models with no model configured -> ${JSON.stringify(bareModels).slice(0, 200)}`);
  try {
    console.log(`chat -> ${JSON.stringify(await call(bare.connection, 'POST', '/api/chat', { message: 'hi' }))}`);
  } catch (error) {
    console.log(`chat refused: ${error.message}`);
  }
  bare.child.kill();
  stub.close();
}

void main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});