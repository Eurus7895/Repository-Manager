import { GitCommandService } from './gitCommandService';

export const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The current branch (or HEAD when detached) and the highest release tag reachable from it.
 * Versions are compared as numbers here: Git's `v:refname` sort orders `v1.9.0` above `1.10.0`
 * because it compares the `v` prefix as text.
 */
export async function resolveReleaseRange(git: GitCommandService, root: string): Promise<{ currentBranch: string; latestReleaseTag?: string }> {
  const run = (args: string[]) => git.execGit(args, root, 10000).catch(() => '');
  const currentBranch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || 'HEAD';
  const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let latest: { tag: string; version: number[] } | undefined;
  for (const tag of (await run(['tag', '--merged', 'HEAD'])).split('\n').map(line => line.trim())) {
    const match = RELEASE_TAG.exec(tag);
    const version = match ? match.slice(1).map(Number) : undefined;
    if (version && (!latest || compare(version, latest.version) > 0)) { latest = { tag, version }; }
  }
  return { currentBranch, latestReleaseTag: latest?.tag };
}
