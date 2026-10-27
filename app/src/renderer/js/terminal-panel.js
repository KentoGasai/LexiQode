/*
 * The terminal panel.
 *
 * It is a command console, not a pseudo-terminal, and it says so in the corner
 * instead of pretending: the shell runs in a child process whose standard input
 * is a pipe, so anything that reads a command and prints lines works, including
 * colour, while a full-screen program cannot. For a coding assistant's terminal
 * that trade buys a great deal: no native module, no compiler on the machine
 * that builds the app, and identical behaviour for every user.
 *
 * Output is drawn by xterm; input is a single line below it, because with no
 * pseudo-console there is no remote echo and no line editor. The prompt shows
 * the folder the shell itself reported, so it is never out of date.
 */

import { clear, el, iconButton } from './ui.js';
import { t } from './i18n.js';

export function createTerminalPanel({ api, bus, settings, onNotice }) {
  const body = document.getElementById('panel-body');
  const tabsHost = document.getElementById('panel-tabs');
  const actions = document.getElementById('panel-actions');

  const sessions = new Map();
  let current = '';
  let counter = 0;
  const history = [];
  let historyIndex = -1;

  const input = el('input', {
    class: 'terminal__field',
    type: 'text',
    placeholder: t('terminal.placeholder'),
    spellcheck: 'false',
    autocomplete: 'off',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        const command = input.value;
        input.value = '';
        if (!command.trim()) return;
        history.unshift(command);
        historyIndex = -1;
        void submit(command);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (historyIndex + 1 < history.length) {
          historyIndex += 1;
          input.value = history[historyIndex];
        }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyIndex > 0) {
          historyIndex -= 1;
          input.value = history[historyIndex];
        } else {
          historyIndex = -1;
          input.value = '';
        }
      }
    }
  });
  const promptLabel = el('span', { class: 'terminal__prompt', text: '…' });
  const note = el('span', { class: 'terminal__note', text: t('terminal.note') });
  const inputRow = el('div', { class: 'terminal__input' }, [promptLabel, input, note]);

  async function submit(command) {
    const session = sessions.get(current);
    if (!session) return;
    session.term.write(`\x1b[90m${promptLabel.textContent} \x1b[0m${command}\r\n`);
    try {
      await api.terminal.submit(current, command);
    } catch (error) {
      session.term.write(`\x1b[31m${error.message}\x1b[0m\r\n`);
    }
  }

  /**
   * Run a command the window built, in the folder that is open.
   *
   * Used by the run button, which is why it makes sure a session exists first:
   * pressing Run with no shell open should start one and run the file, not say
   * that there is no terminal. The line is echoed into the console the same way a
   * typed command is, so the record of what was run is in one place.
   */
  async function run(command) {
    const text = String(command || '').trim();
    if (!text) throw new Error(t('terminal.nothingToRun'));
    const session = await openInFolder();
    if (!session) throw new Error(t('terminal.noFolder'));
    await submit(text);
    return { id: session.id, command: text };
  }

  function renderTabs() {
    clear(tabsHost);
    for (const [id, session] of sessions) {
      tabsHost.append(
        el('button', {
          class: 'panel__tab',
          type: 'button',
          text: session.title,
          'aria-selected': String(id === current),
          onclick: () => {
            current = id;
            renderTabs();
            renderBody();
          }
        })
      );
    }
  }

  function renderBody() {
    clear(body);
    const session = sessions.get(current);
    if (!session) {
      body.append(el('div', { class: 'list__empty', text: t('terminal.empty') }));
      return;
    }
    /*
     * The one host element the session keeps for its whole life.
     *
     * `renderBody` used to build a fresh `<div class="terminal">` every time and
     * hand it to `term.open()`. xterm 6 refuses that: `open(parent)` returns
     * immediately when the parent is already part of the document - it decides
     * from `parent.isConnected` that the terminal is open already and builds
     * nothing. Measured, not guessed: the panel held a 154-pixel host with no
     * `.xterm-screen` inside it while the shell's output arrived normally, so the
     * window showed an empty rectangle and pressing Run looked like nothing
     * happening. The terminal had no DOM at all.
     *
     * The host is therefore created once, before it is attached, and only ever
     * moved: clearing the panel detaches it, and appending it again brings the
     * terminal's own DOM with it, exactly as it was.
     */
    body.append(session.host, inputRow);
    requestAnimationFrame(() => {
      try {
        session.fit.fit();
        session.term.focus();
      } catch {
        // The panel is hidden or has no size yet; the observer will fix that.
      }
    });
    input.focus();
  }

  function renderActions() {
    clear(actions);
    actions.append(
      iconButton('plus', t('terminal.new'), () => void open()),
      iconButton('close', t('terminal.close'), () => void closeCurrent())
    );
  }

  async function open() {
    const workspace = await api.workspace.current().catch(() => null);
    counter += 1;
    try {
      const session = await api.terminal.create({ cwd: workspace ? workspace.root : undefined });
      const term = new window.Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: settings().terminal.fontSize,
        fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace',
        scrollback: 4000,
        theme: {
          background: '#121216',
          foreground: '#dcdce3',
          cursor: '#6ea8fe',
          selectionBackground: '#2a4a7a'
        }
      });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      /*
       * The host is opened while it is still detached, and that is the whole
       * point: xterm 6 builds the terminal's DOM during this call and skips it
       * entirely when the parent is already in the document. Attaching the host
       * first - which is what the code did - produced a terminal with no DOM at
       * all, a panel that looked empty, and a Run button that appeared to do
       * nothing while its output arrived.
       */
      const host = el('div', { class: 'terminal' });
      term.open(host);
      const record = {
        id: session.id,
        title: `${workspace ? workspace.name : 'shell'} ${counter}`,
        term,
        fit,
        host,
        root: workspace ? workspace.root : '',
        observer: null
      };
      // A terminal opened while its panel was collapsed measures zero rows and
      // then draws nothing, even though the session is running and output is
      // arriving. Watching the element is what turns "output arrives" into
      // "output is on screen", for that case and for every later resize.
      if (typeof ResizeObserver === 'function') {
        record.observer = new ResizeObserver(() => {
          try {
            record.fit.fit();
          } catch {
            // No size to fit to yet.
          }
        });
        record.observer.observe(host);
      }
      sessions.set(session.id, record);
      term.writeln(`\x1b[90m${session.shell} · ${session.cwd}\x1b[0m`);
      term.writeln(`\x1b[90m${t('terminal.intro')}\x1b[0m`);
      term.onData((data) => {
        if (data === '\r') input.focus();
      });
      current = session.id;
      renderTabs();
      renderActions();
      renderBody();
    } catch (error) {
      onNotice?.(error.message, 'error');
    }
  }

  async function closeCurrent() {
    const session = sessions.get(current);
    if (!session) return;
    try {
      await api.terminal.kill(current);
    } catch {
      // Already gone.
    }
    session.observer?.disconnect();
    session.term.dispose();
    sessions.delete(current);
    current = sessions.size ? [...sessions.keys()][sessions.size - 1] : '';
    renderTabs();
    renderBody();
  }

  /**
   * Make sure a shell is running in the folder that is open now.
   *
   * A session belongs to the directory it was started in - `cd` inside it
   * persists, which is the point of a persistent console - so after a folder
   * change the old one is not moved or reused: it is closed, and a new shell is
   * started where the user is actually working. Returns the session that is now
   * current, or null when there is no folder to start one in.
   */
  async function openInFolder() {
    const workspace = await api.workspace.current().catch(() => null);
    if (!workspace) return null;
    const stale = [...sessions.values()].filter((session) => session.root !== workspace.root);
    for (const session of stale) {
      await api.terminal.kill(session.id).catch(() => {});
      session.observer?.disconnect();
      session.term.dispose();
      sessions.delete(session.id);
    }
    if (!sessions.size) {
      await open();
    } else {
      if (!sessions.has(current)) current = [...sessions.keys()][sessions.size - 1];
      renderTabs();
      renderActions();
      renderBody();
    }
    const session = sessions.get(current);
    return session ? { id: session.id, title: session.title, root: session.root } : null;
  }

  bus.on('terminal:data', (payload) => {
    if (!payload) return;
    const session = sessions.get(payload.id);
    if (!session) return;
    if (payload.data) session.term.write(payload.data);
    if (payload.prompt) {
      if (payload.id === current) promptLabel.textContent = payload.prompt.cwd;
      if (payload.prompt.status === 'err') promptLabel.style.color = 'var(--danger)';
      else promptLabel.style.color = 'var(--ok)';
    }
  });

  bus.on('terminal:exit', (payload) => {
    const session = sessions.get(payload && payload.id);
    if (!session) return;
    session.term.writeln(`\r\n\x1b[90m${t('terminal.ended', { code: payload.code })}\x1b[0m`);
  });

  function mount() {
    renderActions();
    renderTabs();
    if (!sessions.size) {
      void open();
      return;
    }
    renderBody();
  }

  function unmount() {
    // Sessions stay alive while the panel is hidden: losing a running build
    // because a panel was collapsed would be a poor trade.
  }

  function focus() {
    input.focus();
  }

  return { mount, unmount, open, openInFolder, run, focus, get count() { return sessions.size; } };
}