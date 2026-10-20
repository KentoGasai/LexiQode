import * as vscode from 'vscode';

/**
 * One log for everything the extension and the core produce.
 *
 * The core's stderr is the only place its startup failures appear, so those
 * lines are mirrored here rather than shown in a transient notification the
 * user cannot copy. A bounded ring buffer keeps the recent history available
 * for a bug report without keeping the channel alive.
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly history: string[] = [];
  private static readonly HISTORY_LIMIT = 500;

  constructor(name = 'LexiQode') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
    this.write('error', message + detail);
  }

  /** Lines the core wrote to stderr, forwarded verbatim. */
  core(line: string): void {
    this.write('core', line);
  }

  recent(limit = 200): string[] {
    return this.history.slice(-limit);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    const line = `[${stamp}] ${level.padEnd(5)} ${message}`;
    this.history.push(line);
    if (this.history.length > Logger.HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - Logger.HISTORY_LIMIT);
    }
    this.channel.appendLine(line);
  }
}