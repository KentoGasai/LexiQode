import * as vscode from 'vscode';
import { ChatController, ChatSurface, InboundMessage } from './chatController';
import { renderChatHtml } from './webview';

/** Wraps an editor tab so the controller can treat it like any other surface. */
class PanelSurface implements ChatSurface {
  constructor(private readonly panel: vscode.WebviewPanel) {}

  get webview(): vscode.Webview {
    return this.panel.webview;
  }

  get visible(): boolean {
    return this.panel.visible;
  }
}

/**
 * The agent as a tab beside the code.
 *
 * A sidebar view is a fixed strip; a working session needs the transcript next
 * to the file it is changing, wide enough to read a diff, and closable without
 * hiding the agent from the rest of the window. That is what this is.
 *
 * One tab at a time: asking for it twice reveals the tab already open instead of
 * showing the same conversation twice.
 */
export class ChatEditorPanel implements vscode.Disposable {
  public static readonly viewType = 'lexiqode.chatEditor';

  private static current: ChatEditorPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
    this.panel.webview.html = renderChatHtml(this.panel.webview, extensionUri);

    const surface = new PanelSurface(this.panel);
    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.controller.handle(message),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.controller.attach(surface);
  }

  /** Open the agent beside the current editor, or reveal the tab already open. */
  static show(extensionUri: vscode.Uri, controller: ChatController): void {
    if (ChatEditorPanel.current) {
      ChatEditorPanel.current.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatEditorPanel.viewType,
      'LexiQode',
      // Beside and without focus: the file being discussed stays visible.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatEditorPanel.current = new ChatEditorPanel(panel, extensionUri, controller);
  }

  /** True while the tab is open. */
  static get isOpen(): boolean {
    return ChatEditorPanel.current !== undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    // The panel raises this itself when the user closes the tab; clearing first
    // makes the second call a no-op rather than a loop.
    if (ChatEditorPanel.current === this) {
      ChatEditorPanel.current = undefined;
    }
    try {
      this.panel.dispose();
    } catch {
      // Already disposed.
    }
  }
}