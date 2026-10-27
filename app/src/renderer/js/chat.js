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
 *
 * Three things about a turn are worth reading twice, because all three were
 * wrong in a way that looked like working software.
 *
 * * The model's scratchpad is folded into one disclosure above the answer, open
 *   while it is still thinking. It used to be drawn as a second assistant turn
 *   appended after the first, which put the thinking under the answer it exists
 *   to explain.
 * * Tool calls are one collapsed line per turn. They used to be a full-width row
 *   each, which buried the answer under a wall of `read_file` entries and showed
 *   `[object Object]` for the arguments, since the core sends them as an object.
 * * How full the model's window is, and that the conversation is compacted
 *   before it overflows, is stated in the composer rather than discovered.
 */

import { clear, debounce, el, icon, toast } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { agentStateKey, current as i18nInfo, t } from './i18n.js';
import { describeArguments, formatTokens } from './tool-arguments.js';
import { menuPoint, openContextMenu } from './context-menu.js';

/**
 * The marker the core puts on the message that replaces a summarised part of a
 * conversation (`core/lexiqode/agent/loop.py`). It is a user-role message on the
 * wire, so without this the panel would draw the summary as something the user
 * said.
 */
const SUMMARY_MARKER = '[context summary]';

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

export function createChat({ api, bus, settings, onNotice, editor, onProfile }) {
  const transcript = document.getElementById('transcript');
  const input = document.getElementById('composer-input');
  const sendButton = document.getElementById('composer-send');
  const stopButton = document.getElementById('composer-stop');
  const modesHost = document.getElementById('composer-modes');
  const contextHost = document.getElementById('composer-context');
  const modelHost = document.getElementById('composer-model');
  const dot = document.getElementById('chat-dot');
  const stateLabel = document.getElementById('chat-state');
  const actions = document.getElementById('chat-actions');
  const tabsHost = document.getElementById('chat-tabs');

  const state = {
    modes: knownModes(),
    mode: 'agent',
    agent: { state: 'stopped', detail: '' },
    /** Open chats, in the order they were opened. */
    tabs: [],
    /** Every saved chat of this folder, newest first. */
    conversations: [],
    activeChat: '',
    /** Which chat the core itself has open, so a switch is not sent twice. */
    coreChat: '',
    running: false,
    current: null,
    reasoning: null,
    tools: new Map(),
    approvals: new Map(),
    context: null,
    /** Files pinned to the next message, in the order they were added. */
    contextFiles: [],
    /** The open file the user took out of the message, by path. */
    contextMuted: new Set(),
    /** Model ids the endpoint last reported, and the profile they came from. */
    models: [],
    modelsFor: '',
    modelsError: '',
    /** The "the conversation is empty" line, while it is on screen. */
    emptyState: null,
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

  /**
   * Drop the empty-state line the moment the conversation stops being empty.
   *
   * It is drawn when a chat with no messages is loaded, and nothing removed it
   * when the first message arrived: the transcript kept "the conversation is
   * empty" above the answer it was already showing.
   */
  function clearEmptyState() {
    if (!state.emptyState) return;
    state.emptyState.remove();
    state.emptyState = null;
  }

  function addUser(text) {
    clearEmptyState();
    const created = turn('user');
    created.body.textContent = text;
    return created;
  }

  function addAssistant() {
    clearEmptyState();
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
        created.meta.append(el('span', { class: 'spinner' }), el('span', { text: t('chat.working2') }));
      } else if (created.steps) {
        created.meta.append(
          el('span', {
            text: t(created.steps === 1 ? 'chat.stepsOne' : 'chat.steps', { count: created.steps })
          })
        );
      }
    }
    for (const link of created.body.querySelectorAll('a[data-external]')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void api.shell.openExternal(link.getAttribute('href')).catch((error) => toast('error', error.message));
      });
    }
  }

  /** The turn the current event belongs to, created on demand. */
  function activeTurn() {
    if (!state.current) state.current = addAssistant();
    return state.current;
  }

  /**
   * The model's scratchpad, folded into one disclosure above the answer.
   *
   * It arrives as `reasoning_delta` before the answer does, so it is inserted as
   * the first child of this turn rather than as a turn of its own. It stays open
   * while the model is thinking - that is what makes a slow first token bearable -
   * and folds away as soon as the answer starts, which is also the state a
   * conversation is worth re-reading in.
   */
  function reasoningBlock() {
    const created = activeTurn();
    if (!created.reasoning) {
      const node = el('details', { class: 'reasoning', open: true });
      const head = el('summary', { class: 'reasoning__head' });
      const spinner = el('span', { class: 'spinner' });
      const label = el('span', { class: 'reasoning__label', text: t('chat.thinking') });
      const spent = el('span', { class: 'reasoning__spent' });
      const body = el('div', { class: 'reasoning__body' });
      head.append(spinner, label, spent);
      node.append(head, body);
      // Above the answer, and above the tools when those came first.
      created.node.insertBefore(node, created.tools ? created.tools.node : created.body);
      created.reasoning = { node, body, head, label, spent, spinner, startedAt: Date.now(), folded: false, toggled: false };
      // A click is the user's decision, and it outranks the automatic fold.
      head.addEventListener('click', () => {
        created.reasoning.toggled = true;
      });
    }
    state.reasoning = created.reasoning;
    return created.reasoning;
  }

  /** Say that the model is thinking again, after it already had an answer. */
  function markThinking(record) {
    record.folded = false;
    record.node.open = true;
    if (!record.spinner.isConnected) record.head.insertBefore(record.spinner, record.label);
    record.label.textContent = t('chat.thinking');
    record.spent.textContent = '';
  }

  /**
   * Fold the scratchpad away and date it, unless the user already decided.
   *
   * The label says how long the model thought, because that is the one fact a
   * reader wants from a folded block they chose not to open.
   */
  function foldThinking() {
    const record = state.reasoning;
    if (!record || record.folded || record.toggled || !record.body.textContent) return;
    record.folded = true;
    record.node.open = false;
    record.spinner.remove();
    record.label.textContent = t('chat.thoughts', {
      seconds: Math.max(1, Math.round((Date.now() - record.startedAt) / 1000))
    });
  }

  /**
   * One collapsed line for every tool the turn used.
   *
   * The rows are still there, one click away, with the arguments the model
   * actually sent; what is gone is the wall of them between the question and the
   * answer.
   */
  function toolGroup() {
    const created = activeTurn();
    if (!created.tools) {
      const node = el('details', { class: 'tools' });
      const head = el('summary', { class: 'tools__head' });
      const spinner = el('span', { class: 'spinner' });
      const label = el('span', { class: 'tools__label' });
      const rows = el('div', { class: 'tools__rows' });
      head.append(spinner, label);
      node.append(head, rows);
      // Immediately before the answer: the order things happened in.
      created.node.insertBefore(node, created.body);
      created.tools = { node, head, label, spinner, rows, count: 0, running: 0, failed: 0 };
    }
    return created.tools;
  }

  function renderToolGroup(group) {
    if (!group) return;
    const count = group.count;
    const key = group.running ? 'chat.toolsWorking' : count === 1 ? 'chat.toolsOne' : 'chat.tools';
    group.label.textContent = t(key, { count });
    group.node.dataset.state = group.running ? 'running' : group.failed ? 'failed' : 'done';
    group.spinner.hidden = !group.running;
  }

  /**
   * One tool call: a single line while collapsed, the wire arguments and the
   * result when opened.
   *
   * `payload.arguments` is an object - the model's own JSON - and it is shown as
   * such, as text, with the bulky fields measured rather than printed.
   */
  function toolRow(payload, phase) {
    const group = toolGroup();
    const id = String(payload.id || payload.call_id || payload.tool_call_id || payload.name || Math.random());
    let row = state.tools.get(id);
    if (!row) {
      row = {
        name: payload.name || payload.tool || 'tool',
        args: payload.arguments || payload.args || payload.input || {},
        result: '',
        meta: null,
        elapsed: 0,
        details: el('details', { class: 'toolrow', dataset: { state: 'running' } })
      };
      row.head = el('summary', { class: 'toolrow__head' });
      row.nameNode = el('span', { class: 'toolrow__name', text: row.name });
      row.argsNode = el('span', { class: 'toolrow__args' });
      row.stateNode = el('span', { class: 'toolrow__state', text: t('tool.running') });
      row.body = el('div', { class: 'toolrow__body' });
      row.head.append(row.nameNode, row.argsNode, row.stateNode);
      row.details.append(row.head, row.body);
      group.rows.append(row.details);
      group.count += 1;
      group.running += 1;
      state.tools.set(id, row);
    }
    if (payload.name || payload.tool) row.name = payload.name || payload.tool;
    if (payload.arguments || payload.args || payload.input) {
      row.args = payload.arguments || payload.args || payload.input;
    }
    if (phase === 'end') {
      row.result = String(payload.content || payload.result || payload.output || payload.message || '');
      row.meta = payload.meta && Object.keys(payload.meta).length ? payload.meta : null;
      row.elapsed = Number(payload.elapsed_ms) || 0;
      const failed = payload.ok === false || payload.error || payload.status === 'error';
      row.details.dataset.state = failed ? 'failed' : 'done';
      row.stateNode.textContent = failed ? t('tool.failed') : t('tool.done');
      group.running = Math.max(0, group.running - 1);
      if (failed) group.failed += 1;
      renderToolRow(row);
    }
    row.nameNode.textContent = row.name;
    row.argsNode.textContent = describeArguments(row.name, row.args);
    row.head.title = [row.name, JSON.stringify(row.args, null, 2), row.result.slice(0, 2000)]
      .filter(Boolean)
      .join('\n\n');
    renderToolGroup(group);
    scrollIfFollowing(atBottom());
  }

  /** The opened part of a row: what was sent, what came back. */
  function renderToolRow(row) {
    clear(row.body);
    if (row.args && Object.keys(row.args).length) {
      row.body.append(
        el('div', { class: 'toolrow__label', text: t('tool.arguments') }),
        el('pre', { class: 'toolrow__pre', text: JSON.stringify(row.args, null, 2) })
      );
    }
    if (row.meta) {
      row.body.append(
        el('div', { class: 'toolrow__label', text: t('tool.meta') }),
        el('pre', { class: 'toolrow__pre', text: JSON.stringify(row.meta, null, 2) })
      );
    }
    if (row.result) {
      row.body.append(
        el('div', {
          class: 'toolrow__label',
          text: row.elapsed ? t('tool.resultIn', { ms: row.elapsed }) : t('tool.result')
        }),
        el('pre', { class: 'toolrow__pre', text: row.result })
      );
    }
    if (!row.body.childElementCount) {
      row.body.append(el('div', { class: 'toolrow__label', text: t('tool.noOutput') }));
    }
  }

  /** A line in the transcript that is neither a message nor an error. */
  function addNotice(text) {
    clearEmptyState();
    const node = el('div', { class: 'notice', text });
    transcript.append(node);
    state.current = null;
    scrollIfFollowing(atBottom());
    return node;
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
    const key = agentStateKey(state.agent.state);
    dot.dataset.state = key;
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

  /** Read the main process's own view of the agent and show it. */
  async function refreshStatus() {
    try {
      applyStatus(await api.agent.status());
    } catch {
      // The status call is the one thing that cannot fail into an error card:
      // the panel keeps whatever it last knew, and the next transition replaces
      // it.
    }
  }

  function renderRunning() {
    stopButton.hidden = !state.running;
    sendButton.disabled = state.running;
    sendButton.textContent = state.running ? t('chat.working') : t('chat.send');
  }

  // ------------------------------------------------------------- the chats

  /**
   * One tab per open chat.
   *
   * A chat is a document in the core with an id of its own; this strip only says
   * which documents are open. That is why closing a tab deletes nothing and why
   * reopening the window restores the same set - and why "new conversation" now
   * means a new chat rather than the end of the one that was open. What used to
   * happen: the transcript was cleared, the agent was reset, and the previous
   * conversation could not be found anywhere afterwards.
   */
  function titleOf(id) {
    const row = state.conversations.find((entry) => entry.id === id);
    return (row && row.title) || t('chat.untitled');
  }

  function renderTabs() {
    if (!tabsHost) return;
    clear(tabsHost);
    for (const tab of state.tabs) {
      const active = tab.id === state.activeChat;
      const node = el('div', {
        class: `chattab${active ? ' chattab--active' : ''}`,
        dataset: { id: tab.id },
        role: 'tab',
        'aria-selected': String(active),
        title: tab.title || titleOf(tab.id),
        onclick: () => void openChat(tab.id)
      });
      node.append(
        el('span', { class: 'chattab__label', text: tab.title || titleOf(tab.id) }),
        el('button', {
          class: 'chattab__close',
          type: 'button',
          text: '×',
          title: t('chat.closeTab'),
          'aria-label': t('chat.closeTab'),
          onclick: (event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }
        })
      );
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openContextMenu({
          ...menuPoint(event),
          label: tab.title || titleOf(tab.id),
          items: [
            { label: t('chat.renameChat'), run: () => renameChat(tab.id) },
            { label: t('chat.deleteChat'), danger: true, run: () => deleteChat(tab.id) },
            { separator: true },
            { label: t('chat.closeTab'), run: () => closeTab(tab.id) }
          ]
        });
      });
      tabsHost.append(node);
    }
    tabsHost.append(
      el('button', {
        class: 'chattabs__add',
        type: 'button',
        text: '+',
        title: t('chat.newTab'),
        'aria-label': t('chat.newTab'),
        onclick: () => void newChat()
      }),
      el('button', {
        class: 'chattabs__add',
        type: 'button',
        text: '≡',
        title: t('chat.history'),
        'aria-label': t('chat.history'),
        onclick: (event) => {
          event.stopPropagation();
          openChatMenu(event);
        }
      })
    );
  }

  /** Every saved chat, and what can be done with the open one. */
  function openChatMenu(event) {
    const items = state.conversations.length
      ? state.conversations.slice(0, 20).map((row) => ({
          label: `${row.title || t('chat.untitled')} · ${row.messages}`,
          run: () => openChat(row.id)
        }))
      : [{ label: t('chat.noSavedChats'), disabled: true }];
    items.push({ separator: true });
    items.push({ label: t('chat.newTab'), run: () => newChat() });
    openContextMenu({ ...menuPoint(event), label: t('chat.history'), items });
  }

  async function refreshConversations() {
    try {
      const snapshot = await api.agent.conversations();
      state.conversations = (snapshot && snapshot.conversations) || [];
      if (snapshot && snapshot.current && snapshot.current.id) {
        state.coreChat = snapshot.current.id;
      }
    } catch {
      // The panel keeps the list it has: a core that is starting up answers the
      // next call, and an empty strip would look like lost chats.
    }
    renderTabs();
  }

  function persistChats() {
    void api.settings
      .update({ session: { chats: state.tabs.map((tab) => tab.id), activeChat: state.activeChat } })
      .catch(() => {});
  }

  /** Make one chat the open one, loading its transcript from the core. */
  async function openChat(id) {
    if (!id) return;
    const known = state.tabs.some((tab) => tab.id === id);
    if (!known) state.tabs.push({ id, title: titleOf(id) });
    state.activeChat = id;
    renderTabs();
    try {
      if (state.coreChat !== id) {
        await api.agent.openConversation(id);
        state.coreChat = id;
      }
      clear(transcript);
      state.current = null;
      state.reasoning = null;
      state.tools.clear();
      state.approvals.clear();
      state.context = null;
      await loadHistory();
      await loadState();
      renderContext();
    } catch (error) {
      toast('error', error.message);
      await refreshConversations();
    }
    persistChats();
  }

  /** A new chat in a new tab. The one that was open stays where it is. */
  async function newChat() {
    try {
      const created = await api.agent.newConversation();
      const id = created && created.conversation ? created.conversation.id : '';
      if (!id) throw new Error('the core did not name the new conversation');
      state.coreChat = id;
      state.tabs.push({ id, title: t('chat.untitled') });
      state.activeChat = id;
      clear(transcript);
      state.current = null;
      state.reasoning = null;
      state.tools.clear();
      state.context = null;
      renderTabs();
      renderContext();
      await refreshConversations();
      input.focus();
      onNotice?.(t('chat.newStarted'), 'ok');
    } catch (error) {
      toast('error', error.message);
    }
  }

  /** Close a tab. The chat itself stays saved and can be opened again. */
  function closeTab(id) {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    state.tabs.splice(index, 1);
    if (state.activeChat !== id) {
      renderTabs();
      persistChats();
      return;
    }
    const next = state.tabs[index] || state.tabs[index - 1] || null;
    if (next) {
      void openChat(next.id);
      return;
    }
    // The last tab: the panel keeps the chat open but shows nothing to switch to,
    // which is what `+` is for.
    state.activeChat = state.coreChat || '';
    renderTabs();
    persistChats();
  }

  async function renameChat(id) {
    const current = state.conversations.find((row) => row.id === id);
    const name = window.prompt(t('chat.renamePrompt'), (current && current.title) || '');
    if (!name) return;
    try {
      await api.agent.renameConversation(id, name);
      await refreshConversations();
      const tab = state.tabs.find((entry) => entry.id === id);
      if (tab) tab.title = titleOf(id);
      renderTabs();
    } catch (error) {
      toast('error', error.message);
    }
  }

  async function deleteChat(id) {
    const confirmed = await api.dialogs.confirm({
      message: t('chat.deleteConfirm', { title: titleOf(id) }),
      detail: t('chat.deleteDetail'),
      danger: true,
      confirmLabel: t('chat.deleteAction')
    });
    if (!confirmed) return;
    try {
      const result = await api.agent.deleteConversation(id);
      state.tabs = state.tabs.filter((tab) => tab.id !== id);
      state.activeChat = result && result.current ? result.current.id : '';
      state.coreChat = state.activeChat;
      await refreshConversations();
      if (state.activeChat) await openChat(state.activeChat);
      else {
        clear(transcript);
        state.current = null;
      }
      onNotice?.(t('chat.deleted'), 'ok');
    } catch (error) {
      toast('error', error.message);
    }
  }

  function handleEvent(event) {
    const data = event.data || {};
    switch (event.name) {
      case 'turn_start':
        state.running = true;
        state.reasoning = null;
        // Tool ids repeat across turns when a server sends none of its own
        // (`call_0`, `call_1`), so the map is per turn: keeping it would fold a
        // new call into last turn's row.
        state.tools.clear();
        state.current = addAssistant();
        renderRunning();
        break;
      case 'step_start':
        if (state.current && data.step) state.current.steps = data.step;
        break;
      case 'text_delta': {
        // The answer has started, so the scratchpad folds away.
        foldThinking();
        if (!state.current) state.current = addAssistant();
        state.current.text += String(data.text || '');
        const following = atBottom();
        renderAssistant(state.current, true);
        scrollIfFollowing(following);
        break;
      }
      case 'assistant_text': {
        foldThinking();
        if (!state.current) state.current = addAssistant();
        // The complete text follows the deltas, so it replaces them rather than
        // being appended: appending would duplicate the whole answer.
        state.current.text = String(data.text || state.current.text);
        renderAssistant(state.current, state.running);
        break;
      }
      case 'reasoning_delta': {
        const block = reasoningBlock();
        const following = atBottom();
        // A later step thinks again after answering: it is the same disclosure,
        // reopened, rather than a second one.
        if (block.folded) markThinking(block);
        block.body.textContent += String(data.text || '');
        scrollIfFollowing(following);
        break;
      }
      case 'tool_start':
        toolRow(data, 'start');
        break;
      case 'tool_end':
        toolRow(data, 'end');
        break;
      case 'context_compacted': {
        // The one thing about the context the user cannot see for themselves.
        addNotice(
          t(data.summarised ? 'chat.compacted' : 'chat.compactedDropped', {
            dropped: data.dropped || 0
          })
        );
        break;
      }
      case 'conversation_changed': {
        // The core names a chat once it has a question in it, and reports a
        // rename from anywhere else in the window. The tab strip follows.
        if (data.id === undefined) break;
        if (data.deleted) {
          state.tabs = state.tabs.filter((tab) => tab.id !== data.id);
        } else if (data.title) {
          const tab = state.tabs.find((entry) => entry.id === data.id);
          if (tab) tab.title = data.title;
        }
        renderTabs();
        void refreshConversations();
        break;
      }
      case 'turn_end': {
        state.running = false;
        if (state.current) {
          state.current.steps = data.steps || state.current.steps;
          renderAssistant(state.current, false);
        }
        // How full the window is now, and whether it was measured or estimated.
        if (data.context) {
          state.context = data.context;
          renderContext();
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
    // The popup is not a child of this row: the row scrolls horizontally, and an
    // absolutely positioned child of a scrolling box is clipped to it - which is
    // exactly how a dropdown ends up present in the DOM and invisible on screen.
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

  let modePopup = null;

  /** Place the list above the button, inside the window, and keep it there. */
  function showModePopup() {
    hideModePopup();
    const button = modesHost.querySelector('.modebtn');
    if (!button) return;
    const list = renderModeList();
    document.body.append(list);
    const anchor = button.getBoundingClientRect();
    const size = list.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - size.width - 8));
    const top = Math.max(8, anchor.top - size.height - 6);
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
    modePopup = list;
  }

  function hideModePopup() {
    if (modePopup) {
      modePopup.remove();
      modePopup = null;
    }
  }

  function toggleModeList(open) {
    state.modeOpen = open;
    renderModes();
    if (open) showModePopup();
    else hideModePopup();
  }

  function chooseMode(id) {
    state.mode = id;
    toggleModeList(false);
    renderModes();
    void api.settings.update({ agent: { defaultMode: id } }).catch(() => {});
    input.focus();
  }

  // --------------------------------------------------------------- the model

  /**
   * The model, beside the mode.
   *
   * The list is the endpoint's own, asked for once per profile: it is the same
   * call the settings form makes, except that nothing has to be typed first,
   * because here the credentials are already saved. A profile with no endpoint
   * is not asked at all - the answer would be an error about a profile that is
   * not configured, which is not worth showing next to a text field.
   */
  async function loadModels({ force = false } = {}) {
    const profile = state.profile || {};
    const signature = `${profile.id || ''}|${profile.base_url || ''}`;
    if (!profile.base_url) {
      state.models = [];
      state.modelsFor = '';
      state.modelsError = '';
      renderModel();
      return;
    }
    if (!force && signature === state.modelsFor) return;
    state.modelsFor = signature;
    state.modelsError = '';
    renderModel();
    try {
      const result = await api.agent.models({ profile: profile.id });
      const names = ((result && (result.models || result.data)) || []).map(String);
      state.models = names.slice(0, 300);
    } catch (error) {
      state.models = [];
      state.modelsError = error.message;
    }
    renderModel();
  }

  /**
   * Draw the model chooser.
   *
   * The model in force is always in the list, whether the endpoint mentioned it
   * or not: a chooser that cannot show what is being used is worse than none,
   * and an endpoint that was reconfigured since the list was fetched would
   * otherwise silently look like "no model".
   */
  function renderModel() {
    if (!modelHost) return;
    clear(modelHost);
    const profile = state.profile || {};
    const current = String(profile.model || '');
    if (!current && !state.models.length) {
      modelHost.append(
        el('span', {
          class: 'modelnone',
          title: state.modelsError || t('chat.modelHint'),
          text: t('chat.modelNone')
        })
      );
      return;
    }
    const names = current && !state.models.includes(current) ? [current, ...state.models] : state.models;
    const picker = el('select', {
      class: 'modelbtn',
      title: state.modelsError
        ? t('chat.modelFailed', { model: current || t('chat.modelNone'), message: state.modelsError })
        : t('chat.modelTitle', { model: current || t('chat.modelNone') }),
      onchange: () => void chooseModel(picker.value)
    });
    for (const name of names) picker.append(el('option', { value: name, text: name }));
    picker.value = current;
    modelHost.append(picker);
  }

  /**
   * Save the chosen model into the active profile.
   *
   * The core merges a profile patch into the profile it already has, so the
   * endpoint, the key and the limits all survive; only the model is named here.
   */
  async function chooseModel(name) {
    const profile = state.profile || {};
    const model = String(name || '').trim();
    if (!model || model === profile.model) return;
    try {
      await api.agent.saveProfile({
        active_profile: profile.id,
        profile: { id: profile.id, model: model }
      });
      toast('info', t('chat.modelChosen', { model: model }));
      await loadState();
    } catch (error) {
      toast('error', error.message);
      renderModel();
    }
  }

  // ----------------------------------------------------------- the composer

  /** How many files may be pinned at once: a preamble, not a repository. */
  const MAX_CONTEXT_FILES = 20;

  function contextFiles() {
    return state.contextFiles.slice();
  }

  /**
   * Whether the next message will carry this file.
   *
   * Two ways in: a file the user pinned, and the file in the editor, which the
   * preference offers by itself. Both are the same thing to whoever is looking
   * at the row of chips, so the tree's menu asks this rather than "is it
   * pinned" - otherwise it would say "remove" about a file it cannot remove.
   */
  function hasContextFile(path) {
    if (state.contextFiles.includes(path)) return true;
    const context = editor.context();
    return Boolean(settings().agent.includeActiveFile) && context.file === path && !state.contextMuted.has(path);
  }

  function addContextFile(path) {
    if (!path || state.contextFiles.includes(path)) return false;
    if (state.contextFiles.length >= MAX_CONTEXT_FILES) {
      toast('info', t('chat.contextFull', { count: MAX_CONTEXT_FILES }));
      return false;
    }
    state.contextFiles.push(path);
    // Pinning it again is the one way back from having dropped it.
    state.contextMuted.delete(path);
    renderContext();
    return true;
  }

  function removeContextFile(path) {
    const index = state.contextFiles.indexOf(path);
    if (index === -1) return false;
    state.contextFiles.splice(index, 1);
    renderContext();
    return true;
  }

  /**
   * Pin a file or take it out: what the tree's own menu asks for.
   *
   * "Out" means out of the next message, which for the file in the editor is not
   * the same as unpinning it: the preference would draw its chip again on the
   * next redraw, and a menu item called "remove" that leaves the file in place
   * is worse than no menu item at all.
   */
  function toggleContextFile(path) {
    if (hasContextFile(path)) {
      if (state.contextFiles.includes(path)) removeContextFile(path);
      state.contextMuted.add(path);
      renderContext();
      return false;
    }
    return addContextFile(path);
  }

  /**
   * What the next message carries.
   *
   * The open file is offered by preference, the pinned ones always, and a file
   * the user took out stays out until it is pinned back - the previous version
   * had no way to take one out at all, and a chip that returned on its own would
   * be the same broken promise.
   */
  function messageContext() {
    const context = editor.context();
    const preferences = settings().agent;
    const open =
      preferences.includeActiveFile && context.file && !state.contextMuted.has(context.file) ? context.file : '';
    return {
      file: open,
      files: contextFiles().filter((path) => path !== open),
      dirty: open ? context.dirty : false,
      language: context.language,
      selection: preferences.includeSelection ? context.selection : '',
      selectionRange: context.selectionRange
    };
  }

  /** One file in the message, with the cross that takes it back out. */
  function contextChip(path, labelKey, dropKey, onDrop) {
    return el('span', { class: 'ctx', title: path }, [
      el('span', { class: 'ctx__label', text: `${t(labelKey)} · ${path}` }),
      el('button', {
        class: 'ctx__drop',
        type: 'button',
        title: t(dropKey, { path: path }),
        text: '×',
        onclick: onDrop
      })
    ]);
  }

  function renderContext() {
    const context = editor.context();
    const preferences = settings().agent;
    clear(contextHost);

    const open =
      preferences.includeActiveFile && context.file && !state.contextMuted.has(context.file) ? context.file : '';
    if (open) {
      contextHost.append(contextChip(open, 'chat.contextFile', 'chat.contextDropOpen', () => {
        state.contextMuted.add(open);
        renderContext();
      }));
    }
    for (const path of state.contextFiles) {
      if (path === open) continue;
      contextHost.append(
        contextChip(path, 'chat.contextFilePinned', 'chat.contextDrop', () => void removeContextFile(path))
      );
    }
    // The open file can also be pinned by hand, and only while it is not in the
    // message already: a button that does nothing reads as broken.
    if (context.file && !open && !state.contextFiles.includes(context.file)) {
      contextHost.append(
        el('button', {
          class: 'ctx ctx--add',
          type: 'button',
          title: t('chat.contextAddOpen', { path: context.file }),
          text: t('chat.contextAdd'),
          onclick: () => void addContextFile(context.file)
        })
      );
    }
    if (preferences.includeSelection && context.selection) {
      const label = context.selectionRange
        ? t('chat.selection', { from: context.selectionRange.start, to: context.selectionRange.end })
        : t('chat.selectionChars', { count: context.selection.length });
      contextHost.append(el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: label })]));
    }
    if (context.dirty && open) {
      contextHost.append(
        el('span', { class: 'ctx' }, [el('span', { class: 'ctx__label', text: t('chat.unsaved') })])
      );
    }
    renderContextMeter();
  }

  /**
   * How much of the model's window this conversation occupies.
   *
   * The two numbers a user cannot otherwise get: what the window is, and whether
   * the conversation is about to be compacted. `measured` separates a token count
   * the provider reported from the loop's own four-characters-per-token estimate,
   * because a gauge that quietly mixes the two is worse than no gauge.
   */
  function renderContextMeter() {
    const context = state.context;
    if (!context || !context.window) return;
    const percent = Math.max(0, Math.min(100, Math.round((context.tokens / context.window) * 100)));
    const compactAt = Math.round(
      (context.compact_at || settings().agent.compact_at || 0.75) * 100
    );
    contextHost.append(
      el(
        'span',
        {
          class: 'ctx ctx--meter',
          dataset: { state: percent >= compactAt ? 'full' : 'ok' },
          title: [
            t('chat.contextHint', { percent: compactAt }),
            context.measured ? t('chat.contextMeasured') : t('chat.contextEstimated')
          ].join(' ')
        },
        [
          el('span', {
            class: 'ctx__label',
            text: t('chat.contextUsage', {
              used: formatTokens(context.tokens),
              total: formatTokens(context.window),
              percent
            })
          })
        ]
      )
    );
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.running) return;
    const context = messageContext();
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
        context
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
    // Every way of starting a chat comes through here: the header button, the
    // keyboard chord and the command palette. It opens a tab, because the chat
    // that was open is still there to go back to.
    await newChat();
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
    // The window and the answer budget belong to the model, and until now they
    // existed in the core's settings file and nowhere in the interface: the two
    // numbers that decide whether a long conversation is even possible could not
    // be read, let alone changed.
    const contextWindow = el('input', {
      type: 'text',
      value: String(profile.context_window ?? 128000),
      title: t('settings.contextWindowHint')
    });
    const maxOutput = el('input', {
      type: 'text',
      value: String(profile.max_output_tokens ?? 8192),
      title: t('settings.maxOutputHint')
    });
    const compactAt = el('input', {
      type: 'text',
      value: String(Math.round((agentSettings.compact_at ?? 0.75) * 100)),
      title: t('settings.autoCompactHint')
    });
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
          model: model.value.trim(),
          context_window: Number(contextWindow.value) || undefined,
          max_output_tokens: Number(maxOutput.value) || undefined
        },
        agent: {
          max_steps: Number(maxSteps.value) || undefined,
          command_timeout: Number(commandTimeout.value) || undefined,
          compact_at: (Number(compactAt.value) || 75) / 100,
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
        // Saving is what makes a configured assistant usable, so the core is
        // brought up here rather than left for the first message: the settings
        // only reach it when it starts, and a panel that says "выключен" after a
        // successful save is telling the user their save did not work.
        await startAgent(status);
        await loadState();
        return true;
      } catch (error) {
        status.textContent = error.message;
        toast('error', error.message);
        return false;
      }
    }

    /**
     * Start the core and say where it got to.
     *
     * The one refusal worth translating is the one a user can act on: the core
     * works inside a folder, and with none open it says so in English only.
     */
    async function startAgent(statusNode) {
      try {
        applyStatus(await api.agent.start());
      } catch (error) {
        await refreshStatus();
        const message = /no folder/i.test(error.message) ? t('chat.needsFolder') : error.message;
        if (statusNode) statusNode.textContent = message;
        return false;
      }
      // applyStatus above came from the agent's own answer; the panel's status
      // line confirms the model that is now in force.
      if (statusNode) statusNode.textContent = t('settings.savedAndReady');
      return true;
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
    const retryButton = () =>
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: t('settings.scanAgain'),
        onclick: () => void scanModels({ force: true })
      });
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
        // The list the chooser beside the mode offers comes from here too: this
        // is the one place that asks while credentials are still being typed,
        // and the answer is the same list.
        state.models = names.map(String).slice(0, 300);
        renderModel();
        clear(models);
        if (!names.length) {
          models.append(el('span', { text: t('settings.scanNone') }));
          models.append(retryButton());
          return;
        }
        models.append(el('span', { text: t('settings.scanFound', { count: names.length }) }));
        const picker = el('select', {
          class: 'modelpick',
          title: t('settings.useModel'),
          onchange: async () => {
            if (!picker.value) return;
            model.value = picker.value;
            // Choosing from the list is not a reason to ask again.
            scanned = `${id.value.trim()}|${baseUrl.value.trim()}|${apiKey.value.trim()}`;
            // The choice is the decision, so it is saved here rather than left
            // waiting for a Save press the user has no reason to expect: picking
            // a different model and finding the old one still in force reads as a
            // list that does not work.
            await save({ quiet: true });
          }
        });
        picker.append(el('option', { value: '', text: t('settings.model') }));
        for (const name of names.slice(0, 300)) {
          picker.append(el('option', { value: String(name), text: String(name) }));
        }
        models.append(picker);
      } catch (error) {
        clear(models);
        // "no folder is open" is the one failure a user can act on, and it is the
        // one the core states in English only.
        const message = /no folder/i.test(error.message) ? t('chat.needsFolder') : error.message;
        models.append(el('span', { text: message }));
        models.append(retryButton());
      }
    }

    const scheduleScan = debounce(() => void scanModels(), 700);
    for (const control of [id, baseUrl, apiKey]) control.addEventListener('input', scheduleScan);

    // The window's own language, next to the agent's settings because this is
    // the only settings surface the interface has.
    const language = el('select', {
      class: 'langpick',
      onchange: () => void api.settings.update({ appearance: { language: language.value } }).catch(() => {})
    });
    for (const code of ['system', ...i18nInfo().available]) {
      language.append(
        el('option', { value: code, text: code === 'system' ? t('settings.languageSystem') : code.toUpperCase() })
      );
    }
    language.value = settings().appearance.language;

    /**
     * The window's theme, next to its language.
     *
     * Both are window settings rather than agent settings, and this is the only
     * settings surface the window has. Until now the only way to change the theme
     * was the command palette, which is why a machine whose system theme is light
     * had no discoverable way to reach the dark one.
     */
    const theme = el('select', {
      class: 'langpick',
      onchange: () => void api.settings.update({ appearance: { theme: theme.value } }).catch(() => {})
    });
    for (const [value, key] of [
      ['system', 'settings.themeSystem'],
      ['dark', 'settings.themeDark'],
      ['light', 'settings.themeLight']
    ]) {
      theme.append(el('option', { value, text: t(key) }));
    }
    theme.value = settings().appearance.theme;

    const sheet = el('div', { class: 'commit' }, [
      el('div', { class: 'turn__who' }, [el('span', { class: 'turn__role', text: t('settings.title') })]),
      field(t('settings.profile'), id),
      field(t('settings.endpoint'), baseUrl),
      field(t('settings.apiKey'), apiKey),
      field(t('settings.model'), model),
      field(t('settings.contextWindow'), contextWindow),
      field(t('settings.maxOutput'), maxOutput),
      field(t('settings.autoCompact'), compactAt),
      field(t('settings.maxSteps'), maxSteps),
      field(t('settings.commandTimeout'), commandTimeout),
      field(t('settings.language'), language),
      field(t('settings.theme'), theme),
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
      // The status bar shows the model the core is actually configured with, and
      // this is the only place that knows it: it used to say "no model chosen"
      // forever, whatever had been saved.
      onProfile?.(state.profile);
      // The chooser beside the mode follows the profile: another endpoint is
      // another list, and asking again for the same one is skipped.
      void loadModels();
      state.agentSettings = snapshot.agent || {};
      // The core reports what its window looks like, so a window opened in the
      // middle of a long conversation draws the gauge before the next turn.
      if (snapshot.context) state.context = snapshot.context;
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
      renderContext();
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
        state.emptyState = el('div', { class: 'list__empty', text: t('chat.empty') });
        transcript.append(state.emptyState);
        return;
      }
      state.emptyState = null;
      for (const message of messages) {
        const text = stripContext(String(message.content || ''));
        if (!text.trim()) continue;
        // A summarised part of the conversation is a user-role message on the
        // wire. Drawing it as a bubble would put words in the user's mouth; it
        // is a note about what the agent no longer remembers.
        if (text.startsWith(SUMMARY_MARKER)) {
          transcript.append(el('div', { class: 'notice', text: t('chat.compactedHistory') }));
          continue;
        }
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
  window.addEventListener('resize', () => {
    if (state.modeOpen) toggleModeList(false);
  });

  /**
   * Follow every agent transition the main process reports.
   *
   * Reading the status once, when the panel was built, is why a window that was
   * opened before a folder was chosen went on saying "выключен" while the agent
   * behind it was already connected and answering: nothing told the panel that
   * anything had changed.
   */
  bus.on('agent:status-changed', (payload) => applyStatus(payload));

  /**
   * And follow the turn itself.
   *
   * This subscription is the whole reason the panel can show an answer. The main
   * process emits every event the core produces on this channel; without a
   * listener the panel sent a message and then displayed nothing at all - no
   * streaming text, no tool cards, no approval prompt and not even the error
   * that would have explained why - which is exactly what an assistant that does
   * not answer looks like.
   */
  bus.on('agent:event', (payload) => {
    if (payload && payload.name) handleEvent(payload);
  });

  /**
   * Restore the tabs that were open, and open the one that was active.
   *
   * The ids come from the window's own settings and the chats themselves from
   * the core, so an id that no longer exists is dropped rather than shown as a
   * tab that opens nothing.
   */
  async function restoreTabs() {
    await refreshConversations();
    const known = new Set(state.conversations.map((row) => row.id));
    const saved = (settings().session && settings().session.chats) || [];
    state.tabs = saved.filter((id) => known.has(id)).map((id) => ({ id, title: titleOf(id) }));

    const core = state.coreChat;
    const wanted = (settings().session && settings().session.activeChat) || '';
    const active = wanted && known.has(wanted) ? wanted : core;
    if (active && !state.tabs.some((tab) => tab.id === active)) {
      state.tabs.unshift({ id: active, title: titleOf(active) });
    }
    renderTabs();
    if (active && active !== core) await openChat(active);
  }

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
    renderModel();
    renderContext();
    renderRunning();
    await loadState();
    await loadHistory();
    await restoreTabs();
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
    hideModePopup();
    state.tabs = [];
    state.activeChat = '';
    state.coreChat = '';
    await refreshStatus();
    await loadState();
    await loadHistory();
    await restoreTabs();
    renderModel();
    renderContext();
    renderRunning();
    grow();
  }

  return {
    mount,
    send,
    cancel,
    reset,
    reload,
    toggleSettings,
    renderContext,
    focus: () => input.focus(),
    // The message's own context, for the tree's menu: a file can be pinned
    // where it is found instead of only from the composer's own row.
    contextFiles,
    hasContextFile,
    addContextFile,
    removeContextFile,
    toggleContextFile,
    loadModels,
    renderModel,
    state
  };
}