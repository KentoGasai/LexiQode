import { ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { Logger } from './logger';
import { findLiveCore, LiveCore, sameWorkspace } from './runtime';
import {
  AgentSettings,
  ChatMessage,
  CoreFrame,
  CoreState,
  HANDSHAKE_PREFIX,
  Handshake,
  HealthResponse,
  PROTOCOL_VERSION,
  ToolInfo,
} from './types';

export type ConnectionState = 'stopped' | 'starting' | 'ready' | 'error';

export interface CoreClientEvents {
  /** Every frame from /api/events, already parsed. */
  onFrame(frame: CoreFrame): void;
  onState(state: ConnectionState, detail?: string): void;
  /** The core's stderr, for the log. */
  onCoreStderr(line: string): void;
}

export interface CoreClientOptions {
  workspace: string;
  pythonPath: string;
  /** Directory that contains the `lexiqode` package, i.e. the core folder. */
  coreRoot: string;
  /** Extra environment for the child, e.g. LEXIQODE_API_KEY. */
  env?: Record<string, string>;
  attachToRunningCore?: boolean;
  log: Logger;
  events: CoreClientEvents;
}

const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const STREAM_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Raised for a non-2xx API response, carrying the core's own message. */
export class CoreRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CoreRequestError';
  }
}

/**
 * Owns the connection to one core process.
 *
 * Two ways to be connected: attach to a core that another window already
 * started, or spawn one. In both cases the token stays inside the extension
 * host - it is used on the HTTP calls and on the event stream here, and is never
 * handed to a webview.
 */
export class CoreClient {
  private readonly options: CoreClientOptions;
  private readonly log: Logger;
  private child?: ChildProcess;
  private handshake?: Handshake;
  private attached?: LiveCore;
  private streamRequest?: http.ClientRequest;
  private streamBuffer = '';
  private retryIndex = 0;
  private retryTimer?: NodeJS.Timeout;
  private disposed = false;
  private state: ConnectionState = 'stopped';
  private starting?: Promise<void>;

  constructor(options: CoreClientOptions) {
    this.options = options;
    this.log = options.log;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get info(): Handshake | undefined {
    return this.handshake;
  }

  get isAttached(): boolean {
    return this.attached !== undefined;
  }

  get baseUrl(): string | undefined {
    return this.handshake?.base_url;
  }

  get workspace(): string {
    return this.options.workspace;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Attach to a live core, or spawn one. Safe to call repeatedly. */
  start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setState('starting');

    if (this.options.attachToRunningCore !== false) {
      const live = await findLiveCore(this.options.workspace, process.env);
      if (live && live.token) {
        this.attached = live;
        this.handshake = {
          product: live.health.product,
          version: live.health.version,
          protocol: live.health.protocol,
          base_url: live.baseUrl,
          host: '',
          port: live.descriptor.port ?? 0,
          token: live.token,
          pid: live.health.pid,
          workspace: live.health.workspace,
        };
        this.log.info(
          `attached to the core already running for this workspace (pid ${live.health.pid}, ${live.baseUrl})`
        );
        this.setState('ready');
        this.openEventStream();
        return;
      }
    }

    await this.spawnCore();
  }

  private async spawnCore(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      // The core must not buffer, or the handshake line would arrive late.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    const args = ['-m', 'lexiqode', 'serve', this.options.workspace];
    this.log.info(`starting core: ${this.options.pythonPath} ${args.join(' ')} (cwd ${this.options.coreRoot})`);

    const child = spawn(this.options.pythonPath, args, {
      cwd: this.options.coreRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const stderrTail: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        stderrTail.push(line);
        if (stderrTail.length > 40) {
          stderrTail.shift();
        }
        this.options.events.onCoreStderr(line);
      }
    });

    child.on('error', (error) => {
      this.fail(`cannot start the core (${this.options.pythonPath}): ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.disposed) {
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.closeStream();
      this.handshake = undefined;
      this.setState('stopped', `the core exited (${reason})`);
      this.log.warn(`core exited: ${reason}`);
    });

    try {
      const handshake = await this.readHandshake(child, stderrTail);
      this.handshake = handshake;
      this.log.info(
        `core ready: ${handshake.product} ${handshake.version} (protocol ${handshake.protocol}), pid ${handshake.pid}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(message);
      throw error;
    }

    if (this.handshake.protocol !== PROTOCOL_VERSION) {
      const message =
        `the core speaks protocol ${this.handshake.protocol} but this extension implements ` +
        `${PROTOCOL_VERSION}; update whichever is older`;
      this.fail(message);
      throw new Error(message);
    }

    this.setState('ready');
    this.openEventStream();
  }

  /** Read the single handshake line, or reject with the core's own stderr. */
  private readHandshake(child: ChildProcess, stderrTail: string[]): Promise<Handshake> {
    return new Promise<Handshake>((resolve, reject) => {
      let buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(this.explainNoHandshake(stderrTail, 'the core did not report readiness in time')));
        }
      }, START_TIMEOUT_MS);

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          return;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line.startsWith(HANDSHAKE_PREFIX)) {
          settle(() =>
            reject(
              new Error(
                `the core printed something other than a handshake on stdout: ${JSON.stringify(line.slice(0, 200))}`
              )
            )
          );
          return;
        }
        try {
          const payload = JSON.parse(line.slice(HANDSHAKE_PREFIX.length).trim()) as Handshake;
          if (!payload.base_url || !payload.token) {
            throw new Error('the handshake is missing base_url or token');
          }
          settle(() => resolve(payload));
        } catch (error) {
          settle(() =>
            reject(new Error(`the handshake could not be parsed: ${error instanceof Error ? error.message : error}`))
          );
        }
      });

      child.on('exit', () => {
        settle(() => reject(new Error(this.explainNoHandshake(stderrTail, 'the core exited before reporting readiness'))));
      });
    });
  }

  private explainNoHandshake(stderrTail: string[], headline: string): string {
    const detail = stderrTail.length ? `\n${stderrTail.join('\n')}` : '';
    return `${headline}. Check the LexiQode log for details.${detail}`;
  }

  private fail(message: string): void {
    this.log.error(message);
    this.setState('error', message);
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state && !detail) {
      return;
    }
    this.state = state;
    this.options.events.onState(state, detail);
  }

  /** Stop the core. Closing stdin is the portable shutdown the protocol defines. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.closeStream();
    const child = this.child;
    this.child = undefined;
    this.handshake = undefined;
    if (!child) {
      return;
    }
    if (child.exitCode === null && !child.killed) {
      child.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // A core that will not stop must not hold the window open.
          child.kill();
          resolve();
        }, 5_000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.setState('stopped');
  }

  /** Throw away the current core and start a fresh one. */
  async restart(): Promise<void> {
    this.log.info('restarting the core');
    const wasDisposed = this.disposed;
    await this.dispose();
    this.disposed = wasDisposed;
    await this.start();
  }

  // ------------------------------------------------------------------ SSE stream

  private openEventStream(): void {
    if (this.disposed || !this.handshake) {
      return;
    }
    this.closeStream();
    const url = new URL('/api/events', this.handshake.base_url);
    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.handshake.token}`,
          'Cache-Control': 'no-cache',
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          this.scheduleReconnect(`the event stream answered HTTP ${response.statusCode}`);
          return;
        }
        this.retryIndex = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => this.consumeStream(chunk));
        response.on('end', () => this.scheduleReconnect('the event stream closed'));
        response.on('error', (error) => this.scheduleReconnect(error.message));
      }
    );
    request.on('error', (error) => this.scheduleReconnect(error.message));
    this.streamRequest = request;
  }

  private closeStream(): void {
    const request = this.streamRequest;
    this.streamRequest = undefined;
    this.streamBuffer = '';
    if (request) {
      request.destroy();
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.retryTimer) {
      return;
    }
    this.closeStream();
    const delay = STREAM_RETRY_DELAYS_MS[Math.min(this.retryIndex, STREAM_RETRY_DELAYS_MS.length - 1)];
    this.retryIndex += 1;
    this.log.warn(`event stream interrupted (${reason}); retrying in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.openEventStream();
    }, delay);
  }

  /** Incremental SSE parsing: complete frames end with a blank line. */
  private consumeStream(chunk: string): void {
    this.streamBuffer += chunk.replace(/\r\n/g, '\n');
    let separator = this.streamBuffer.indexOf('\n\n');
    while (separator >= 0) {
      const raw = this.streamBuffer.slice(0, separator);
      this.streamBuffer = this.streamBuffer.slice(separator + 2);
      this.dispatchFrame(raw);
      separator = this.streamBuffer.indexOf('\n\n');
    }
  }

  private dispatchFrame(raw: string): void {
    let name = '';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        name = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }
    if (!name) {
      return;
    }
    let data: Record<string, unknown> = {};
    if (dataLines.length) {
      try {
        data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      } catch (error) {
        this.log.warn(`could not parse a ${name} frame: ${error instanceof Error ? error.message : error}`);
        return;
      }
    }
    if (name === 'ready') {
      const protocol = Number(data.protocol ?? 0);
      if (protocol && protocol !== PROTOCOL_VERSION) {
        this.fail(`the core reports protocol ${protocol}, this extension implements ${PROTOCOL_VERSION}`);
      }
      return;
    }
    this.options.events.onFrame({ event: name, data });
  }

  // ------------------------------------------------------------------ API calls

  private async request<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (!this.handshake) {
      throw new Error('the core is not running');
    }
    const url = new URL(apiPath, this.handshake.base_url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.handshake?.token ?? ''}`,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, unknown> = {};
            if (text.trim()) {
              try {
                parsed = JSON.parse(text) as Record<string, unknown>;
              } catch {
                reject(new CoreRequestError(`the core returned non-JSON for ${apiPath}: ${text.slice(0, 200)}`, response.statusCode ?? 0));
                return;
              }
            }
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const message = typeof parsed.error === 'string' ? parsed.error : `HTTP ${status} from ${apiPath}`;
              reject(new CoreRequestError(message, status));
              return;
            }
            resolve(parsed as T);
          });
        }
      );
      request.on('timeout', () => {
        request.destroy(new Error(`the core did not answer ${apiPath} within ${timeoutMs} ms`));
      });
      request.on('error', (error) => reject(error));
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  }

  async getState(): Promise<CoreState> {
    return this.request<CoreState>('GET', '/api/state');
  }

  async getHistory(): Promise<ChatMessage[]> {
    const payload = await this.request<{ messages: ChatMessage[] }>('GET', '/api/history');
    return payload.messages ?? [];
  }

  async getTools(): Promise<ToolInfo[]> {
    const payload = await this.request<{ tools: ToolInfo[] }>('GET', '/api/tools');
    return payload.tools ?? [];
  }

  /**
   * Start a turn.
   *
   * `mode` selects what the agent may do; the core refuses an unknown id with a
   * 400 naming the valid ones. `tools: false` answers without offering any tool
   * schema at all, which an inline edit needs.
   */
  async startTurn(
    message: string,
    options: { mode?: string; tools?: boolean } = {}
  ): Promise<{ mode: string }> {
    const payload = await this.request<{ mode: string }>('POST', '/api/chat', {
      message,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
    return payload;
  }

  async cancel(): Promise<void> {
    await this.request('POST', '/api/cancel', {});
  }

  async reset(): Promise<void> {
    await this.request('POST', '/api/reset', {});
  }

  async answerApproval(id: string, approved: boolean, remember = false, reason = ''): Promise<boolean> {
    const payload = await this.request<{ delivered: boolean }>('POST', '/api/approval', {
      id,
      approved,
      remember,
      reason,
    });
    return Boolean(payload.delivered);
  }

  async patchSettings(patch: {
    agent?: Partial<AgentSettings>;
    profile?: Record<string, unknown>;
  }): Promise<void> {
    await this.request('PUT', '/api/settings', patch);
  }

  async listModels(profile?: string): Promise<string[]> {
    const payload = await this.request<{ models: string[] }>('POST', '/api/models', profile ? { profile } : {});
    return payload.models ?? [];
  }

  /**
   * One-shot completion for editor features such as an inline edit.
   *
   * Not a turn: no history, no tools, and its own model call, so it is safe to
   * use while a chat turn is running. Generating a replacement for a large
   * selection can take a while, hence the separate timeout.
   */
  async complete(
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
      profile?: string;
      model?: string;
    } = {}
  ): Promise<string> {
    const payload = await this.request<{ text: string }>(
      'POST',
      '/api/complete',
      {
        prompt,
        ...(options.system ? { system: options.system } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.model ? { model: options.model } : {}),
      },
      180_000
    );
    return payload.text ?? '';
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/api/health');
  }

  /** True when the attached or spawned core is the one serving this workspace. */
  isForWorkspace(): boolean {
    return sameWorkspace(this.workspace, this.handshake?.workspace ?? '');
  }

  /** The Python package root, resolved for the spawn and for diagnostics. */
  coreRoot(): string {
    return path.resolve(this.options.coreRoot);
  }
}