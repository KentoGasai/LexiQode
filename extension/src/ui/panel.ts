import * as vscode from 'vscode';
import { ChatController, ChatSurface, InboundMessage } from './chatController';
import { renderChatHtml } from './webview';

/** Wraps a sidebar view so the controller can treat it like any other surface. */
class ViewSurface implements ChatSurface {
  constructor(private readonly view: vscode.WebviewView) {}

  get webview(): vscode.Webview {
    return this.view.webview;
  }

  get visible(): boolean {
    return this.view.visible;
  }
}

/**
 * The agent in the side bar.
 *
 * The view is disposable - it is collapsed, or the window reloads - while the
 * conversation is not, so all of that lives in the controller and this class
 * only wires a view to it.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'lexiqode.chat';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = renderChatHtml(view.webview, this.extensionUri);

    const surface = new ViewSurface(view);
    view.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.controller.handle(message),
      undefined,
      this.disposables
    );
    view.onDidDispose(
      () => {
        this.controller.detach(surface);
        this.view = undefined;
      },
      undefined,
      this.disposables
    );
    this.controller.attach(surface);
  }

  /** Bring the view into focus, resolving it first if it was never opened. */
  async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      return;
    }
    this.view.show?.(true);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }
}