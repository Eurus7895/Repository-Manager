/**
 * Repository Manager Extension
 * Main entry point for the VS Code extension
 */

import * as vscode from 'vscode';
import { GitOperations } from './gitOperations';
import { RepositoryTreeProvider, ActionsTreeProvider } from './repositoryTreeProvider';
import { PRManager } from './prManager';
import { registerBasicCommands, CommandContext } from './commands/submoduleCommands';
import { registerCreateBranchCommand } from './commands/createBranchCommand';

let repositoryTreeProvider: RepositoryTreeProvider;
let actionsTreeProvider: ActionsTreeProvider;
let gitOps: GitOperations;
let prManager: PRManager;

export function activate(context: vscode.ExtensionContext) {
  console.log('Repository Manager extension is now active');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Repository Manager: No workspace folder open');
    return;
  }

  // Initialize services
  gitOps = new GitOperations(workspaceRoot);
  prManager = new PRManager(workspaceRoot);

  // Initialize tree providers
  repositoryTreeProvider = new RepositoryTreeProvider(workspaceRoot);
  actionsTreeProvider = new ActionsTreeProvider();

  // Register tree views
  const repositoryTreeView = vscode.window.createTreeView('repositoryList', {
    treeDataProvider: repositoryTreeProvider,
    showCollapseAll: true
  });

  const actionsTreeView = vscode.window.createTreeView('repositoryActions', {
    treeDataProvider: actionsTreeProvider
  });

  context.subscriptions.push(repositoryTreeView, actionsTreeView);

  // Create command context
  const commandContext: CommandContext = {
    gitOps,
    repositoryTreeProvider,
    prManager,
    workspaceRoot,
    extensionUri: context.extensionUri
  };

  // Register commands
  registerBasicCommands(context, commandContext);
  registerCreateBranchCommand(context, gitOps, repositoryTreeProvider);

  // Auto-refresh when files change
  const watcher = vscode.workspace.createFileSystemWatcher('**/.gitmodules');
  watcher.onDidChange(() => repositoryTreeProvider.refresh());
  watcher.onDidCreate(() => repositoryTreeProvider.refresh());
  watcher.onDidDelete(() => repositoryTreeProvider.refresh());
  context.subscriptions.push(watcher);

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('repositoryManager.welcomeShown');
  if (!hasShownWelcome) {
    vscode.window.showInformationMessage(
      'Repository Manager is ready! Open the panel with Ctrl+Shift+G M (Cmd+Shift+G M on Mac)',
      'Open Panel'
    ).then(selection => {
      if (selection === 'Open Panel') {
        vscode.commands.executeCommand('repositoryManager.openPanel');
      }
    });
    context.globalState.update('repositoryManager.welcomeShown', true);
  }
}

export function deactivate() {
  console.log('Repository Manager extension is now deactivated');
}
