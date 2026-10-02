import { GitCommandService } from './gitCommandService';

export const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The current branch (or HEAD when detached) and the highest release tag reachable from it.
 * Versions are compared as numbers here: Git's `v:refname` sort orders `v1.9.0` above `1.10.0`
 * because it compares the `v` prefix as text.
 */
export async function resolveReleaseRange(git: GitCommandService, root: string): Promise<{ currentBranch: string; latestReleaseTag?: string }> {
  // A detached HEAD makes symbolic-ref fail, which is expected; any other Git failure (listing
  // tags) propagates, so it is not reported as "no release tag".
  const currentBranch = (await git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, 10000).catch(() => '')).trim() || 'HEAD';
  const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let latest: { tag: string; version: number[] } | undefined;
  for (const tag of (await git.execGit(['tag', '--merged', 'HEAD'], root, 10000)).split('\n').map(line => line.trim())) {
    const match = RELEASE_TAG.exec(tag);
    const version = match ? match.slice(1).map(Number) : undefined;
    if (version && (!latest || compare(version, latest.version) > 0)) { latest = { tag, version }; }
  }
  return { currentBranch, latestReleaseTag: latest?.tag };
}
