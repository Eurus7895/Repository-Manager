import { CommandResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { HistoryActionService } from './historyActionService';

export type HistoryRewriteAction = 'rebase' | 'reset' | 'drop';
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface HistoryRewritePreview {
  action: HistoryRewriteAction;
  branch: string;
  head: string;
  target: string;
  targetSubject: string;
  affectedCount: number;
  affected: { hash: string; subject: string }[];
}

export class HistoryRewriteService {
  private historyActions: HistoryActionService;

  constructor(private git: GitCommandService) {
    this.historyActions = new HistoryActionService(git);
  }

  async preview(repositoryPath: string, revision: string, action: HistoryRewriteAction): Promise<HistoryRewritePreview> {
    if (!['rebase', 'reset', 'drop'].includes(action)) {
      throw new Error('Unsupported history rewrite action.');
    }
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const target = await this.git.resolveRevision(repositoryPath, revision);
    const targetSubject = await this.git.execGit(['show', '-s', '--format=%s', target], cwd, 5000);
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000)
      .catch(() => { throw new Error('Checkout a local branch before rewriting its history.'); });
    const head = await this.git.resolveRevision(repositoryPath, 'HEAD');
    if (head === target && action !== 'drop') {
      throw new Error('The selected commit is already the current HEAD.');
    }
    let range: string;
    if (action === 'drop') {
      const ancestry = await this.git.execGit(['rev-list', '--first-parent', 'HEAD'], cwd, 10000);
      if (!ancestry.split('\n').includes(target)) {
        throw new Error('Only a commit on the current branch first-parent history can be dropped.');
      }
      const parents = (await this.git.execGit(['rev-list', '--parents', '-n', '1', target], cwd, 5000)).split(/\s+/).slice(1);
      if (parents.length !== 1) {
        throw new Error('Dropping a root or merge commit is not supported.');
      }
      const published = await this.git.execGit(['for-each-ref', `--contains=${target}`, '--format=%(refname)', 'refs/remotes'], cwd, 10000);
      if (published) {
        throw new Error('This commit is reachable from a remote branch. Dropping a published commit is blocked.');
      }
      range = `${target}..${head}`;
    } else if (action === 'rebase') {
      const base = await this.git.execGit(['merge-base', target, head], cwd, 5000)
        .catch(() => { throw new Error('The selected commit has no common ancestor with the current branch.'); });
      if (base === target) {
        throw new Error('The selected commit is already an ancestor of the current branch.');
      }
      range = `${base}..${head}`;
    } else {
      range = `${target}..${head}`;
    }
    if (action !== 'reset') {
      const merges = await this.git.execGit(['rev-list', '--merges', range], cwd, 10000);
      if (merges) {
        throw new Error('Rewriting a range containing merge commits is not supported.');
      }
    }
    const affectedCount = Number(await this.git.execGit(['rev-list', '--first-parent', '--count', range], cwd, 10000));
    const log = await this.git.execGit(['log', '--first-parent', '--reverse', '--max-count=10', '--format=%H%x1f%s', range], cwd, 10000);
    const affected = log.split('\n').filter(Boolean).map(line => {
      const [hash, ...subject] = line.split('\x1f');
      return { hash, subject: subject.join('\x1f') };
    });
    return { action, branch, head, target, targetSubject, affectedCount, affected };
  }

  async execute(repositoryPath: string, target: string, action: HistoryRewriteAction,
    expectedBranch: string, expectedHead: string, mode?: ResetMode): Promise<CommandResult> {
    let started = false;
    let backup: string | undefined;
    try {
      if (!expectedBranch || !/^[a-f0-9]{40}$/i.test(expectedHead)) {
        throw new Error('Missing confirmed branch or HEAD.');
      }
      if (action === 'reset' && !['soft', 'mixed', 'hard'].includes(mode || '')) {
        throw new Error('Choose a reset mode.');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      const preview = await this.preview(repositoryPath, target, action);
      if (preview.branch !== expectedBranch || preview.head !== expectedHead || preview.target !== target) {
        throw new Error('Branch, HEAD, or selected commit changed. Review the action again.');
      }
      if (await this.historyActions.pendingOperation(repositoryPath)) {
        throw new Error('Finish or abort the current Git operation first.');
      }
      if (await this.git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, 10000)) {
        throw new Error('Commit, stash, or discard working tree changes before rewriting history.');
      }
      // Recheck immediately before making a backup or changing the current branch.
      if (await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000) !== expectedBranch ||
          await this.git.resolveRevision(repositoryPath, 'HEAD') !== expectedHead) {
        throw new Error('Current branch changed. Review the action again.');
      }
      if (action === 'drop' || (action === 'reset' && mode === 'hard')) {
        backup = `history-backup/${action}-${Date.now()}-${expectedHead.slice(0, 8)}`;
        await this.git.execGit(['branch', backup, expectedHead], cwd, 5000);
      }
      const args = action === 'reset'
        ? ['reset', `--${mode}`, target]
        : action === 'drop'
          ? expectedHead === target ? ['reset', '--hard', `${target}^`]
            : ['rebase', '--no-fork-point', '--onto', `${target}^`, target]
          : ['rebase', '--no-fork-point', '--onto', target, await this.git.execGit(['merge-base', target, expectedHead], cwd, 5000)];
      started = true;
      await this.git.execGit(args, cwd, 120000);
      return { success: true, data: { backup }, message: `${action}${mode ? ` (${mode})` : ''} completed on ${expectedBranch}.${backup ? ` Backup: ${backup}.` : ''}` };
    } catch (error) {
      const pending = started ? await this.historyActions.pendingOperation(repositoryPath).catch(() => undefined) : undefined;
      return { success: false, data: { pending, backup },
        message: `${action} failed: ${error instanceof Error ? error.message : String(error)}` +
          `${pending === 'rebase' ? ' Resolve conflicts, stage files, then continue or abort the rebase.' : ''}` +
          `${backup ? ` Backup: ${backup}.` : ''}` };
    }
  }

  async resolveRebase(repositoryPath: string, command: 'continue' | 'abort'): Promise<CommandResult> {
    try {
      if (await this.historyActions.pendingOperation(repositoryPath) !== 'rebase') {
        throw new Error('There is no rebase in progress.');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      await this.git.execGit(['-c', 'core.editor=true', 'rebase', `--${command}`], cwd, 120000);
      return { success: true, message: `Rebase ${command} completed.` };
    } catch (error) {
      return { success: false, message: `Unable to ${command} rebase: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
