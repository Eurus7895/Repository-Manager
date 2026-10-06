/**
 * Repository Manager Extension
 * Main entry point for the VS Code extension
 */

import * as vscode from 'vscode';
import { GitOperations } from './gitOperations';
import { RepositoryTreeProvider } from './repositoryTreeProvider';
import { PRManager } from './prManager';
import { registerBasicCommands, CommandContext } from './commands/submoduleCommands';
import { registerCreateBranchCommand } from './commands/createBranchCommand';
import { registerReviewCommands } from './commands/reviewCommands';
import { RepositoryManagerLauncher } from './repositoryManagerLauncher';
import { RepositoryManagerPanel } from './repositoryManagerPanel';

let repositoryTreeProvider: RepositoryTreeProvider;
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

  // Keep the provider as a command refresh dependency. The Activity Bar shows the
  // dashboard's own repository list (RepositoryManagerLauncher), not this tree.
  repositoryTreeProvider = new RepositoryTreeProvider(workspaceRoot);

  // Create command context
  const commandContext: CommandContext = {
    gitOps,
    repositoryTreeProvider,
    prManager,
    workspaceRoot,
    extensionUri: context.extensionUri
  };

  // Register commands
  RepositoryManagerPanel.globalState = context.globalState;
  registerBasicCommands(context, commandContext);
  registerCreateBranchCommand(context, gitOps, repositoryTreeProvider);
  registerReviewCommands(context, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RepositoryManagerLauncher.viewType,
      new RepositoryManagerLauncher(context.extensionUri, {
        isOpen: () => Boolean(RepositoryManagerPanel.currentPanel),
        open: async () => RepositoryManagerPanel.createOrShow(context.extensionUri, workspaceRoot, context.workspaceState, true),
        post: message => RepositoryManagerPanel.currentPanel?.post(message)
      })
    )
  );

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
