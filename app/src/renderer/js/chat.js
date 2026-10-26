/*
 * The assistant panel.
 *
 * The panel is a view of the core's transcript, never a second copy of it: a
 * turn is drawn from the events the core emits, the history is drawn from the
 * core's own history, and every action is a call the core already documents.
 * That is why reopening the window shows the conversation intact and why nothing
 * here has to guess what the agent did.
 *
 * The event names and field names below are the contract the core publishes -
 * `text_delta {text}`, `assistant_text {text}`, `step_start {step, max_steps}`,
 * `tool_start`/`tool_end`, `turn_start`, `turn_end`, `error {message}` - and were
 * confirmed against a real turn before this file was written.
 *
 * Modes live in the composer, at the bottom, because that is where the decision
 * is made: what the next message is allowed to do. The header carries status
 * only.
 */

import { clear, el, toast } from './ui.js';
import { renderMarkdown, toPlainText } from './markdown.js';

const FALLBACK_MODES = [
  { id: 'agent', label: 'Agent', hint: 'Do the work: read, edit and run what the task needs.' },
  { id: 'ask', label: 'Ask', hint: 'Answer from what is already known. No edits, no commands.' },
  { id: 'plan', label: 'Plan', hint: 'Read and propose a plan. Nothing is changed.' },
  { id: 'debug', label: 'Debug', hint: 'Find the cause, then fix it and prove the fix.' },
  { id: 'review', label: 'Review', hint: 'Read the change and report problems. No edits.' }
];

export function createChat({ api, bus, settings, onNotice, editor }) {
  const transcript = document.getElementById('transcript');
  const input = document.getElementById('composer-input');
  const sendButton = document.getElementById('composer-send');
  const stopButton = document.getElementById('composer-stop');
  const modesHost = document.getElementById('composer-modes');
  const contextHost = document.getElementById('composer-context');
  const dot = document.getElementById('chat-dot');
  const actions = document.getElementById('chat-actions');
  const agentChip = document.getElementById('titlebar-agent');

  const state = {
    modes: FALLBACK_MODES,
    mode: FALLBACK_MODES[0].id,
    agent: { state: 'stopped', detail: '' },
    running: false,
    current: null,
    reasoning: null,
    tools: new Map(),
    approvals: new Map(),
    settingsOpen: false
  };

  // ------------------------------------------------------------- transcript

  function atBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
  }

  function scrollIfFollowing(following) {
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }

  function turn(role, { kind = '' } = {}) {
    const node = el('div', { class: `turn turn--${role}${kind ? ` turn--${kind}` : ''}` });
    const who = el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: role })]);
    const body = el('div', { class: 'turn__body' });
    node.append(who, body);
    transcript.append(node);
    return { node, body, who };
  }

  function addUser(text) {
    const created = turn('user');
    created.body.textContent = text;
    return created;
  }

  function addAssistant() {
    const created = turn('assistant');
    created.meta = el('div', { class: 'turn__meta' });
    created.node.append(created.meta);
    created.text = '';
    return created;
  }

  function addError(message) {
    const created = turn('assistant', { kind: 'error' });
    created.body.textContent = message;
    toast('error', message);
    return created;
  }

  function renderAssistant(created, streaming) {
    created.body.innerHTML = renderMarkdown(created.text);
    if (created.meta) {
      clear(created.meta);
      if (streaming) {
        created.meta.append(el('span', { class: 'spinner' }), el('span', { text: 'working' }));
      } else if (created.steps) {
        created.meta.append(el('span', { text: `${created.steps} step${created.steps === 1 ? '' : 's'}` }));
      }
    }
    for (const link of created.body.querySelectorAll('a[data-external]')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void api.shell.openExternal(link.getAttribute('href')).catch((error) => toast('error', error.message));
      });
    }
  }

  function reasoningBlock() {
    if (!state.reasoning) {
      const created = turn('assistant');
      created.node.classList.add('turn--reasoning');
      created.reasoningNode = el('div', { class: 'reasoning' });
      created.node.insertBefore(created.reasoningNode, created.body);
      created.reasoningNode.hidden = false;
      created.text = '';
      state.reasoning = created;
    }
    return state.reasoning;
  }

  function toolRow(payload, phase) {
    const id = String(payload.id || payload.call_id || payload.tool_call_id || payload.name || Math.random());
    let created = state.tools.get(id);
    if (!created) {
      created = {
        name: payload.name || payload.tool || 'tool',
        detail: payload.arguments || payload.args || payload.input || '',
        result: '',
        node: el('div', { class: 'tool', dataset: { state: 'running' } })
      };
      created.label = el('span', { class: 'tool__name', text: created.name });
      created.detailNode = el('span', { class: 'tool__detail' });
      created.stateNode = el('span', { class: 'tool__state' });
      created.node.append(created.label, created.detailNode, created.stateNode);
      transcript.append(created.node);
      state.tools.set(id, created);
    }
    if (payload.name || payload.tool) created.name = payload.name || payload.tool;
    if (payload.arguments || payload.args || payload.input) {
      created.detail = payload.arguments || payload.args || payload.input;
    }
    if (phase === 'end') {
      created.result = payload.result || payload.output || payload.message || '';
      const failed = payload.ok === false || payload.error || payload.status === 'error';
      created.node.dataset.state = failed ? 'failed' : 'done';
      created.stateNode.textContent = failed ? 'failed' : 'done';
    } else {
      created.node.dataset.state = 'running';
      created.stateNode.textContent = 'running';
    }
    created.label.textContent = created.name;
    created.detailNode.textContent = toPlainText(String(created.detail), 90);
    created.detailNode.title = `${created.name}\n\n${String(created.detail).slice(0, 1200)}\n\n${String(created.result).slice(0, 1200)}`;
    scrollIfFollowing(atBottom());
  }

  function approvalCard(payload) {
    const id = String(payload.request_id || payload.id || '');
    if (!id || state.approvals.has(id)) return;
    const what = payload.detail || payload.command || payload.path || payload.summary || 'the agent wants to continue';
    const node = el('div', { class: 'approval' });
    node.append(
      el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: 'approval needed' })]),
      el('div', { class: 'approval__what', text: `${payload.tool || payload.name || 'action'}\n${what}` }),
      el('div', { class: 'approval__row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Approve',
          onclick: () => void decide(id, true, node)
        }),
        el('button', { class: 'btn', type: 'button', text: 'Deny', onclick: () => void decide(id, false, node) })
      ])
    );
    transcript.append(node);
    state.approvals.set(id, node);
    scrollIfFollowing(atBottom());
  }

  async function decide(id, approved, node) {
    try {
      await api.agent.approval({ requestId: id, approved, reason: approved ? '' : 'denied in the editor' });
      node.remove();
      state.approvals.delete(id);
    } catch (error) {
      toast('error', error.message);
    }
  }

  // --------------------------------------------------------- agent events

  function applyStatus(status) {
    state.agent = status || { state: 'stopped', detail: '' };
    const known = ['ready', 'starting', 'error'];
    dot.dataset.state = known.includes(state.agent.state) ? state.agent.state : 'off';
    dot.title = state.agent.detail || state.agent.state;
    agentChip.textContent = `agent: ${state.agent.state}`;
    agentChip.title = state.agent.detail || '';
    if (state.agent.state !== 'ready') {
      state.running = false;
      renderRunning();
    }
  }

  function renderRunning() {
    stopButton.hidden = !state.running;
    sendButton.disabled = state.running;
    sendButton.textContent = state.running ? 'Working…' : 'Send';
  }

  function handleEvent(event) {
    const data = event.data || {};
    switch (event.name) {
      case 'turn_start':
        state.running = true;
        state.reasoning = null;
        state.current = addAssistant();
        renderRunning();
        break;
      case 'step_start':
        if (state.current && data.step) state.current.steps = data.step;
        break;
      case 'text_delta': {
        if (!state.current) state.current = addAssistant();
        state.current.text += String(data.text || '');
        const following = atBottom();
        renderAssistant(state.current, true);
        scrollIfFollowing(following);
        break;
      }
      case 'assistant_text': {
        if (!state.current) state.current = addAssistant();
        // The complete text follows the deltas, so it replaces them rather than
        // being appended: appending would duplicate the whole answer.
        state.current.text = String(data.text || state.current.text);
        renderAssistant(state.current, state.running);
        break;
      }
      case 'reasoning_delta': {
        const block = reasoningBlock();
        block.reasoningNode.textContent += String(data.text || '');
        break;
      }
      case 'tool_start':
        toolRow(data, 'start');
        break;
      case 'tool_end':
        toolRow(data, 'end');
        break;
      case 'turn_end': {
        state.running = false;
        if (state.current) {
          state.current.steps = data.steps || state.current.steps;
          renderAssistant(state.current, false);
        }
        state.current = null;
        renderRunning();
        if (data.stopped && data.stopped !== 'completed') {
          toast('warn', `the turn stopped: ${data.stopped}`);
        }
        break;
      }
      case 'error':
        state.running = false;
        renderRunning();
        addError(data.message || 'the agent reported an error');
        break;
      default:
        if (data.request_id || data.approval_id) approvalCard(data);
        break;
    }
  }

  // ------------------------------------------------------------- the modes

  function renderModes() {
    clear(modesHost);
    for (const mode of state.modes) {
      const button = el('button', {
        class: 'mode',
        type: 'button',
        text: mode.label || mode.id,
        title: mode.hint || mode.summary || mode.description || '',
        'aria-pressed': String(mode.id === state.mode),
        onclick: () => {
          state.mode = mode.id;
          renderModes();
          void api.settings.update({ agent: { defaultMode: mode.id } }).catch(() => {});
        }
      });
      modesHost.append(button);
    }
  }

  // ----------------------------------------------------------- the composer

  function renderContext() {
    const context = editor.context();
    const preferences = settings().agent;
    clear(contextHost);
    if (preferences.includeActiveFile && context.file) {
      contextHost.append(
        el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: context.file })])
      );
    }
    if (preferences.includeSelection && context.selection) {
      const lines = context.selectionRange
        ? `lines ${context.selectionRange.start}–${context.selectionRange.end}`
        : `${context.selection.length} chars`;
      contextHost.append(el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: `selection · ${lines}` })]));
    }
    if (context.dirty) {
      contextHost.append(el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: 'unsaved changes' })]));
    }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.running) return;
    const context = editor.context();
    const preferences = settings().agent;
    input.value = '';
    grow();
    addUser(text);
    state.current = null;
    state.running = true;
    renderRunning();
    scrollIfFollowing(true);
    try {
      await api.agent.send({
        message: text,
        mode: state.mode,
        context: {
          file: preferences.includeActiveFile ? context.file : '',
          dirty: context.dirty,
          language: context.language,
          selection: preferences.includeSelection ? context.selection : '',
          selectionRange: context.selectionRange
        }
      });
    } catch (error) {
      state.running = false;
      state.current = null;
      renderRunning();
      addError(error.message);
    }
  }

  async function cancel() {
    try {
      await api.agent.cancel();
      toast('info', 'asked the agent to stop');
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function reset() {
    try {
      await api.agent.reset();
    } catch (error) {
      toast('error', error.message);
    }
    clear(transcript);
    state.current = null;
    state.reasoning = null;
    state.tools.clear();
    state.approvals.clear();
    onNotice?.('started a new conversation', 'ok');
  }

  // ------------------------------------------------------- agent settings

  /**
   * The settings form, built from the profile the core reports.
   *
   * The endpoint list cannot be asked for unsaved values - the core probes the
   * profile it has - so the button saves first and lists models afterwards.
   * Pretending otherwise would produce a "test" that fails for a reason the user
   * cannot see.
   */
  function renderSettings() {
    const profile = state.profile || {};
    const agentSettings = state.agentSettings || {};
    const field = (label, control) =>
      el('div', { class: 'field__row' }, [el('span', { text: label, style: { minWidth: '90px' } }), control]);

    const id = el('input', { type: 'text', value: profile.id || 'default' });
    const baseUrl = el('input', { type: 'text', value: profile.base_url || '', placeholder: 'https://host/v1' });
    const apiKey = el('input', { type: 'password', value: '', placeholder: profile.has_api_key ? '(stored)' : 'sk-…' });
    const model = el('input', { type: 'text', value: profile.model || '', placeholder: 'model id' });
    const maxSteps = el('input', { type: 'text', value: String(agentSettings.max_steps ?? 12) });
    const commandTimeout = el('input', { type: 'text', value: String(agentSettings.command_timeout ?? 120) });
    const autoApprove = el('input', { type: 'checkbox', checked: Boolean(agentSettings.auto_approve) });
    const approveWrites = el('input', { type: 'checkbox', checked: Boolean(agentSettings.approve_writes) });
    const approveCommands = el('input', { type: 'checkbox', checked: Boolean(agentSettings.approve_commands) });
    const models = el('div', { class: 'list__empty', text: 'The endpoint has not been asked yet.' });
    const status = el('div', { class: 'list__empty', text: '' });

    async function save({ quiet = false } = {}) {
      const patch = {
        active_profile: id.value.trim() || 'default',
        profile: {
          id: id.value.trim() || 'default',
          base_url: baseUrl.value.trim(),
          model: model.value.trim()
        },
        agent: {
          max_steps: Number(maxSteps.value) || undefined,
          command_timeout: Number(commandTimeout.value) || undefined,
          auto_approve: autoApprove.checked,
          approve_writes: approveWrites.checked,
          approve_commands: approveCommands.checked
        }
      };
      if (apiKey.value.trim()) patch.profile.api_key = apiKey.value.trim();
      try {
        await api.agent.saveProfile(patch);
        apiKey.value = '';
        status.textContent = 'Saved.';
        if (!quiet) onNotice?.('agent settings saved', 'ok');
        await loadState();
        return true;
      } catch (error) {
        status.textContent = error.message;
        toast('error', error.message);
        return false;
      }
    }

    async function listModels() {
      models.textContent = 'Asking the endpoint…';
      try {
        const result = await api.agent.models({ profile: id.value.trim() || 'default' });
        const names = (result && (result.models || result.data)) || [];
        clear(models);
        if (!names.length) {
          models.append(el('span', { text: 'The endpoint listed no models.' }));
          return;
        }
        models.append(el('span', { text: `${names.length} offered: ` }));
        for (const name of names.slice(0, 40)) {
          models.append(
            el('button', {
              class: 'panel__tab',
              type: 'button',
              text: String(name),
              title: 'Use this model id',
              onclick: () => {
                model.value = String(name);
              }
            })
          );
        }
      } catch (error) {
        models.textContent = error.message;
      }
    }

    const sheet = el('div', { class: 'commit' }, [
      el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: 'agent settings' })]),
      field('profile id', id),
      field('endpoint', baseUrl),
      field('api key', apiKey),
      field('model', model),
      field('max steps', maxSteps),
      field('command timeout', commandTimeout),
      el('div', { class: 'field__row' }, [
        el('label', {}, [autoApprove, el('span', { text: 'run without asking' })]),
        el('label', {}, [approveWrites, el('span', { text: 'ask before writes' })]),
        el('label', {}, [approveCommands, el('span', { text: 'ask before commands' })])
      ]),
      el('div', { class: 'approval__row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Save & test',
          onclick: async () => {
            if (await save({ quiet: true })) await listModels();
          }
        }),
        el('button', { class: 'btn', type: 'button', text: 'Save', onclick: () => void save() }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Close', onclick: () => toggleSettings(false) })
      ]),
      models,
      status
    ]);
    return sheet;
  }

  function toggleSettings(force) {
    const open = force === undefined ? !state.settingsOpen : Boolean(force);
    if (state.settingsNode) state.settingsNode.remove();
    state.settingsNode = null;
    state.settingsOpen = open;
    if (open) {
      state.settingsNode = renderSettings();
      transcript.insertBefore(state.settingsNode, transcript.firstChild);
    }
  }

  /** The stored context preamble is what the agent saw; the panel hides it. */
  function stripContext(text) {
    const marker = 'Context from the editor:';
    if (!text.startsWith(marker)) return text;
    const end = text.indexOf('\n\n');
    return end === -1 ? '' : text.slice(end + 2);
  }

  async function loadState() {
    try {
      const snapshot = await api.agent.state();
      state.profile = snapshot.profile || {};
      state.agentSettings = snapshot.agent || {};
      if (Array.isArray(snapshot.modes) && snapshot.modes.length) {
        state.modes = snapshot.modes.map((mode) => ({
          id: mode.id || mode.mode || 'agent',
          label: mode.label || mode.title || mode.id || 'Agent',
          hint: mode.hint || mode.summary || mode.description || ''
        }));
      }
      if (!state.modes.some((mode) => mode.id === state.mode)) {
        state.mode = state.modes[0].id;
      }
      if (snapshot.pending_approvals && snapshot.pending_approvals.length) {
        for (const id of snapshot.pending_approvals) approvalCard({ request_id: id });
      }
      renderModes();
      if (state.settingsOpen) toggleSettings(true);
    } catch (error) {
      state.agentSettings = {};
      addError(error.message);
    }
  }

  async function loadHistory() {
    try {
      const snapshot = await api.agent.history();
      const messages = (snapshot && snapshot.messages) || [];
      for (const message of messages) {
        const text = stripContext(String(message.content || ''));
        if (!text.trim()) continue;
        if (message.role === 'user') addUser(text);
        else if (message.role === 'assistant') {
          const created = addAssistant();
          created.text = text;
          renderAssistant(created, false);
        }
      }
      transcript.scrollTop = transcript.scrollHeight;
    } catch {
      // An empty or unreachable history is not worth an error card: the panel
      // simply starts empty.
    }
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  input.addEventListener('input', grow);
  input.addEventListener('focus', renderContext);
  sendButton.addEventListener('click', () => void send());
  stopButton.addEventListener('click', () => void cancel());

  async function mount() {
    clear(actions);
    actions.append(
      el('button', { class: 'iconbtn', type: 'button', title: 'New conversation', text: '＋', onclick: () => void reset() }),
      el('button', { class: 'iconbtn', type: 'button', title: 'Agent settings', text: '⚙', onclick: () => toggleSettings() }),
      el('button', {
        class: 'iconbtn',
        type: 'button',
        title: 'Ask the endpoint for its models',
        text: '↻',
        onclick: () => void loadState()
      })
    );
    applyStatus(await api.agent.status().catch(() => ({ state: 'stopped', detail: 'the agent is not running' })));
    renderModes();
    renderContext();
    renderRunning();
    await loadState();
    await loadHistory();
    grow();
  }

  return { mount, send, cancel, reset, toggleSettings, renderContext, focus: () => input.focus(), state };
}