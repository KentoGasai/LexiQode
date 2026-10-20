import * as vscode from 'vscode';
import { CoreFrame } from '../core/types';
import { Logger } from '../core/logger';
import { readSettings, setApiKey } from '../config';
import { Session, SessionState } from '../session';

/** Messages any chat surface sends to the extension host. */
export type InboundMessage =
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

/** A place the chat can be drawn: a sidebar view or an editor tab. */
export interface ChatSurface {
  readonly webview: vscode.Webview;
  /** Whether a human can see it, which decides how approvals are asked. */
  readonly visible: boolean;
}

/**
 * One conversation, several places to show it.
 *
 * The same transcript can be open in the side bar and in an editor tab at the
 * same time, so this owns the single set of subscriptions to the session and
 * fans everything out to whichever surfaces are attached. That also keeps
 * approvals correct: the question is drawn inline when any surface is visible,
 * and asked as a modal dialog only when none is - which is the case that used to
 * turn into a silent refusal.
 */
export class ChatController implements vscode.Disposable {
  private readonly surfaces = new Set<ChatSurface>();
  private readonly disposables: vscode.Disposable[] = [];
  /** The mode the next turn will ask for. */
  private selectedMode: string;
  /** Approvals already answered elsewhere, so a card is not drawn twice. */
  private readonly handledApprovals = new Set<string>();
  private disposed = false;

  constructor(
    private readonly session: Session,
    private readonly log: Logger,
    private readonly secrets: vscode.SecretStorage
  ) {
    this.selectedMode = session.mode;
    this.disposables.push(
      session.onFrame((frame) => void this.onFrame(frame)),
      session.onState((state) => void this.publishState(state))
    );
  }

  get mode(): string {
    return this.selectedMode;
  }

  /** True when at least one surface is on screen. */
  get anyVisible(): boolean {
    for (const surface of this.surfaces) {
      if (surface.visible) {
        return true;
      }
    }
    return false;
  }

  get surfaceCount(): number {
    return this.surfaces.size;
  }

  /** Start drawing the conversation in one more place. */
  attach(surface: ChatSurface): void {
    this.surfaces.add(surface);
    void this.sendInit(surface);
    // The core may still be starting; make sure the surface does not sit on a
    // "starting" header forever.
    if (this.session.currentState.connection !== 'ready') {
      void this.session
        .ensureClient()
        .then(() => this.publishState(this.session.currentState));
    }
  }

  detach(surface: ChatSurface): void {
    this.surfaces.delete(surface);
  }

  /** A one-off line in every open surface, e.g. an inline-edit result. */
  postNotice(text: string, isError = false): void {
    this.post({ type: 'connection', state: isError ? 'error' : 'ready', detail: text });
  }

  // ------------------------------------------------------------------ inbound

  async handle(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.broadcastInit();
        return;
      case 'send':
        await this.handleSend(message.text, message.mode);
        return;
      case 'setMode':
        // Remembered here so the next turn uses it; the core validates the id
        // again when the turn starts, so a bad value cannot slip through.
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
   * The settings sheet belongs to the agent, so it lives in the agent's own
   * surface. Only values the extension can act on are shown.
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
      // model belong to the person, not to one project.
      await config.update('baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global);
      await config.update('model', message.model.trim(), vscode.ConfigurationTarget.Global);
      await config.update(
        'maxSteps',
        Math.max(1, Math.min(200, Math.round(message.maxSteps))),
        vscode.ConfigurationTarget.Global
      );
      await config.update('autoApproveWrites', !message.askWrites, vscode.ConfigurationTarget.Global);
      await config.update('autoApproveCommands', !message.askCommands, vscode.ConfigurationTarget.Global);
      if (message.apiKey.trim()) {
        await setApiKey(this.secrets, message.apiKey);
      }

      // The key and the endpoint reach the core as environment variables, so a
      // restart is what makes them take effect.
      await this.session.restart();
      await this.session.applyPolicy();
      this.post({ type: 'settingsSaved', ok: true });
      this.broadcastInit();
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

  private broadcastInit(): void {
    for (const surface of this.surfaces) {
      void this.sendInit(surface);
    }
  }

  private async sendInit(surface: ChatSurface): Promise<void> {
    if (this.disposed || !this.surfaces.has(surface)) {
      return;
    }
    const [model, history, policy, modes] = await Promise.all([
      this.session.describeModel(),
      this.session.history(),
      this.session.policySnapshot(),
      this.session.modes(),
    ]);
    const state = this.session.currentState;
    void surface.webview.postMessage({
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

    // The mode catalogue only exists once the core is up, so refresh the mode
    // row after the connection settles instead of leaving it empty.
    if (state.connection !== 'ready') {
      void this.session.ensureClient().then(async () => {
        const available = await this.session.modes();
        if (available.length && this.surfaces.has(surface)) {
          // Deliberately not another "init": that carries the model, the policy
          // and the transcript, and a partial one would blank the header.
          void surface.webview.postMessage({
            type: 'modes',
            mode: this.selectedMode,
            modes: available,
          });
        }
      });
    }
  }

  private async onFrame(frame: CoreFrame): Promise<void> {
    if (frame.event === 'approval_request') {
      await this.onApprovalRequest(frame);
      return;
    }
    this.post({ type: 'frame', event: frame.event, data: frame.data });
  }

  /**
   * An approval blocks the turn until it is answered.
   *
   * The inline card is the primary surface. Asking as a modal dialog is the
   * fallback for when nothing is on screen, because an unseen request would
   * otherwise time out and be recorded as a refusal.
   */
  private async onApprovalRequest(frame: CoreFrame): Promise<void> {
    const data = frame.data as {
      id?: string;
      tool?: string;
      family?: string;
      summary?: string;
      detail?: string;
    };
    const id = data.id ?? '';
    if (!id || this.handledApprovals.has(id)) {
      return;
    }

    if (this.anyVisible) {
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
    this.handledApprovals.add(id);
    const delivered = await this.session.answerApproval(
      id,
      choice === 'Allow' || choice === 'Always allow',
      choice === 'Always allow',
      choice === undefined ? 'no answer from the user' : ''
    );
    if (!delivered) {
      this.postNotice('That request had already expired or been answered.', true);
    }
  }

  private async publishState(state: SessionState): Promise<void> {
    const model = state.connection === 'ready' ? await this.session.describeModel() : undefined;
    this.post({ type: 'connection', state: state.connection, detail: state.detail, model });
  }

  private post(message: unknown): void {
    for (const surface of this.surfaces) {
      void surface.webview.postMessage(message);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.surfaces.clear();
  }
}