/**
 * Webview panel for Repository Manager
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitOperations } from './gitOperations';
import { PRManager } from './prManager';
import { getHtmlForWebview, getReviewHtml, WebviewResourceUris, WorkspaceFolderInfo } from './webview/template';
import { ReviewBridge } from './reviewBridge';
import { messageHandlers, MessageHandlerContext } from './handlers/webviewMessageHandler';
import { GitCommandService } from './services/gitCommandService';
import { ChangeContextService, MAX_PATCH_BYTES } from './services/changeContextService';
import { CopilotSummaryProvider } from './services/changeSummaryService';
import { SecurityReviewService } from './services/securityReviewService';
import { SecurityReviewProvider } from './services/securityReviewProvider';
import { ReviewController, ReviewRunner } from './reviewController';
import { ReviewConsentStore } from './reviewConsent';
import { ReviewHistoryStore } from './reviewHistory';
import { ReviewUnitCache } from './reviewUnitCache';
import { ReviewSkillStore } from './reviewSkillStore';
import { resolveReleaseRange } from './services/releaseRange';
import { RepositoryManagerLauncher } from './repositoryManagerLauncher';
import { CommitMessageController } from './commitMessageController';

/** Read-only documents for opening review evidence at the reviewed revision. */
const REVIEW_EVIDENCE_SCHEME = 'repository-manager-review';

/** Webview requests that only read Git state and may run during a background fetch. */
const READ_ONLY_MESSAGES = new Set([
  'getHistory', 'getCommitDetail', 'getFileDiff', 'getRepositoryRefs', 'getWorkingTreeChanges',
  'getWorkingTreePreview', 'getBranches', 'getCommits', 'getRecordedCommit', 'getBaseBranchesForCreate',
  'getPendingOperation', 'summarizeChanges', 'cancelChangeSummary', 'loadSummaryModels', 'resolveReleaseRange', 'refreshRepositories',
  // Reviews read pinned commits only; they never touch refs a background fetch updates.
  'requestReview', 'openReviewTab', 'dashboardContext', 'getReviewStatus', 'getReviewQuality', 'reviewReady', 'showReviewEvidence',
  'startReview', 'cancelReview', 'exportReviewReport', 'openReviewEvidence', 'setFindingTriage',
  'proposeReviewFix', 'discardReviewFix', 'cancelReviewFix', 'listReviewHistory', 'openStoredReview', 'deleteStoredReview',
  // Writing a commit message reads the working tree's diff; nothing is committed.
  'generateCommitMessage', 'cancelCommitMessage',
  // The Side Bar's copy of the repository list; no Git.
  'sidebarSnapshot'
]);

export class RepositoryManagerPanel {
  public static currentPanel: RepositoryManagerPanel | undefined;
  /** The extension's global state, for what follows the user across workspaces (review skills). */
  public static globalState: vscode.Memento | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _gitOps: GitOperations;
  private _prManager: PRManager;
  private _disposables: vscode.Disposable[] = [];
  private _workspaceRoot: string;
  private readonly _summaryProvider = new CopilotSummaryProvider();
  private readonly _reviews: ReviewController;
  private readonly _commitMessages: CommitMessageController;
  /** Routes review messages between this dashboard, the Repository Review tab and the controller. */
  private readonly _reviewBridge: ReviewBridge;
  private _reviewPanel?: vscode.WebviewPanel;
  private readonly _skills: ReviewSkillStore;
  private readonly _evidenceDocuments = new Map<string, string>();
  private _summaryToken?: vscode.CancellationTokenSource;
  private _summaryRequest = 0;
  private _autoFetchTimer?: NodeJS.Timeout;
  private _autoFetchRun?: Promise<void>;
  private _lastAutoFetch = 0;
  private _messagesInFlight = 0;

  /** `preserveFocus` keeps the keyboard where it is, as when the Side Bar opens the dashboard. */
  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string, workspaceState?: vscode.Memento, preserveFocus = false) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (RepositoryManagerPanel.currentPanel) {
      RepositoryManagerPanel.currentPanel._panel.reveal(column, preserveFocus);
      RepositoryManagerPanel.currentPanel.refresh();
      RepositoryManagerPanel.currentPanel._autoFetchIfDue();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'repositoryManager',
      'Repository Manager',
      { viewColumn: column || vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    RepositoryManagerPanel.currentPanel = new RepositoryManagerPanel(
      panel,
      extensionUri,
      workspaceRoot,
      workspaceState
    );
  }

  private readonly _workspaceState?: vscode.Memento;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string,
    workspaceState?: vscode.Memento
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceRoot = workspaceRoot;
    this._workspaceState = workspaceState;
    this._gitOps = new GitOperations(workspaceRoot);
    this._prManager = new PRManager(workspaceRoot);

    const consent = new ReviewConsentStore(workspaceState);
    // Finished components of earlier reviews: a stopped review continues instead of starting over.
    const unitCache = new ReviewUnitCache(workspaceState);
    const skills = new ReviewSkillStore(path.join(extensionUri.fsPath, 'resources', 'review-skills'), RepositoryManagerPanel.globalState);
    this._skills = skills;
    // Assigned before the controller, which posts through it.
    this._reviewBridge = new ReviewBridge({
      controller: { handles: type => this._reviews.handles(type), handle: message => this._reviews.handle(message) },
      postDashboard: message => this._panel.webview.postMessage(message),
      openView: () => this._openReviewPanel(),
      revealDashboard: () => this._panel.reveal(undefined, false)
    });
    this._commitMessages = new CommitMessageController({
      workspaceRoot: () => this._workspaceRoot,
      post: message => Promise.resolve(this._panel.webview.postMessage(message)),
      ask: (message, detail, actions) => Promise.resolve(vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions)),
      alwaysConfirm: () => vscode.workspace.getConfiguration('repositoryManager').get<boolean>('review.confirmBeforeSending', false),
      isConsentRemembered: root => consent.has(root),
      rememberConsent: root => consent.allow(root),
      complete: (prompt, modelId, token) => this._summaryProvider.complete(prompt, modelId, token as vscode.CancellationToken),
      createCancellation: () => new vscode.CancellationTokenSource()
    });
    this._reviews = new ReviewController({
      workspaceRoot: () => this._workspaceRoot,
      post: message => this._reviewBridge.toReview(message),
      ask: (message, detail, actions) => Promise.resolve(vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions)),
      alwaysConfirm: () => vscode.workspace.getConfiguration('repositoryManager').get<boolean>('review.confirmBeforeSending', false),
      isConsentRemembered: root => consent.has(root),
      rememberConsent: root => consent.allow(root),
      createRunner: root => new SecurityReviewService(new GitCommandService(root), undefined, unitCache, () => skills.snapshot()) as unknown as ReviewRunner,
      createCancellation: () => new vscode.CancellationTokenSource(),
      copyText: text => Promise.resolve(vscode.env.clipboard.writeText(text)),
      saveText: async (fileName, text) => {
        const folder = vscode.Uri.file(this._workspaceRoot);
        // The filter key is the label VS Code shows in the dialog.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, fileName), filters: { Markdown: ['md'] } });
        if (!target) { return false; }
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        return true;
      },
      openText: async (content, revision, filePath, line) => {
        // The path keeps the file extension, so VS Code picks the right language.
        const uri = vscode.Uri.from({ scheme: REVIEW_EVIDENCE_SCHEME, path: `/${revision.slice(0, 8)}/${filePath}` });
        this._evidenceDocuments.set(uri.toString(), content);
        const document = await vscode.workspace.openTextDocument(uri);
        const position = new vscode.Position(Math.min(line, document.lineCount) - 1, 0);
        await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
      },
      notify: (message, isError) => {
        void (isError ? vscode.window.showErrorMessage(message) : vscode.window.showInformationMessage(message));
      },
      createFixModel: modelId => {
        const provider = new SecurityReviewProvider();
        return { request: (instructions, input, token, onText) =>
          provider.requestJson(instructions, input, modelId, token as vscode.CancellationToken, undefined, onText) };
      },
      isDirtyInEditor: absolutePath => vscode.workspace.textDocuments.some(document =>
        document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath === absolutePath),
      workingTreeChanged: () => { this.refresh(); },
      history: new ReviewHistoryStore(workspaceState),
      skills,
      pickSkillFile: async () => {
        // The filter key is the label VS Code shows in the dialog.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import skill', filters: { Markdown: ['md'] } });
        if (!picked || !picked[0]) { return undefined; }
        return Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
      }
    });
    this._disposables.push(vscode.workspace.registerTextDocumentContentProvider(REVIEW_EVIDENCE_SCHEME, {
      provideTextDocumentContent: uri => this._evidenceDocuments.get(uri.toString()) || ''
    }));

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
    // A running review keeps going: it is pinned to the folder it started in.
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

  /** A message for the dashboard webview (the Side Bar forwards its clicks this way). */
  public post(message: { type: string; payload?: unknown }): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
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
  private async _listRepositories(gitOps: GitOperations = this._gitOps) {
    const submodules = await gitOps.getSubmodules();
    const parentRepo = await gitOps.getParentRepoInfo();
    return parentRepo ? [parentRepo, ...submodules] : submodules;
  }

  private async _update(fullRefresh: boolean = true) {
    const gitOps = this._gitOps;
    const allRepos = await this._listRepositories(gitOps);
    // A workspace folder switch while listing makes this result stale; the switch posts its own.
    if (gitOps !== this._gitOps) {
      return;
    }

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
      reloadDashboardHistory: (repositoryPaths) => this.reloadDashboardHistory(repositoryPaths),
      workspaceState: this._workspaceState
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
      if (this._reviewBridge.fromDashboard(message)) { return; }
      if (message.type === 'getReviewQuality') {
        await this._panel.webview.postMessage({ type: 'reviewQualityLoaded', payload: { includeQuality: this._skills.includeQuality() } });
        return;
      }
      if (this._reviews.handles(message.type)) {
        await this._reviews.handle(message);
        return;
      }
      if (this._commitMessages.handles(message.type)) {
        await this._commitMessages.handle(message);
        return;
      }
      if (message.type === 'sidebarSnapshot') {
        const html = (message.payload as { html?: unknown } | undefined)?.html;
        if (typeof html === 'string') { RepositoryManagerLauncher.current?.update(html); }
        return;
      }
      if (message.type === 'cancelChangeSummary') {
        this._cancelSummary();
        return;
      }
      if (message.type === 'resolveReleaseRange') {
        await this._resolveReleaseRange(message.payload);
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
      // The repository list only (switching repository): no result, so nothing else reloads.
      if (message.type === 'refreshRepositories') {
        await this.refresh();
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

  /**
   * The Repository Review tab, beside the dashboard. Closing it leaves a running review going
   * (ReviewBridge replays it when the tab opens again); closing the dashboard closes it.
   */
  private _openReviewPanel(): void {
    if (this._reviewPanel) {
      this._reviewPanel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel('repositoryManager.review', 'Repository Review',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')] });
    this._reviewPanel = panel;
    panel.webview.html = getReviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'review.js')),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.css'))
    });
    this._reviewBridge.attach({ post: message => panel.webview.postMessage(message) });
    panel.webview.onDidReceiveMessage(async (message: { type: string; payload?: unknown }) => {
      // Like the dashboard's messages: writing (an applied fix) waits for a background fetch.
      if (this._autoFetchRun && !READ_ONLY_MESSAGES.has(message.type)) { await this._autoFetchRun.catch(() => undefined); }
      await this._reviewBridge.fromReview(message);
    }, null, this._disposables);
    panel.onDidDispose(() => {
      if (this._reviewPanel === panel) {
        this._reviewPanel = undefined;
        this._reviewBridge.detach();
      }
    }, null, this._disposables);
  }

  public dispose() {
    this._cancelSummary();
    this._reviews.cancel();
    this._commitMessages.cancel();
    const reviewPanel = this._reviewPanel;
    this._reviewPanel = undefined;
    reviewPanel?.dispose();
    if (this._autoFetchTimer) {
      clearInterval(this._autoFetchTimer);
    }
    RepositoryManagerPanel.currentPanel = undefined;
    RepositoryManagerLauncher.current?.dashboardClosed();
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

  /** Latest release tag → current branch, as commit hashes, for Release › Summarize changes. */
  private async _resolveReleaseRange(payload: unknown): Promise<void> {
    const request = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const { repositoryPath, requestId } = request;
    if (typeof repositoryPath !== 'string' || typeof requestId !== 'number') {
      return;
    }
    const git = new GitCommandService(this._workspaceRoot);
    const reply = (extra: Record<string, unknown>) =>
      this._panel.webview.postMessage({ type: 'releaseRangeResolved', payload: { requestId, repositoryPath, ...extra } });
    try {
      const root = git.resolveRepositoryPath(repositoryPath);
      const { currentBranch, latestReleaseTag } = await resolveReleaseRange(git, root);
      if (!latestReleaseTag) {
        await reply({ message: `No release tag like 1.5.0 or v1.5.0 is reachable from ${currentBranch}. ` +
          'Select Base and Target in the history to summarize other changes.' });
        return;
      }
      const [baseSha, targetSha] = await Promise.all([git.resolveRevision(repositoryPath, latestReleaseTag),
        git.resolveRevision(repositoryPath, currentBranch)]);
      await reply(baseSha === targetSha
        ? { message: `${currentBranch} has no changes since ${latestReleaseTag}.` }
        : { baseSha, targetSha, baseLabel: latestReleaseTag, targetLabel: currentBranch });
    } catch (error) {
      await reply({ message: `Cannot resolve the release range: ${error instanceof Error ? error.message : String(error)}` });
    }
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
