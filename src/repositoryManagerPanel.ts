/**
 * Webview panel for Repository Manager
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitOperations } from './gitOperations';
import { PRManager } from './prManager';
import { getHtmlForWebview, WebviewResourceUris, WorkspaceFolderInfo } from './webview/template';
import { messageHandlers, MessageHandlerContext } from './handlers/webviewMessageHandler';

export class RepositoryManagerPanel {
  public static currentPanel: RepositoryManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _gitOps: GitOperations;
  private _prManager: PRManager;
  private _disposables: vscode.Disposable[] = [];
  private _workspaceRoot: string;

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (RepositoryManagerPanel.currentPanel) {
      RepositoryManagerPanel.currentPanel._panel.reveal(column);
      RepositoryManagerPanel.currentPanel.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'repositoryManager',
      'Repository Manager',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    RepositoryManagerPanel.currentPanel = new RepositoryManagerPanel(
      panel,
      extensionUri,
      workspaceRoot
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceRoot = workspaceRoot;
    this._gitOps = new GitOperations(workspaceRoot);
    this._prManager = new PRManager(workspaceRoot);

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );
  }

  /**
   * Get all workspace folders info for the folder selector
   */
  private _getWorkspaceFolders(): WorkspaceFolderInfo[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map(folder => ({
      name: folder.name,
      path: folder.uri.fsPath,
      isCurrent: folder.uri.fsPath === this._workspaceRoot
    }));
  }

  /**
   * Switch to a different workspace folder
   */
  private async _switchWorkspaceFolder(folderPath: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders || [];
    const targetFolder = folders.find(f => f.uri.fsPath === folderPath);
    if (!targetFolder) {
      vscode.window.showErrorMessage(`Workspace folder not found: ${path.basename(folderPath)}`);
      return;
    }

    this._workspaceRoot = folderPath;
    this._gitOps = new GitOperations(folderPath);
    this._prManager = new PRManager(folderPath);
    await this.refresh();
  }

  public async refresh(fullRefresh: boolean = false) {
    await this._update(fullRefresh);
  }

  private _getResourceUris(): WebviewResourceUris {
    const graphScriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'historyGraph.js')
    );
    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.js')
    );
    const styleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.css')
    );
    return { graphScriptUri, scriptUri, styleUri };
  }

  private async _update(fullRefresh: boolean = true) {
    const submodules = await this._gitOps.getSubmodules();

    // Get parent repo info and prepend it to the list
    const parentRepo = await this._gitOps.getParentRepoInfo();
    const allRepos = parentRepo ? [parentRepo, ...submodules] : submodules;

    if (fullRefresh) {
      const resourceUris = this._getResourceUris();
      const workspaceFolders = this._getWorkspaceFolders();
      this._panel.webview.html = getHtmlForWebview(allRepos, resourceUris, workspaceFolders);
    } else {
      // Send data update instead of regenerating HTML
      this._panel.webview.postMessage({
        type: 'updateSubmodules',
        payload: { submodules: allRepos }
      });
    }
  }

  /**
   * Create message handler context
   */
  private _createHandlerContext(): MessageHandlerContext {
    return {
      panel: this._panel,
      gitOps: this._gitOps,
      prManager: this._prManager,
      workspaceRoot: this._workspaceRoot,
      refresh: () => this.refresh()
    };
  }

  private async _handleMessage(message: { type: string; payload?: unknown }) {
    try {
      // Handle refresh separately as it's not in the handler map
      if (message.type === 'refresh') {
        await this.refresh();
        return;
      }

      // Handle workspace folder switch
      if (message.type === 'switchWorkspaceFolder') {
        const payload = message.payload as { folderPath: string };
        if (payload && payload.folderPath) {
          await this._switchWorkspaceFolder(payload.folderPath);
        }
        return;
      }

      // Look up the handler in the message handlers map
      const handler = messageHandlers[message.type];
      if (handler) {
        const ctx = this._createHandlerContext();
        await handler(ctx, message.payload);
      } else {
        console.warn(`Unhandled webview message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling webview message '${message.type}':`, error);
      // Try to notify the user about the error
      try {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Repository Manager: ${errorMsg}`);
      } catch {
        // Last resort - ignore
      }
    }
  }

  public dispose() {
    RepositoryManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
