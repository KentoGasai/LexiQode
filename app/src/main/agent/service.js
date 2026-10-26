'use strict';

/**
 * The agent, as the window sees it: one object with a status, a transcript and
 * a handful of actions.
 *
 * Everything the panel needs is routed through here so the window never holds a
 * token, never learns a port and never has to know whether the core is a child
 * process or a core that was already running. The status is explicit rather than
 * implied - `stopped`, `starting`, `ready`, `error` with a reason - because the
 * panel has to say something useful when the model is unreachable instead of
 * looking frozen.
 */

const { CoreClient, CoreRequestError } = require('./core-client');
const { CoreProcess, findPython } = require('./core-process');

const EVENT_TYPES = [
  'assistant_text',
  'text_delta',
  'reasoning_delta',
  'tool_call_delta',
  'tool_start',
  'tool_end',
  'step_start',
  'error'
];

/**
 * Describe what the user is looking at, for the agent to start from.
 *
 * Sent as a short preamble to the message rather than as a new protocol field:
 * the core already accepts a message, and the panel is the only thing that has
 * to know how a selection is phrased. The file is named by its relative path,
 * which is what the agent's own tools understand.
 */
function buildContextPreamble(context) {
  if (!context) return '';
  const parts = [];
  if (context.file) {
    parts.push(`- open file: ${context.file}${context.dirty ? ' (unsaved changes)' : ''}`);
  }
  if (typeof context.selection === 'string' && context.selection.trim()) {
    const lines = context.selectionRange
      ? ` (lines ${context.selectionRange.start}-${context.selectionRange.end})`
      : '';
    parts.push(`- selected text${lines}:\n\`\`\`${context.language || ''}\n${context.selection.trim()}\n\`\`\``);
  }
  if (context.terminalTail) {
    parts.push(`- last terminal output:\n\`\`\`\n${String(context.terminalTail).trim().slice(-1200)}\n\`\`\``);
  }
  if (!parts.length) return '';
  return `Context from the editor:\n${parts.join('\n')}\n\n`;
}

class AgentService {
  constructor({ workspace, onEvent = () => {}, onStatus = () => {}, onLog = () => {} }) {
    this.workspace = workspace;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.status = { state: 'stopped', detail: '' };
    this.process = new CoreProcess({
      workspace,
      onLog: (line) => this.onLog(line),
      onExit: ({ code, reason }) => {
        this.client?.close();
        this.client = null;
        this.streamAbort = null;
        this.#setStatus('error', `the agent stopped (exit ${code})${reason ? `: ${reason}` : ''}`);
      }
    });
    this.client = null;
    this.streamAbort = null;
    this.lastError = '';
  }

  #setStatus(state, detail = '') {
    const next = { state, detail };
    const changed = next.state !== this.status.state || next.detail !== this.status.detail;
    this.status = next;
    if (changed) this.onStatus(next);
  }

  describe() {
    const python = (() => {
      try {
        return findPython();
      } catch (error) {
        return { error: error.message };
      }
    })();
    return { ...this.status, python, lastError: this.lastError };
  }

  /** Start the core if it is not running and attach the event stream. */
  async ensureStarted() {
    if (this.client) return this.describe();
    // The core is created for one workspace: its tools resolve paths inside it
    // and its transcript belongs to it. Starting one without a folder would make
    // it work in whatever directory the window happened to be launched from.
    if (!this.workspace.current()) {
      this.#setStatus('stopped', 'no folder is open');
      throw new CoreRequestError('no folder is open', { status: 0, reason: 'no-workspace' });
    }
    this.#setStatus('starting', 'starting the agent');
    try {
      const connection = await this.process.start();
      this.client = new CoreClient(connection);
      this.#setStatus('ready', `connected on ${connection.baseUrl}`);
      this.#attachStream();
      return this.describe();
    } catch (error) {
      this.client = null;
      this.lastError = error.message;
      this.#setStatus('error', error.message);
      throw error;
    }
  }

  #attachStream() {
    if (!this.client || this.streamAbort) return;
    const controller = new AbortController();
    this.streamAbort = controller;
    void this.client.stream({
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'ready') return;
        this.onEvent({ type: EVENT_TYPES.includes(event.type) ? event.type : 'other', name: event.type, data: event.data });
      },
      onEnd: ({ reason, message }) => {
        this.streamAbort = null;
        if (reason === 'aborted' || this.status.state === 'stopped') return;
        if (reason === 'failed') {
          this.lastError = message || 'the event stream ended';
          this.#setStatus('error', this.lastError);
        } else {
          // The core closed the stream without exiting: reconnecting is right,
          // because a turn in progress is still running inside it.
          this.#setStatus('starting', 'reconnecting to the agent');
          setTimeout(() => {
            if (this.workspace.current()) void this.ensureStarted();
          }, 500);
        }
      }
    });
  }

  #require() {
    if (!this.client) throw new CoreRequestError('the agent is not running yet', { status: 0 });
    return this.client;
  }

  async state() {
    await this.ensureStarted();
    return this.#require().get('/api/state');
  }

  async history() {
    await this.ensureStarted();
    return this.#require().get('/api/history');
  }

  async send({ message, mode, context }) {
    const text = `${buildContextPreamble(context)}${String(message ?? '').trim()}`;
    if (!text.trim()) throw new CoreRequestError('the message is empty');
    await this.ensureStarted();
    return this.#require().post('/api/chat', { message: text, mode: mode || undefined, tools: true });
  }

  async cancel() {
    return this.#require().post('/api/cancel');
  }

  async reset() {
    await this.ensureStarted();
    return this.#require().post('/api/reset');
  }

  async approval({ requestId, approved, reason }) {
    // The field is named `id` by the core's route, not `request_id`; sending the
    // other name produced a 400 that looked like the approval had been ignored.
    return this.#require().post('/api/approval', {
      id: requestId,
      approved: Boolean(approved),
      reason: reason || ''
    });
  }

  /** Ask the endpoint what it offers, without storing anything. */
  async models({ profile, baseUrl, apiKey } = {}) {
    await this.ensureStarted();
    return this.#require().post('/api/models', {
      profile: profile || undefined,
      base_url: baseUrl || undefined,
      api_key: apiKey || undefined
    });
  }

  async saveProfile(patch) {
    await this.ensureStarted();
    // Settings are replaced, not created: the core exposes this route as PUT.
    return this.#require().put('/api/settings', patch);
  }

  async complete({ prompt, system, model }) {
    await this.ensureStarted();
    return this.#require().post('/api/complete', { prompt, system, model });
  }

  async stop() {
    this.#setStatus('stopped', 'stopped');
    this.client?.close();
    this.client = null;
    this.streamAbort = null;
    return this.process.stop();
  }

  /**
   * Stop and start again, for a workspace that changed.
   *
   * A running core is bound to the folder it was started in, so switching
   * folders has to replace it; keeping it would let the agent read and write the
   * previous folder while the window shows a different one.
   */
  async restart() {
    await this.stop().catch(() => {});
    return this.ensureStarted();
  }
}

module.exports = { AgentService, buildContextPreamble };