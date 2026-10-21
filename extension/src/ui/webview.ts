import * as vscode from 'vscode';

/**
 * The chat surface: one HTML document.
 *
 * Styles and script live in `media/` as real files rather than inside this
 * template. Three reasons, and the last one is the important one:
 *
 * * the content security policy can name them exactly, so `'unsafe-inline'` is
 *   not needed for either;
 * * the script is a normal file, so it can be read, linted and tested on its own;
 * * an embedded copy cannot contain a backtick or a backslash without being
 *   rewritten on the way out, which quietly corrupts code and cannot be caught by
 *   looking at the TypeScript.
 *
 * The layout follows the agent surfaces people already use: the top bar carries
 * nothing but status, the transcript fills the middle, and the composer sits at
 * the bottom with the mode control inside it - next to the field it applies to,
 * where there is room for it even in a narrow side bar.
 *
 * The webview never receives a secret. Everything it draws arrives as a
 * render-ready payload from the extension host.
 */
export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomNonce();
  const styles = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
  const icon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="icon" href="${icon}">
<title>LexiQode</title>
<link rel="stylesheet" href="${styles}">
</head>
<body>
<div class="app">

  <header class="topbar">
    <span class="dot" id="dot" data-state="stopped"></span>
    <span class="status" id="status">starting</span>
    <button class="iconbtn" id="settingsBtn" title="Agent settings" aria-label="Agent settings">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.1 1.6a.5.5 0 0 1 .5.4l.2 1.2c.4.1.8.3 1.2.6l1.1-.5a.5.5 0 0 1 .6.1l1.1 1.6a.5.5 0 0 1-.1.6l-.9.8c.1.4.1.9 0 1.3l.9.8a.5.5 0 0 1 .1.6l-1.1 1.6a.5.5 0 0 1-.6.1l-1.1-.5c-.4.3-.8.5-1.2.6l-.2 1.2a.5.5 0 0 1-.5.4H7.9a.5.5 0 0 1-.5-.4l-.2-1.2a4.6 4.6 0 0 1-1.2-.6l-1.1.5a.5.5 0 0 1-.6-.1L3.2 8.9a.5.5 0 0 1 .1-.6l.9-.8a4 4 0 0 1 0-1.3l-.9-.8a.5.5 0 0 1-.1-.6l1.1-1.6a.5.5 0 0 1 .6-.1l1.1.5c.4-.3.8-.5 1.2-.6l.2-1.2a.5.5 0 0 1 .5-.4zM8.5 5.9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"/></svg>
    </button>
    <button class="iconbtn" id="newBtn" title="New session" aria-label="New session">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a.6.6 0 0 1 .6.6v4.3h4.3a.6.6 0 1 1 0 1.2H8.6v4.3a.6.6 0 1 1-1.2 0V8.6H3.1a.6.6 0 1 1 0-1.2h4.3V3.1A.6.6 0 0 1 8 2.5z"/></svg>
    </button>
  </header>

  <main class="log" id="log">
    <div class="empty" id="empty">
      <p class="empty-title">Ask LexiQode to change your code</p>
      <p class="empty-text">It reads the workspace, edits files and runs your tests. Nothing is written and no command runs until you agree.</p>
      <ul class="empty-hints">
        <li><span class="kbd">Enter</span> send, <span class="kbd">Shift+Enter</span> new line</li>
        <li>Switch between <b>Agent</b>, <b>Ask</b> and <b>Plan</b> with the control in the field below</li>
        <li><span class="kbd">Ctrl+Alt+K</span> rewrites the selected code</li>
      </ul>
    </div>
  </main>

  <footer class="composer">
    <div class="approvals" id="approvals"></div>
    <div class="field" id="field">
      <textarea id="input" rows="1" spellcheck="false"
        placeholder="Ask anything, or describe a change to make"></textarea>
      <div class="controls">
        <button class="mode" id="modeBtn" aria-haspopup="menu" aria-expanded="false">
          <span class="mode-label" id="modeLabel">Agent</span>
          <svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 6.3a.6.6 0 0 1 .9 0L8 9.2l2.9-2.9a.6.6 0 1 1 .9.9L8.6 10a.6.6 0 0 1-.9 0L4.2 7.2a.6.6 0 0 1 0-.9z"/></svg>
        </button>
        <span class="grow"></span>
        <button class="stop" id="stopBtn" title="Stop" aria-label="Stop" hidden>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>
        </button>
        <button class="send" id="sendBtn" title="Send" aria-label="Send" disabled>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.4a.7.7 0 0 0 .7-.7V5.2l2.4 2.4a.7.7 0 1 0 1-1L8.5 3.2a.7.7 0 0 0-1 0L4 6.6a.7.7 0 1 0 1 1l2.3-2.4v7.5a.7.7 0 0 0 .7.7z"/></svg>
        </button>
      </div>
    </div>
  </footer>

  <div class="popover" id="modeMenu" role="menu" hidden>
    <div class="popover-body" id="modeList"></div>
    <div class="popover-sep"></div>
    <div class="popover-body">
      <label class="check-row" for="askWrites">
        <input type="checkbox" id="askWrites">
        <span>Ask before editing files</span>
      </label>
      <label class="check-row" for="askCommands">
        <input type="checkbox" id="askCommands">
        <span>Ask before running commands</span>
      </label>
    </div>
  </div>

  <section class="sheet" id="settings" hidden aria-label="Agent settings">
    <header class="sheet-head">
      <span class="sheet-title">Agent settings</span>
      <button class="iconbtn" id="closeSettings" title="Close" aria-label="Close">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4.7a.55.55 0 0 1 .8-.8L8 7.2l3.2-3.3a.55.55 0 1 1 .8.8L8.8 8l3.2 3.2a.55.55 0 0 1-.8.8L8 8.8 4.8 12a.55.55 0 0 1-.8-.8L7.2 8z"/></svg>
      </button>
    </header>
    <div class="sheet-body">
      <label class="field-label" for="setBaseUrl">Endpoint</label>
      <input class="input" id="setBaseUrl" type="text" spellcheck="false" placeholder="https://your-server/v1">
      <p class="field-note">Any OpenAI-compatible endpoint: a local server or a hosted one.</p>

      <label class="field-label" for="setModel">Model</label>
      <input class="input" id="setModel" type="text" spellcheck="false" placeholder="model id">

      <label class="field-label" for="setApiKey">API key</label>
      <input class="input" id="setApiKey" type="password" spellcheck="false" placeholder="leave empty to keep the stored key">
      <p class="field-note" id="keyNote">Stored in the operating system's credential store.</p>

      <label class="field-label" for="setMaxSteps">Steps per turn</label>
      <input class="input" id="setMaxSteps" type="number" min="1" max="200" step="1">
      <p class="field-note">How many model round trips one request may use.</p>

      <label class="check-row" for="setAskWrites">
        <input type="checkbox" id="setAskWrites">
        <span>Ask before editing files</span>
      </label>
      <label class="check-row" for="setAskCommands">
        <input type="checkbox" id="setAskCommands">
        <span>Ask before running commands</span>
      </label>

      <div class="sheet-actions">
        <button class="primary" id="saveSettings">Save and reconnect</button>
        <span class="save-note" id="saveNote"></span>
      </div>
    </div>
  </section>

</div>
<script nonce="${nonce}" src="${script}"></script>
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