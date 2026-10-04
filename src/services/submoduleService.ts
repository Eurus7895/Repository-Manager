/**
 * Submodule Service
 * Handles submodule-specific operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { GitCommandService } from './gitCommandService';
import { SubmoduleInfo, SubmoduleStatus, CommandResult, GitStatus } from '../types';

export class SubmoduleService {
  constructor(private gitCmd: GitCommandService) {}

  /**
   * Branch, commit, ahead/behind and local changes of one repository in a single Git process
   * (`status --porcelain=v2 --branch`), instead of one process per question. Ahead/behind come
   * from the upstream; a branch without one falls back to the same-named branch on origin.
   */
  private async readState(cwd: string, ignoreSubmoduleContent: boolean): Promise<{ commit: string; branch: string; detached: boolean;
    hasChanges: boolean; ahead: number; behind: number }> {
    const args = ['status', '--porcelain=v2', '--branch'];
    // A parent lists a submodule with new commits, but not edits inside it: each submodule reports those itself.
    if (ignoreSubmoduleContent) { args.push('--ignore-submodules=dirty'); }
    const lines = (await this.gitCmd.execGitRaw(args, cwd)).split('\n');
    const header = (key: string) => lines.find(line => line.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length).trim() || '';
    const oid = header('oid');
    const head = header('head');
    const detached = head === '(detached)';
    const branch = detached ? '' : head;
    const counts = /^\+(\d+) -(\d+)$/.exec(header('ab'));
    let ahead = counts ? Number(counts[1]) : 0;
    let behind = counts ? Number(counts[2]) : 0;
    if (!counts && branch && oid !== '(initial)') {
      try {
        const [behindStr, aheadStr] = (await this.gitCmd.execGit(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], cwd)).split('\t');
        behind = parseInt(behindStr, 10) || 0;
        ahead = parseInt(aheadStr, 10) || 0;
      } catch {
        // No upstream and no same-named remote branch: nothing to compare with.
      }
    }
    return { commit: oid === '(initial)' ? '' : oid, branch, detached, hasChanges: lines.some(line => line && !line.startsWith('#')), ahead, behind };
  }

  /**
   * Get information about the parent (main) repository
   */
  async getParentRepoInfo(): Promise<SubmoduleInfo | null> {
    const workspaceRoot = this.gitCmd.getWorkspaceRoot();
    const [state, remoteUrl] = await Promise.all([
      this.readState(workspaceRoot, true).catch(() => null),
      this.gitCmd.execGit(['remote', 'get-url', 'origin']).catch(() => '')
    ]);
    if (!state) { return null; }
    const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/);
    return {
      name: match ? match[1] : path.basename(workspaceRoot) || 'Parent Repository',
      path: '.', // Use '.' to indicate the root/parent repo
      url: '',
      branch: state.branch || 'main',
      currentCommit: state.commit.substring(0, 8),
      currentBranch: state.branch,
      status: state.hasChanges ? 'modified' : state.detached ? 'detached' : 'clean',
      hasChanges: state.hasChanges,
      ahead: state.ahead,
      behind: state.behind,
      isParentRepo: true
    };
  }

  /** Name, path, URL and branch of every submodule in .gitmodules, from one Git process. */
  private async readGitmodules(): Promise<Array<{ name: string; path: string; url: string; branch: string }>> {
    const output = await this.gitCmd.execGit(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\.']).catch(() => '');
    const byName = new Map<string, { name: string; path: string; url: string; branch: string }>();
    for (const line of output.split('\n')) {
      const match = line.match(/^submodule\.(.+)\.(path|url|branch)\s+(.*)$/);
      if (!match) { continue; }
      const [, name, key, value] = match;
      const entry = byName.get(name) || { name, path: '', url: '', branch: '' };
      entry[key as 'path' | 'url' | 'branch'] = value.trim();
      byName.set(name, entry);
    }
    return [...byName.values()].filter(entry => entry.path);
  }

  /** The commits the parent records for these submodule paths, from one `ls-tree`. */
  private async readRecordedCommits(paths: string[]): Promise<Map<string, string>> {
    const recorded = new Map<string, string>();
    if (!paths.length) { return recorded; }
    const output = await this.gitCmd.execGit(['ls-tree', 'HEAD', '--', ...paths]).catch(() => '');
    for (const line of output.split('\n')) {
      const match = line.match(/^\d+ commit ([0-9a-f]+)\t(.+)$/);
      if (match) { recorded.set(match[2], match[1]); }
    }
    return recorded;
  }

  private async describeSubmodule(entry: { name: string; path: string; url: string; branch: string }, recordedCommit: string): Promise<SubmoduleInfo> {
    const fullPath = this.gitCmd.resolveRepositoryPath(entry.path);
    // An uninitialized submodule is an empty folder: Git run there would describe the parent instead.
    const initialized = fs.existsSync(path.join(fullPath, '.git'));
    const state = initialized ? await this.readState(fullPath, false).catch(() => null) : null;
    const status: SubmoduleStatus = !state || !state.commit ? 'uninitialized' : state.hasChanges ? 'modified' : state.detached ? 'detached' : 'clean';
    const currentCommit = state && state.commit ? state.commit : '';
    return {
      name: entry.name,
      path: entry.path,
      url: entry.url,
      branch: entry.branch || 'main',
      currentCommit: currentCommit.substring(0, 8),
      currentBranch: state && state.commit ? state.branch : '',
      status,
      hasChanges: Boolean(state && state.commit && state.hasChanges),
      ahead: state && state.commit ? state.ahead : 0,
      behind: state && state.commit ? state.behind : 0,
      recordedCommit: recordedCommit.substring(0, 8),
      atRecordedCommit: recordedCommit && currentCommit ? recordedCommit === currentCommit : undefined,
      lastUpdated: new Date()
    };
  }

  /**
   * Get list of all submodules: .gitmodules and the recorded commits are read once, then each
   * submodule's state is read in parallel (a few at a time).
   */
  async getSubmodules(): Promise<SubmoduleInfo[]> {
    const entries = await this.readGitmodules();
    const recorded = await this.readRecordedCommits(entries.map(entry => entry.path));
    const results: SubmoduleInfo[] = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const index = next++;
        results[index] = await this.describeSubmodule(entries[index], recorded.get(entries[index].path) || '');
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
    return results;
  }

  /**
   * Get detailed information about a specific submodule
   */
  async getSubmoduleInfo(name: string, submodulePath: string): Promise<SubmoduleInfo> {
    const entry = (await this.readGitmodules()).find(item => item.name === name) || { name, path: submodulePath, url: '', branch: '' };
    const recorded = await this.readRecordedCommits([submodulePath]);
    return this.describeSubmodule({ ...entry, path: submodulePath }, recorded.get(submodulePath) || '');
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
      // A commit that is already local needs no network; fetch only for branches or missing objects.
      const isLocalCommit = /^[0-9a-f]{7,64}$/i.test(target)
        && await this.gitCmd.execGit(['cat-file', '-e', `${target}^{commit}`], fullPath).then(() => true, () => false);
      if (!isLocalCommit) {
        await this.gitCmd.execGit(['fetch', '--all'], fullPath);
      }
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
