/**
 * Commit Service
 * Handles commit-related operations
 */

import { GitCommandService } from './gitCommandService';
import { CommitInfo, RemoteInfo, CommandResult, WorkingTreeChange } from '../types';

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function parseWorkingTreeStatus(output: string): WorkingTreeChange[] {
  const records = output.split('\0');
  const changes: WorkingTreeChange[] = [];

  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record || record.length < 3) {
      continue;
    }

    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const path = record.slice(3);
    const renamedOrCopied = indexStatus === 'R' || indexStatus === 'C';
    const originalPath = renamedOrCopied ? records[index++] : undefined;
    const untracked = indexStatus === '?' && workTreeStatus === '?';

    const change: WorkingTreeChange = {
      path,
      indexStatus,
      workTreeStatus,
      staged: !untracked && indexStatus !== ' ',
      unstaged: !untracked && workTreeStatus !== ' ',
      untracked,
      conflicted: CONFLICT_STATUSES.has(indexStatus + workTreeStatus)
    };
    if (originalPath) {
      change.originalPath = originalPath;
    }
    changes.push(change);
  }

  return changes;
}

export class CommitService {
  constructor(private gitCmd: GitCommandService) {}

  async getWorkingTreeChanges(repositoryPath: string): Promise<WorkingTreeChange[]> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const output = await this.gitCmd.execGitRaw(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      repositoryRoot,
      10000
    );
    return parseWorkingTreeStatus(output);
  }

  async commitFiles(repositoryPath: string, filePaths: string[], message: string): Promise<CommandResult> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitMessage = message.trim();
    if (!commitMessage || commitMessage.includes('\0')) {
      return { success: false, message: 'Commit message is required' };
    }

    const requestedPaths = Array.from(new Set(filePaths.map(filePath => this.gitCmd.resolveFilePath(filePath))));
    if (requestedPaths.length === 0) {
      return { success: false, message: 'Select at least one changed file' };
    }

    try {
      const changes = await this.getWorkingTreeChanges(repositoryPath);
      const changesByPath = new Map(changes.map(change => [change.path, change]));
      const selectedChanges = requestedPaths.map(filePath => changesByPath.get(filePath));

      if (selectedChanges.some(change => !change)) {
        return { success: false, message: 'One or more selected files are no longer changed' };
      }
      if (selectedChanges.some(change => change?.conflicted)) {
        return { success: false, message: 'Resolve conflicted files before committing' };
      }

      const pathspecs = Array.from(new Set(selectedChanges.flatMap(change => {
        if (!change) {
          return [];
        }
        return [change.path, ...(change.originalPath ? [change.originalPath] : [])]
          .map(filePath => this.gitCmd.resolveFilePath(filePath));
      })));

      await this.gitCmd.execGit(['add', '-A', '--', ...pathspecs], repositoryRoot);
      await this.gitCmd.execGit(['commit', '--only', '-m', commitMessage, '--', ...pathspecs], repositoryRoot, 60000);
      const shortHash = await this.gitCmd.execGit(['rev-parse', '--short', 'HEAD'], repositoryRoot);
      return { success: true, message: `Created commit ${shortHash}` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to commit: ${err.message}` };
    }
  }

  /**
   * Get recent commits for a submodule
   */
  async getRecentCommits(submodulePath: string, count: number = 10): Promise<CommitInfo[]> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const commits: CommitInfo[] = [];

    try {
      const output = await this.gitCmd.execGit(
        ['log', `-${count}`, '--format=%H|%h|%an|%ae|%ai|%s'],
        fullPath
      );

      for (const line of output.split('\n').filter(l => l)) {
        const [hash, shortHash, author, email, date, message] = line.split('|');
        commits.push({
          hash,
          shortHash,
          author,
          email,
          date: new Date(date),
          message
        });
      }
    } catch {
      // Error getting commits
    }

    return commits;
  }

  /**
   * Checkout a specific commit in a submodule
   */
  async checkoutCommit(submodulePath: string, commit: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      await this.gitCmd.execGit(['fetch', '--all'], fullPath);
      await this.gitCmd.execGit(['checkout', commit], fullPath);
      return { success: true, message: `Checked out commit '${commit.substring(0, 8)}'` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to checkout commit: ${err.message}` };
    }
  }

  /**
   * Get remote information for a submodule
   */
  async getRemotes(submodulePath: string): Promise<RemoteInfo[]> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const remotes: RemoteInfo[] = [];

    try {
      const output = await this.gitCmd.execGit(['remote', '-v'], fullPath);
      const remoteMap = new Map<string, RemoteInfo>();

      for (const line of output.split('\n').filter(l => l)) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (match) {
          const [, name, url, type] = match;

          if (!remoteMap.has(name)) {
            remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
          }

          const remote = remoteMap.get(name)!;
          if (type === 'fetch') {
            remote.fetchUrl = url;
          } else {
            remote.pushUrl = url;
          }
        }
      }

      remotes.push(...remoteMap.values());
    } catch {
      // Error getting remotes
    }

    return remotes;
  }

  /**
   * Get GitHub repository info from remote URL
   */
  parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    // Handle SSH format: git@github.com:owner/repo.git
    let match = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }

    // Handle HTTPS format: https://github.com/owner/repo.git
    match = url.match(/https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }

    return null;
  }
}
