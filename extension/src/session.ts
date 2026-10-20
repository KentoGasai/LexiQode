import * as vscode from 'vscode';
import { CoreClient, ConnectionState } from './core/client';
import { Logger } from './core/logger';
import { AgentModeInfo, CoreFrame, Handshake, ToolEndEvent, ToolStartEvent } from './core/types';
import {
  agentPatch,
  coreEnvironment,
  EditorSettings,
  getApiKey,
  readSettings,
  resolveCoreRoot,
} from './config';
import { ChangeTracker } from './ui/changeTracker';

export interface SessionState {
  connection: ConnectionState;
  detail?: string;
  model?: string;
  version?: string;
  attached?: boolean;
}

/**
 * Owns everything that outlives a single panel view: the core process, the
 * conversation policy and the change tracker.
 *
 * The panel comes and goes as the user collapses or reopens the sidebar; the
 * session does not. That is what keeps a running turn alive across a view
 * reload, and why the core is started here rather than in the view provider.
 */
export class Session implements vscode.Disposable {
  private client?: CoreClient;
  private starting?: Promise<CoreClient | undefined>;
  private disposed = false;

  private readonly frameEmitter = new vscode.EventEmitter<CoreFrame>();
  readonly onFrame = this.frameEmitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<SessionState>();
  readonly onState = this.stateEmitter.event;

  private readonly tracker: ChangeTracker;
  private state: SessionState = { connection: 'stopped' };

  constructor(
    private readonly log: Logger,
    private readonly secrets: vscode.SecretStorage
  ) {
    const settings = readSettings();
    this.tracker = new ChangeTracker(log, {
      showDiffs: settings.showDiffs,
      revealNewFiles: settings.revealChangedFile,
    });
  }

  get currentState(): SessionState {
    return this.state;
  }

  get workspace(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get handshake(): Handshake | undefined {
    return this.client?.info;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the core if it is not running. Resolves with the client, or undefined on failure. */
  ensureClient(): Promise<CoreClient | undefined> {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doEnsure().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doEnsure(): Promise<CoreClient | undefined> {
    if (this.disposed) {
      return undefined;
    }
    const workspace = this.workspace;
    if (!workspace) {
      this.publish({ connection: 'error', detail: 'Open a folder first: LexiQode works inside a workspace.' });
      return undefined;
    }
    if (this.client && this.client.connectionState === 'ready') {
      return this.client;
    }

    const settings = readSettings();
    const coreRoot = resolveCoreRoot(settings);
    if (!coreRoot) {
      this.publish({
        connection: 'error',
        detail:
          'The LexiQode core was not found. Set "lexiqode.coreRoot" to the folder that contains the lexiqode package.',
      });
      return undefined;
    }
    const apiKey = await getApiKey(this.secrets);

    const client = new CoreClient({
      workspace,
      pythonPath: settings.pythonPath,
      coreRoot,
      env: coreEnvironment(settings, apiKey),
      attachToRunningCore: settings.attachToRunningCore,
      log: this.log,
      events: {
        onFrame: (frame) => this.handleFrame(frame),
        onState: (state, detail) => this.publish({ connection: state, detail }),
        onCoreStderr: (line) => this.log.core(line),
      },
    });
    this.client = client;

    try {
      await client.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ connection: 'error', detail: message });
      return undefined;
    }

    if (client.connectionState !== 'ready') {
      return undefined;
    }

    await this.applyPolicy().catch((error) => {
      this.log.warn(`could not apply the agent policy: ${error instanceof Error ? error.message : error}`);
    });

    const handshake = client.info;
    this.publish({
      connection: 'ready',
      model: handshake ? `${handshake.product} ${handshake.version}` : undefined,
      version: handshake?.version,
      attached: client.isAttached,
    });
    if (handshake) {
      this.log.info(`connected to ${handshake.base_url} (${client.isAttached ? 'attached' : 'spawned'})`);
    }
    return client;
  }

  /** Push the editor's approval policy into the running core. */
  async applyPolicy(overrides?: { writes?: boolean; commands?: boolean }): Promise<void> {
    const client = this.client;
    if (!client || client.connectionState !== 'ready') {
      return;
    }
    const settings = readSettings();
    const patch = agentPatch(settings);
    if (overrides?.writes !== undefined) {
      patch.approve_writes = !overrides.writes;
    }
    if (overrides?.commands !== undefined) {
      patch.approve_commands = !overrides.commands;
    }
    await client.patchSettings({
      agent: { max_steps: patch.max_steps },
      profile: this.profilePatch(settings),
    });
    // Writes and commands are toggled separately because the API validates them
    // as booleans, and a partial patch is cheaper than a full settings write.
    await client.patchSettings({
      agent: { approve_writes: patch.approve_writes, approve_commands: patch.approve_commands },
    });
  }

  private profilePatch(settings: EditorSettings): Record<string, unknown> | undefined {
    if (!settings.baseUrl && !settings.model) {
      return undefined;
    }
    const patch: Record<string, unknown> = {};
    if (settings.baseUrl) {
      patch.base_url = settings.baseUrl;
    }
    if (settings.model) {
      patch.model = settings.model;
    }
    return patch;
  }

  async restart(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.dispose();
    }
    await this.ensureClient();
  }

  // ------------------------------------------------------------------ actions

  async send(text: string, mode?: string): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      throw new Error('the core is not running');
    }
    const chosen = mode || this.lastMode;
    const started = await client.startTurn(text, { mode: chosen });
    if (started?.mode) {
      this.lastMode = started.mode;
    }
  }

  /** The mode a turn uses when the caller does not name one. */
  private lastMode = 'agent';

  get mode(): string {
    return this.lastMode;
  }

  /**
   * The mode catalogue, read from the core so the menu and the enforcement
   * cannot disagree: the core is the only thing that decides what a mode allows.
   */
  async modes(): Promise<AgentModeInfo[]> {
    const client = this.client;
    if (!client || client.connectionState !== 'ready') {
      return [];
    }
    try {
      return (await client.getState()).modes ?? [];
    } catch (error) {
      this.log.warn(`could not read the mode list: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  async cancel(): Promise<void> {
    await this.client?.cancel();
  }

  async reset(): Promise<void> {
    await this.client?.reset();
  }

  async openChange(relative: string, created: boolean): Promise<void> {
    await this.tracker.openChanged(relative, created);
  }

  /**
   * Answer a pending approval. Returns false when the core had already resolved
   * it - expired, cancelled, or answered in another window - which the caller
   * should show rather than retry.
   */
  async answerApproval(id: string, approved: boolean, remember = false, reason = ''): Promise<boolean> {
    const client = this.client;
    if (!client || client.connectionState !== 'ready') {
      return false;
    }
    try {
      return await client.answerApproval(id, approved, remember, reason);
    } catch (error) {
      this.log.warn(`could not answer the approval: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /** The model id shown in the panel header. */
  async describeModel(): Promise<string> {
    const client = this.client;
    if (!client || client.connectionState !== 'ready') {
      return 'not connected';
    }
    try {
      const state = await client.getState();
      const endpoint = state.profile.base_url || 'endpoint not set';
      const key = state.profile.has_api_key ? '' : ' (no API key)';
      return `${state.profile.model} - ${endpoint}${key}`;
    } catch (error) {
      this.log.warn(`could not read the core state: ${error instanceof Error ? error.message : error}`);
      return 'connected';
    }
  }

  async history(): Promise<unknown[]> {
    const client = this.client;
    if (!client || client.connectionState !== 'ready') {
      return [];
    }
    try {
      return await client.getHistory();
    } catch {
      return [];
    }
  }

  async policySnapshot(): Promise<{ writes: boolean; commands: boolean }> {
    const client = this.client;
    if (client && client.connectionState === 'ready') {
      try {
        const state = await client.getState();
        return {
          writes: !state.agent.approve_writes,
          commands: !state.agent.approve_commands,
        };
      } catch {
        // Fall through to the editor settings.
      }
    }
    const settings = readSettings();
    return { writes: settings.autoApproveWrites, commands: settings.autoApproveCommands };
  }

  // ------------------------------------------------------------------ internals

  private handleFrame(frame: CoreFrame): void {
    try {
      if (frame.event === 'tool_start') {
        this.tracker.onToolStart(frame.data as unknown as ToolStartEvent);
      } else if (frame.event === 'tool_end') {
        void this.tracker.onToolEnd(frame.data as unknown as ToolEndEvent);
      }
    } catch (error) {
      this.log.warn(`change tracking failed: ${error instanceof Error ? error.message : error}`);
    }
    this.frameEmitter.fire(frame);
  }

  private publish(update: Partial<SessionState> & { connection: ConnectionState }): void {
    this.state = { ...this.state, ...update };
    this.stateEmitter.fire(this.state);
  }

  dispose(): void {
    this.disposed = true;
    this.tracker.dispose();
    this.frameEmitter.dispose();
    this.stateEmitter.dispose();
    const client = this.client;
    this.client = undefined;
    void client?.dispose();
  }
}