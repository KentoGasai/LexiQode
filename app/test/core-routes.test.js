'use strict';

/**
 * The window against the core's route table.
 *
 * Saving agent settings failed with `no route for POST /api/settings`, because
 * the window posted where the core serves PUT. Nothing caught it: the window
 * tested its own client against a stub of its own making, and the core tested its
 * own routes. This closes that gap by reading both sides and comparing them, so
 * the next mismatch fails here instead of in front of a user.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const CORE = path.resolve(APP, '..', 'core');
const HTTP = path.join(CORE, 'lexiqode', 'server', 'http.py');
const AGENT = path.join(APP, 'src', 'main', 'agent');

/** Every route the core serves, as `METHOD /path` pairs. */
function servedRoutes() {
  const source = fs.readFileSync(HTTP, 'utf8');
  const routes = new Set();
  let method = null;
  for (const line of source.split('\n')) {
    const handler = /def do_(GET|PUT|POST|DELETE)\b/.exec(line);
    if (handler) {
      method = handler[1];
      continue;
    }
    if (!method) continue;
    // A route is a literal comparison inside the handler that follows it.
    const route = /path ==\s*"([^"]+)"/.exec(line);
    if (route) routes.add(`${method} ${route[1]}`);
  }
  return routes;
}

/** Every call the window's agent client makes, as `METHOD /path` pairs. */
function askedRoutes() {
  const asked = new Set();
  for (const file of fs.readdirSync(AGENT).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(AGENT, file), 'utf8');
    for (const match of source.matchAll(/\.(get|post|put)\(\s*'([^']+)'/g)) {
      asked.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
    for (const match of source.matchAll(/request\(\s*'(GET|PUT|POST)',\s*'([^']+)'/g)) {
      asked.add(`${match[1]} ${match[2]}`);
    }
  }
  return asked;
}

test('the core serves the routes this window calls', () => {
  const served = servedRoutes();
  const asked = askedRoutes();
  assert.ok(served.size >= 10, `expected to find the core's routes, saw ${served.size}`);
  assert.ok(asked.size >= 8, `expected to find the window's calls, saw ${asked.size}`);

  const missing = [...asked].filter((route) => !served.has(route)).sort();
  assert.deepEqual(missing, [], `the core does not serve: ${missing.join(', ')}`);
});

test('the settings route is written, not posted', () => {
  // Pinned explicitly, because this is the mistake that was made: a route that
  // exists under another method looks exactly like a route that does not exist.
  const served = servedRoutes();
  assert.ok(served.has('PUT /api/settings'), 'the core updates settings with PUT');
  assert.equal(served.has('POST /api/settings'), false);
  assert.ok(askedRoutes().has('PUT /api/settings'), 'the window must update settings with PUT');
});

test('the approval route is sent the field name the core reads', () => {
  const source = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const http = fs.readFileSync(HTTP, 'utf8');
  assert.match(http, /body\.get\("id"\)/, 'the core reads the approval id from `id`');
  assert.match(source, /\bid:\s*requestId/, 'the window must send the approval id as `id`');
  assert.equal(/request_id:\s*requestId/.test(source), false, '`request_id` is not a field the core reads');
});