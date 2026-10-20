import * as vscode from 'vscode';

/**
 * The chat surface: one HTML document, no framework, no bundler.
 *
 * Two rules shape this file:
 *
 * * it must look native in any theme, so every colour comes from the editor's
 *   own `--vscode-*` custom properties rather than a hard-coded palette;
 * * it must never hold a secret. The webview only ever receives render-ready
 *   payloads - the core's token and the API key stay in the extension host.
 */

export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomNonce();
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="icon" href="${iconUri}">
<title>LexiQode</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <header class="bar">
    <span class="dot" id="dot"></span>
    <span class="model" id="model">starting the core...</span>
    <span class="spacer"></span>
    <button class="icon" id="newSession" title="New session">&#8635;</button>
  </header>

  <main class="log" id="log">
    <div class="empty" id="empty">
      <p class="empty-title">Ask LexiQode to change your code.</p>
      <p class="empty-hint">It reads the workspace, edits files and runs your tests. Writes and shell commands ask you first.</p>
    </div>
  </main>

  <footer class="composer">
    <div class="approvals" id="approvals"></div>
    <textarea id="input" rows="3" placeholder="Describe a change. Enter sends, Shift+Enter adds a line."></textarea>
    <div class="row">
      <button class="primary" id="send">Send</button>
      <button class="ghost" id="stop" hidden>Stop</button>
      <span class="spacer"></span>
      <label class="toggle" title="Let the agent edit files without asking">
        <input type="checkbox" id="allowWrites"> edits
      </label>
      <label class="toggle" title="Let the agent run shell commands without asking">
        <input type="checkbox" id="allowCommands"> commands
      </label>
    </div>
  </footer>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

const STYLES = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, transparent);
}
.app { display: flex; flex-direction: column; height: 100vh; }

.bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  flex: 0 0 auto;
}
.bar .model { font-size: 11px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .spacer { flex: 1 1 auto; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground, #888); }
.dot.ready { background: var(--vscode-testing-iconPassed, #3fa34d); }
.dot.busy { background: var(--vscode-charts-yellow, #d7a52b); animation: pulse 1.1s ease-in-out infinite; }
.dot.error { background: var(--vscode-testing-iconFailed, #d94a4a); }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

.log { flex: 1 1 auto; overflow-y: auto; padding: 10px 8px 16px; }
.empty { color: var(--vscode-descriptionForeground); padding: 8px 4px; }
.empty-title { margin: 0 0 6px; font-weight: 600; color: var(--vscode-foreground); }
.empty-hint { margin: 0; line-height: 1.5; }

.turn { margin-bottom: 14px; }
.user {
  background: var(--vscode-input-background, rgba(128,128,128,.12));
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.3));
  border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word;
}
.assistant { margin-top: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
.assistant.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
.reasoning {
  margin-top: 6px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  color: var(--vscode-descriptionForeground); font-size: 11px; white-space: pre-wrap;
  max-height: 140px; overflow: auto;
}

.tools { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.tool {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  border-radius: 6px; overflow: hidden;
  background: var(--vscode-editor-background, rgba(128,128,128,.05));
}
.tool-head {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer;
  font-size: 12px; user-select: none;
}
.tool-head .name { font-family: var(--vscode-editor-font-family, monospace); }
.tool-head .detail {
  flex: 1 1 auto; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
}
.tool-head .status { flex: 0 0 auto; font-size: 11px; opacity: .8; }
.tool.running .status { color: var(--vscode-charts-yellow, #d7a52b); }
.tool.ok .status { color: var(--vscode-testing-iconPassed, #3fa34d); }
.tool.failed .status { color: var(--vscode-testing-iconFailed, #d94a4a); }
.tool-body {
  display: none; margin: 0; padding: 8px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.08));
}
.tool.open .tool-body { display: block; }

.changed {
  display: inline-flex; align-items: center; gap: 4px; margin-left: 4px;
  color: var(--vscode-textLink-foreground, #4daafc); cursor: pointer; text-decoration: underline;
}

.approvals { display: flex; flex-direction: column; gap: 6px; }
.approval {
  border: 1px solid var(--vscode-inputValidation-warningBorder, #d7a52b);
  border-radius: 6px; padding: 8px; background: var(--vscode-inputValidation-warningBackground, rgba(215,165,43,.1));
}
.approval .title { font-weight: 600; margin-bottom: 4px; }
.approval .summary {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto;
  margin-bottom: 8px; opacity: .9;
}
.approval .row { display: flex; gap: 6px; flex-wrap: wrap; }

.composer {
  flex: 0 0 auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
}
textarea {
  width: 100%; resize: vertical; min-height: 54px; padding: 6px 8px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); border-radius: 6px;
  font-family: inherit; font-size: inherit;
}
textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1 1 auto; }
button {
  font-family: inherit; font-size: 12px; cursor: pointer; border-radius: 4px;
  padding: 4px 10px; border: 1px solid transparent;
}
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.ghost {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-panel-border, rgba(128,128,128,.4));
}
button.icon { background: transparent; color: var(--vscode-foreground); padding: 2px 6px; font-size: 14px; }
button:disabled { opacity: .5; cursor: default; }
.toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; opacity: .85; cursor: pointer; }
.notice { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 0; }
.notice.error { color: var(--vscode-errorForeground, #d94a4a); }
`;

/**
 * Webview script. Written without template literals and without backslashes,
 * because the whole block is embedded in a TypeScript template literal above:
 * either of those would be rewritten before the browser ever sees it.
 */
const SCRIPT = `
(function () {
  var api = acquireVsCodeApi();
  var log = document.getElementById('log');
  var empty = document.getElementById('empty');
  var input = document.getElementById('input');
  var sendButton = document.getElementById('send');
  var stopButton = document.getElementById('stop');
  var dot = document.getElementById('dot');
  var modelLabel = document.getElementById('model');
  var approvals = document.getElementById('approvals');
  var allowWrites = document.getElementById('allowWrites');
  var allowCommands = document.getElementById('allowCommands');
  var newSession = document.getElementById('newSession');

  var turn = null;
  var body = null;
  var toolBox = null;
  var reasonBox = null;
  var toolNodes = {};
  var busy = false;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  }

  function scrollDown(force) {
    if (force || atBottom()) { log.scrollTop = log.scrollHeight; }
  }

  function clearEmpty() {
    if (empty && empty.parentNode) { empty.parentNode.removeChild(empty); }
    empty = null;
  }

  function setBusy(value) {
    busy = value;
    stopButton.hidden = !value;
    sendButton.disabled = value;
    dot.className = 'dot ' + (value ? 'busy' : 'ready');
  }

  function startTurn(text) {
    clearEmpty();
    var wrap = element('div', 'turn');
    wrap.appendChild(element('div', 'user', text));
    body = element('div', 'assistant thinking', '');
    body.textContent = '';
    wrap.appendChild(body);
    toolBox = element('div', 'tools');
    wrap.appendChild(toolBox);
    log.appendChild(wrap);
    turn = wrap;
    reasonBox = null;
    toolNodes = {};
    scrollDown(true);
  }

  function appendText(chunk) {
    if (!body) { startTurn(''); }
    body.className = 'assistant';
    body.textContent = body.textContent + chunk;
    scrollDown(false);
  }

  function appendReasoning(chunk) {
    if (!reasonBox) {
      reasonBox = element('div', 'reasoning', '');
      if (toolBox) { turn.insertBefore(reasonBox, toolBox); } else { turn.appendChild(reasonBox); }
    }
    reasonBox.textContent = reasonBox.textContent + chunk;
    scrollDown(false);
  }

  function argumentDetail(name, args) {
    if (!args || typeof args !== 'object') { return ''; }
    var value = args.command || args.path || args.pattern || args.query || '';
    if (typeof value !== 'string') { value = JSON.stringify(value); }
    return value.length > 160 ? value.slice(0, 160) + '...' : value;
  }

  function toolStart(data) {
    if (!toolBox) { startTurn(''); }
    var card = element('div', 'tool running');
    var head = element('div', 'tool-head');
    head.appendChild(element('span', 'name', data.name));
    head.appendChild(element('span', 'detail', argumentDetail(data.name, data.arguments)));
    head.appendChild(element('span', 'status', 'running'));
    var bodyNode = element('pre', 'tool-body', '');
    card.appendChild(head);
    card.appendChild(bodyNode);
    head.addEventListener('click', function () { card.classList.toggle('open'); });
    toolBox.appendChild(card);
    toolNodes[data.id] = { card: card, body: bodyNode, status: head.lastChild, name: data.name };
    scrollDown(false);
  }

  function toolEnd(data) {
    var node = toolNodes[data.id];
    if (!node) { return; }
    node.card.className = 'tool ' + (data.cancelled ? 'failed' : (data.ok ? 'ok' : 'failed'));
    node.status.textContent = data.cancelled ? 'skipped' : (data.ok ? 'done in ' + data.elapsed_ms + ' ms' : 'failed');
    node.body.textContent = data.content || '';

    var meta = data.meta || {};
    if (meta.changed && meta.path) {
      var link = element('span', 'changed', meta.created ? 'open new file' : 'review change');
      link.addEventListener('click', function (event) {
        event.stopPropagation();
        api.postMessage({ type: 'openChange', path: meta.path, created: !!meta.created });
      });
      node.card.querySelector('.tool-head').appendChild(link);
    }

    if (!data.ok) { node.card.classList.add('open'); }
    scrollDown(false);
  }

  function showApproval(data) {
    var card = element('div', 'approval');
    card.appendChild(element('div', 'title', data.family === 'command' ? 'Run a command?' : 'Change files?'));
    var detail = data.summary || '';
    if (data.detail) { detail = detail + '  ' + data.detail; }
    card.appendChild(element('div', 'summary', detail));

    var row = element('div', 'row');
    var allow = element('button', 'primary', 'Allow');
    var always = element('button', 'ghost', 'Always allow');
    var deny = element('button', 'ghost', 'Deny');

    function answer(approved, remember) {
      api.postMessage({ type: 'approval', id: data.id, approved: approved, remember: remember });
      if (card.parentNode) { card.parentNode.removeChild(card); }
    }

    allow.addEventListener('click', function () { answer(true, false); });
    always.addEventListener('click', function () {
      answer(true, true);
      if (data.family === 'command') { allowCommands.checked = true; } else { allowWrites.checked = true; }
    });
    deny.addEventListener('click', function () { answer(false, false); });
    row.appendChild(allow);
    row.appendChild(always);
    row.appendChild(deny);
    card.appendChild(row);
    approvals.appendChild(card);
    input.focus();
  }

  function notice(text, isError) {
    var node = element('div', 'notice' + (isError ? ' error' : ''), text);
    approvals.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) { node.parentNode.removeChild(node); }
    }, isError ? 12000 : 6000);
  }

  function onFrame(name, data) {
    if (name === 'turn_start') {
      if (!body) { startTurn(''); }
      setBusy(true);
    } else if (name === 'text_delta') {
      appendText(data.text || '');
    } else if (name === 'reasoning_delta') {
      appendReasoning(data.text || '');
    } else if (name === 'tool_start') {
      toolStart(data);
    } else if (name === 'tool_end') {
      toolEnd(data);
    } else if (name === 'approval_request') {
      showApproval(data);
    } else if (name === 'error') {
      notice('Core error: ' + (data.message || 'unknown'), true);
      setBusy(false);
    } else if (name === 'turn_end') {
      setBusy(false);
      if (data.stopped === 'max_steps') { notice('Stopped: the step budget ran out.'); }
      if (data.stopped === 'cancelled') { notice('Stopped by you.'); }
      if (body && !body.textContent) { body.className = 'assistant'; }
    }
  }

  function renderHistory(messages) {
    var count = messages ? messages.length : 0;
    if (!count) { return; }
    var lastUser = null;
    var lastAssistant = null;
    for (var index = 0; index < count; index += 1) {
      var message = messages[index];
      if (message.role === 'user' && typeof message.content === 'string') { lastUser = message.content; }
      if (message.role === 'assistant' && typeof message.content === 'string') { lastAssistant = message.content; }
    }
    if (!lastUser) { return; }
    clearEmpty();
    var wrap = element('div', 'turn');
    wrap.appendChild(element('div', 'user', lastUser));
    if (lastAssistant) { wrap.appendChild(element('div', 'assistant', lastAssistant)); }
    log.appendChild(wrap);
    scrollDown(true);
  }

  function submit() {
    var text = input.value.trim();
    if (!text || busy) { return; }
    input.value = '';
    api.postMessage({ type: 'send', text: text });
  }

  sendButton.addEventListener('click', submit);
  stopButton.addEventListener('click', function () { api.postMessage({ type: 'cancel' }); });
  newSession.addEventListener('click', function () {
    api.postMessage({ type: 'newSession' });
    toolNodes = {};
    body = null;
    turn = null;
    toolBox = null;
    reasonBox = null;
    log.textContent = '';
    approvals.textContent = '';
    notice('New session started.');
  });
  allowWrites.addEventListener('change', function () {
    api.postMessage({ type: 'policy', writes: allowWrites.checked, commands: allowCommands.checked });
  });
  allowCommands.addEventListener('change', function () {
    api.postMessage({ type: 'policy', writes: allowWrites.checked, commands: allowCommands.checked });
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  input.focus();

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }
    if (message.type === 'init') {
      dot.className = 'dot ' + (message.connection === 'ready' ? 'ready' : (message.connection === 'error' ? 'error' : ''));
      modelLabel.textContent = message.model || 'not connected';
      allowWrites.checked = !!message.allowWrites;
      allowCommands.checked = !!message.allowCommands;
      renderHistory(message.history);
      if (message.notice) { notice(message.notice, message.connection === 'error'); }
    } else if (message.type === 'connection') {
      dot.className = 'dot ' + (message.state === 'ready' ? 'ready' : (message.state === 'error' ? 'error' : 'busy'));
      if (message.model) { modelLabel.textContent = message.model; }
      if (message.detail) { notice(message.detail, message.state === 'error'); }
    } else if (message.type === 'frame') {
      onFrame(message.event, message.data || {});
    }
  });

  api.postMessage({ type: 'ready' });
})();
`;