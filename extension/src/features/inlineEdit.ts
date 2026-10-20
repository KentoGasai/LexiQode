import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { readSettings } from '../config';
import { Session } from '../session';

/**
 * Ctrl+Alt+K: rewrite the selection with the model, then insert the result as an
 * ordinary editor edit.
 *
 * Applying it as a `WorkspaceEdit` rather than writing the file matters: the
 * user gets one undo step, the editor stays in sync, and nothing is written
 * until the model has answered. The core is asked through `/api/complete`, which
 * is not a conversation turn, so this never appears in the chat transcript and
 * never competes with a running turn.
 */

const SELECTION_LIMIT = 20_000;

const SYSTEM_PROMPT =
  'You are a precise code editor embedded in an IDE. You rewrite exactly the code ' +
  'you are shown, in the style already present. Reply with the replacement code ' +
  'only: no explanation, no markdown fences, no commentary. Preserve the original ' +
  'indentation.';

export function registerInlineEdit(session: Session, log: Logger): vscode.Disposable {
  return vscode.commands.registerCommand('lexiqode.inlineEdit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('LexiQode: open a file and select the code to change.');
      return;
    }
    const selection = editor.selection;
    const selected = editor.document.getText(selection);
    if (!selected.trim()) {
      void vscode.window.showInformationMessage('LexiQode: select the code you want to change first.');
      return;
    }
    if (selected.length > SELECTION_LIMIT) {
      void vscode.window.showWarningMessage(
        `LexiQode: the selection is ${selected.length} characters, over the ${SELECTION_LIMIT} limit. ` +
          'Select a smaller region.'
      );
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: 'LexiQode: edit selection',
      prompt: 'How should this code change?',
      placeHolder: 'for example: handle the empty list and add type hints',
      ignoreFocusOut: true,
    });
    if (instruction === undefined) {
      return;
    }

    const client = await session.ensureClient();
    if (!client) {
      log.error('inline edit requested but the core is not running');
      void vscode.window.showErrorMessage('LexiQode: the core is not running. See the LexiQode log.');
      return;
    }

    const settings = readSettings();
    const prompt = buildPrompt(editor, selected, instruction);
    try {
      const answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LexiQode is rewriting the selection', cancellable: false },
        () =>
          client.complete(prompt, {
            system: SYSTEM_PROMPT,
            maxTokens: Math.min(8_192, Math.max(512, Math.ceil(selected.length / 2))),
            ...(settings.inlineEditModel ? { model: settings.inlineEditModel } : {}),
          })
      );
      const replacement = cleanAnswer(answer, selected);
      if (!replacement.trim()) {
        void vscode.window.showWarningMessage('LexiQode: the model returned nothing to insert.');
        return;
      }
      if (replacement === selected) {
        void vscode.window.showInformationMessage('LexiQode: the model kept the selection unchanged.');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(editor.document.uri, selection, replacement);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        void vscode.window.showErrorMessage('LexiQode: the edit could not be applied; the document changed.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('inline edit failed', error);
      void vscode.window.showErrorMessage(`LexiQode: ${message}`);
    }
  });
}

function buildPrompt(editor: vscode.TextEditor, selected: string, instruction: string): string {
  const document = editor.document;
  const selection = editor.selection;
  const firstLine = selection.start.line + 1;
  const lastLine = selection.end.line + 1;
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const contextBefore = document
    .getText(new vscode.Range(Math.max(0, selection.start.line - 8), 0, selection.start.line, 0))
    .trimEnd();
  const contextAfter = document
    .getText(new vscode.Range(selection.end.line + 1, 0, Math.min(document.lineCount - 1, selection.end.line + 8), 0))
    .trimEnd();

  const parts = [
    'Rewrite the selected code.',
    '',
    `File: ${relative}`,
    `Language: ${document.languageId}`,
    `Selection: lines ${firstLine}-${lastLine} of ${document.lineCount}`,
    '',
    `Instruction: ${instruction.trim() || 'improve this code without changing its behaviour'}`,
  ];
  if (contextBefore) {
    parts.push('', 'Code immediately before the selection (do not repeat it):', '<<<', contextBefore, '>>>');
  }
  parts.push('', 'Selected code to replace:', '<<<', selected, '>>>');
  if (contextAfter) {
    parts.push('', 'Code immediately after the selection (do not repeat it):', '<<<', contextAfter, '>>>');
  }
  parts.push('', 'Reply with the replacement for the selected code only.');
  return parts.join('\n');
}

/**
 * Models often wrap code in a fenced block even when told not to, and Windows
 * editors dislike a trailing blank line. Both are corrected here rather than
 * pushed back on the user.
 */
export function cleanAnswer(answer: string, original: string): string {
  let text = answer.replace(/\r\n/g, '\n');
  const fence = /^\s*```[a-zA-Z0-9+#._-]*\n([\s\S]*?)\n?\s*```\s*$/;
  const match = fence.exec(text);
  if (match) {
    text = match[1];
  }
  // Drop a single leading blank line but keep the code's own indentation.
  text = text.replace(/^\n+/, '');
  const originalTrailing = original.endsWith('\n');
  const answerTrailing = text.endsWith('\n');
  if (!originalTrailing && answerTrailing) {
    text = text.replace(/\n+$/, '');
  }
  return text;
}