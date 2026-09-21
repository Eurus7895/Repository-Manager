/**
 * Aggregates repository refs for the dashboard sidebar.
 */

import { RepositoryRefs, StashInfo, TagInfo } from '../types';
import { BranchService } from './branchService';
import { CommitService } from './commitService';
import { GitCommandService } from './gitCommandService';

export function parseTagsOutput(output: string): TagInfo[] {
  return output
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [name, targetHash, createdAt] = record.split('\0');
      return { name, targetHash, createdAt: createdAt || undefined };
    });
}

export function parseStashesOutput(output: string): StashInfo[] {
  return output
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [ref, subject, createdAt] = record.split('\x1f');
      const match = ref.match(/^stash@\{(\d+)\}$/);
      return {
        index: match ? Number(match[1]) : -1,
        ref,
        subject,
        createdAt
      };
    });
}

export class ReferenceService {
  constructor(
    private gitCmd: GitCommandService,
    private branchService: BranchService,
    private commitService: CommitService
  ) {}

  async getRepositoryRefs(repositoryPath: string): Promise<RepositoryRefs> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const [branches, remotes, tagsOutput, stashesOutput] = await Promise.all([
      this.branchService.getBranches(repositoryPath),
      this.commitService.getRemotes(repositoryPath),
      this.gitCmd.execGitRaw([
        'for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)%1e', 'refs/tags'
      ], repositoryRoot, 10000),
      this.gitCmd.execGitRaw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cI%x1e'], repositoryRoot, 10000)
    ]);

    return {
      repositoryPath,
      branches,
      tags: parseTagsOutput(tagsOutput),
      remotes,
      stashes: parseStashesOutput(stashesOutput)
    };
  }
}
