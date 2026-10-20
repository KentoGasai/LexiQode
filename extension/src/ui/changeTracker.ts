import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { ToolEndEvent, ToolStartEvent } from '../core/types';

/**
 * Turns the core's file changes into reviewable diffs.
 *
 * The core reports *that* a file changed, not its previous contents, and it
 * edits the file on disk directly rather than through the editor. So the
 * extension snapshots the file when a write-family tool starts and compares
 * against that snapshot when the tool finishes. The snapshot is served to the
 * diff editor through a virtual read-only document, which keeps the original
 * file untouched and works whether or not the workspace is a git repository.
 */

export const BEFORE_SCHEME = 'lexiqode-before';

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
/** Snapshots are kept so "review change" still works after a turn ends. */
const SNAPSHOT_LIMIT = 50;

export class ChangeTracker implements vscode.Disposable {
  private readonly snapshots = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly log: Logger,
    private readonly options: { showDiffs: boolean; revealNewFiles: boolean }
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
      provideTextDocumentContent: (uri: vscode.Uri): string => {
        const key = decodeURIComponent(uri.query);
        return this.snapshots.get(key) ?? '';
      },
    });
  }

  /** Remember the file as it is right now, before the tool touches it. */
  onToolStart(event: ToolStartEvent): void {
    if (!WRITE_TOOLS.has(event.name) || !this.options.showDiffs) {
      return;
    }
    const raw = event.arguments?.path;
    if (typeof raw !== 'string' || !raw) {
      return;
    }
    const absolute = this.absolute(raw);
    if (!absolute) {
      return;
    }
    try {
      this.snapshots.set(absolute, fs.readFileSync(absolute, 'utf8'));
      this.trimSnapshots();
    } catch {
      // A new file has nothing to snapshot; absence is the "did not exist" case.
      this.snapshots.delete(absolute);
    }
  }

  /** Show the change, or open the file when it was created from nothing. */
  async onToolEnd(event: ToolEndEvent): Promise<void> {
    const meta = event.meta ?? {};
    const relative = typeof meta.path === 'string' ? meta.path : '';
    if (!meta.changed || !relative) {
      return;
    }
    const absolute = this.absolute(relative);
    if (!absolute) {
      return;
    }

    if (!this.snapshots.has(absolute)) {
      // The file did not exist before, so there is nothing to compare against.
      if (this.options.revealNewFiles) {
        await this.reveal(absolute);
      }
      return;
    }
    if (!this.options.showDiffs) {
      return;
    }

    // The snapshot stays: the diff editor reads it lazily through the content
    // provider, and the chat's "review change" link needs it after the turn too.
    const name = path.basename(absolute);
    const beforeUri = vscode.Uri.from({
      scheme: BEFORE_SCHEME,
      path: '/' + name,
      query: encodeURIComponent(absolute),
    });
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        beforeUri,
        vscode.Uri.file(absolute),
        `${name}: before -> after (LexiQode)`,
        { preview: true }
      );
    } catch (error) {
      this.log.warn(`could not open the diff for ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Open the changed file itself, used for "review change" in the chat. */
  async openChanged(relative: string, created: boolean): Promise<void> {
    const absolute = this.absolute(relative);
    if (!absolute) {
      return;
    }
    if (!created && this.snapshots.has(absolute)) {
      const name = path.basename(absolute);
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.from({
          scheme: BEFORE_SCHEME,
          path: '/' + name,
          query: encodeURIComponent(absolute),
        }),
        vscode.Uri.file(absolute),
        `${name}: before -> after (LexiQode)`,
        { preview: true }
      );
      return;
    }
    await this.reveal(absolute);
  }

  dispose(): void {
    this.registration.dispose();
    this.snapshots.clear();
  }

  private async reveal(absolute: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.log.warn(`could not open ${absolute}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private trimSnapshots(): void {
    while (this.snapshots.size > SNAPSHOT_LIMIT) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done) {
        return;
      }
      this.snapshots.delete(oldest.value);
    }
  }

  private absolute(relative: string): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const resolved = path.resolve(folder.uri.fsPath, relative);
    const root = folder.uri.fsPath;
    // The core confines itself to the workspace; the extension re-checks because
    // a path that arrives over a socket must not be trusted blindly.
    const normalisedRoot = path.resolve(root);
    if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + path.sep)) {
      this.log.warn(`ignoring a path outside the workspace: ${relative}`);
      return undefined;
    }
    return resolved;
  }
}