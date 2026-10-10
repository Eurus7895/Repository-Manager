/**
 * Discard Service
 * Discards uncommitted changes. Tracked files go back to HEAD (staged and unstaged changes alike),
 * after their changes are kept as a stash entry that `git stash apply` brings back. New files, which
 * Git has no copy of, are handed to a remover (VS Code moves them to the Trash).
 */

import * as path from 'path';
import { lstatSync, rmdirSync, rmSync } from 'fs';
import { GitCommandService } from './gitCommandService';
import { CommitService } from './commitService';
import { HistoryActionService } from './historyActionService';
import { WorkingTreeChange } from '../types';

export interface DiscardPlan {
  repositoryPath: string;
  /** Tracked files that go back to HEAD. */
  tracked: WorkingTreeChange[];
  /** New files: removed, since Git has no copy of them. */
  untracked: string[];
  /** Changes left as they are, and why. */
  skipped: Array<{ path: string; reason: string }>;
}

export interface DiscardOutcome {
  success: boolean;
  message: string;
  /** The backup of the tracked changes, as `git stash list` names it right after. */
  stash?: string;
  discarded: string[];
  removed: string[];
  /** New files the remover could not remove, with its reason. */
  notRemoved: Array<{ path: string; reason: string }>;
}

/** Removes one file, given its absolute path. */
export type Remover = (absolutePath: string) => Promise<void>;

const unique = (items: string[]) => Array.from(new Set(items));
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What a confirmation was given for: a plan that no longer matches it is not carried out. */
function signature(plan: DiscardPlan): string {
  return JSON.stringify([plan.tracked.map(change => [change.path, change.originalPath, change.indexStatus, change.workTreeStatus]),
    plan.untracked]);
}

/**
 * One change per path. A file staged as deleted that is still on disk (`git rm --cached`) is listed
 * twice, deleted and untracked: it is a tracked file, and going back to HEAD restores it. Treating
 * it as new would send the file to the Trash.
 */
function changesByPath(changes: WorkingTreeChange[]): Map<string, WorkingTreeChange> {
  const byPath = new Map<string, WorkingTreeChange>();
  for (const change of changes) {
    if (!byPath.has(change.path) || !change.untracked) {
      byPath.set(change.path, change);
    }
  }
  return byPath;
}

export class DiscardService {
  constructor(private gitCmd: GitCommandService, private commits: CommitService, private historyActions: HistoryActionService) {}

  /**
   * What discarding would do: every change, or only `filePaths` (each must still be changed). Throws
   * when tracked files cannot go back to HEAD: no commit yet, or a merge, rebase, cherry-pick or
   * revert in progress (discarding would leave it with a result it never produced).
   */
  async plan(repositoryPath: string, filePaths?: string[]): Promise<DiscardPlan> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const byPath = changesByPath(await this.commits.getWorkingTreeChanges(repositoryPath));
    let targets = Array.from(byPath.values());
    if (filePaths) {
      const wanted = unique(filePaths.map(filePath => this.gitCmd.resolveFilePath(filePath)));
      const gone = wanted.find(filePath => !byPath.has(filePath));
      if (gone) {
        throw new Error(`${gone} is no longer changed. Nothing was discarded.`);
      }
      targets = wanted.map(filePath => byPath.get(filePath) as WorkingTreeChange);
    }

    const hasHead = await this.gitCmd.execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repositoryRoot)
      .then(() => true, () => false);
    const linked = hasHead ? await this.gitlinkChanges(repositoryRoot) : new Set<string>();
    const plan: DiscardPlan = { repositoryPath, tracked: [], untracked: [], skipped: [] };
    for (const change of targets) {
      if (change.conflicted) {
        plan.skipped.push({ path: change.path, reason: 'in conflict: resolve it in Source Control' });
      } else if (linked.has(change.path) || (change.originalPath && linked.has(change.originalPath))) {
        // Git cannot put a submodule's own files back from here; its pointer alone would change.
        plan.skipped.push({ path: change.path, reason: 'linked repository: discard inside it' });
      } else if (change.untracked && change.path.endsWith('/')) {
        plan.skipped.push({ path: change.path, reason: 'nested Git repository: never deleted' });
      } else if (change.untracked) {
        plan.untracked.push(change.path);
      } else {
        plan.tracked.push(change);
      }
    }

    if (plan.tracked.length) {
      if (!hasHead) {
        throw new Error('This repository has no commit yet, so there is no version to go back to. Nothing was discarded.');
      }
      const pending = await this.historyActions.pendingOperation(repositoryPath);
      if (pending) {
        const operation = pending === 'am' ? 'patch application (git am)' : pending;
        throw new Error(`A ${operation} is in progress: finish or abort it (Source Control) before discarding changes. Nothing was discarded.`);
      }
    }
    return plan;
  }

  /**
   * Carries out a confirmed plan. The files are read again first: if they changed state since the
   * plan (staged, unstaged, added, gone), nothing is done. Tracked files are kept as a stash entry,
   * then go back to HEAD; new files go to `moveToTrash`, and folders left empty by that go too.
   */
  async discard(confirmed: DiscardPlan, moveToTrash: Remover): Promise<DiscardOutcome> {
    const outcome: DiscardOutcome = { success: false, message: '', discarded: [], removed: [], notRemoved: [] };
    let plan: DiscardPlan;
    try {
      plan = await this.plan(confirmed.repositoryPath, [...confirmed.tracked.map(change => change.path), ...confirmed.untracked]);
    } catch (error) {
      return { ...outcome, message: firstLine(error) };
    }
    if (signature(plan) !== signature(confirmed)) {
      return { ...outcome, message: 'The files changed while you were confirming. Nothing was discarded: look at them again and retry.' };
    }

    const repositoryRoot = this.gitCmd.resolveRepositoryPath(plan.repositoryPath);
    if (plan.tracked.length) {
      const paths = unique(plan.tracked.flatMap(change => change.originalPath ? [change.path, change.originalPath] : [change.path])
        .map(filePath => this.gitCmd.resolveFilePath(filePath)));
      try {
        await this.backUp(repositoryRoot, paths, plan.tracked);
      } catch (error) {
        return { ...outcome, message: `Could not keep a backup of the changes (${firstLine(error)}). Nothing was discarded.` };
      }
      outcome.stash = 'stash@{0}';
      try {
        // Index and working tree from HEAD; a path HEAD does not have (a new, staged file) goes from both.
        await this.gitCmd.execGitRaw(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths],
          repositoryRoot, 60000);
      } catch (error) {
        return { ...outcome, message: `Could not discard the changes (${firstLine(error)}). They are kept as ${outcome.stash} as well.` };
      }
      outcome.discarded = plan.tracked.map(change => change.path);
    }

    Object.assign(outcome, await this.removeFiles(repositoryRoot, plan.untracked, moveToTrash));
    outcome.success = outcome.notRemoved.length === 0;
    outcome.message = describe(outcome, 'moved', 'to the Trash');
    return outcome;
  }

  /**
   * Deletes new files that are still untracked, for the ones the Trash refused (a remote file
   * system may have no Trash). A file that is no longer new is left alone.
   */
  async deleteUntracked(repositoryPath: string, filePaths: string[], deletePermanently: Remover): Promise<DiscardOutcome> {
    const outcome: DiscardOutcome = { success: false, message: '', discarded: [], removed: [], notRemoved: [] };
    const changes = changesByPath(await this.commits.getWorkingTreeChanges(repositoryPath));
    const files = unique(filePaths.map(filePath => this.gitCmd.resolveFilePath(filePath)))
      .filter(filePath => changes.get(filePath)?.untracked && !filePath.endsWith('/'));
    Object.assign(outcome, await this.removeFiles(this.gitCmd.resolveRepositoryPath(repositoryPath), files, deletePermanently));
    outcome.success = outcome.notRemoved.length === 0;
    outcome.message = describe(outcome, 'deleted', 'permanently');
    return outcome;
  }

  /** Paths whose change involves a submodule (a gitlink, mode 160000) on either side. */
  private async gitlinkChanges(repositoryRoot: string): Promise<Set<string>> {
    const output = await this.gitCmd.execGitRaw(
      ['diff-index', '-z', '--no-renames', '--ignore-submodules=none', 'HEAD', '--'], repositoryRoot, 15000);
    const records = output.split('\0');
    const linked = new Set<string>();
    for (let index = 0; index + 1 < records.length; index += 2) {
      const [sourceMode, targetMode] = records[index].slice(1).split(' ');
      if (sourceMode === '160000' || targetMode === '160000') {
        linked.add(records[index + 1]);
      }
    }
    return linked;
  }

  /**
   * Stores the changes to `paths` as a stash entry, laid out as `git stash` lays one out (the
   * working tree commit, with HEAD and the index commit as parents), so `git stash apply` brings
   * them back. Built in a temporary index from HEAD, it holds these files only, not other changes.
   */
  private async backUp(repositoryRoot: string, paths: string[], tracked: WorkingTreeChange[]): Promise<void> {
    const indexPath = path.resolve(repositoryRoot, await this.gitCmd.execGit(['rev-parse', '--git-path', 'index'], repositoryRoot));
    const temporaryIndex = `${indexPath}.repository-manager-discard-${process.pid}-${Date.now()}`;
    const temporary: NodeJS.ProcessEnv = { ...process.env };
    temporary['GIT_INDEX_FILE'] = temporaryIndex;
    // Without a configured identity, use the one `git stash` itself falls back to.
    const identified = await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']
      .map(name => this.gitCmd.execGit(['var', name], repositoryRoot).then(() => true, () => false)));
    const commitEnv: NodeJS.ProcessEnv = { ...process.env };
    if (identified.includes(false)) {
      for (const role of ['AUTHOR', 'COMMITTER']) {
        commitEnv[`GIT_${role}_NAME`] = 'git stash';
        commitEnv[`GIT_${role}_EMAIL`] = 'git@stash';
      }
    }
    try {
      const run = (args: string[], env = temporary) => this.gitCmd.execGitRaw(args, repositoryRoot, 60000, false, env);
      const head = await this.gitCmd.execGit(['rev-parse', 'HEAD'], repositoryRoot);
      const headLine = await this.gitCmd.execGit(['log', '-1', '--format=%h %s', 'HEAD'], repositoryRoot);
      const branch = await this.gitCmd.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryRoot)
        .catch(() => '(no branch)');
      await run(['read-tree', head]);

      // The index commit: these files as staged (absent when staged as deleted, or renamed away).
      const staged = (await this.gitCmd.execGitRaw(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths], repositoryRoot))
        .split('\0').map(entry => /^(\d+) ([0-9a-f]+) 0\t(.*)$/s.exec(entry)).filter((match): match is RegExpExecArray => Boolean(match));
      const stagedPaths = new Set(staged.map(match => match[3]));
      if (staged.length) {
        await run(['update-index', '--add', ...staged.flatMap(match => ['--cacheinfo', `${match[1]},${match[2]},${match[3]}`])]);
      }
      const unstaged = paths.filter(filePath => !stagedPaths.has(filePath));
      if (unstaged.length) {
        await run(['update-index', '--force-remove', '--', ...unstaged]);
      }
      const indexTree = (await run(['write-tree'])).trim();
      const indexCommit = (await run(['commit-tree', indexTree, '-p', head, '-m', `index on ${branch}: ${headLine}`], commitEnv)).trim();

      // The working tree commit: these files as they are on disk (absent when deleted).
      const onDisk = paths.filter(filePath => {
        try { lstatSync(path.join(repositoryRoot, filePath)); return true; } catch { return false; }
      });
      const missing = paths.filter(filePath => !onDisk.includes(filePath));
      if (onDisk.length) {
        await run(['update-index', '--add', '--', ...onDisk]);
      }
      if (missing.length) {
        await run(['update-index', '--force-remove', '--', ...missing]);
      }
      const workTree = (await run(['write-tree'])).trim();
      const names = tracked.map(change => change.path);
      const message = `On ${branch}: Repository Manager: discarded ${names.length === 1 ? names[0] : plural(names.length, 'file')}`;
      const stash = (await run(['commit-tree', workTree, '-p', head, '-p', indexCommit, '-m', message], commitEnv)).trim();
      await this.gitCmd.execGit(['stash', 'store', '-m', message, stash], repositoryRoot);
    } finally {
      rmSync(temporaryIndex, { force: true });
    }
  }

  private async removeFiles(repositoryRoot: string, files: string[], remove: Remover):
    Promise<Pick<DiscardOutcome, 'removed' | 'notRemoved'>> {
    const removed: string[] = [];
    const notRemoved: DiscardOutcome['notRemoved'] = [];
    for (const file of files) {
      const absolute = path.join(repositoryRoot, this.gitCmd.resolveFilePath(file));
      try {
        await remove(absolute);
        removed.push(file);
      } catch (error) {
        notRemoved.push({ path: file, reason: firstLine(error) });
        continue;
      }
      // Folders the file leaves empty go too, as `git clean -d` would; one with anything left stays.
      for (let folder = path.dirname(absolute); path.relative(repositoryRoot, folder) && !path.relative(repositoryRoot, folder).startsWith('..');
        folder = path.dirname(folder)) {
        try { rmdirSync(folder); } catch { break; }
      }
    }
    return { removed, notRemoved };
  }
}

function describe(outcome: DiscardOutcome, removedVerb: string, removedWhere: string): string {
  const done = [
    outcome.discarded.length ? `Discarded changes to ${plural(outcome.discarded.length, 'file')}` : '',
    outcome.removed.length ? `${removedVerb} ${plural(outcome.removed.length, 'new file')} ${removedWhere}` : ''
  ].filter(Boolean).join(' and ');
  const backup = outcome.stash ? ` Backup: ${outcome.stash} (Git: Apply Stash brings it back).` : '';
  const failed = outcome.notRemoved.length
    ? ` Could not remove ${outcome.notRemoved.map(item => item.path).slice(0, 3).join(', ')}${outcome.notRemoved.length > 3 ? ` and ${outcome.notRemoved.length - 3} more` : ''}: ${outcome.notRemoved[0].reason}`
    : '';
  const start = done ? `${done.charAt(0).toUpperCase()}${done.slice(1)}.` : 'Nothing was discarded.';
  return `${start}${backup}${failed}`;
}
