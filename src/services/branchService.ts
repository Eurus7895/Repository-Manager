/**
 * Branch Service
 * Handles branch-related operations
 */

import { GitCommandService } from './gitCommandService';
import { BranchInfo, CommandResult } from '../types';

export class BranchService {
  constructor(private gitCmd: GitCommandService) {}

  /**
   * Get branches for a submodule (fast - single git command, no network calls)
   */
  async getBranches(submodulePath: string): Promise<BranchInfo[]> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const branches: BranchInfo[] = [];

    try {
      // Use simple git branch -a command (most compatible) with 5s timeout
      const output = await this.gitCmd.execGit(['branch', '-a'], fullPath, 5000);
      const localNames = new Set<string>();
      const remoteNames = new Set<string>();
      let currentBranchName = '';

      // First pass: categorize all branches into local and remote sets
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.includes('HEAD')) {
          continue;
        }

        const isCurrent = trimmed.startsWith('*');
        const branchName = trimmed.replace(/^\*\s*/, '').trim();
        const isRemote = branchName.startsWith('remotes/origin/') || branchName.startsWith('origin/');
        const cleanName = branchName
          .replace(/^remotes\/origin\//, '')
          .replace(/^origin\//, '');

        if (isCurrent && !isRemote) {
          currentBranchName = cleanName;
        }

        if (isRemote) {
          remoteNames.add(cleanName);
        } else {
          localNames.add(cleanName);
        }
      }

      // Second pass: build unique branch list with local/remote tracking
      const allNames = new Set([...localNames, ...remoteNames]);
      for (const name of allNames) {
        const hasLocalCopy = localNames.has(name);
        const hasRemoteCopy = remoteNames.has(name);
        // Prefer local over remote for dedup
        const isRemote = hasRemoteCopy && !hasLocalCopy;

        branches.push({
          name,
          isRemote,
          isCurrent: name === currentBranchName,
          commit: '',
          // For remote-only branches: mark if they also have a local checkout
          hasLocal: isRemote && hasLocalCopy ? true : undefined,
          // For local branches: mark if they also exist on remote (checked out from remote)
          hasRemote: !isRemote && hasRemoteCopy ? true : undefined
        });
      }

      // Sort: current first, then alphabetically
      branches.sort((a, b) => {
        if (a.isCurrent) {
          return -1;
        }
        if (b.isCurrent) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    } catch (error) {
      console.error('Error getting branches:', error);
    }

    return branches;
  }

  /**
   * Create a branch in the specified submodule
   */
  async createBranch(
    submodulePath: string,
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      // If base branch specified, start from it
      if (baseBranch) {
        await this.gitCmd.execGit(['checkout', baseBranch], fullPath);
        await this.gitCmd.execGit(['pull', 'origin', baseBranch], fullPath);
      }

      // Create the branch
      if (checkout) {
        await this.gitCmd.execGit(['checkout', '-b', branchName], fullPath);
      } else {
        await this.gitCmd.execGit(['branch', branchName], fullPath);
      }

      return { success: true, message: `Branch '${branchName}' created successfully` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to create branch: ${err.message}` };
    }
  }

  /**
   * Create a branch across multiple submodules
   */
  async createBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();

    for (const submodulePath of submodulePaths) {
      const result = await this.createBranch(submodulePath, branchName, baseBranch, checkout);
      results.set(submodulePath, result);
    }

    return results;
  }

  /**
   * Checkout a branch in a submodule
   */
  async checkoutBranch(
    submodulePath: string,
    branchName: string,
    replaceWithRemote: boolean = false
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      if (replaceWithRemote) {
        const workingTree = await this.gitCmd.execGit(['status', '--porcelain'], fullPath);
        if (workingTree.trim()) {
          return {
            success: false,
            message: 'Cannot replace the local branch while the working tree has uncommitted changes'
          };
        }

        const remoteBranch = `origin/${branchName}`;
        await this.gitCmd.execGit(['rev-parse', '--verify', `refs/remotes/${remoteBranch}`], fullPath);
        await this.gitCmd.execGit(['checkout', '-B', branchName, remoteBranch], fullPath);
        await this.gitCmd.execGit(['branch', '--set-upstream-to', remoteBranch, branchName], fullPath);
        return {
          success: true,
          message: `Replaced local '${branchName}' with '${remoteBranch}'`
        };
      }

      await this.gitCmd.execGit(['checkout', branchName], fullPath);
      return { success: true, message: `Checked out '${branchName}'` };
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        message: replaceWithRemote
          ? `Failed to replace local branch from origin: ${err.message}`
          : `Failed to checkout: ${err.message}`
      };
    }
  }

  /**
   * Pull changes for a submodule
   */
  async pullChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      const currentBranch = branch || await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
      await this.gitCmd.execGit(['pull', 'origin', currentBranch], fullPath);
      return { success: true, message: 'Changes pulled successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to pull: ${err.message}` };
    }
  }

  /**
   * Push changes for a submodule
   */
  async pushChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      const currentBranch = branch || await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
      await this.gitCmd.execGit(['push', '-u', 'origin', currentBranch], fullPath);
      return { success: true, message: 'Changes pushed successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to push: ${err.message}` };
    }
  }

  /**
   * Delete a branch in a submodule
   */
  async deleteBranch(
    submodulePath: string,
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      // Check if trying to delete current branch
      const currentBranch = await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
      if (currentBranch === branchName) {
        return { success: false, message: `Cannot delete the currently checked out branch '${branchName}'` };
      }

      // Delete local branch
      await this.gitCmd.execGit(['branch', '-D', branchName], fullPath);

      // Optionally delete remote branch
      if (deleteRemote) {
        try {
          await this.gitCmd.execGit(['push', 'origin', '--delete', branchName], fullPath);
        } catch (error: unknown) {
          const err = error as Error;
          return {
            success: true,
            message: `Local branch '${branchName}' deleted, but failed to delete remote: ${err.message}`
          };
        }
      }

      return { success: true, message: `Branch '${branchName}' deleted successfully${deleteRemote ? ' (local + remote)' : ''}` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to delete branch: ${err.message}` };
    }
  }

  /**
   * Delete a branch across multiple submodules
   */
  async deleteBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();

    for (const submodulePath of submodulePaths) {
      const result = await this.deleteBranch(submodulePath, branchName, deleteRemote);
      results.set(submodulePath, result);
    }

    return results;
  }

  /**
   * Fetch updates for a submodule
   */
  async fetchUpdates(submodulePath: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      await this.gitCmd.execGit(['fetch', '--all', '--prune'], fullPath);
      return { success: true, message: 'Updates fetched successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to fetch: ${err.message}` };
    }
  }
}
