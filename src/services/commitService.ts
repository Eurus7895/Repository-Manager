/**
 * Commit Service
 * Handles commit-related operations
 */

import * as path from 'path';
import { realpathSync, rmSync } from 'fs';
import { GitCommandService } from './gitCommandService';
import { CommitInfo, RemoteInfo, CommandResult, PartialStagedChoice, WorkingTreeChange, WorkingTreePreview } from '../types';

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const MAX_PREVIEW_LENGTH = 1024 * 1024;

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

/** Staged, then changed again in the working tree. */
export function isPartlyStaged(change: WorkingTreeChange): boolean {
  return change.staged && change.unstaged && !change.untracked && !change.conflicted;
}

const unique = (items: string[]) => Array.from(new Set(items));

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

  private async getUntrackedRepositoryPreview(
    repositoryPath: string,
    repositoryRoot: string,
    safePath: string,
    requestId: number
  ): Promise<WorkingTreePreview> {
    const nestedRoot = path.resolve(repositoryRoot, safePath);
    const topLevel = await this.gitCmd.execGit(['rev-parse', '--show-toplevel'], nestedRoot, 5000);
    if (path.relative(realpathSync(nestedRoot), realpathSync(topLevel)) !== '') {
      throw new Error('Untracked directory is not a nested Git repository');
    }

    let head: string | null = null;
    try {
      head = await this.gitCmd.execGit(['rev-parse', '--verify', 'HEAD'], nestedRoot, 5000);
    } catch {
      // An unborn nested repository cannot be staged as a gitlink.
    }

    let branch = 'detached HEAD';
    try {
      branch = await this.gitCmd.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], nestedRoot, 5000);
    } catch {
      // Keep the detached HEAD label.
    }
    const status = await this.gitCmd.execGitRaw(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], nestedRoot, 10000
    );
    const pendingFiles = status.split('\0').filter(Boolean).length;
    const patch = head
      ? [
        `diff --git a/${safePath} b/${safePath}`,
        'new file mode 160000',
        '--- /dev/null',
        `+++ b/${safePath}`,
        '@@ -0,0 +1 @@',
        `+Subproject commit ${head}`,
        '',
        `Nested Git repository: ${safePath} (${branch})`,
        pendingFiles
          ? `Nested working tree has ${pendingFiles} change(s). Only the HEAD commit is included in the parent commit.`
          : 'Nested working tree is clean. The parent commit includes the HEAD gitlink.'
      ].join('\n')
      : [
        `Nested Git repository: ${safePath} (${branch})`,
        'No commit at HEAD. Commit inside this repository before adding it to the parent repository.'
      ].join('\n');

    return { repositoryPath, path: safePath, mode: 'unstaged', patch, truncated: false, requestId };
  }

  async getWorkingTreePreview(
    repositoryPath: string,
    filePath: string,
    mode: 'staged' | 'unstaged',
    requestId: number
  ): Promise<WorkingTreePreview> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const safePath = this.gitCmd.resolveFilePath(filePath);
    const change = (await this.getWorkingTreeChanges(repositoryPath))
      .find(item => item.path === safePath);

    if (!change) {
      throw new Error('File is no longer changed. Reopen Commit to refresh the list.');
    }
    if (mode !== 'staged' && mode !== 'unstaged') {
      throw new Error('Invalid preview mode');
    }
    if (mode === 'staged' && !change.staged) {
      throw new Error('No staged changes for this file');
    }
    if (mode === 'unstaged' && !change.unstaged && !change.untracked) {
      throw new Error('No unstaged changes for this file');
    }

    if (change.untracked && safePath.endsWith('/')) {
      return this.getUntrackedRepositoryPreview(repositoryPath, repositoryRoot, safePath, requestId);
    }

    const paths = [safePath, ...(change.originalPath ? [this.gitCmd.resolveFilePath(change.originalPath)] : [])];
    const args = change.untracked
      ? ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=5', '--', '/dev/null', safePath]
      : ['diff', ...(mode === 'staged' ? ['--cached'] : []),
        '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=5', '--', ...paths];
    const output = await this.gitCmd.execGitRaw(args, repositoryRoot, 15000, change.untracked);
    const truncated = output.length > MAX_PREVIEW_LENGTH;

    return {
      repositoryPath,
      path: safePath,
      mode,
      patch: truncated ? output.slice(0, MAX_PREVIEW_LENGTH) : output,
      truncated,
      requestId
    };
  }

  /**
   * Commits the selected files, and only them. The commit is built in a temporary index, so the
   * real index (what you staged) is not touched unless the commit succeeds, and other staged files
   * stay staged. A selected file that is partly staged (staged, then changed again) needs `partial`:
   * 'staged' commits the staged version and leaves the later changes; 'whole' commits the file as
   * it is in the working tree.
   */
  async commitFiles(repositoryPath: string, filePaths: string[], message: string,
    partial?: PartialStagedChoice): Promise<CommandResult> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitMessage = message.trim();
    if (!commitMessage || commitMessage.includes('\0')) {
      return { success: false, message: 'Commit message is required' };
    }

    const requestedPaths = Array.from(new Set(filePaths.map(filePath => this.gitCmd.resolveFilePath(filePath))));
    if (requestedPaths.length === 0) {
      return { success: false, message: 'Select at least one changed file' };
    }

    let temporaryIndex: string | undefined;
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
      const selected = selectedChanges as WorkingTreeChange[];
      // A merge commit must hold the whole merge result: committing only some files would record an
      // incomplete merge (Git refuses `commit -- <paths>` during a merge for the same reason).
      if (await this.gitCmd.execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repositoryRoot).then(() => true, () => false)) {
        return { success: false, message: 'A merge is in progress: finish it by committing every file of the merge (Source Control), or abort it, before committing selected files' };
      }
      if (selected.some(isPartlyStaged) && partial !== 'staged' && partial !== 'whole') {
        return { success: false, message: 'Choose whether to commit only the staged part of partly staged files, or the whole files' };
      }

      const pathsOf = (change: WorkingTreeChange) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]
        .map(filePath => this.gitCmd.resolveFilePath(filePath));
      const stagedOnly = partial === 'staged' ? selected.filter(isPartlyStaged) : [];
      const wholePaths = unique(selected.filter(change => !stagedOnly.includes(change)).flatMap(pathsOf));
      const stagedPaths = unique(stagedOnly.flatMap(pathsOf));

      // The temporary index starts from HEAD, so files that were not selected are committed as they are in HEAD.
      const indexPath = path.resolve(repositoryRoot, await this.gitCmd.execGit(['rev-parse', '--git-path', 'index'], repositoryRoot));
      temporaryIndex = `${indexPath}.repository-manager-${process.pid}-${Date.now()}`;
      // Git reads the index named by this variable, so the real one stays as it is.
      const temporary: NodeJS.ProcessEnv = { ...process.env };
      temporary['GIT_INDEX_FILE'] = temporaryIndex;
      const hasHead = await this.gitCmd.execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repositoryRoot).then(() => true, () => false);
      await this.gitCmd.execGitRaw(['read-tree', ...(hasHead ? ['HEAD'] : ['--empty'])], repositoryRoot, 30000, false, temporary);
      if (wholePaths.length) {
        await this.gitCmd.execGitRaw(['add', '-A', '--', ...wholePaths], repositoryRoot, 30000, false, temporary);
      }
      for (const filePath of stagedPaths) {
        // The staged version: the real index entry, or none when the file was staged as deleted (or renamed away).
        const entry = (await this.gitCmd.execGitRaw(['ls-files', '-s', '-z', '--', filePath], repositoryRoot)).split('\0')[0];
        const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(entry || '');
        await this.gitCmd.execGitRaw(match
          ? ['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${filePath}`]
          : ['update-index', '--force-remove', '--', filePath], repositoryRoot, 30000, false, temporary);
      }
      await this.gitCmd.execGitRaw(['commit', '-m', commitMessage], repositoryRoot, 60000, false, temporary);
      const shortHash = await this.gitCmd.execGit(['rev-parse', '--short', 'HEAD'], repositoryRoot);

      // The commit exists: the selected files' index entries now match it. A whole file is then clean;
      // a file committed by its staged part keeps its later changes, unstaged. If that fails (another
      // Git process holds the index), the commit still exists: say so, rather than invite a second one.
      try {
        await this.gitCmd.execGit(['reset', '-q', '--', ...wholePaths, ...stagedPaths], repositoryRoot);
      } catch (error: unknown) {
        return { success: true, message: `Created commit ${shortHash}, but the staged files could not be updated to match it ` +
          `(${(error as Error).message.split('\n')[0]}). They may still show as staged: run "git reset -- <file>" on them.` };
      }
      return { success: true, message: `Created commit ${shortHash}` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to commit: ${err.message}` };
    } finally {
      if (temporaryIndex) { rmSync(temporaryIndex, { force: true }); }
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
  async checkoutCommit(submodulePath: string, commit: string, fromHistory = false): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      if (!fromHistory) {
        await this.gitCmd.execGit(['fetch', '--all'], fullPath);
      }
      const sha = await this.gitCmd.resolveRevision(submodulePath, commit);
      await this.gitCmd.execGit(['checkout', '--detach', sha], fullPath);
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
