import { CommandResult } from '../types';
import { GitCommandService } from './gitCommandService';

export type HistoryAction = 'cherry-pick' | 'revert' | 'merge';

export class HistoryActionService {
  constructor(private git: GitCommandService) {}

  async describe(repositoryPath: string, commit: string): Promise<{ sha: string; branch: string; parents: string[] }> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const sha = await this.git.resolveRevision(repositoryPath, commit);
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000)
      .catch(() => { throw new Error('Checkout a local branch before applying a commit.'); });
    const ancestry = await this.git.execGit(['rev-list', '--parents', '-n', '1', sha], cwd, 5000);
    return { sha, branch, parents: ancestry.split(/\s+/).slice(1) };
  }

  async apply(repositoryPath: string, commit: string, operation: HistoryAction, mainline?: number): Promise<CommandResult> {
    let started = false;
    try {
      if (!['cherry-pick', 'revert', 'merge'].includes(operation)) {
        throw new Error('Unsupported history action');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      const { sha, branch, parents } = await this.describe(repositoryPath, commit);
      if (await this.pendingOperation(repositoryPath)) {
        throw new Error('Finish or abort the current Git operation first.');
      }
      const status = await this.git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, 10000);
      if (status) {
        throw new Error('Commit, stash, or discard working tree changes before running this action.');
      }
      if (operation !== 'merge' && parents.length > 1 &&
          (!Number.isInteger(mainline) || mainline! < 1 || mainline! > parents.length)) {
        throw new Error('Choose a parent for the merge commit.');
      }
      const args = operation === 'merge'
        ? ['merge', '--no-edit', sha]
        : [operation, '--no-edit', ...(parents.length > 1 ? ['-m', String(mainline)] : []), sha];
      started = true;
      await this.git.execGit(args, cwd, 120000);
      return { success: true, message: `${operation} ${sha.slice(0, 12)} completed on ${branch}.` };
    } catch (error) {
      const pending = started ? await this.pendingOperation(repositoryPath).catch(() => undefined) : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      const guidance = pending
        ? ` Resolve conflicts in Source Control, then run git ${pending} --continue, or abort the operation.`
        : '';
      return { success: false, data: { pending }, message: `${operation} failed: ${detail}${guidance}` };
    }
  }

  async pendingOperation(repositoryPath: string): Promise<HistoryAction | undefined> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    for (const [ref, operation] of [
      ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['MERGE_HEAD', 'merge']
    ] as const) {
      const found = await this.git.execGit(['rev-parse', '-q', '--verify', ref], cwd, 5000).catch(() => '');
      if (found) {
        return operation;
      }
    }
    return undefined;
  }

  async abort(repositoryPath: string, operation: HistoryAction): Promise<CommandResult> {
    try {
      if (await this.pendingOperation(repositoryPath) !== operation) {
        throw new Error('That operation is no longer in progress.');
      }
      await this.git.execGit([operation, '--abort'], this.git.resolveRepositoryPath(repositoryPath), 30000);
      return { success: true, message: `${operation} aborted.` };
    } catch (error) {
      return { success: false, message: `Unable to abort ${operation}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
