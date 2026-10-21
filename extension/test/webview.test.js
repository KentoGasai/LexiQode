/**
 * The chat surface, verified without an editor.
 *
 * The layout is a product decision, so it is worth asserting rather than
 * eyeballing: the mode control belongs inside the composer at the bottom, the
 * top bar carries status only, and the page must reference its styles and script
 * as files so the content security policy needs no `'unsafe-inline'`.
 *
 * Two checks here catch whole classes of silent breakage:
 *
 * * every `getElementById` in the script must exist in the rendered markup, so a
 *   renamed id is a failing test instead of a dead button;
 * * the message types the script sends and handles must match the types the
 *   controller declares, so the two halves cannot drift apart.
 *
 *     node test/webview.test.js        (or: npm run test:webview)
 */

const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('module');
const path = require('node:path');
const { describe, it } = require('node:test');

// The compiled renderer still requires the editor module; a stub is enough
// because it only ever touches the webview object it is handed.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      Uri: {
        joinPath: (base, ...parts) => ({
          path: path.join(base?.fsPath ?? String(base), ...parts),
          fsPath: path.join(base?.fsPath ?? String(base), ...parts),
        }),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { renderChatHtml } = require('../out/ui/webview.js');

const extensionRoot = path.resolve(__dirname, '..');
const mediaDir = path.join(extensionRoot, 'media');
const scriptSource = fs.readFileSync(path.join(mediaDir, 'chat.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(mediaDir, 'chat.css'), 'utf8');
const controllerSource = fs.readFileSync(path.join(extensionRoot, 'src', 'ui', 'chatController.ts'), 'utf8');

const CSP_SOURCE = 'vscode-webview://test';
const webview = {
  cspSource: CSP_SOURCE,
  asWebviewUri: (uri) => ({ toString: () => `https://test.local/${path.basename(uri.path)}` }),
};
const extensionUri = { path: extensionRoot, fsPath: extensionRoot };

const html = renderChatHtml(webview, extensionUri);

/** The markup between two anchors, used to reason about where something lives. */
function between(haystack, startAnchor, endAnchor) {
  const start = haystack.indexOf(startAnchor);
  assert.ok(start >= 0, `anchor not found: ${startAnchor}`);
  const end = haystack.indexOf(endAnchor, start);
  assert.ok(end > start, `closing anchor not found: ${endAnchor}`);
  return haystack.slice(start, end);
}

describe('chat markup', () => {
  it('loads its styles and script as files, with no inline allowance', () => {
    assert.match(html, /href="[^"]*chat\.css"/, 'the stylesheet must be referenced');
    assert.match(html, /src="[^"]*chat\.js"/, 'the script must be referenced');
    assert.doesNotMatch(html, /unsafe-inline/, 'the policy must not need inline code or styles');
    assert.match(html, /script-src 'nonce-[A-Za-z0-9]{32}'/, 'the script must carry a nonce');
    assert.match(html, /default-src 'none'/, 'the default must deny everything');
  });

  it('puts the mode control inside the composer, not in the top bar', () => {
    const composerAt = html.indexOf('<footer class="composer"');
    const modeAt = html.indexOf('id="modeBtn"');
    assert.ok(composerAt > 0, 'the composer must exist');
    assert.ok(modeAt > composerAt, 'the mode control must live in the composer');

    const topbar = between(html, '<header class="topbar"', '</header>');
    assert.doesNotMatch(
      topbar,
      /mode/i,
      'the top bar must carry status only; the mode control belongs at the bottom'
    );
  });

  it('keeps the bottom row to two controls so a narrow panel still fits', () => {
    const controls = between(html, '<div class="controls">', '</div>');
    const buttons = controls.match(/<button/g) || [];
    assert.strictEqual(
      buttons.length,
      3,
      `expected the mode control, stop and send, found ${buttons.length} buttons in the composer row`
    );
    assert.match(controls, /id="modeBtn"/);
    assert.match(controls, /id="sendBtn"/);
    // Stop is hidden until a turn runs, so exactly two controls are visible.
    const stop = between(controls, 'id="stopBtn"', '>');
    assert.match(stop, /hidden/, 'stop must stay hidden until a turn is running');
    assert.doesNotMatch(controls, /id="sendBtn"[^>]*hidden/, 'send is the visible action when idle');
  });

  it('offers the permission switches inside the mode menu', () => {
    const menu = between(html, 'id="modeMenu"', '<section class="sheet"');
    assert.match(menu, /id="askWrites"/, 'writing files must be switchable');
    assert.match(menu, /id="askCommands"/, 'running commands must be switchable');
  });

  it('has a settings sheet with every value the controller sends', () => {
    const sheet = html.slice(html.indexOf('<section class="sheet"'));
    for (const id of ['setBaseUrl', 'setModel', 'setApiKey', 'setMaxSteps', 'setAskWrites', 'setAskCommands']) {
      assert.ok(sheet.includes(`id="${id}"`), `${id} is missing from the settings sheet`);
    }
    assert.match(sheet, /id="saveSettings"/);
  });

  it('marks the transcript as the scrollable region and the composer as fixed', () => {
    assert.match(html, /<main class="log" id="log">/);
    assert.match(styleSource, /\.log \{[^}]*overflow-y: auto/s);
    assert.match(styleSource, /\.log \{[^}]*flex: 1 1 auto/s);
    assert.match(styleSource, /\.composer \{ flex: 0 0 auto/, 'the composer must not be squeezed away');
  });

  it('truncates instead of overflowing when the panel is narrow', () => {
    // Every flexible child that can receive a long path or model name needs a
    // zero min-width, otherwise the row grows and the panel scrolls sideways.
    assert.match(styleSource, /\.status \{[^}]*min-width: 0/s);
    assert.match(styleSource, /\.tool-head \.target \{[^}]*min-width: 0/s);
    assert.match(styleSource, /\.tool-head \.target \{[^}]*text-overflow: ellipsis/s);
    assert.match(styleSource, /\.app \{[^}]*min-width: 0/s);
  });

  it('gives every element the script looks up an id in the markup', () => {
    const wanted = new Set();
    const lookup = /getElementById\('([^']+)'\)/g;
    for (const match of scriptSource.matchAll(lookup)) {
      wanted.add(match[1]);
    }
    assert.ok(wanted.size >= 15, `only ${wanted.size} lookups found; the script may not have been read`);
    for (const id of wanted) {
      assert.ok(html.includes(`id="${id}"`), `the script looks up #${id}, which the markup does not define`);
    }
  });

  it('never writes host data as markup', () => {
    // Only the fixed icon constants may be assigned as innerHTML.
    const assignments = [...scriptSource.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)];
    assert.ok(assignments.length, 'expected the icon helper to assign innerHTML');
    for (const [, value] of assignments) {
      const expression = value.trim();
      assert.ok(
        /^(svg|ICON_[A-Z_]+)$/.test(expression),
        `innerHTML is assigned from "${expression}", which could carry text from the model`
      );
    }
    assert.doesNotMatch(scriptSource, /insertAdjacentHTML|outerHTML|document\.write/);
  });
});

describe('the two halves agree on the message contract', () => {
  const inboundBlock = controllerSource.slice(
    controllerSource.indexOf('export type InboundMessage'),
    controllerSource.indexOf('/** A place the chat can be drawn')
  );
  const declaredInbound = new Set([...inboundBlock.matchAll(/type: '([a-zA-Z]+)'/g)].map((m) => m[1]));

  const declaredOutbound = new Set(
    [...controllerSource.matchAll(/(?:this\.post|webview\.postMessage)\(\{\s*type: '([a-zA-Z]+)'/g)].map((m) => m[1])
  );

  it('the controller declares both directions', () => {
    assert.ok(declaredInbound.size >= 8, `only ${declaredInbound.size} inbound types found`);
    assert.ok(declaredOutbound.size >= 5, `only ${declaredOutbound.size} outbound types found`);
  });

  it('the script only sends messages the controller accepts', () => {
    const sent = new Set([...scriptSource.matchAll(/postMessage\(\{\s*type: '([a-zA-Z]+)'/g)].map((m) => m[1]));
    assert.ok(sent.size >= 6, `only ${sent.size} messages sent; the script may not have been read`);
    for (const type of sent) {
      assert.ok(declaredInbound.has(type), `the script sends "${type}", which the controller does not declare`);
    }
  });

  it('the script handles every message the controller sends', () => {
    const handled = new Set([...scriptSource.matchAll(/message\.type === '([a-zA-Z]+)'/g)].map((m) => m[1]));
    for (const type of declaredOutbound) {
      assert.ok(handled.has(type), `the controller sends "${type}", which the script ignores`);
    }
  });
});