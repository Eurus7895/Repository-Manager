/**
 * Commit Service
 * Handles commit-related operations
 */

import { GitCommandService } from './gitCommandService';
import { CommitInfo, RemoteInfo, CommandResult } from '../types';

export class CommitService {
  constructor(private gitCmd: GitCommandService) {}

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
