/**
 * Submodule Service
 * Handles submodule-specific operations
 */

import * as path from 'path';
import { GitCommandService } from './gitCommandService';
import { SubmoduleInfo, SubmoduleStatus, CommandResult, GitStatus } from '../types';

export class SubmoduleService {
  constructor(private gitCmd: GitCommandService) {}

  /**
   * Get information about the parent (main) repository
   */
  async getParentRepoInfo(): Promise<SubmoduleInfo | null> {
    const workspaceRoot = this.gitCmd.getWorkspaceRoot();

    try {
      // Check if it's a git repo
      await this.gitCmd.execGit(['rev-parse', '--git-dir']);

      // Get repo name from the root folder or remote URL
      let name = 'Parent Repository';
      try {
        const remoteUrl = await this.gitCmd.execGit(['remote', 'get-url', 'origin']);
        const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/);
        if (match) {
          name = match[1];
        }
      } catch {
        // Use folder name if no remote
        name = path.basename(workspaceRoot);
      }

      // Get current commit
      let currentCommit = '';
      try {
        currentCommit = await this.gitCmd.execGit(['rev-parse', 'HEAD']);
      } catch {
        // No commits yet
      }

      // Get current branch
      let currentBranch = '';
      let status: SubmoduleStatus = 'unknown';
      try {
        currentBranch = await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (currentBranch === 'HEAD') {
          currentBranch = '';
          status = 'detached';
        }
      } catch {
        currentBranch = '';
        status = 'detached';
      }

      // Check for changes
      let hasChanges = false;
      try {
        const statusOutput = await this.gitCmd.execGit(['status', '--porcelain']);
        hasChanges = statusOutput.trim().length > 0;
      } catch {
        // Ignore
      }

      // Determine final status
      if (hasChanges) {
        status = 'modified';
      } else if (status !== 'detached') {
        status = 'clean';
      }

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      if (currentBranch && currentBranch !== 'HEAD') {
        try {
          const tracking = await this.gitCmd.execGit(
            ['rev-list', '--left-right', '--count', `origin/${currentBranch}...HEAD`]
          );
          const [behindStr, aheadStr] = tracking.split('\t');
          behind = parseInt(behindStr, 10) || 0;
          ahead = parseInt(aheadStr, 10) || 0;
        } catch {
          // No tracking branch
        }
      }

      return {
        name,
        path: '.', // Use '.' to indicate the root/parent repo
        url: '',
        branch: currentBranch || 'main',
        currentCommit: currentCommit.substring(0, 8),
        currentBranch,
        status,
        hasChanges,
        ahead,
        behind,
        isParentRepo: true
      };
    } catch {
      return null;
    }
  }

  /**
   * Get list of all submodules
   */
  async getSubmodules(): Promise<SubmoduleInfo[]> {
    const submodules: SubmoduleInfo[] = [];

    try {
      // Get submodule configuration
      const config = await this.gitCmd.execGit(['config', '--file', '.gitmodules', '--get-regexp', 'path']);
      const lines = config.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const match = line.match(/submodule\.(.+)\.path\s+(.+)/);
        if (match) {
          const name = match[1];
          const submodulePath = match[2];

          try {
            const info = await this.getSubmoduleInfo(name, submodulePath);
            submodules.push(info);
          } catch (error) {
            // Submodule may not be initialized
            submodules.push({
              name,
              path: submodulePath,
              url: '',
              branch: '',
              currentCommit: '',
              currentBranch: '',
              status: 'uninitialized',
              hasChanges: false,
              ahead: 0,
              behind: 0
            });
          }
        }
      }
    } catch {
      // No .gitmodules file or no submodules
    }

    return submodules;
  }

  /**
   * Get detailed information about a specific submodule
   */
  async getSubmoduleInfo(name: string, submodulePath: string): Promise<SubmoduleInfo> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    // Get URL
    let url = '';
    try {
      url = await this.gitCmd.execGit(['config', '--file', '.gitmodules', `submodule.${name}.url`]);
    } catch {
      // URL not found
    }

    // Get configured branch
    let branch = '';
    try {
      branch = await this.gitCmd.execGit(['config', '--file', '.gitmodules', `submodule.${name}.branch`]);
    } catch {
      branch = 'main'; // Default branch
    }

    // Check if submodule is initialized
    let currentCommit = '';
    let currentBranch = '';
    let status: SubmoduleStatus = 'unknown';
    let hasChanges = false;
    let ahead = 0;
    let behind = 0;

    try {
      // Get current commit
      currentCommit = await this.gitCmd.execGit(['rev-parse', 'HEAD'], fullPath);

      // Get current branch
      try {
        currentBranch = await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
        if (currentBranch === 'HEAD') {
          // Detached HEAD - show empty branch so UI can display "(detached)"
          currentBranch = '';
          status = 'detached';
        }
      } catch {
        currentBranch = '';
        status = 'detached';
      }

      // Check for changes inside the submodule (uncommitted files)
      const statusOutput = await this.gitCmd.execGit(['status', '--porcelain'], fullPath);
      // Trim whitespace and check if there are actual changes
      hasChanges = statusOutput.trim().length > 0;

      // Determine final status
      // - 'modified': has uncommitted changes inside the submodule
      // - 'detached': checked out to a specific commit (not on a branch), but clean
      // - 'clean': on a branch with no uncommitted changes
      if (hasChanges) {
        status = 'modified';
      } else if (status !== 'detached') {
        status = 'clean';
      }
      // If detached and no changes, keep status as 'detached'

      // Get ahead/behind counts
      if (currentBranch && currentBranch !== 'HEAD') {
        try {
          const tracking = await this.gitCmd.execGit(
            ['rev-list', '--left-right', '--count', `origin/${currentBranch}...HEAD`],
            fullPath
          );
          const [behindStr, aheadStr] = tracking.split('\t');
          behind = parseInt(behindStr, 10) || 0;
          ahead = parseInt(aheadStr, 10) || 0;
        } catch {
          // No tracking branch
        }
      }
    } catch {
      status = 'uninitialized';
    }

    return {
      name,
      path: submodulePath,
      url,
      branch,
      currentCommit: currentCommit.substring(0, 8),
      currentBranch,
      status,
      hasChanges,
      ahead,
      behind,
      lastUpdated: new Date()
    };
  }

  /**
   * Initialize all submodules
   */
  async initSubmodules(): Promise<CommandResult> {
    try {
      await this.gitCmd.execGit(['submodule', 'init']);
      await this.gitCmd.execGit(['submodule', 'update', '--init', '--recursive']);
      return { success: true, message: 'Submodules initialized successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to initialize submodules: ${err.message}` };
    }
  }

  /**
   * Update all submodules
   */
  async updateSubmodules(): Promise<CommandResult> {
    try {
      await this.gitCmd.execGit(['submodule', 'update', '--remote', '--recursive']);
      return { success: true, message: 'Submodules updated successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to update submodules: ${err.message}` };
    }
  }

  /**
   * Get git status for a submodule
   */
  async getStatus(submodulePath: string): Promise<GitStatus> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const status: GitStatus = {
      staged: [],
      unstaged: [],
      untracked: [],
      hasChanges: false
    };

    try {
      const output = await this.gitCmd.execGit(['status', '--porcelain'], fullPath);

      for (const line of output.split('\n').filter(l => l)) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        const file = line.substring(3);

        if (indexStatus === '?' && workTreeStatus === '?') {
          status.untracked.push(file);
        } else if (indexStatus !== ' ' && indexStatus !== '?') {
          status.staged.push(file);
        } else if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
          status.unstaged.push(file);
        }
      }

      status.hasChanges = status.staged.length > 0 ||
                          status.unstaged.length > 0 ||
                          status.untracked.length > 0;
    } catch {
      // Error getting status
    }

    return status;
  }

  /**
   * Stage submodule changes in parent repo
   */
  async stageSubmodule(submodulePath: string): Promise<CommandResult> {
    try {
      await this.gitCmd.execGit(['add', submodulePath]);
      return { success: true, message: `Staged submodule '${submodulePath}'` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to stage: ${err.message}` };
    }
  }

  /**
   * Sync submodule to a specific commit or branch
   */
  async syncSubmodule(submodulePath: string, target: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      await this.gitCmd.execGit(['fetch', '--all'], fullPath);
      await this.gitCmd.execGit(['checkout', target], fullPath);
      return { success: true, message: `Synced to '${target}'` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to sync: ${err.message}` };
    }
  }

  /**
   * Sync submodules to their recorded commits in the parent repository
   * @param submodulePaths Optional list of submodule paths to sync. If not provided, syncs all.
   */
  async syncAllSubmodules(submodulePaths?: string[]): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();
    const submodules = await this.getSubmodules();

    for (const submodule of submodules) {
      // If specific paths provided, only sync those
      if (submodulePaths && submodulePaths.length > 0 && !submodulePaths.includes(submodule.path)) {
        continue;
      }

      // Get the recorded commit from the parent repository
      const recordedCommit = await this.getRecordedCommit(submodule.path);

      if (recordedCommit) {
        // Sync to the recorded commit, not the branch
        const result = await this.syncSubmodule(submodule.path, recordedCommit);
        results.set(submodule.path, result);
      } else {
        results.set(submodule.path, {
          success: false,
          message: `No recorded commit found for '${submodule.path}'`
        });
      }
    }

    return results;
  }

  /**
   * Get the commit hash recorded in the parent repository for a submodule
   * This is the commit the parent repo expects the submodule to be at
   */
  async getRecordedCommit(submodulePath: string): Promise<string> {
    try {
      // Use ls-tree to get the recorded commit for the submodule
      const output = await this.gitCmd.execGit(['ls-tree', 'HEAD', submodulePath]);
      const match = output.match(/commit\s+([a-f0-9]+)/);
      if (match) {
        return match[1];
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Get the current HEAD commit of a submodule
   */
  async getCurrentCommit(submodulePath: string): Promise<string> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      return await this.gitCmd.execGit(['rev-parse', 'HEAD'], fullPath);
    } catch {
      return '';
    }
  }

  /**
   * Update a submodule to the commit recorded in the parent repository
   */
  async updateToRecordedCommit(submodulePath: string): Promise<CommandResult> {
    try {
      // This updates the submodule to the commit recorded in the parent's index
      // WITHOUT the --remote flag, it uses the recorded commit
      await this.gitCmd.execGit(['submodule', 'update', '--init', '--', submodulePath]);
      return { success: true, message: `Updated '${submodulePath}' to recorded commit` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to update: ${err.message}` };
    }
  }

  /**
   * Update submodules to their recorded commits (not remote)
   * This is different from updateSubmodules which fetches the latest from remote
   */
  async updateSubmodulesToRecorded(): Promise<CommandResult> {
    try {
      // Without --remote, this updates to the recorded commits
      await this.gitCmd.execGit(['submodule', 'update', '--init', '--recursive']);
      return { success: true, message: 'Submodules updated to recorded commits' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to update submodules: ${err.message}` };
    }
  }

  /**
   * Record a specific commit for a submodule in the parent repository
   * This stages the submodule pointer change
   */
  async recordSubmoduleCommit(submodulePath: string, commit?: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      // If a specific commit is provided, checkout that commit first
      if (commit) {
        await this.gitCmd.execGit(['fetch', '--all'], fullPath);
        await this.gitCmd.execGit(['checkout', commit], fullPath);
      }

      // Stage the submodule change in the parent repo
      await this.gitCmd.execGit(['add', submodulePath]);
      const currentCommit = await this.getCurrentCommit(submodulePath);

      return {
        success: true,
        message: `Recorded commit '${currentCommit.substring(0, 8)}' for '${submodulePath}'`,
        data: { commit: currentCommit }
      };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to record commit: ${err.message}` };
    }
  }
}
