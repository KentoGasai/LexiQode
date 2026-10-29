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

test('the answer route is sent the field names the core reads', () => {
  // The same mistake as the approval route, one route over: the core reads `id`
  // and `text`, and a question has no timeout, so a 400 here would leave the
  // turn waiting for ever rather than failing visibly.
  const source = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const http = fs.readFileSync(HTTP, 'utf8');
  assert.match(http, /path == "\/api\/answer"/, 'the core serves the answer route');
  assert.match(http, /body\.get\("text"\)/, 'the core reads the answer from `text`');
  assert.match(source, /post\('\/api\/answer'/, 'the window must call the answer route');
  assert.match(source, /\bid:\s*requestId/, 'the window must send the question id as `id`');
  assert.match(source, /\btext:\s*text/, 'the window must send the answer as `text`');
});

test('the question event is one the window is told about', () => {
  // An event the main process does not forward arrives as `other`, and the
  // panel's switch never reaches the branch that draws the card. For an approval
  // that meant a timeout; for a question it means a turn that never finishes.
  const service = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(APP, 'src', 'renderer', 'js', 'chat.js'),
    'utf8'
  );
  assert.match(service, /'question_request'/, 'the main process must forward the event');
  assert.match(chat, /case 'question_request'/, 'the panel must handle the event by name');
  assert.match(chat, /function questionCard/, 'the panel must draw a card for it');
});

test('the repeat retry is announced, not silent', () => {
  // A turn that is quietly retrying after being told looks exactly like a turn
  // that is stuck, which is the confusion this event exists to remove.
  const service = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(APP, 'src', 'renderer', 'js', 'chat.js'),
    'utf8'
  );
  assert.match(service, /'repeat_retry'/, 'the main process must forward the event');
  assert.match(chat, /case 'repeat_retry'/, 'the panel must handle the event by name');
  assert.match(chat, /chat\.repeatRetry/, 'the panel must say what is happening');
});

test('a promise without action is announced, not silent', () => {
  // The message the agent sent is already in the transcript and looks like
  // progress. The notice is what tells the reader that nothing happened yet.
  const service = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(APP, 'src', 'renderer', 'js', 'chat.js'),
    'utf8'
  );
  assert.match(service, /'promise_nudge'/, 'the main process must forward the event');
  assert.match(chat, /case 'promise_nudge'/, 'the panel must handle the event by name');
  assert.match(chat, /chat\.promiseNudge/, 'the panel must say what is happening');
});

test('an empty or cut-off answer is announced, not silent', () => {
  // Both shapes used to end the turn as though the model had answered, and the
  // window showed a chat that simply stopped. The core now publishes the reason,
  // so the window has to carry it: an event list that drops it and a switch that
  // does not know it are the same silence with more code.
  const service = fs.readFileSync(path.join(AGENT, 'service.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(APP, 'src', 'renderer', 'js', 'chat.js'),
    'utf8'
  );
  for (const event of ['empty_answer_retry', 'answer_truncated', 'empty_answer']) {
    assert.match(service, new RegExp(`'${event}'`), `the main process must forward ${event}`);
    assert.match(chat, new RegExp(`'${event}'`), `the panel must know ${event}`);
  }
  assert.match(chat, /chat\.emptyRetry/, 'the retry must be said out loud');
  assert.match(chat, /chat\.answerTruncated/, 'a cut-off answer is news the reader needs');
  assert.match(chat, /chat\.emptyAnswerNotice/, 'the ending must say what happened');
  assert.match(chat, /chat\.truncatedAnswerNotice/, 'and name the output limit');
});

test('the command a call ran is shown whole, not only as a clipped summary', () => {
  // The row's one-line summary clips at 120 characters. A command is the one
  // argument where the end matters as much as the beginning, so the opened row
  // has to show it in full - otherwise the reader cannot check or copy it.
  const chat = fs.readFileSync(
    path.join(APP, 'src', 'renderer', 'js', 'chat.js'),
    'utf8'
  );
  assert.match(chat, /commandOf\(/, 'the panel must ask for the whole command');
  assert.match(chat, /toolrow__pre--command/, 'the command needs its own block');
  assert.match(chat, /tool\.command/, 'the block must be labelled');
});