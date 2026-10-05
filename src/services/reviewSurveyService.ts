import { ReviewCoverage, ReviewRequest } from '../types';
import { parseChangedFilesOutput } from './diffService';
import { GitCommandService } from './gitCommandService';
import { LoadedReviewPolicy, ReviewPolicyRule, ReviewPolicyService } from './reviewPolicyService';
import { ReviewSnapshot, ReviewSnapshotService } from './reviewSnapshotService';

const MAX_REVIEW_FILES = 256;
const FILES_PER_BATCH = 8;

export interface ReviewWorkUnit {
  component: string;
  paths: string[];
  rules: ReviewPolicyRule[];
}
export interface ReviewPlan {
  request: ReviewRequest;
  snapshot: ReviewSnapshot;
  base?: ReviewSnapshot;
  policy: LoadedReviewPolicy;
  changedPaths: string[];
  oldPaths: Record<string, string>;
  units: ReviewWorkUnit[];
  coverage: ReviewCoverage;
}

/** Only repository-relative glob patterns, with *, ** and ?. No filesystem access. */
export function matchesReviewPattern(pattern: string, filePath: string): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      expression += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${expression}$`).test(filePath);
}

export function appliesToPath(rule: ReviewPolicyRule, filePath: string): boolean {
  return rule.scope.include.some(pattern => matchesReviewPattern(pattern, filePath)) &&
    !(rule.scope.exclude || []).some(pattern => matchesReviewPattern(pattern, filePath));
}

function component(path: string): string {
  const parts = path.split('/');
  return parts.length < 3 ? parts[0] : parts.slice(0, 2).join('/');
}

export class ReviewSurveyService {
  private snapshots: ReviewSnapshotService;
  private policies = new ReviewPolicyService();
  constructor(private git: GitCommandService) {
    this.snapshots = new ReviewSnapshotService(git);
  }

  async plan(request: ReviewRequest): Promise<ReviewPlan> {
    if (!['branch', 'changes'].includes(request.scope) || !request.categories.length ||
        request.categories.some(category => !['security', 'compliance', 'quality'].includes(category))) {
      throw new Error('Invalid review scope or categories');
    }
    const snapshot = await this.snapshots.open(request.repositoryPath, request.targetSha);
    const policy = request.categories.includes('compliance')
      ? await this.policies.load(snapshot)
      : { status: 'not_configured' as const, revision: snapshot.targetSha };
    if (request.policyHash && (policy.status !== 'configured' || request.policyHash !== policy.hash)) {
      throw new Error('Selected policy does not match the target revision');
    }
    const root = snapshot.repositoryPath;
    let base: ReviewSnapshot | undefined;
    let changedPaths: string[] = [];
    const oldPaths: Record<string, string> = {};
    if (request.scope === 'changes') {
      const parents = await this.git.execGit(['rev-list', '--parents', '-n', '1', snapshot.targetSha], root, 5000);
      const baseRef = request.baseSha || parents.split(/\s+/)[1];
      if (baseRef) { base = await this.snapshots.open(request.repositoryPath, baseRef); }
      const output = base
        ? await this.git.execGitRaw(['diff', '--name-status', '-z', '--find-renames', base.targetSha, snapshot.targetSha, '--'], root, 20000)
        : await this.git.execGitRaw(['diff-tree', '--root', '-r', '--name-status', '-z', '--no-commit-id', snapshot.targetSha, '--'], root, 20000);
      const changedFiles = parseChangedFilesOutput(output);
      changedPaths = [...new Set(changedFiles.map(file => file.path))];
      for (const file of changedFiles) {
        if (file.oldPath) { oldPaths[file.path] = file.oldPath; }
      }
    }
    const selected = request.scope === 'changes' ? changedPaths : snapshot.tree.entries.map(entry => entry.path);
    const sorted = selected.sort((a, b) => {
      const priority = (path: string) => /^(\.github\/|\.repository-manager\/|package|pyproject|requirements|Cargo|Dockerfile)/i.test(path) ? 0 : 1;
      return priority(a) - priority(b) || a.localeCompare(b);
    });
    const skipped: ReviewCoverage['skipped'] = [];
    const groups = new Map<string, string[]>();
    // Constant-time lookups and a running count keep planning linear on large trees.
    let grouped = 0;
    for (const path of sorted) {
      const entry = snapshot.entry(path) || base?.entry(path);
      if (!entry || entry.type !== 'blob' || entry.mode === '120000') {
        skipped.push({ path, reason: 'gitlink, symlink or missing source blob' });
        continue;
      }
      if (grouped >= MAX_REVIEW_FILES) {
        skipped.push({ path, reason: 'review file budget' });
        continue;
      }
      const name = component(path);
      const paths = groups.get(name) || [];
      paths.push(path);
      groups.set(name, paths);
      grouped++;
    }
    const units: ReviewWorkUnit[] = [];
    for (const [name, paths] of groups) {
      for (let offset = 0; offset < paths.length; offset += FILES_PER_BATCH) {
        const slice = paths.slice(offset, offset + FILES_PER_BATCH);
        units.push({ component: name, paths: slice,
          rules: policy.status === 'configured'
            ? policy.policy.rules.filter(rule => slice.some(path => appliesToPath(rule, path))) : [] });
      }
    }
    const normalized: ReviewRequest = { ...request, targetSha: snapshot.targetSha,
      baseSha: base?.targetSha, policyHash: policy.status === 'configured' ? policy.hash : undefined };
    const total = request.scope === 'changes' ? selected.length : snapshot.tree.totalEntries;
    const coverage: ReviewCoverage = { surveyed: total, analyzed: 0, skipped, failed: [],
      complete: !snapshot.tree.truncated && !base?.tree.truncated && !skipped.length };
    return { request: normalized, snapshot, base, policy, changedPaths, oldPaths, units, coverage };
  }
}
