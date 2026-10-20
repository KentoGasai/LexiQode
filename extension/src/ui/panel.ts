import * as vscode from 'vscode';
import { CoreFrame } from '../core/types';
import { Logger } from '../core/logger';
import { readSettings, setApiKey } from '../config';
import { Session, SessionState } from '../session';
import { renderChatHtml } from './webview';

/** Messages the webview sends to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; mode?: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'approval'; id: string; approved: boolean; remember: boolean }
  | { type: 'openChange'; path: string; created: boolean }
  | { type: 'policy'; writes: boolean; commands: boolean }
  | { type: 'setMode'; mode: string }
  | { type: 'loadSettings' }
  | {
      type: 'saveSettings';
      baseUrl: string;
      model: string;
      apiKey: string;
      maxSteps: number;
      askWrites: boolean;
      askCommands: boolean;
    };

/**
 * The sidebar chat.
 *
 * The view is disposable - the user collapses it, or the window reloads - while
 * the session is not, so every subscription here is torn down in `dispose` and
 * rebuilt from the session's own state on the next `resolveWebviewView`.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'lexiqode.chat';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  /** The mode the panel will ask for on the next turn. */
  private selectedMode: string;
  /** Approvals already answered from the native dialog, so the card is not shown twice. */
  private readonly handledApprovals = new Set<string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly log: Logger,
    private readonly secrets: vscode.SecretStorage
  ) {
    this.selectedMode = session.mode;
    this.disposables.push(
      session.onFrame((frame) => this.forwardFrame(frame)),
      session.onState((state) => void this.publishState(state))
    );
  }

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = renderChatHtml(view.webview, this.extensionUri);

    view.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handleMessage(message),
      undefined,
      this.disposables
    );
    view.onDidDispose(() => {
      this.view = undefined;
    }, undefined, this.disposables);

    // The core may already be running from a previous view, so refresh the panel
    // from the session rather than waiting for the next event.
    void this.sendInit();
  }

  /** Bring the view into focus, resolving it first if the sidebar was never opened. */
  async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      return;
    }
    this.view.show?.(true);
  }

  /** Push a one-off notice into the chat, e.g. an inline-edit result. */
  postNotice(text: string, isError = false): void {
    this.view?.webview.postMessage({ type: 'connection', state: isError ? 'error' : 'ready', detail: text });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  // ------------------------------------------------------------------ inbound

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendInit();
        return;
      case 'send':
        await this.handleSend(message.text, message.mode);
        return;
      case 'setMode':
        // The selection is remembered here so the next turn uses it; the core
        // validates the id again when the turn starts.
        this.selectedMode = message.mode;
        this.post({ type: 'mode', mode: this.selectedMode });
        return;
      case 'loadSettings':
        await this.handleLoadSettings();
        return;
      case 'saveSettings':
        await this.handleSaveSettings(message);
        return;
      case 'cancel':
        await this.session.cancel();
        return;
      case 'newSession':
        await this.session.reset();
        return;
      case 'approval':
        await this.handleApprovalAnswer(message.id, message.approved, message.remember);
        return;
      case 'openChange':
        await this.session.openChange(message.path, message.created);
        return;
      case 'policy': {
        const settings = vscode.workspace.getConfiguration('lexiqode');
        await settings.update('autoApproveWrites', message.writes, vscode.ConfigurationTarget.Workspace);
        await settings.update('autoApproveCommands', message.commands, vscode.ConfigurationTarget.Workspace);
        await this.session.applyPolicy({ writes: message.writes, commands: message.commands });
        return;
      }
      default:
        return;
    }
  }

  private async handleSend(text: string, mode?: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    try {
      const chosen = mode || this.selectedMode;
      await this.session.send(trimmed, chosen);
      if (chosen) {
        this.selectedMode = chosen;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('the turn could not be started', error);
      this.postNotice(message, true);
    }
  }

  /**
   * The settings sheet is the agent's own settings, so it lives in the agent's
   * own surface. Only the values the extension can actually act on are shown.
   */
  private async handleLoadSettings(): Promise<void> {
    const settings = readSettings();
    let hasApiKey = false;
    try {
      hasApiKey = (await this.secrets.get('lexiqode.apiKey')) !== undefined;
    } catch {
      hasApiKey = false;
    }
    this.post({
      type: 'settings',
      values: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        maxSteps: settings.maxSteps,
        askWrites: !settings.autoApproveWrites,
        askCommands: !settings.autoApproveCommands,
        hasApiKey,
      },
    });
  }

  private async handleSaveSettings(message: {
    baseUrl: string;
    model: string;
    apiKey: string;
    maxSteps: number;
    askWrites: boolean;
    askCommands: boolean;
  }): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('lexiqode');
      // Written to the user's settings, not the workspace's: an endpoint and a
      // model are properties of the person, not of one project.
      await config.update('baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global);
      await config.update('model', message.model.trim(), vscode.ConfigurationTarget.Global);
      await config.update(
        'maxSteps',
        Math.max(1, Math.min(200, Math.round(message.maxSteps))),
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        'autoApproveWrites',
        !message.askWrites,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        'autoApproveCommands',
        !message.askCommands,
        vscode.ConfigurationTarget.Global
      );
      if (message.apiKey.trim()) {
        await setApiKey(this.secrets, message.apiKey);
      }

      // The key and the endpoint reach the core as environment variables, so a
      // restart is what makes them take effect.
      await this.session.restart();
      await this.session.applyPolicy();
      this.post({ type: 'settingsSaved', ok: true });
      await this.sendInit();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.error('could not save the agent settings', error);
      this.post({ type: 'settingsSaved', ok: false, error: detail });
    }
  }

  private async handleApprovalAnswer(id: string, approved: boolean, remember: boolean): Promise<void> {
    this.handledApprovals.add(id);
    const delivered = await this.session.answerApproval(id, approved, remember);
    if (!delivered) {
      this.postNotice('That request had already expired or been answered.', true);
    }
  }

  // ------------------------------------------------------------------ outbound

  private async sendInit(): Promise<void> {
    const [model, history, policy, modes] = await Promise.all([
      this.session.describeModel(),
      this.session.history(),
      this.session.policySnapshot(),
      this.session.modes(),
    ]);
    const state = this.session.currentState;
    this.post({
      type: 'init',
      connection: state.connection,
      model,
      mode: this.selectedMode,
      modes,
      allowWrites: policy.writes,
      allowCommands: policy.commands,
      history,
      notice: state.detail,
    });

    // The catalogue only exists once the core is up, so refresh the mode row
    // after the connection settles instead of leaving it empty.
    if (state.connection !== 'ready') {
      void this.session.ensureClient().then(async () => {
        const available = await this.session.modes();
        if (available.length) {
          this.post({ type: 'init', connection: this.session.currentState.connection, mode: this.selectedMode, modes: available });
        }
      });
    }
    if (state.connection !== 'ready') {
      void this.session.ensureClient().then(() => this.publishState(this.session.currentState));
    }
  }

  private forwardFrame(frame: CoreFrame): void {
    if (frame.event === 'approval_request') {
      void this.handleApprovalRequest(frame);
      return;
    }
    this.post({ type: 'frame', event: frame.event, data: frame.data });
  }

  /**
   * An approval is a blocking request: the core waits until it is answered.
   *
   * The inline card is the primary surface, but if the sidebar is collapsed the
   * user would never see it and the request would expire as a refusal. So when
   * the view is not visible the same question is asked as a modal dialog, and
   * the answer is delivered from here.
   */
  private async handleApprovalRequest(frame: CoreFrame): Promise<void> {
    const data = frame.data as {
      id?: string;
      tool?: string;
      family?: string;
      summary?: string;
      detail?: string;
    };
    const id = data.id ?? '';
    if (!id) {
      return;
    }

    if (this.isVisible) {
      this.post({ type: 'frame', event: frame.event, data: frame.data });
      return;
    }

    const isCommand = data.family === 'command';
    const choice = await vscode.window.showWarningMessage(
      `LexiQode wants to ${isCommand ? 'run a command' : 'change files'}: ${data.summary ?? data.tool ?? ''}`,
      { modal: true, detail: data.detail || undefined },
      'Allow',
      'Always allow',
      'Deny'
    );
    const approved = choice === 'Allow' || choice === 'Always allow';
    const remember = choice === 'Always allow';
    this.handledApprovals.add(id);
    const delivered = await this.session.answerApproval(
      id,
      approved,
      remember,
      choice === undefined ? 'no answer from the user' : ''
    );
    if (!delivered) {
      this.postNotice('That request had already expired or been answered.', true);
    }
  }

  private async publishState(state: SessionState): Promise<void> {
    this.post({
      type: 'connection',
      state: state.connection,
      detail: state.detail,
      model: state.connection === 'ready' ? await this.session.describeModel() : undefined,
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}