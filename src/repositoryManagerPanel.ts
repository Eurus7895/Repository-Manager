/**
 * Webview panel for Repository Manager
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitOperations } from './gitOperations';
import { PRManager } from './prManager';
import { getHtmlForWebview, WebviewResourceUris, WorkspaceFolderInfo } from './webview/template';
import { messageHandlers, MessageHandlerContext } from './handlers/webviewMessageHandler';
import { GitCommandService } from './services/gitCommandService';
import { ChangeContextService, MAX_PATCH_BYTES } from './services/changeContextService';
import { CopilotSummaryProvider } from './services/changeSummaryService';

/** Webview requests that only read Git state and may run during a background fetch. */
const READ_ONLY_MESSAGES = new Set([
  'getHistory', 'getCommitDetail', 'getFileDiff', 'getRepositoryRefs', 'getWorkingTreeChanges',
  'getWorkingTreePreview', 'getBranches', 'getCommits', 'getRecordedCommit', 'getBaseBranchesForCreate',
  'summarizeChanges', 'cancelChangeSummary', 'loadSummaryModels'
]);

export class RepositoryManagerPanel {
  public static currentPanel: RepositoryManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _gitOps: GitOperations;
  private _prManager: PRManager;
  private _disposables: vscode.Disposable[] = [];
  private _workspaceRoot: string;
  private readonly _summaryProvider = new CopilotSummaryProvider();
  private _summaryToken?: vscode.CancellationTokenSource;
  private _summaryRequest = 0;
  private _autoFetchTimer?: NodeJS.Timeout;
  private _autoFetchRun?: Promise<void>;
  private _lastAutoFetch = 0;
  private _messagesInFlight = 0;

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (RepositoryManagerPanel.currentPanel) {
      RepositoryManagerPanel.currentPanel._panel.reveal(column);
      RepositoryManagerPanel.currentPanel.refresh();
      RepositoryManagerPanel.currentPanel._autoFetchIfDue();
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

    this._panel.onDidChangeViewState(() => this._autoFetchIfDue(), null, this._disposables);
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('repositoryManager.autoFetch')
        || event.affectsConfiguration('repositoryManager.autoFetchInterval')) {
        this._scheduleAutoFetch();
      }
    }, null, this._disposables);
    this._scheduleAutoFetch();
    this._autoFetchIfDue();
  }

  /** Background fetch interval in ms, or 0 when disabled. */
  private _autoFetchIntervalMs(): number {
    const config = vscode.workspace.getConfiguration('repositoryManager');
    const minutes = config.get<number>('autoFetchInterval', 5);
    return config.get<boolean>('autoFetch', true) && minutes > 0 ? minutes * 60000 : 0;
  }

  private _scheduleAutoFetch(): void {
    if (this._autoFetchTimer) {
      clearInterval(this._autoFetchTimer);
      this._autoFetchTimer = undefined;
    }
    const interval = this._autoFetchIntervalMs();
    if (interval > 0) {
      this._autoFetchTimer = setInterval(() => this._autoFetchIfDue(), interval);
    }
  }

  /**
   * Fetch every initialized repository so ahead/behind counts stay current. Runs only while
   * the panel is visible, at most once per interval, and never alongside a user action.
   */
  private _autoFetchIfDue(): void {
    const interval = this._autoFetchIntervalMs();
    if (!interval || !this._panel.visible || this._autoFetchRun || this._messagesInFlight > 0
      || Date.now() - this._lastAutoFetch < interval - 1000) {
      return;
    }
    this._lastAutoFetch = Date.now();
    const gitOps = this._gitOps;
    this._autoFetchRun = (async () => {
      const repositories = await this._listRepositories();
      for (const repository of repositories) {
        // Stop early when the user starts an action or switches workspace folder.
        if (this._messagesInFlight > 0 || gitOps !== this._gitOps) {
          return;
        }
        if (repository.status !== 'uninitialized') {
          await gitOps.fetchInBackground(repository.path).catch(() => undefined);
        }
      }
      if (gitOps === this._gitOps) {
        await this.refresh();
      }
    })().catch(() => undefined).finally(() => {
      this._autoFetchRun = undefined;
    });
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
    this._cancelSummary();
    const folders = vscode.workspace.workspaceFolders || [];
    const targetFolder = folders.find(f => f.uri.fsPath === folderPath);
    if (!targetFolder) {
      vscode.window.showErrorMessage(`Workspace folder not found: ${path.basename(folderPath)}`);
      return;
    }

    this._workspaceRoot = folderPath;
    this._gitOps = new GitOperations(folderPath);
    this._prManager = new PRManager(folderPath);
    // Repository paths are relative to the folder (the root is always '.'), so the webview
    // must be told explicitly to drop the old folder's history, refs and selection.
    await this._panel.webview.postMessage({
      type: 'workspaceFolderChanged',
      payload: { repositories: await this._listRepositories() }
    });
  }

  public async refresh(fullRefresh: boolean = false) {
    await this._update(fullRefresh);
  }

  public async reloadDashboardHistory(repositoryPaths: string[]): Promise<void> {
    await this._panel.webview.postMessage({
      type: 'reloadDashboardHistory',
      payload: { repositoryPaths }
    });
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

  /** Parent repository first, then linked repositories. */
  private async _listRepositories() {
    const submodules = await this._gitOps.getSubmodules();
    const parentRepo = await this._gitOps.getParentRepoInfo();
    return parentRepo ? [parentRepo, ...submodules] : submodules;
  }

  private async _update(fullRefresh: boolean = true) {
    const allRepos = await this._listRepositories();

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
      refresh: () => this.refresh(),
      reloadDashboardHistory: (repositoryPaths) => this.reloadDashboardHistory(repositoryPaths)
    };
  }

  private async _handleMessage(message: { type: string; payload?: unknown }) {
    this._messagesInFlight++;
    try {
      // Git actions wait for a running background fetch so they never race it for ref locks.
      if (this._autoFetchRun && !READ_ONLY_MESSAGES.has(message.type)) {
        await this._autoFetchRun;
      }
      await this._dispatchMessage(message);
    } finally {
      this._messagesInFlight--;
    }
  }

  private async _dispatchMessage(message: { type: string; payload?: unknown }) {
    try {
      if (message.type === 'cancelChangeSummary') {
        this._cancelSummary();
        return;
      }
      if (message.type === 'summarizeChanges') {
        await this._summarizeChanges(message.payload);
        return;
      }
      if (message.type === 'loadSummaryModels') {
        try {
          const models = await this._summaryProvider.listModels();
          await this._panel.webview.postMessage({ type: 'summaryModelsLoaded', payload: { models } });
        } catch (error) {
          await this._panel.webview.postMessage({ type: 'summaryModelsError', payload: {
            message: error instanceof Error ? error.message : 'Unable to load Copilot models.'
          } });
        }
        return;
      }
      // Handle refresh separately as it's not in the handler map
      if (message.type === 'refresh') {
        try {
          await this.refresh();
          await this._panel.webview.postMessage({
            type: 'repositoryOperationResult',
            payload: { operation: 'refresh', success: true, message: 'Dashboard refreshed' }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this._panel.webview.postMessage({
            type: 'repositoryOperationResult',
            payload: { operation: 'refresh', success: false, message: `Refresh failed: ${errorMessage}` }
          });
          throw error;
        }
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
    this._cancelSummary();
    if (this._autoFetchTimer) {
      clearInterval(this._autoFetchTimer);
    }
    RepositoryManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _cancelSummary(): void {
    this._summaryRequest++;
    this._summaryToken?.cancel();
    this._summaryToken?.dispose();
    this._summaryToken = undefined;
  }

  private async _summarizeChanges(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const request = payload as Record<string, unknown>;
    const { repositoryPath, targetSha, baseSha, requestId, modelId } = request;
    if (typeof repositoryPath !== 'string' || typeof targetSha !== 'string' ||
        (baseSha !== null && typeof baseSha !== 'string') || typeof requestId !== 'number' ||
        (modelId !== undefined && typeof modelId !== 'string')) {
      return;
    }
    this._cancelSummary();
    const generation = this._summaryRequest;
    const root = this._workspaceRoot;
    const controller = new vscode.CancellationTokenSource();
    this._summaryToken = controller;
    const send = async (type: string, extra: Record<string, unknown>) => {
      if (generation === this._summaryRequest && !controller.token.isCancellationRequested) {
        await this._panel.webview.postMessage({ type, payload: { requestId, repositoryPath, ...extra } });
      }
    };
    try {
      await send('changeSummaryProgress', { status: 'Collecting context…' });
      const context = await new ChangeContextService(new GitCommandService(root))
        .collect(repositoryPath, targetSha, baseSha || undefined);
      if (generation !== this._summaryRequest || controller.token.isCancellationRequested) {
        return;
      }
      const decision = await vscode.window.showInformationMessage(
        `Summarize ${context.coverage.totalFiles} changed files with Copilot?`,
        { modal: true, detail: `${context.repositoryPath}\n${context.baseSha} → ${context.targetSha}\n` +
          `${context.patches.length} patches (up to ${Math.round(MAX_PATCH_BYTES / 1000)} KB total) may be sent across multiple model requests. ` +
          `${context.coverage.omitted.length} items have no patch. Review changed files in the dashboard first.` },
        'Summarize'
      );
      if (decision !== 'Summarize' || generation !== this._summaryRequest || controller.token.isCancellationRequested) {
        await send('changeSummaryError', { message: 'Summary cancelled.' });
        return;
      }
      await send('changeSummaryProgress', { status: 'Summarizing…' });
      const result = await this._summaryProvider.summarize(context, controller.token, status => {
        void send('changeSummaryProgress', { status });
      }, modelId || undefined);
      await send('changeSummaryProgress', { status: 'Validating…' });
      await send('changeSummaryLoaded', { summary: result.summary, model: result.model });
    } catch (error) {
      await send('changeSummaryError', { message: error instanceof Error ? error.message : 'Unable to summarize changes.' });
    } finally {
      if (generation === this._summaryRequest) {
        this._summaryToken = undefined;
      }
      controller.dispose();
    }
  }
}
