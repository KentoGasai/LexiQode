import * as vscode from 'vscode';
import { CoreFrame } from '../core/types';
import { Logger } from '../core/logger';
import { Session, SessionState } from '../session';
import { renderChatHtml } from './webview';

/** Messages the webview sends to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'approval'; id: string; approved: boolean; remember: boolean }
  | { type: 'openChange'; path: string; created: boolean }
  | { type: 'policy'; writes: boolean; commands: boolean };

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
  /** Approvals already answered from the native dialog, so the card is not shown twice. */
  private readonly handledApprovals = new Set<string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly log: Logger
  ) {
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
        await this.handleSend(message.text);
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

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    try {
      await this.session.send(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('the turn could not be started', error);
      this.postNotice(message, true);
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
    const [model, history, policy] = await Promise.all([
      this.session.describeModel(),
      this.session.history(),
      this.session.policySnapshot(),
    ]);
    const state = this.session.currentState;
    this.post({
      type: 'init',
      connection: state.connection,
      model,
      allowWrites: policy.writes,
      allowCommands: policy.commands,
      history,
      notice: state.detail,
    });
    // Starting the core can take a moment; make sure the header is not stuck.
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