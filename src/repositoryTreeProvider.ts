/**
 * TreeView provider for displaying submodules in the sidebar
 */

import * as vscode from 'vscode';
import { GitOperations } from './gitOperations';
import { SubmoduleInfo, SubmoduleStatus } from './types';

export class RepositoryTreeProvider implements vscode.TreeDataProvider<SubmoduleTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SubmoduleTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SubmoduleTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SubmoduleTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private gitOps: GitOperations;
  private submodules: SubmoduleInfo[] = [];

  constructor(private workspaceRoot: string) {
    this.gitOps = new GitOperations(workspaceRoot);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SubmoduleTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SubmoduleTreeItem): Promise<SubmoduleTreeItem[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    if (element) {
      // Handle branches node - fetch and return branch items
      if (element.itemType === 'branches') {
        return this.getBranchChildren(element.submodule);
      }
      // Return details for a specific submodule
      return this.getSubmoduleDetails(element.submodule);
    } else {
      // Return list of all submodules
      return this.getSubmoduleList();
    }
  }

  private async getSubmoduleList(): Promise<SubmoduleTreeItem[]> {
    try {
      this.submodules = await this.gitOps.getSubmodules();

      return this.submodules.map(submodule => {
        const item = new SubmoduleTreeItem(
          submodule.name,
          submodule,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        return item;
      });
    } catch {
      return [];
    }
  }

  private getSubmoduleDetails(submodule: SubmoduleInfo): SubmoduleTreeItem[] {
    const details: SubmoduleTreeItem[] = [];

    // Branches - collapsible node that loads branches on expand
    details.push(new SubmoduleTreeItem(
      'Branches',
      submodule,
      vscode.TreeItemCollapsibleState.Collapsed,
      'branches'
    ));

    // Branch info
    details.push(new SubmoduleTreeItem(
      `Current: ${submodule.currentBranch || 'detached'}`,
      submodule,
      vscode.TreeItemCollapsibleState.None,
      'branch'
    ));

    // Commit info
    details.push(new SubmoduleTreeItem(
      `Commit: ${submodule.currentCommit || 'N/A'}`,
      submodule,
      vscode.TreeItemCollapsibleState.None,
      'commit'
    ));

    // Status
    details.push(new SubmoduleTreeItem(
      `Status: ${this.getStatusLabel(submodule.status)}`,
      submodule,
      vscode.TreeItemCollapsibleState.None,
      'status'
    ));

    // Ahead/Behind
    if (submodule.ahead > 0 || submodule.behind > 0) {
      details.push(new SubmoduleTreeItem(
        `↑${submodule.ahead} ↓${submodule.behind}`,
        submodule,
        vscode.TreeItemCollapsibleState.None,
        'sync'
      ));
    }

    return details;
  }

  private async getBranchChildren(submodule: SubmoduleInfo): Promise<SubmoduleTreeItem[]> {
    try {
      const branches = await this.gitOps.getBranches(submodule.path);

      // Show all branches (local and remote) so user can checkout any
      return branches.map(branch => {
        const label = branch.name +
          (branch.isCurrent ? ' (current)' : '') +
          (branch.isRemote ? ' (remote)' : '');
        const item = new SubmoduleTreeItem(
          label,
          submodule,
          vscode.TreeItemCollapsibleState.None,
          'branch-item',
          branch.name,
          branch.isCurrent,
          branch.isRemote
        );
        return item;
      });
    } catch {
      return [new SubmoduleTreeItem(
        'Failed to load branches',
        submodule,
        vscode.TreeItemCollapsibleState.None,
        'status'
      )];
    }
  }

  private getStatusLabel(status: SubmoduleStatus): string {
    const labels: Record<SubmoduleStatus, string> = {
      'clean': 'Clean',
      'modified': 'Modified',
      'uninitialized': 'Not Initialized',
      'detached': 'Detached HEAD',
      'conflict': 'Conflict',
      'unknown': 'Unknown'
    };
    return labels[status] || status;
  }

  getSubmodules(): SubmoduleInfo[] {
    return this.submodules;
  }

  async getSubmoduleByPath(submodulePath: string): Promise<SubmoduleInfo | undefined> {
    const submodules = await this.gitOps.getSubmodules();
    return submodules.find(s => s.path === submodulePath);
  }
}

export class SubmoduleTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly submodule: SubmoduleInfo,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: 'submodule' | 'branch' | 'commit' | 'status' | 'sync' | 'branches' | 'branch-item' = 'submodule',
    public readonly branchName?: string,
    public readonly isCurrent?: boolean,
    public readonly isRemote?: boolean
  ) {
    super(label, collapsibleState);

    if (itemType === 'submodule') {
      this.contextValue = 'submodule';
      this.tooltip = this.createTooltip();
      this.iconPath = this.getIcon();
      this.description = this.getDescription();
    } else if (itemType === 'branch-item') {
      this.contextValue = 'branchItem';
      if (this.isCurrent) {
        this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      } else if (this.isRemote) {
        this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
      } else {
        this.iconPath = new vscode.ThemeIcon('git-branch');
      }
      this.tooltip = `Click to checkout branch: ${this.branchName}${this.isRemote ? ' (will create local tracking branch)' : ''}`;
      this.command = {
        title: 'Checkout Branch',
        command: 'repositoryManager.checkoutBranchFromTree',
        arguments: [this.submodule.path, this.branchName]
      };
    } else {
      this.contextValue = itemType;
      this.iconPath = this.getDetailIcon();
    }
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.submodule.name}**\n\n`);
    md.appendMarkdown(`- Path: \`${this.submodule.path}\`\n`);
    md.appendMarkdown(`- Branch: \`${this.submodule.currentBranch || 'detached'}\`\n`);
    md.appendMarkdown(`- Commit: \`${this.submodule.currentCommit}\`\n`);
    md.appendMarkdown(`- Status: ${this.submodule.status}\n`);
    if (this.submodule.url) {
      md.appendMarkdown(`- URL: ${this.submodule.url}\n`);
    }
    return md;
  }

  private getIcon(): vscode.ThemeIcon {
    switch (this.submodule.status) {
      case 'clean':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'modified':
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'uninitialized':
        return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconSkipped'));
      case 'detached':
        return new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
      case 'conflict':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
      default:
        return new vscode.ThemeIcon('question');
    }
  }

  private getDetailIcon(): vscode.ThemeIcon {
    switch (this.itemType) {
      case 'branch':
        return new vscode.ThemeIcon('git-branch');
      case 'branches':
        return new vscode.ThemeIcon('list-tree');
      case 'commit':
        return new vscode.ThemeIcon('git-commit');
      case 'status':
        return new vscode.ThemeIcon('info');
      case 'sync':
        return new vscode.ThemeIcon('sync');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private getDescription(): string {
    const parts: string[] = [];

    if (this.submodule.currentBranch) {
      parts.push(this.submodule.currentBranch);
    }

    if (this.submodule.hasChanges) {
      parts.push('*');
    }

    if (this.submodule.ahead > 0) {
      parts.push(`↑${this.submodule.ahead}`);
    }

    if (this.submodule.behind > 0) {
      parts.push(`↓${this.submodule.behind}`);
    }

    return parts.join(' ');
  }
}
