/**
 * A commit object holding the working tree as it is now, so local changes can be reviewed like any
 * other diff (HEAD → snapshot) by an engine that reads revisions.
 *
 * The snapshot is built in a temporary index copied from the real one, then `git add -A` (staged and
 * unstaged changes, and new files that .gitignore does not exclude), and written with `commit-tree`.
 * HEAD, branches, the real index and the working tree are not touched; no ref points to the commit,
 * so Git removes it in a later garbage collection, like any unreachable object.
 *
 * The commit's author, committer and dates are fixed (HEAD's date), so the same changes on the same
 * HEAD give the same commit: running the review again reuses its saved components and decisions.
 */

import * as path from 'path';
import { copyFileSync, existsSync, rmSync } from 'fs';
import { GitCommandService } from './gitCommandService';

export interface LocalChangesSnapshot {
  headSha: string;
  snapshotSha: string;
}

export const SNAPSHOT_MESSAGE = 'Local changes (Repository Manager review snapshot)';

/** The snapshot of `root`'s working tree; undefined when there is nothing beyond HEAD. Throws without a first commit. */
export async function snapshotLocalChanges(git: GitCommandService, root: string): Promise<LocalChangesSnapshot | undefined> {
  const headSha = await git.execGit(['rev-parse', '--verify', 'HEAD^{commit}'], root, 10000)
    .catch(() => { throw new Error('This repository has no commit yet: commit once, then review the changes after it.'); });
  const indexPath = path.resolve(root, await git.execGit(['rev-parse', '--git-path', 'index'], root));
  const temporaryIndex = `${indexPath}.repository-manager-review-${process.pid}-${Date.now()}`;
  try {
    // From the real index, so what is staged (including intent-to-add entries) is the starting point.
    if (existsSync(indexPath)) { copyFileSync(indexPath, temporaryIndex); }
    const env: NodeJS.ProcessEnv = { ...process.env };
    env['GIT_INDEX_FILE'] = temporaryIndex;
    if (!existsSync(indexPath)) { await git.execGitRaw(['read-tree', 'HEAD'], root, 30000, false, env); }
    await git.execGitRaw(['add', '-A'], root, 60000, false, env);
    const tree = (await git.execGitRaw(['write-tree'], root, 30000, false, env)).trim();
    if (tree === await git.execGit(['rev-parse', 'HEAD^{tree}'], root, 10000)) { return undefined; }
    // A fixed identity and date: the snapshot never leaves this repository, and needs no user identity.
    const date = await git.execGit(['log', '-1', '--format=%cI', 'HEAD'], root, 10000);
    for (const role of ['AUTHOR', 'COMMITTER']) {
      env[`GIT_${role}_NAME`] = 'Repository Manager';
      env[`GIT_${role}_EMAIL`] = 'review-snapshot@localhost';
      env[`GIT_${role}_DATE`] = date;
    }
    const snapshotSha = (await git.execGitRaw(['commit-tree', tree, '-p', headSha, '-m', SNAPSHOT_MESSAGE], root, 30000, false, env)).trim();
    return { headSha, snapshotSha };
  } finally {
    rmSync(temporaryIndex, { force: true });
  }
}
