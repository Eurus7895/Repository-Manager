import * as vscode from 'vscode';

/**
 * Activity Bar launcher for the editor dashboard. It intentionally owns no
 * repository tree: selecting the icon opens the dashboard and closes the
 * transient Side Bar so there is only one product surface.
 */
export class RepositoryManagerLauncher implements vscode.WebviewViewProvider {
  static readonly viewType = 'repositoryManager.launcher';

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();

    const openDashboard = async (): Promise<void> => {
      await vscode.commands.executeCommand('repositoryManager.openPanel');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    };

    view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'openDashboard') {
        void openDashboard();
      }
    });

    setTimeout(() => {
      if (view.visible) {
        void openDashboard();
      }
    }, 0);

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void openDashboard();
      }
    });
  }

  private getHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);">
        <button id="open" style="width:100%;height:36px;border:0;border-radius:6px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer;">Open Repository Manager</button>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'openDashboard' }));
        </script>
      </body>
      </html>`;
  }
}
