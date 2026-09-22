/**
 * Command handlers for submodule operations
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitOperations } from '../gitOperations';
import { RepositoryTreeProvider } from '../repositoryTreeProvider';
import { RepositoryManagerPanel } from '../repositoryManagerPanel';
import { PRManager } from '../prManager';

export interface CommandContext {
  gitOps: GitOperations;
  repositoryTreeProvider: RepositoryTreeProvider;
  prManager: PRManager;
  workspaceRoot: string;
  extensionUri: vscode.Uri;
}

/**
 * Register refresh command
 */
export function registerRefreshCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.refresh', () => {
      ctx.repositoryTreeProvider.refresh();
      if (RepositoryManagerPanel.currentPanel) {
        RepositoryManagerPanel.currentPanel.refresh();
      }
      vscode.window.showInformationMessage('Repositories refreshed');
    })
  );
}

/**
 * Register open panel command
 */
export function registerOpenPanelCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.openPanel', () => {
      RepositoryManagerPanel.createOrShow(ctx.extensionUri, ctx.workspaceRoot);
    })
  );
}

/**
 * Register initialize submodules command
 */
export function registerInitSubmodulesCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.initSubmodules', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Initializing submodules...',
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.initSubmodules();
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register update submodules command
 */
export function registerUpdateSubmodulesCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.updateSubmodules', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Updating submodules...',
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.updateSubmodules();
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register sync versions command
 */
export function registerSyncVersionsCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.syncVersions', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing submodule versions...',
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.syncAllSubmodules();
        }
      );

      let successCount = 0;
      result.forEach((res) => {
        if (res.success) {
          successCount++;
        }
      });

      vscode.window.showInformationMessage(
        `Synced ${successCount}/${result.size} submodule(s)`
      );

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register open submodule command
 */
export function registerOpenSubmoduleCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.openSubmodule', async (item) => {
      if (item && item.submodule) {
        const fullPath = vscode.Uri.file(
          path.join(ctx.workspaceRoot, item.submodule.path)
        );
        await vscode.commands.executeCommand('revealInExplorer', fullPath);
      }
    })
  );
}

/**
 * Register checkout branch command
 */
export function registerCheckoutBranchCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.checkoutBranch', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      const branches = await ctx.gitOps.getBranches(item.submodule.path);

      if (branches.length === 0) {
        vscode.window.showWarningMessage('No branches found');
        return;
      }

      const branchItems = branches.map(b => ({
        label: b.name,
        description: b.isCurrent ? '(current)' : undefined,
        detail: b.isRemote ? 'Remote branch' : 'Local branch'
      }));

      const selected = await vscode.window.showQuickPick(branchItems, {
        placeHolder: 'Select a branch to checkout'
      });

      if (!selected) {
        return;
      }

      const result = await ctx.gitOps.checkoutBranch(item.submodule.path, selected.label);

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register checkout branch from tree command
 */
export function registerCheckoutBranchFromTreeCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.checkoutBranchFromTree', async (submodulePath: string, branchName: string) => {
      if (!submodulePath || !branchName) {
        return;
      }

      const result = await ctx.gitOps.checkoutBranch(submodulePath, branchName);

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register pull changes command
 */
export function registerPullChangesCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.pullChanges', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling changes for ${item.submodule.name}...`,
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.pullChanges(item.submodule.path);
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register push changes command
 */
export function registerPushChangesCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.pushChanges', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing changes for ${item.submodule.name}...`,
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.pushChanges(item.submodule.path);
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register create PR command
 */
export function registerCreatePRCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.createPR', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      await ctx.prManager.createPRWithGitHub(item.submodule.path);
    })
  );
}

/**
 * Register stage submodule command
 */
export function registerStageSubmoduleCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.stageSubmodule', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      const result = await ctx.gitOps.stageSubmodule(item.submodule.path);

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );
}

/**
 * Register delete branch command (right-click submodule -> Delete Branch)
 */
export function registerDeleteBranchCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.deleteBranch', async (item) => {
      if (!item || !item.submodule) {
        return;
      }

      const branches = await ctx.gitOps.getBranches(item.submodule.path);

      if (branches.length === 0) {
        vscode.window.showWarningMessage('No branches found');
        return;
      }

      // Filter out current branch from delete options
      const branchItems = branches
        .filter(b => !b.isCurrent)
        .map(b => ({
          label: b.name,
          description: b.isRemote ? 'Remote branch' : 'Local branch'
        }));

      if (branchItems.length === 0) {
        vscode.window.showWarningMessage('No branches available to delete (cannot delete current branch)');
        return;
      }

      const selected = await vscode.window.showQuickPick(branchItems, {
        placeHolder: 'Select a branch to delete',
        title: `Delete Branch in ${item.submodule.name}`
      });

      if (!selected) {
        return;
      }

      // Ask about remote deletion
      const deleteRemote = await vscode.window.showQuickPick(
        [
          { label: 'Local only', description: 'Delete only the local branch', value: false },
          { label: 'Local + Remote', description: 'Delete both local and remote branch', value: true }
        ],
        { placeHolder: 'Delete remote branch as well?' }
      );

      if (!deleteRemote) {
        return;
      }

      // Confirm deletion
      const confirm = await vscode.window.showWarningMessage(
        `Delete branch '${selected.label}' in ${item.submodule.name}${deleteRemote.value ? ' (local + remote)' : ''}?`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') {
        return;
      }

      const result = await ctx.gitOps.deleteBranch(item.submodule.path, selected.label, deleteRemote.value);

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register delete branch from tree command (right-click on branch item)
 */
export function registerDeleteBranchFromTreeCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.deleteBranchFromTree', async (item) => {
      if (!item || !item.submodule || !item.branchName) {
        return;
      }

      if (item.isCurrent) {
        vscode.window.showWarningMessage('Cannot delete the currently checked out branch');
        return;
      }

      // Ask about remote deletion
      const deleteRemote = await vscode.window.showQuickPick(
        [
          { label: 'Local only', description: 'Delete only the local branch', value: false },
          { label: 'Local + Remote', description: 'Delete both local and remote branch', value: true }
        ],
        { placeHolder: `Delete '${item.branchName}' - delete remote as well?` }
      );

      if (!deleteRemote) {
        return;
      }

      // Confirm deletion
      const confirm = await vscode.window.showWarningMessage(
        `Delete branch '${item.branchName}' in ${item.submodule.name}${deleteRemote.value ? ' (local + remote)' : ''}?`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') {
        return;
      }

      const result = await ctx.gitOps.deleteBranch(item.submodule.path, item.branchName, deleteRemote.value);

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register delete branch across submodules command (quick action)
 */
export function registerDeleteBranchAcrossSubmodulesCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.deleteBranchAcrossSubmodules', async () => {
      let submodules = ctx.repositoryTreeProvider.getSubmodules();
      if (submodules.length === 0) {
        submodules = await ctx.gitOps.getSubmodules();
      }

      // Include parent/main repo so Quick Actions can interact with it too
      const parentRepo = await ctx.gitOps.getParentRepoInfo();
      if (parentRepo) {
        submodules = [parentRepo, ...submodules];
      }

      if (submodules.length === 0) {
        vscode.window.showWarningMessage('No repositories found');
        return;
      }

      // Get branch name to delete
      const branchName = await vscode.window.showInputBox({
        prompt: 'Enter the branch name to delete across repositories',
        placeHolder: 'e.g., feature/my-branch'
      });

      if (!branchName) {
        return;
      }

      // Select repositories
      const items = submodules.map(s => ({
        label: s.name,
        description: s.path,
        picked: true
      }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select repositories to delete branch from'
      });

      if (!selected || selected.length === 0) {
        return;
      }

      // Ask about remote deletion
      const deleteRemote = await vscode.window.showQuickPick(
        [
          { label: 'Local only', description: 'Delete only the local branch', value: false },
          { label: 'Local + Remote', description: 'Delete both local and remote branch', value: true }
        ],
        { placeHolder: 'Delete remote branch as well?' }
      );

      if (!deleteRemote) {
        return;
      }

      // Confirm deletion
      const confirm = await vscode.window.showWarningMessage(
        `Delete branch '${branchName}' in ${selected.length} submodule(s)${deleteRemote.value ? ' (local + remote)' : ''}?`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') {
        return;
      }

      const selectedPaths = selected.map(s => s.description!);

      const results = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting branch '${branchName}'...`,
          cancellable: false
        },
        async () => {
          return await ctx.gitOps.deleteBranchAcrossSubmodules(selectedPaths, branchName, deleteRemote.value);
        }
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
          `Branch '${branchName}' deleted in ${successCount} submodule(s)`
        );
      } else {
        vscode.window.showWarningMessage(
          `Deleted in ${successCount}, failed in ${failCount} submodule(s)`
        );
      }

      ctx.repositoryTreeProvider.refresh();
    })
  );
}

/**
 * Register all basic commands (excluding create branch)
 */
export function registerBasicCommands(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  registerOpenPanelCommand(context, ctx);
  registerRefreshCommand(context, ctx);
  registerInitSubmodulesCommand(context, ctx);
  registerUpdateSubmodulesCommand(context, ctx);
  registerSyncVersionsCommand(context, ctx);
  registerOpenSubmoduleCommand(context, ctx);
  registerCheckoutBranchCommand(context, ctx);
  registerCheckoutBranchFromTreeCommand(context, ctx);
  registerPullChangesCommand(context, ctx);
  registerPushChangesCommand(context, ctx);
  registerCreatePRCommand(context, ctx);
  registerStageSubmoduleCommand(context, ctx);
  registerDeleteBranchCommand(context, ctx);
  registerDeleteBranchFromTreeCommand(context, ctx);
  registerDeleteBranchAcrossSubmodulesCommand(context, ctx);
}
