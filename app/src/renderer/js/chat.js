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

import { clear, debounce, el, icon, toast } from './ui.js';
import { renderMarkdown, toPlainText } from './markdown.js';
import { current as i18nInfo, t } from './i18n.js';

/**
 * The five modes, by id: an icon and the two keys that name them.
 *
 * The ids are the core's; the labels are the window's. A mode the core gains
 * before this list knows about it still appears, labelled with its id, which is
 * better than a mode that silently cannot be chosen.
 */
const MODE_INFO = {
  agent: { icon: 'spark', label: 'chat.modeAgent', hint: 'chat.modeAgentHint' },
  ask: { icon: 'ask', label: 'chat.modeAsk', hint: 'chat.modeAskHint' },
  plan: { icon: 'plan', label: 'chat.modePlan', hint: 'chat.modePlanHint' },
  debug: { icon: 'bug', label: 'chat.modeDebug', hint: 'chat.modeDebugHint' },
  review: { icon: 'review', label: 'chat.modeReview', hint: 'chat.modeReviewHint' }
};

function modeIcon(id) {
  return (MODE_INFO[id] && MODE_INFO[id].icon) || 'spark';
}

function modeLabel(id) {
  return MODE_INFO[id] ? t(MODE_INFO[id].label) : id;
}

function modeHint(id) {
  return MODE_INFO[id] ? t(MODE_INFO[id].hint) : '';
}

function knownModes() {
  return Object.keys(MODE_INFO).map((id) => ({ id, label: modeLabel(id), hint: modeHint(id) }));
}

export function createChat({ api, bus, settings, onNotice, editor }) {
  const transcript = document.getElementById('transcript');
  const input = document.getElementById('composer-input');
  const sendButton = document.getElementById('composer-send');
  const stopButton = document.getElementById('composer-stop');
  const modesHost = document.getElementById('composer-modes');
  const contextHost = document.getElementById('composer-context');
  const dot = document.getElementById('chat-dot');
  const stateLabel = document.getElementById('chat-state');
  const actions = document.getElementById('chat-actions');

  const state = {
    modes: knownModes(),
    mode: 'agent',
    agent: { state: 'stopped', detail: '' },
    running: false,
    current: null,
    reasoning: null,
    tools: new Map(),
    approvals: new Map(),
    settingsOpen: false,
    modeOpen: false
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
      created.stateNode.textContent = failed ? t('tool.failed') : t('tool.done');
    } else {
      created.node.dataset.state = 'running';
      created.stateNode.textContent = t('tool.running');
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
      el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: t('chat.approvalNeeded') })]),
      el('div', { class: 'approval__what', text: `${payload.tool || payload.name || 'action'}\n${what}` }),
      el('div', { class: 'approval__row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: t('chat.approve'),
          onclick: () => void decide(id, true, node)
        }),
        el('button', { class: 'btn', type: 'button', text: t('chat.deny'), onclick: () => void decide(id, false, node) })
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
    const key = known.includes(state.agent.state) ? state.agent.state : 'off';
    dot.dataset.state = known.includes(state.agent.state) ? state.agent.state : 'off';
    dot.title = state.agent.detail || t(`agent.${key}`);
    if (stateLabel) {
      stateLabel.textContent = t(`agent.${key}`);
      stateLabel.title = state.agent.detail || '';
      stateLabel.dataset.state = key;
    }
    if (state.agent.state !== 'ready') {
      state.running = false;
      renderRunning();
    }
  }

  function renderRunning() {
    stopButton.hidden = !state.running;
    sendButton.disabled = state.running;
    sendButton.textContent = state.running ? t('chat.working') : t('chat.send');
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
          toast('warn', t('chat.turnStopped', { reason: data.stopped }));
        }
        break;
      }
      case 'error':
        state.running = false;
        renderRunning();
        addError(data.message || t('chat.error'));
        break;
      default:
        if (data.request_id || data.approval_id) approvalCard(data);
        break;
    }
  }

  // ------------------------------------------------------------- the modes

  function renderModes() {
    clear(modesHost);
    const info = MODE_INFO[state.mode];
    modesHost.append(
      el(
        'button',
        {
          class: 'modebtn',
          type: 'button',
          title: `${t('chat.mode')}: ${modeLabel(state.mode)} — ${modeHint(state.mode)}`,
          'aria-haspopup': 'listbox',
          'aria-expanded': String(state.modeOpen),
          onclick: (event) => {
            event.stopPropagation();
            toggleModeList(!state.modeOpen);
          }
        },
        [
          el('span', { class: 'modebtn__icon', html: icon(modeIcon(state.mode)) }),
          el('span', { class: 'modebtn__label', text: modeLabel(state.mode) }),
          el('span', { class: 'modebtn__chevron', html: icon('chevron') })
        ]
      )
    );
    if (info === undefined) {
      // A mode the core knows and this window does not: it is still selectable,
      // and the tooltip says where the name came from.
      modesHost.lastChild.title = state.mode;
    }
    if (state.modeOpen) modesHost.append(renderModeList());
  }

  function renderModeList() {
    const list = el('div', { class: 'modelist', role: 'listbox', 'aria-label': t('chat.mode') });
    for (const mode of state.modes) {
      const selected = mode.id === state.mode;
      const row = el(
        'button',
        {
          class: 'modelist__item',
          type: 'button',
          role: 'option',
          'aria-selected': String(selected),
          onclick: (event) => {
            event.stopPropagation();
            chooseMode(mode.id);
          }
        },
        [
          el('span', { class: 'modelist__icon', html: icon(modeIcon(mode.id)) }),
          el('span', { class: 'modelist__text' }, [
            el('span', { class: 'modelist__label', text: mode.label || modeLabel(mode.id) }),
            el('span', { class: 'modelist__hint', text: mode.hint || modeHint(mode.id) })
          ])
        ]
      );
      list.append(row);
    }
    return list;
  }

  function toggleModeList(open) {
    state.modeOpen = open;
    renderModes();
  }

  function chooseMode(id) {
    state.mode = id;
    state.modeOpen = false;
    renderModes();
    void api.settings.update({ agent: { defaultMode: id } }).catch(() => {});
    input.focus();
  }

  // ----------------------------------------------------------- the composer

  function renderContext() {
    const context = editor.context();
    const preferences = settings().agent;
    clear(contextHost);
    if (preferences.includeActiveFile && context.file) {
      contextHost.append(
        el('span', { class: 'ctx', title: t('chat.contextFile') }, [
          el('span', { class: 'ctx__label', text: context.file })
        ])
      );
    }
    if (preferences.includeSelection && context.selection) {
      const label = context.selectionRange
        ? t('chat.selection', { from: context.selectionRange.start, to: context.selectionRange.end })
        : t('chat.selectionChars', { count: context.selection.length });
      contextHost.append(el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: label })]));
    }
    if (context.dirty) {
      contextHost.append(
        el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: t('chat.unsaved') })])
      );
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
      toast('info', t('chat.stopped'));
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
    onNotice?.(t('chat.newStarted'), 'ok');
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
    const apiKey = el('input', {
      type: 'password',
      value: '',
      placeholder: profile.has_api_key ? t('settings.apiKeyStored') : 'sk-…'
    });
    const model = el('input', { type: 'text', value: profile.model || '', placeholder: t('settings.modelPlaceholder') });
    const maxSteps = el('input', { type: 'text', value: String(agentSettings.max_steps ?? 12) });
    const commandTimeout = el('input', { type: 'text', value: String(agentSettings.command_timeout ?? 120) });
    const autoApprove = el('input', { type: 'checkbox', checked: Boolean(agentSettings.auto_approve) });
    const approveWrites = el('input', { type: 'checkbox', checked: Boolean(agentSettings.approve_writes) });
    const approveCommands = el('input', { type: 'checkbox', checked: Boolean(agentSettings.approve_commands) });
    const models = el('div', { class: 'list__empty', text: t('settings.scanHint') });
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
        status.textContent = t('settings.saved');
        if (!quiet) onNotice?.(t('settings.savedNotice'), 'ok');
        await loadState();
        return true;
      } catch (error) {
        status.textContent = error.message;
        toast('error', error.message);
        return false;
      }
    }

    /**
     * Ask the endpoint for its models, from what is typed rather than from what
     * is saved.
     *
     * The scan runs on its own once the endpoint looks complete, because the
     * point of the list is to save the user from knowing a model id by heart -
     * and asking them to save first would answer a question about the previous
     * endpoint. The signature keeps a keystroke from firing a request per
     * character.
     */
    let scanned = '';
    async function scanModels({ force = false } = {}) {
      const endpoint = baseUrl.value.trim();
      if (!endpoint) {
        clear(models);
        models.append(el('span', { text: t('settings.scanHint') }));
        scanned = '';
        return;
      }
      const signature = `${id.value.trim()}|${endpoint}|${apiKey.value.trim()}`;
      if (!force && signature === scanned) return;
      scanned = signature;
      clear(models);
      models.append(el('span', { class: 'spinner' }), el('span', { text: t('settings.scanning') }));
      try {
        const result = await api.agent.models({
          profile: id.value.trim() || 'default',
          baseUrl: endpoint,
          apiKey: apiKey.value.trim()
        });
        const names = (result && (result.models || result.data)) || [];
        clear(models);
        if (!names.length) {
          models.append(el('span', { text: t('settings.scanNone') }));
          return;
        }
        models.append(el('span', { text: t('settings.scanFound', { count: names.length }) }));
        const picker = el('select', {
          class: 'modelpick',
          title: t('settings.useModel'),
          onchange: () => {
            if (picker.value) {
              model.value = picker.value;
              // Choosing from the list is not a reason to ask again.
              scanned = `${id.value.trim()}|${baseUrl.value.trim()}|${apiKey.value.trim()}`;
            }
          }
        });
        picker.append(el('option', { value: '', text: t('settings.model') }));
        for (const name of names.slice(0, 300)) {
          picker.append(el('option', { value: String(name), text: String(name) }));
        }
        models.append(picker);
      } catch (error) {
        clear(models);
        models.append(el('span', { text: error.message }));
      }
    }

    const scheduleScan = debounce(() => void scanModels(), 700);
    for (const control of [id, baseUrl, apiKey]) control.addEventListener('input', scheduleScan);

    // The window's own language, next to the agent's settings because this is
    // the only settings surface the interface has.
    const language = el('select', {
      class: 'modelpick',
      onchange: () => void api.settings.update({ appearance: { language: language.value } }).catch(() => {})
    });
    for (const code of ['system', ...i18nInfo().available]) {
      language.append(
        el('option', { value: code, text: code === 'system' ? t('settings.languageSystem') : code.toUpperCase() })
      );
    }
    language.value = settings().appearance.language;

    const sheet = el('div', { class: 'commit' }, [
      el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: t('settings.title') })]),
      field(t('settings.profile'), id),
      field(t('settings.endpoint'), baseUrl),
      field(t('settings.apiKey'), apiKey),
      field(t('settings.model'), model),
      field(t('settings.maxSteps'), maxSteps),
      field(t('settings.commandTimeout'), commandTimeout),
      field(t('settings.language'), language),
      el('div', { class: 'field__row' }, [
        el('label', {}, [autoApprove, el('span', { text: t('settings.autoApprove') })]),
        el('label', {}, [approveWrites, el('span', { text: t('settings.askWrites') })]),
        el('label', {}, [approveCommands, el('span', { text: t('settings.askCommands') })])
      ]),
      el('div', { class: 'approval__row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: t('settings.saveTest'),
          onclick: async () => {
            if (await save({ quiet: true })) await scanModels({ force: true });
          }
        }),
        el('button', { class: 'btn', type: 'button', text: t('settings.save'), onclick: () => void save() }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.close'),
          onclick: () => toggleSettings(false)
        })
      ]),
      models,
      status
    ]);
    // A form opened on a saved profile shows its models without being asked.
    if (baseUrl.value.trim()) setTimeout(() => void scanModels(), 0);
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
          // The core names the modes in English; the window knows them by id and
          // shows its own wording, falling back to the core's for a mode it has
          // not been taught yet.
          label: MODE_INFO[mode.id] ? modeLabel(mode.id) : mode.label || mode.title || mode.id || 'Agent',
          hint: MODE_INFO[mode.id] ? modeHint(mode.id) : mode.hint || mode.summary || mode.description || ''
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
      if (!messages.length) {
        transcript.append(el('div', { class: 'list__empty', text: t('chat.empty') }));
        return;
      }
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
  // A dropdown closes when the click lands anywhere else, which is what every
  // other dropdown on this platform does.
  document.addEventListener('click', () => {
    if (state.modeOpen) toggleModeList(false);
  });

  async function mount() {
    clear(actions);
    actions.append(
      el('button', {
        class: 'iconbtn',
        type: 'button',
        title: t('chat.newConversation'),
        text: '＋',
        onclick: () => void reset()
      }),
      el('button', {
        class: 'iconbtn',
        type: 'button',
        title: t('chat.settings'),
        text: '⚙',
        onclick: () => toggleSettings()
      }),
      el('button', {
        class: 'iconbtn',
        type: 'button',
        title: t('chat.reload'),
        text: '↻',
        onclick: () => void loadState()
      })
    );
    applyStatus(await api.agent.status().catch(() => ({ state: 'stopped', detail: '' })));
    renderModes();
    renderContext();
    renderRunning();
    await loadState();
    await loadHistory();
    grow();
  }

  /**
   * Draw the conversation again from the core.
   *
   * Used when the workspace changes: the core is bound to a folder, so its
   * transcript is now a different one and the panel must not keep showing the
   * previous folder's conversation.
   */
  async function reload() {
    clear(transcript);
    state.current = null;
    state.reasoning = null;
    state.tools.clear();
    state.approvals.clear();
    state.modeOpen = false;
    await loadState();
    await loadHistory();
    renderContext();
    renderRunning();
    grow();
  }

  return { mount, send, cancel, reset, reload, toggleSettings, renderContext, focus: () => input.focus(), state };
}