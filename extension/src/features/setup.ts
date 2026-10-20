import * as vscode from 'vscode';
import { CoreClient } from '../core/client';
import { Logger } from '../core/logger';
import { readSettings, setApiKey } from '../config';
import { Session } from '../session';

/**
 * Three questions and the agent is usable: endpoint, key, model.
 *
 * The order matters. The endpoint and the key are stored first and the core is
 * restarted with them, which means the model list can then be fetched from the
 * user's own server instead of being typed from memory. If the endpoint does not
 * answer, the step falls back to free text and says why - a wrong URL and a
 * wrong key are the two mistakes worth naming precisely.
 */

const MANUAL = '$(pencil) Type the model id myself';

export async function runSetup(session: Session, log: Logger, secrets: vscode.SecretStorage): Promise<void> {
  const config = vscode.workspace.getConfiguration('lexiqode');
  const current = readSettings();
  const endpointProblem = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'An endpoint is required.';
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      return 'Use a full URL, including http:// or https://';
    }
    return undefined;
  };

  const baseUrl = await vscode.window.showInputBox({
    title: 'LexiQode setup (1 of 3): endpoint',
    prompt: 'Base URL of your OpenAI-compatible server. The /chat/completions path is added automatically.',
    placeHolder: 'https://gateway.example.com/v1',
    value: current.baseUrl,
    ignoreFocusOut: true,
    validateInput: endpointProblem,
  });
  if (baseUrl === undefined) {
    return;
  }

  const stored = await secrets.get('lexiqode.apiKey');
  const key = await vscode.window.showInputBox({
    title: 'LexiQode setup (2 of 3): API key',
    prompt: stored
      ? 'A key is already stored. Leave this empty to keep it, or paste a new one.'
      : 'Key for this endpoint. It goes into the operating system\u2019s credential store, never into a settings file.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }

  await config.update('baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
  if (key.trim()) {
    await setApiKey(secrets, key);
  }
  log.info(`endpoint set to ${baseUrl.trim()}`);

  // The key travels to the core as an environment variable, so the process has
  // to be recreated before the endpoint can be queried.
  const client = await session.restart().then(() => session.ensureClient());
  if (!client) {
    const detail = session.currentState.detail ?? 'the core did not start';
    void vscode.window.showErrorMessage(`LexiQode: the core did not start. ${detail}`);
    return;
  }

  const model = await askForModel(client, current.model, log);
  if (model === undefined) {
    return;
  }
  await config.update('model', model, vscode.ConfigurationTarget.Global);
  await session.applyPolicy();
  log.info(`model set to ${model}`);

  const verified = await verify(session, log);
  const choice = await vscode.window.showInformationMessage(
    'LexiQode is ready.',
    { modal: true, detail: verified },
    'Open the agent'
  );
  if (choice === 'Open the agent') {
    await vscode.commands.executeCommand('lexiqode.openChat');
  }
}

/** Offer the endpoint's own model list, falling back to typing one in. */
async function askForModel(
  client: CoreClient,
  currentModel: string,
  log: Logger
): Promise<string | undefined> {
  let models: string[] = [];
  try {
    models = await client.listModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`the endpoint did not return a model list: ${message}`);
    void vscode.window.showWarningMessage(
      `LexiQode could not read the model list (${message}). You can still type the model id.`
    );
  }

  if (models.length) {
    const picked = await vscode.window.showQuickPick(
      [...models.map((id) => ({ label: id })), { label: MANUAL }],
      {
        title: `LexiQode setup (3 of 3): model (${models.length} offered by your endpoint)`,
        placeHolder: currentModel ? `current: ${currentModel}` : 'pick a model',
        ignoreFocusOut: true,
      }
    );
    if (picked === undefined) {
      return undefined;
    }
    if (picked.label !== MANUAL) {
      return picked.label;
    }
  }

  return vscode.window.showInputBox({
    title: 'LexiQode setup (3 of 3): model',
    prompt: models.length ? 'Model id to send to the endpoint.' : 'Your endpoint did not list any models; type the id.',
    value: currentModel,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'A model id is required.'),
  });
}

/** Ask the core what it is actually configured with, rather than assuming. */
async function verify(session: Session, log: Logger): Promise<string> {
  const client = await session.ensureClient();
  if (!client) {
    return 'The core is not running.';
  }
  try {
    const state = await client.getState();
    const tools = state.tools.filter((tool) => tool.enabled).length;
    return [
      `endpoint: ${state.profile.base_url || '(not set)'}`,
      `model:    ${state.profile.model || '(not set)'}`,
      `api key:  ${state.profile.has_api_key ? 'stored' : 'not set'}`,
      `tools:    ${tools} of ${state.tools.length} enabled`,
      `core:     ${client.info?.base_url ?? '?'} (${client.isAttached ? 'attached' : 'spawned'})`,
    ].join('\n');
  } catch (error) {
    log.warn(`could not read the core state after setup: ${error instanceof Error ? error.message : error}`);
    return 'The core is running but did not report its state.';
  }
}