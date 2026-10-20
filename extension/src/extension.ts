import * as vscode from 'vscode';
import { Logger } from './core/logger';
import { ChatViewProvider } from './ui/panel';
import { Session } from './session';
import { isCoreRoot, setApiKey } from './config';
import { registerInlineEdit } from './features/inlineEdit';
import { runSetup } from './features/setup';

/**
 * Activation.
 *
 * Everything long-lived is created once and pushed onto `context.subscriptions`,
 * so a window reload leaves no core process, no listener and no event stream
 * behind. The core itself is started lazily: opening the editor must not spawn a
 * Python process if the user never touches the agent.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger();
  const session = new Session(log, context.secrets);
  const panel = new ChatViewProvider(context.extensionUri, session, log);

  // The core lives in a folder the workspace does not always contain: opening
  // your own project somewhere else means nothing points at it. Rather than
  // leaving the user with an error message and a setting name, offer the picker.
  let corePromptShown = false;

  context.subscriptions.push(
    log,
    session,
    panel,

    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, panel, {
      // Keeps the transcript and its scroll position when the view is hidden.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('lexiqode.openChat', () => panel.reveal()),

    vscode.commands.registerCommand('lexiqode.newSession', async () => {
      await session.reset();
      panel.postNotice('New session started.');
    }),

    vscode.commands.registerCommand('lexiqode.cancelTurn', async () => {
      await session.cancel();
    }),

    vscode.commands.registerCommand('lexiqode.restartCore', async () => {
      panel.postNotice('Restarting the core...');
      await session.restart();
      const state = session.currentState;
      panel.postNotice(
        state.connection === 'ready' ? 'Core is ready.' : `Core did not start: ${state.detail ?? 'unknown reason'}`,
        state.connection !== 'ready'
      );
    }),

    vscode.commands.registerCommand('lexiqode.setApiKey', () =>
      promptForApiKey(context, session, log, panel)
    ),

    vscode.commands.registerCommand('lexiqode.setup', () =>
      runSetup(session, log, context.secrets)
    ),

    vscode.commands.registerCommand('lexiqode.locateCore', () => locateCore(session, log)),

    session.onState(async (state) => {
      if (state.connection === 'ready') {
        corePromptShown = false;
        return;
      }
      if (state.connection !== 'error' || corePromptShown) {
        return;
      }
      if (!/core was not found|coreRoot/i.test(state.detail ?? '')) {
        return;
      }
      corePromptShown = true;
      const choice = await vscode.window.showWarningMessage(
        'LexiQode could not find its Python core for this folder.',
        'Locate the core folder'
      );
      if (choice === 'Locate the core folder') {
        await locateCore(session, log);
      }
    }),

    vscode.commands.registerCommand('lexiqode.showCoreLog', () => log.show()),

    vscode.commands.registerCommand('lexiqode.showCoreInfo', () => showCoreInfo(session, log)),

    registerInlineEdit(session, log),

    // Changing the endpoint or the policy while a core is running must take
    // effect immediately, without the user having to restart anything.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('lexiqode')) {
        return;
      }
      log.info('configuration changed; reapplying the agent policy');
      await session.applyPolicy();
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      // A core serves exactly one workspace, so a different folder needs a
      // different core. The old one is stopped first.
      log.info('workspace folders changed; reconnecting the core');
      await session.restart();
    })
  );

  log.info(`LexiQode extension activated (extension ${context.extension.packageJSON.version as string})`);
}

export function deactivate(): void {
  // Disposal is handled by the subscriptions registered in activate().
}

/**
 * The API key is stored in `SecretStorage` and passed to the core as an
 * environment variable on the next spawn, so it is never written to a settings
 * file and never reaches the webview.
 */
async function promptForApiKey(
  context: vscode.ExtensionContext,
  session: Session,
  log: Logger,
  panel: ChatViewProvider
): Promise<void> {
  const existing = await context.secrets.get('lexiqode.apiKey');
  const value = await vscode.window.showInputBox({
    title: 'LexiQode: model API key',
    prompt: existing
      ? 'A key is already stored. Enter a new one, or leave empty to remove it.'
      : 'Key for your OpenAI-compatible endpoint. Stored in the OS credential store.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  await setApiKey(context.secrets, value);
  log.info(value.trim() ? 'API key updated' : 'API key removed');
  // The key is delivered to the process environment, so the core is respawned.
  await session.restart();
  const state = session.currentState;
  panel.postNotice(
    state.connection === 'ready' ? 'API key saved and the core restarted.' : 'Core did not start after the update.',
    state.connection !== 'ready'
  );
}

async function showCoreInfo(session: Session, log: Logger): Promise<void> {
  const client = await session.ensureClient();
  if (!client) {
    const detail = session.currentState.detail ?? 'unknown reason';
    void vscode.window.showWarningMessage(`LexiQode: the core is not running. ${detail}`);
    return;
  }
  try {
    const state = await client.getState();
    const handshake = client.info;
    const enabled = state.tools.filter((tool) => tool.enabled).length;
    const detail = [
      `workspace:  ${state.workspace}`,
      `core:       ${handshake?.base_url ?? '?'} (pid ${handshake?.pid ?? '?'})`,
      `ownership:  ${client.isAttached ? 'attached to a core another window started' : 'spawned by this window'}`,
      `version:    ${state.version} (protocol ${state.protocol})`,
      `model:      ${state.profile.model}`,
      `endpoint:   ${state.profile.base_url || 'not configured'}`,
      `api key:    ${state.profile.has_api_key ? 'set' : 'not set'}`,
      `tools:      ${enabled}/${state.tools.length} enabled`,
      `approvals:  writes ${state.agent.approve_writes ? 'ask' : 'allowed'}, ` +
        `commands ${state.agent.approve_commands ? 'ask' : 'allowed'}`,
      `turn:       ${state.turn.running ? 'running' : 'idle'}` +
        (state.turn.last_stopped ? `, last ${state.turn.last_stopped}` : ''),
    ].join('\n');
    const choice = await vscode.window.showInformationMessage(
      'LexiQode core',
      { modal: true, detail },
      'Show log'
    );
    if (choice === 'Show log') {
      log.show();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('could not read the core state', error);
    void vscode.window.showErrorMessage(`LexiQode: ${message}`);
  }
}

/**
 * Ask for the folder that contains the `lexiqode` Python package and remember
 * it, then bring the core up with it.
 *
 * The folder is validated before it is saved: picking a project folder by
 * mistake would otherwise turn into a confusing failure on the next attempt
 * instead of an explanation here.
 */
async function locateCore(session: Session, log: Logger): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this folder as the LexiQode core',
    title: 'Select the folder that contains the lexiqode package',
  });
  if (!picked || !picked.length) {
    return;
  }
  const folder = picked[0].fsPath;
  if (!isCoreRoot(folder)) {
    void vscode.window.showErrorMessage(
      `That folder does not contain a "lexiqode" package (expected ${folder}\\lexiqode\\__init__.py).`
    );
    return;
  }

  await vscode.workspace
    .getConfiguration('lexiqode')
    .update('coreRoot', folder, vscode.ConfigurationTarget.Global);
  log.info(`core folder set to ${folder}`);

  await session.restart();
  const state = session.currentState;
  if (state.connection === 'ready') {
    void vscode.window.showInformationMessage(`LexiQode is connected using ${folder}.`);
  } else {
    void vscode.window.showErrorMessage(
      `LexiQode still could not start the core: ${state.detail ?? 'unknown reason'}`
    );
  }
}