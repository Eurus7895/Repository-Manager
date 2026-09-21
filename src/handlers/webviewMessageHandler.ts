/**
 * Webview Message Handler
 * Handles all messages from the webview panel
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitOperations } from '../gitOperations';
import { PRManager } from '../prManager';
import { HistoryQuery } from '../types';

export interface MessageHandlerContext {
  panel: vscode.WebviewPanel;
  gitOps: GitOperations;
  prManager: PRManager;
  workspaceRoot: string;
  refresh: () => Promise<void>;
}

export type MessagePayload = {
  submodules?: string[];
  submodule?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  commit?: string;
  isRebasing?: boolean;
};

/**
 * Show result message to user
 */
function showResult(success: boolean, message: string): void {
  if (success) {
    vscode.window.showInformationMessage(message);
  } else {
    vscode.window.showErrorMessage(message);
  }
}

/**
 * Send a message to the webview with await and error logging
 */
async function sendToWebview(ctx: MessageHandlerContext, message: { type: string; payload: unknown }): Promise<void> {
  try {
    const delivered = await ctx.panel.webview.postMessage(message);
    if (!delivered) {
      console.warn(`[RepositoryManager] Message '${message.type}' was NOT delivered to webview`);
    }
  } catch (error) {
    console.error(`[RepositoryManager] Failed to send message '${message.type}' to webview:`, error);
  }
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid dashboard request payload');
  }
  return payload as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid '${field}'`);
  }
  return value;
}

async function sendDashboardError(
  ctx: MessageHandlerContext,
  request: string,
  repositoryPath: string,
  error: unknown
): Promise<void> {
  await sendToWebview(ctx, {
    type: 'dashboardError',
    payload: {
      request,
      repositoryPath,
      message: error instanceof Error ? error.message : 'Unknown dashboard backend error'
    }
  });
}

export async function handleGetHistory(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const query: HistoryQuery = {
    repositoryPath,
    limit: typeof request.limit === 'number' ? request.limit : undefined,
    offset: typeof request.offset === 'number' ? request.offset : undefined,
    search: typeof request.search === 'string' ? request.search : undefined,
    branch: typeof request.branch === 'string' ? request.branch : undefined,
    includeRemotes: request.includeRemotes === true
  };

  try {
    const history = await ctx.gitOps.getHistory(query);
    await sendToWebview(ctx, {
      type: 'historyLoaded',
      payload: {
        ...history,
        requestId: typeof request.requestId === 'number' ? request.requestId : 0
      }
    });
  } catch (error) {
    await sendDashboardError(ctx, 'getHistory', repositoryPath, error);
  }
}

export async function handleGetCommitDetail(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const commitHash = requireString(request, 'commitHash');

  try {
    const detail = await ctx.gitOps.getCommitDetail(repositoryPath, commitHash);
    await sendToWebview(ctx, {
      type: 'commitDetailLoaded',
      payload: { repositoryPath, detail }
    });
  } catch (error) {
    await sendDashboardError(ctx, 'getCommitDetail', repositoryPath, error);
  }
}

export async function handleGetFileDiff(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const commitHash = requireString(request, 'commitHash');
  const filePath = requireString(request, 'path');

  try {
    const diff = await ctx.gitOps.getFileDiff(repositoryPath, commitHash, filePath);
    await sendToWebview(ctx, { type: 'fileDiffLoaded', payload: diff });
  } catch (error) {
    await sendDashboardError(ctx, 'getFileDiff', repositoryPath, error);
  }
}

export async function handleGetRepositoryRefs(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');

  try {
    const refs = await ctx.gitOps.getRepositoryRefs(repositoryPath);
    await sendToWebview(ctx, { type: 'repositoryRefsLoaded', payload: refs });
  } catch (error) {
    await sendDashboardError(ctx, 'getRepositoryRefs', repositoryPath, error);
  }
}

/**
 * Handler for initializing submodules
 */
export async function handleInitSubmodules(ctx: MessageHandlerContext): Promise<void> {
  const result = await ctx.gitOps.initSubmodules();
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for updating submodules
 */
export async function handleUpdateSubmodules(ctx: MessageHandlerContext): Promise<void> {
  const result = await ctx.gitOps.updateSubmodules();
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for creating a branch
 */
export async function handleCreateBranch(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string; baseBranch: string }
): Promise<void> {
  const results = await ctx.gitOps.createBranchAcrossSubmodules(
    payload.submodules,
    payload.branchName,
    payload.baseBranch,
    true
  );

  let successCount = 0;
  let failCount = 0;

  results.forEach((result) => {
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  });

  if (failCount === 0) {
    vscode.window.showInformationMessage(
      `Branch '${payload.branchName}' created in ${successCount} repository/repositories`
    );
  } else {
    vscode.window.showWarningMessage(
      `Branch created in ${successCount} repository/repositories, failed in ${failCount}`
    );
  }

  await ctx.refresh();
}

/**
 * Handler for creating a branch with review
 */
export async function handleCreateBranchWithReview(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string; baseBranch: string }
): Promise<void> {
  const results = await ctx.gitOps.createBranchAcrossSubmodules(
    payload.submodules,
    payload.branchName,
    payload.baseBranch,
    true
  );

  // Convert results map to array for sending to webview
  const resultsArray: Array<{ repository: string; success: boolean; message: string }> = [];
  results.forEach((result, submodulePath) => {
    resultsArray.push({
      repository: submodulePath,
      success: result.success,
      message: result.message
    });
  });

  // Send results to webview for review
  await sendToWebview(ctx, {
    type: 'branchCreationResults',
    payload: {
      branchName: payload.branchName,
      results: resultsArray
    }
  });

  await ctx.refresh();
}

/**
 * Fallback branches when getBranches fails
 */
const FALLBACK_BRANCHES = [
  { name: 'main', isCurrent: false, isRemote: false },
  { name: 'master', isCurrent: false, isRemote: false },
  { name: 'develop', isCurrent: false, isRemote: false }
];

/**
 * Handler for getting base branches for create modal
 */
export async function handleGetBaseBranchesForCreate(ctx: MessageHandlerContext): Promise<void> {
  let branches = FALLBACK_BRANCHES;

  try {
    const result = await ctx.gitOps.getBranches('.');
    if (result && result.length > 0) {
      branches = result;
    }
  } catch (error) {
    console.error('[RepositoryManager] Error getting base branches:', error);
  }

  // Always send the response, whether we got real branches or fallback
  await sendToWebview(ctx, {
    type: 'baseBranchesForCreate',
    payload: { branches }
  });
}

/**
 * Handler for pushing created branches
 */
export async function handlePushCreatedBranches(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string }
): Promise<void> {
  const results: Array<{ submodule: string; success: boolean; message: string }> = [];

  for (const submodulePath of payload.submodules) {
    try {
      const result = await ctx.gitOps.pushChanges(submodulePath);
      results.push({
        submodule: submodulePath,
        success: result.success,
        message: result.message
      });
    } catch (error) {
      results.push({
        submodule: submodulePath,
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  const successCount = results.filter(r => r.success).length;

  if (successCount === results.length) {
    vscode.window.showInformationMessage(
      `Branch '${payload.branchName}' pushed to ${successCount} remote(s)`
    );
  } else {
    vscode.window.showWarningMessage(
      `Pushed to ${successCount}/${results.length} remotes`
    );
  }

  // Send results to webview
  await sendToWebview(ctx, {
    type: 'pushResults',
    payload: { results }
  });

  await ctx.refresh();
}

/**
 * Handler for checking out a branch
 */
export async function handleCheckoutBranch(
  ctx: MessageHandlerContext,
  payload: { submodule: string; branch: string }
): Promise<void> {
  const result = await ctx.gitOps.checkoutBranch(payload.submodule, payload.branch);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for pulling changes
 */
export async function handlePullChanges(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.pullChanges(payload.submodule);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for pushing changes
 */
export async function handlePushChanges(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.pushChanges(payload.submodule);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for fetching remote refs without modifying the working tree.
 */
export async function handleFetchUpdates(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.fetchUpdates(payload.submodule);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for syncing versions
 */
export async function handleSyncVersions(
  ctx: MessageHandlerContext,
  payload: { submodules: string[] }
): Promise<void> {
  // Sync only the selected submodules, or all if none selected
  const submodulesToSync = payload.submodules.length > 0 ? payload.submodules : undefined;
  const results = await ctx.gitOps.syncAllSubmodules(submodulesToSync);
  let successCount = 0;
  const errors: string[] = [];

  results.forEach((result, submodulePath) => {
    if (result.success) {
      successCount++;
    } else {
      errors.push(`${submodulePath}: ${result.message}`);
    }
  });

  if (errors.length === 0) {
    vscode.window.showInformationMessage(
      `Successfully synced ${successCount} repository/repositories to recorded commits`
    );
  } else {
    // Show detailed error message
    const errorSummary = errors.length <= 3
      ? errors.join(' | ')
      : `${errors.slice(0, 2).join(' | ')} and ${errors.length - 2} more`;
    vscode.window.showWarningMessage(
      `Synced ${successCount}/${results.size}. Failed: ${errorSummary}`
    );
  }
  await ctx.refresh();
}

/**
 * Handler for creating a PR
 */
export async function handleCreatePR(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  await ctx.prManager.createPRWithGitHub(payload.submodule);
}

/**
 * Handler for opening a submodule in explorer
 */
export async function handleOpenSubmodule(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const fullPath = path.join(ctx.workspaceRoot, payload.submodule);
  const uri = vscode.Uri.file(fullPath);
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

/**
 * Handler for staging a submodule
 */
export async function handleStageSubmodule(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.stageSubmodule(payload.submodule);
  showResult(result.success, result.message);
}

/**
 * Handler for getting branches
 */
export async function handleGetBranches(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  let branches = [
    { name: 'main', isCurrent: false, isRemote: false },
    { name: 'master', isCurrent: false, isRemote: false }
  ];

  try {
    const result = await ctx.gitOps.getBranches(payload.submodule);
    if (result && result.length > 0) {
      branches = result;
    }
  } catch (error) {
    console.error('[RepositoryManager] Error getting branches:', error);
  }

  await sendToWebview(ctx, {
    type: 'branches',
    payload: { submodule: payload.submodule, branches }
  });
}

/**
 * Handler for checking out a commit
 */
export async function handleCheckoutCommit(
  ctx: MessageHandlerContext,
  payload: { submodule: string; commit: string }
): Promise<void> {
  const result = await ctx.gitOps.checkoutCommit(payload.submodule, payload.commit);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for getting commits
 */
export async function handleGetCommits(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const commits = await ctx.gitOps.getRecentCommits(payload.submodule, 20);
  await sendToWebview(ctx, {
    type: 'commits',
    payload: { submodule: payload.submodule, commits }
  });
}

/**
 * Handler for getting recorded commit
 */
export async function handleGetRecordedCommit(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const recordedCommit = await ctx.gitOps.getRecordedCommit(payload.submodule);
  const currentCommit = await ctx.gitOps.getCurrentCommit(payload.submodule);
  await sendToWebview(ctx, {
    type: 'recordedCommit',
    payload: {
      submodule: payload.submodule,
      recordedCommit,
      currentCommit,
      isMatching: recordedCommit === currentCommit
    }
  });
}

/**
 * Handler for updating to recorded commit
 */
export async function handleUpdateToRecorded(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.updateToRecordedCommit(payload.submodule);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for deleting a branch
 */
export async function handleDeleteBranch(
  ctx: MessageHandlerContext,
  payload: { submodule: string; branch: string; deleteRemote: boolean }
): Promise<void> {
  // Confirm deletion with a modal dialog
  const remoteLabel = payload.deleteRemote ? ' (local + remote)' : '';
  const confirm = await vscode.window.showWarningMessage(
    `Delete branch '${payload.branch}' in ${payload.submodule}${remoteLabel}?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  const result = await ctx.gitOps.deleteBranch(payload.submodule, payload.branch, payload.deleteRemote);
  showResult(result.success, result.message);

  // Refresh the branches panel by sending updated branches
  if (result.success) {
    try {
      const branches = await ctx.gitOps.getBranches(payload.submodule);
      await sendToWebview(ctx, {
        type: 'branches',
        payload: { submodule: payload.submodule, branches }
      });
    } catch {
      // Ignore branch refresh errors
    }
  }

  await ctx.refresh();
}

/**
 * Handler for setting rebase status
 */
export async function handleSetRebaseStatus(
  ctx: MessageHandlerContext,
  payload: { submodule: string; isRebasing: boolean }
): Promise<void> {
  await sendToWebview(ctx, {
    type: 'rebaseStatusUpdated',
    payload: { submodule: payload.submodule, isRebasing: payload.isRebasing }
  });
}

/**
 * Message handler map for quick lookup
 */
export const messageHandlers: Record<string, (ctx: MessageHandlerContext, payload?: unknown) => Promise<void>> = {
  'getHistory': (ctx, payload) => handleGetHistory(ctx, payload),
  'getCommitDetail': (ctx, payload) => handleGetCommitDetail(ctx, payload),
  'getFileDiff': (ctx, payload) => handleGetFileDiff(ctx, payload),
  'getRepositoryRefs': (ctx, payload) => handleGetRepositoryRefs(ctx, payload),
  'initSubmodules': (ctx) => handleInitSubmodules(ctx),
  'updateSubmodules': (ctx) => handleUpdateSubmodules(ctx),
  'createBranch': (ctx, payload) => handleCreateBranch(ctx, payload as { submodules: string[]; branchName: string; baseBranch: string }),
  'createBranchWithReview': (ctx, payload) => handleCreateBranchWithReview(ctx, payload as { submodules: string[]; branchName: string; baseBranch: string }),
  'getBaseBranchesForCreate': (ctx) => handleGetBaseBranchesForCreate(ctx),
  'pushCreatedBranches': (ctx, payload) => handlePushCreatedBranches(ctx, payload as { submodules: string[]; branchName: string }),
  'checkoutBranch': (ctx, payload) => handleCheckoutBranch(ctx, payload as { submodule: string; branch: string }),
  'pullChanges': (ctx, payload) => handlePullChanges(ctx, payload as { submodule: string }),
  'pushChanges': (ctx, payload) => handlePushChanges(ctx, payload as { submodule: string }),
  'fetchUpdates': (ctx, payload) => handleFetchUpdates(ctx, payload as { submodule: string }),
  'syncVersions': (ctx, payload) => handleSyncVersions(ctx, payload as { submodules: string[] }),
  'createPR': (ctx, payload) => handleCreatePR(ctx, payload as { submodule: string }),
  'openSubmodule': (ctx, payload) => handleOpenSubmodule(ctx, payload as { submodule: string }),
  'stageSubmodule': (ctx, payload) => handleStageSubmodule(ctx, payload as { submodule: string }),
  'getBranches': (ctx, payload) => handleGetBranches(ctx, payload as { submodule: string }),
  'checkoutCommit': (ctx, payload) => handleCheckoutCommit(ctx, payload as { submodule: string; commit: string }),
  'getCommits': (ctx, payload) => handleGetCommits(ctx, payload as { submodule: string }),
  'getRecordedCommit': (ctx, payload) => handleGetRecordedCommit(ctx, payload as { submodule: string }),
  'updateToRecorded': (ctx, payload) => handleUpdateToRecorded(ctx, payload as { submodule: string }),
  'deleteBranch': (ctx, payload) => handleDeleteBranch(ctx, payload as { submodule: string; branch: string; deleteRemote: boolean }),
  'setRebaseStatus': (ctx, payload) => handleSetRebaseStatus(ctx, payload as { submodule: string; isRebasing: boolean })
};
