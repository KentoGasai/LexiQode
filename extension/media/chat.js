/*
 * The chat surface script.
 *
 * Plain browser JavaScript with no build step, loaded by the extension host as a
 * real file. Two rules hold throughout:
 *
 * * every value that comes from the model, the core or the user is written with
 *   `textContent`, never `innerHTML`. Only fixed strings from this file are ever
 *   assigned as markup, which is why the few icons below are safe.
 * * nothing is sent to the host that the host does not expect: the message shapes
 *   here are the contract in `chatController.ts`.
 */

(function () {
  'use strict';

  var api = acquireVsCodeApi();

  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status');
  var settingsBtn = document.getElementById('settingsBtn');
  var newBtn = document.getElementById('newBtn');
  var log = document.getElementById('log');
  var empty = document.getElementById('empty');
  var approvals = document.getElementById('approvals');
  var input = document.getElementById('input');
  var modeBtn = document.getElementById('modeBtn');
  var modeLabel = document.getElementById('modeLabel');
  var modeMenu = document.getElementById('modeMenu');
  var modeList = document.getElementById('modeList');
  var askWrites = document.getElementById('askWrites');
  var askCommands = document.getElementById('askCommands');
  var sendBtn = document.getElementById('sendBtn');
  var stopBtn = document.getElementById('stopBtn');
  var sheet = document.getElementById('settings');
  var closeSettings = document.getElementById('closeSettings');
  var saveSettings = document.getElementById('saveSettings');
  var saveNote = document.getElementById('saveNote');
  var setBaseUrl = document.getElementById('setBaseUrl');
  var setModel = document.getElementById('setModel');
  var setApiKey = document.getElementById('setApiKey');
  var setMaxSteps = document.getElementById('setMaxSteps');
  var setAskWrites = document.getElementById('setAskWrites');
  var setAskCommands = document.getElementById('setAskCommands');
  var keyNote = document.getElementById('keyNote');

  var ICON_CARET = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.3 4.2a.6.6 0 0 1 .9 0l3 3.4a.6.6 0 0 1 0 .8l-3 3.4a.6.6 0 1 1-.9-.8L8.8 8 6.3 5a.6.6 0 0 1 0-.8z"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 4.2a.7.7 0 0 1 0 1L7.1 11.4a.7.7 0 0 1-1 0L3 8.3a.7.7 0 1 1 1-1l2.6 2.7 5.6-5.8a.7.7 0 0 1 1 0z"/></svg>';

  /* Which verb to show for a tool call. The model names a tool; a person reads
   * what happened, so the verb is chosen here rather than showing the raw name. */
  var VERBS = {
    read_file: 'Read',
    list_dir: 'Listed',
    glob: 'Found files by pattern',
    grep: 'Searched',
    write_file: 'Wrote',
    edit_file: 'Edited',
    run_command: 'Ran'
  };

  var modes = [];
  var currentMode = 'agent';
  var busy = false;
  var stepLine = '';
  var modelLine = '';
  var turn = null;
  var body = null;
  var toolsBox = null;
  var reasoningBox = null;
  var reasoningText = null;
  var toolNodes = {};

  /* -------------------------------------------------------------- small helpers */

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function icon(svg, className) {
    var span = document.createElement('span');
    span.className = className || 'icon';
    span.innerHTML = svg;
    return span;
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 70;
  }

  function scrollDown(force) {
    if (force || atBottom()) { log.scrollTop = log.scrollHeight; }
  }

  function clearEmpty() {
    if (empty && empty.parentNode) { empty.parentNode.removeChild(empty); }
    empty = null;
  }

  function setStatus(state, text) {
    dot.setAttribute('data-state', state);
    statusText.textContent = text || '';
  }

  function refreshStatus() {
    if (busy) {
      setStatus('starting', stepLine ? stepLine + ' - ' + modelLine : modelLine || 'working');
      return;
    }
    setStatus(dot.getAttribute('data-state') === 'error' ? 'error' : 'ready', modelLine);
  }

  function setBusy(value) {
    busy = value;
    sendBtn.hidden = value;
    stopBtn.hidden = !value;
    refreshSendEnabled();
    refreshStatus();
  }

  function refreshSendEnabled() {
    sendBtn.disabled = busy || input.value.trim().length === 0;
  }

  /* ---------------------------------------------------------------- transcript */

  function startTurn(userText) {
    clearEmpty();
    var wrap = element('div', 'turn');
    wrap.appendChild(element('div', 'user', userText));
    body = element('div', 'assistant thinking', '');
    wrap.appendChild(body);
    toolsBox = element('div', 'tools');
    wrap.appendChild(toolsBox);
    log.appendChild(wrap);
    turn = wrap;
    reasoningBox = null;
    reasoningText = null;
    toolNodes = {};
    scrollDown(true);
  }

  function ensureTurn() {
    if (!turn) { startTurn(''); }
  }

  function appendText(chunk) {
    ensureTurn();
    body.className = 'assistant';
    body.textContent = body.textContent + chunk;
    scrollDown(false);
  }

  function appendReasoning(chunk) {
    ensureTurn();
    if (!reasoningBox) {
      reasoningBox = element('div', 'reasoning');
      var head = element('div', 'reasoning-head');
      head.appendChild(icon(ICON_CARET));
      head.appendChild(element('span', null, 'Thinking'));
      reasoningText = element('div', 'reasoning-text', '');
      reasoningBox.appendChild(head);
      reasoningBox.appendChild(reasoningText);
      head.addEventListener('click', function () { reasoningBox.classList.toggle('open'); });
      if (body && body.parentNode === turn) {
        turn.insertBefore(reasoningBox, body);
      } else {
        turn.appendChild(reasoningBox);
      }
    }
    reasoningText.textContent = reasoningText.textContent + chunk;
    scrollDown(false);
  }

  function toolTarget(name, args) {
    if (!args || typeof args !== 'object') { return ''; }
    var value = args.command || args.path || args.pattern || args.query || '';
    if (typeof value !== 'string') {
      try { value = JSON.stringify(value); } catch (error) { value = ''; }
    }
    return value.length > 300 ? value.slice(0, 300) + '...' : value;
  }

  function toolStart(data) {
    ensureTurn();
    var card = element('div', 'tool running');
    var head = element('div', 'tool-head');
    head.appendChild(icon(ICON_CARET, 'caret'));
    head.appendChild(element('span', 'verb', VERBS[data.name] || data.name));
    head.appendChild(element('span', 'target', toolTarget(data.name, data.arguments)));
    var state = element('span', 'state', 'running');
    head.appendChild(state);
    var output = element('pre', 'tool-body', '');
    card.appendChild(head);
    card.appendChild(output);
    head.addEventListener('click', function () { card.classList.toggle('open'); });
    toolsBox.appendChild(card);
    toolNodes[data.id] = { card: card, head: head, output: output, state: state };
    scrollDown(false);
  }

  function toolEnd(data) {
    var node = toolNodes[data.id];
    if (!node) { return; }
    var failed = !data.ok && !data.cancelled;
    node.card.className = 'tool ' + (data.cancelled ? 'skipped' : failed ? 'failed' : 'ok');
    node.state.textContent = data.cancelled
      ? 'skipped'
      : failed
        ? 'failed'
        : formatDuration(data.elapsed_ms);
    node.output.textContent = data.content || '';

    var meta = data.meta || {};
    if (meta.changed && typeof meta.path === 'string') {
      var review = element('span', 'review', meta.created ? 'open' : 'review');
      review.addEventListener('click', function (event) {
        event.stopPropagation();
        api.postMessage({ type: 'openChange', path: meta.path, created: !!meta.created });
      });
      node.head.appendChild(review);
    }
    if (failed) { node.card.classList.add('open'); }
    scrollDown(false);
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || ms < 0) { return ''; }
    if (ms < 1000) { return ms + ' ms'; }
    return (ms / 1000).toFixed(1) + ' s';
  }

  function renderHistory(messages) {
    if (!messages || !messages.length) { return; }
    // A reload can hand over a long transcript; showing the tail keeps the panel
    // usable while still giving the conversation its context.
    var tail = messages.slice(-30);
    var rendered = 0;
    for (var index = 0; index < tail.length; index += 1) {
      var message = tail[index];
      if (!message || typeof message.content !== 'string' || !message.content.trim()) { continue; }
      if (message.role === 'user') {
        clearEmpty();
        var wrap = element('div', 'turn');
        wrap.appendChild(element('div', 'user', message.content));
        log.appendChild(wrap);
        body = null;
        turn = wrap;
        toolsBox = null;
        rendered += 1;
      } else if (message.role === 'assistant' && turn) {
        var text = element('div', 'assistant', message.content);
        turn.appendChild(text);
        rendered += 1;
      }
    }
    if (rendered) {
      body = null;
      turn = null;
      toolsBox = null;
      scrollDown(true);
    }
  }

  /* ---------------------------------------------------------------- approvals */

  function showApproval(data) {
    ensureTurn();
    var card = element('div', 'approval');
    card.appendChild(element('div', 'title', data.family === 'command' ? 'Run this command?' : 'Change these files?'));
    card.appendChild(element('div', 'summary', data.detail ? data.summary + '\n' + data.detail : data.summary || ''));

    var row = element('div', 'row');
    var allow = element('button', 'primary', 'Allow');
    var always = element('button', 'ghost', 'Always allow');
    var deny = element('button', 'ghost', 'Deny');

    function answer(approved, remember) {
      api.postMessage({ type: 'approval', id: data.id, approved: approved, remember: remember });
      if (card.parentNode) { card.parentNode.removeChild(card); }
      input.focus();
    }

    allow.addEventListener('click', function () { answer(true, false); });
    always.addEventListener('click', function () { answer(true, true); });
    deny.addEventListener('click', function () { answer(false, false); });
    row.appendChild(allow);
    row.appendChild(always);
    row.appendChild(deny);
    card.appendChild(row);
    approvals.appendChild(card);
    scrollDown(true);
    input.focus();
  }

  function notice(text, isError) {
    var node = element('div', 'notice' + (isError ? ' error' : ''), text);
    approvals.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) { node.parentNode.removeChild(node); }
    }, isError ? 12000 : 6000);
  }

  /* ------------------------------------------------------------- mode selector */

  function renderModes() {
    modeList.textContent = '';
    for (var index = 0; index < modes.length; index += 1) {
      var mode = modes[index];
      var row = element('button', 'mode-row');
      row.setAttribute('role', 'menuitem');
      row.setAttribute('type', 'button');
      var top = element('div', 'row-top');
      top.appendChild(element('span', 'row-name', mode.label));
      if (mode.id === currentMode) {
        top.appendChild(icon(ICON_CHECK, 'row-check'));
      }
      row.appendChild(top);
      if (mode.summary) {
        row.appendChild(element('span', 'row-summary', mode.summary));
      }
      (function (id) {
        row.addEventListener('click', function () {
          currentMode = id;
          applyMode();
          api.postMessage({ type: 'setMode', mode: id });
          closeMenu();
        });
      })(mode.id);
      modeList.appendChild(row);
    }
  }

  function applyMode() {
    var label = currentMode;
    for (var index = 0; index < modes.length; index += 1) {
      if (modes[index].id === currentMode) { label = modes[index].label; break; }
    }
    modeLabel.textContent = label;
    renderModes();
  }

  function openMenu() {
    modeMenu.hidden = false;
    modeBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    modeMenu.hidden = true;
    modeBtn.setAttribute('aria-expanded', 'false');
  }

  function menuOpen() {
    return !modeMenu.hidden;
  }

  /* ------------------------------------------------------------------- sending */

  function submit() {
    var text = input.value.trim();
    if (!text || busy) { return; }
    input.value = '';
    growTextarea();
    refreshSendEnabled();
    startTurn(text);
    setBusy(true);
    api.postMessage({ type: 'send', text: text, mode: currentMode });
  }

  function growTextarea() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  /* -------------------------------------------------------------- settings sheet */

  function openSheet() {
    closeMenu();
    sheet.hidden = false;
    saveNote.textContent = '';
    saveNote.className = 'save-note';
    api.postMessage({ type: 'loadSettings' });
  }

  function closeSheet() {
    sheet.hidden = true;
    input.focus();
  }

  function fillSettings(values) {
    setBaseUrl.value = values.baseUrl || '';
    setModel.value = values.model || '';
    setMaxSteps.value = String(values.maxSteps || 40);
    setAskWrites.checked = values.askWrites !== false;
    setAskCommands.checked = values.askCommands !== false;
    setApiKey.value = '';
    setApiKey.placeholder = values.hasApiKey ? 'a key is stored - type to replace it' : 'paste the key';
    keyNote.textContent = values.hasApiKey
      ? 'A key is stored in the operating system credential store.'
      : 'Stored in the operating system credential store. It never reaches the chat surface.';
  }

  function submitSettings() {
    var steps = parseInt(setMaxSteps.value, 10);
    if (!isFinite(steps) || steps < 1) { steps = 40; }
    if (steps > 200) { steps = 200; }
    setMaxSteps.value = String(steps);
    saveNote.textContent = 'saving...';
    saveNote.className = 'save-note';
    api.postMessage({
      type: 'saveSettings',
      baseUrl: setBaseUrl.value.trim(),
      model: setModel.value.trim(),
      apiKey: setApiKey.value,
      maxSteps: steps,
      askWrites: setAskWrites.checked,
      askCommands: setAskCommands.checked
    });
  }

  /* ------------------------------------------------------------------- wiring up */

  modeBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    if (menuOpen()) { closeMenu(); } else { openMenu(); }
  });
  document.addEventListener('click', function (event) {
    if (menuOpen() && !modeMenu.contains(event.target) && event.target !== modeBtn) {
      closeMenu();
    }
  });

  askWrites.addEventListener('change', function () {
    api.postMessage({ type: 'policy', writes: askWrites.checked, commands: askCommands.checked });
  });
  askCommands.addEventListener('change', function () {
    api.postMessage({ type: 'policy', writes: askWrites.checked, commands: askCommands.checked });
  });

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', function () { api.postMessage({ type: 'cancel' }); });
  settingsBtn.addEventListener('click', openSheet);
  closeSettings.addEventListener('click', closeSheet);
  saveSettings.addEventListener('click', submitSettings);

  newBtn.addEventListener('click', function () {
    api.postMessage({ type: 'newSession' });
    log.textContent = '';
    approvals.textContent = '';
    turn = null;
    body = null;
    toolsBox = null;
    reasoningBox = null;
    toolNodes = {};
    stepLine = '';
    setBusy(false);
    var fresh = element('div', 'empty');
    fresh.appendChild(element('p', 'empty-title', 'New session'));
    fresh.appendChild(element('p', 'empty-text', 'The conversation is cleared. The workspace is untouched.'));
    log.appendChild(fresh);
    empty = fresh;
    input.focus();
  });

  input.addEventListener('input', function () {
    growTextarea();
    refreshSendEnabled();
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') { return; }
    if (!sheet.hidden) { closeSheet(); return; }
    if (menuOpen()) { closeMenu(); }
  });

  /* ------------------------------------------------------------- host messages */

  function onFrame(name, data) {
    if (name === 'turn_start') {
      setBusy(true);
    } else if (name === 'step_start') {
      stepLine = data && data.max_steps ? 'step ' + data.step + '/' + data.max_steps : '';
      refreshStatus();
    } else if (name === 'text_delta') {
      appendText(data.text || '');
    } else if (name === 'assistant_text') {
      ensureTurn();
      body.className = 'assistant';
      body.textContent = data.text || '';
      scrollDown(false);
    } else if (name === 'reasoning_delta') {
      appendReasoning(data.text || '');
    } else if (name === 'tool_start') {
      toolStart(data);
    } else if (name === 'tool_end') {
      toolEnd(data);
    } else if (name === 'approval_request') {
      showApproval(data || {});
    } else if (name === 'error') {
      notice('Core error: ' + (data.message || 'unknown'), true);
      setStatus('error', modelLine);
    } else if (name === 'turn_end') {
      stepLine = '';
      setBusy(false);
      if (data.stopped === 'max_steps') { notice('Stopped: the step budget ran out.'); }
      if (data.stopped === 'cancelled') { notice('Stopped by you.'); }
      if (data.stopped === 'error') { dot.setAttribute('data-state', 'error'); }
      if (body && !body.textContent) { body.className = 'assistant'; }
      refreshStatus();
    }
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }

    if (message.type === 'init') {
      modelLine = message.model || 'not connected';
      if (Array.isArray(message.modes)) { modes = message.modes; }
      if (message.mode) { currentMode = message.mode; }
      applyMode();
      if (typeof message.allowWrites === 'boolean') { askWrites.checked = message.allowWrites; }
      if (typeof message.allowCommands === 'boolean') { askCommands.checked = message.allowCommands; }
      setStatus(message.connection === 'ready' ? 'ready' : message.connection === 'error' ? 'error' : 'starting', modelLine);
      renderHistory(message.history);
      if (message.notice) { notice(message.notice, message.connection === 'error'); }
      return;
    }
    if (message.type === 'modes') {
      modes = message.modes || [];
      if (message.mode) { currentMode = message.mode; }
      applyMode();
      return;
    }
    if (message.type === 'mode') {
      currentMode = message.mode;
      applyMode();
      return;
    }
    if (message.type === 'connection') {
      if (message.model) { modelLine = message.model; }
      if (message.state === 'error') {
        setStatus('error', modelLine);
      } else if (message.state === 'ready') {
        dot.setAttribute('data-state', 'ready');
        refreshStatus();
      } else {
        dot.setAttribute('data-state', 'starting');
      }
      if (message.detail) { notice(message.detail, message.state === 'error'); }
      return;
    }
    if (message.type === 'settings') {
      fillSettings(message.values || {});
      return;
    }
    if (message.type === 'settingsSaved') {
      if (message.ok) {
        saveNote.textContent = 'saved; the core reconnected';
        saveNote.className = 'save-note';
      } else {
        saveNote.textContent = message.error || 'could not save';
        saveNote.className = 'save-note error';
      }
      return;
    }
    if (message.type === 'frame') {
      onFrame(message.event, message.data || {});
    }
  });

  growTextarea();
  refreshSendEnabled();
  api.postMessage({ type: 'ready' });
})();