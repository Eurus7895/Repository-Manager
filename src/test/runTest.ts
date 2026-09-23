import * as assert from 'assert/strict';
import * as path from 'path';
import { BranchService } from '../services/branchService';
import { CommitService, parseWorkingTreeStatus } from '../services/commitService';
import { DiffService, parseChangedFilesOutput } from '../services/diffService';
import { GitCommandService } from '../services/gitCommandService';
import { HistoryService, parseDecorations, parseHistoryOutput } from '../services/historyService';
import { parseStashesOutput, parseTagsOutput, ReferenceService } from '../services/referenceService';
import { renderDashboardToolbar } from '../webview/toolbar';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const historyGraph = require('../../resources/historyGraph.js') as {
  buildGraphModel: (commits: Array<{ hash: string; parentHashes: string[] }>) => {
    rows: Array<{ lane: number; parentLanes: number[]; isMerge: boolean }>;
    laneCount: number;
    width: number;
  };
  laneX: (lane: number) => number;
  toggleCompareSelection: (selection: string[], commitHash: string) => string[];
  transitionCompareSelection: (
    selection: string[], commitHash: string, comparisonActive: boolean
  ) => { selection: string[]; action: 'compare' | 'parent' | 'none' };
  normalizeHistoryFilters: (saved: unknown) => { branch: string; includeRemotes: boolean; search: string };
};

function testParsers(): void {
  const history = parseHistoryOutput(
    'abcdef\x1fabc1234\x1fparent1 parent2\x1fJane Doe\x1fjane@example.com\x1f2026-09-21T10:00:00Z\x1fSubject with | delimiter\x1fHEAD -> refs/heads/main, tag: refs/tags/v1.1.0\x1e'
  );
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].parentHashes, ['parent1', 'parent2']);
  assert.equal(history[0].subject, 'Subject with | delimiter');
  assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.1.0'), [
    { name: 'main', kind: 'head', isCurrent: true },
    { name: 'origin/main', kind: 'remote-branch' },
    { name: 'v1.1.0', kind: 'tag' }
  ]);

  assert.deepEqual(parseChangedFilesOutput('M\0README.md\0R100\0old.ts\0new.ts\0D\0removed.ts\0'), [
    { path: 'README.md', status: 'modified' },
    { oldPath: 'old.ts', path: 'new.ts', status: 'renamed' },
    { path: 'removed.ts', status: 'deleted' }
  ]);

  assert.deepEqual(parseTagsOutput('v1.1.0\x00deadbeef\x002026-09-21T10:00:00Z\x1e\n'), [
    { name: 'v1.1.0', targetHash: 'deadbeef', createdAt: '2026-09-21T10:00:00Z' }
  ]);
  assert.deepEqual(parseStashesOutput('stash@{0}\x1fWIP on main\x1f2026-09-21T10:00:00Z\x1e'), [
    { index: 0, ref: 'stash@{0}', subject: 'WIP on main', createdAt: '2026-09-21T10:00:00Z' }
  ]);

  assert.deepEqual(parseWorkingTreeStatus(
    ' M src/modified.ts\0M  src/staged.ts\0MM src/both.ts\0?? src/new.ts\0R  src/new-name.ts\0src/old-name.ts\0UU src/conflict.ts\0'
  ), [
    {
      path: 'src/modified.ts', indexStatus: ' ', workTreeStatus: 'M',
      staged: false, unstaged: true, untracked: false, conflicted: false
    },
    {
      path: 'src/staged.ts', indexStatus: 'M', workTreeStatus: ' ',
      staged: true, unstaged: false, untracked: false, conflicted: false
    },
    {
      path: 'src/both.ts', indexStatus: 'M', workTreeStatus: 'M',
      staged: true, unstaged: true, untracked: false, conflicted: false
    },
    {
      path: 'src/new.ts', indexStatus: '?', workTreeStatus: '?',
      staged: false, unstaged: false, untracked: true, conflicted: false
    },
    {
      path: 'src/new-name.ts', originalPath: 'src/old-name.ts', indexStatus: 'R', workTreeStatus: ' ',
      staged: true, unstaged: false, untracked: false, conflicted: false
    },
    {
      path: 'src/conflict.ts', indexStatus: 'U', workTreeStatus: 'U',
      staged: true, unstaged: true, untracked: false, conflicted: true
    }
  ]);
}

function testPathBoundary(): void {
  const workspaceRoot = path.resolve('/workspace/project');
  const git = new GitCommandService(workspaceRoot);
  assert.equal(git.resolveRepositoryPath('.'), workspaceRoot);
  assert.equal(git.resolveRepositoryPath('packages/app'), path.join(workspaceRoot, 'packages', 'app'));
  assert.throws(() => git.resolveRepositoryPath('../outside'));
  assert.throws(() => git.resolveRepositoryPath('/tmp/outside'));
  assert.equal(git.resolveFilePath('src/index.ts'), 'src/index.ts');
  assert.throws(() => git.resolveFilePath('../secret'));
}

function testHistoryGraph(): void {
  const linear = historyGraph.buildGraphModel([
    { hash: 'c', parentHashes: ['b'] },
    { hash: 'b', parentHashes: ['a'] },
    { hash: 'a', parentHashes: [] }
  ]);
  assert.equal(linear.laneCount, 1);
  assert.deepEqual(linear.rows.map(row => row.lane), [0, 0, 0]);
  assert.equal(linear.width, 76);

  const merge = historyGraph.buildGraphModel([
    { hash: 'merge', parentHashes: ['left', 'right'] },
    { hash: 'left', parentHashes: ['root'] },
    { hash: 'right', parentHashes: ['root'] },
    { hash: 'root', parentHashes: [] }
  ]);
  assert.equal(merge.laneCount, 2);
  assert.equal(merge.rows[0].isMerge, true);
  assert.deepEqual(merge.rows[0].parentLanes, [0, 1]);
  assert.equal(merge.rows[2].lane, 1);

  const octopusParents = Array.from({ length: 8 }, (_, index) => `parent-${index}`);
  const octopus = historyGraph.buildGraphModel([
    { hash: 'octopus', parentHashes: octopusParents },
    ...octopusParents.map(hash => ({ hash, parentHashes: [] }))
  ]);
  assert.equal(octopus.laneCount, 8);
  assert.ok(octopus.width > 76);
  assert.equal(new Set(octopusParents.map((_, index) => historyGraph.laneX(index))).size, 8);

  let selection: string[] = [];
  selection = historyGraph.toggleCompareSelection(selection, 'a');
  selection = historyGraph.toggleCompareSelection(selection, 'b');
  assert.deepEqual(selection, ['a', 'b']);
  selection = historyGraph.toggleCompareSelection(selection, 'c');
  assert.deepEqual(selection, ['b', 'c']);
  selection = historyGraph.toggleCompareSelection(selection, 'b');
  assert.deepEqual(selection, ['c']);

  assert.deepEqual(historyGraph.transitionCompareSelection(['a', 'b'], 'b', true), {
    selection: ['a'], action: 'parent'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection(['a'], 'b', false), {
    selection: ['a', 'b'], action: 'compare'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection([], 'a', false), {
    selection: ['a'], action: 'none'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection(['a', 'b'], 'c', true), {
    selection: ['c'], action: 'parent'
  });
  assert.deepEqual(historyGraph.normalizeHistoryFilters(undefined), {
    branch: '', includeRemotes: true, search: ''
  });
  assert.deepEqual(historyGraph.normalizeHistoryFilters({
    branch: 'origin/main', includeRemotes: false, search: 'merge'
  }), {
    branch: 'origin/main', includeRemotes: false, search: 'merge'
  });
}

function testDashboardToolbarHierarchy(): void {
  const toolbar = renderDashboardToolbar({ ahead: 2, behind: 3 });

  assert.match(toolbar, /class="dashboard-remote-actions"[^>]*role="group"/);
  assert.match(toolbar, /class="dashboard-command dashboard-command-secondary"[^>]*data-action="openCreateBranchModal"/);
  assert.match(toolbar, /class="dashboard-command dashboard-command-commit"[^>]*data-action="openCommitChangesModal"/);
  assert.match(toolbar, /dashboard-command-commit[^>]*>[\s\S]*?<svg[\s\S]*?Commit/);
  assert.ok(toolbar.indexOf('data-action="openCreateBranchModal"') < toolbar.indexOf('data-action="openCommitChangesModal"'));
  assert.match(toolbar, /id="dashboardAheadCount"[^>]*>2<\/small>/);
  assert.match(toolbar, /id="dashboardBehindCount"[^>]*>3<\/small>/);
}

async function testRepositoryIntegration(): Promise<void> {
  const git = new GitCommandService(process.cwd());
  assert.equal(await git.isGitRepository(), true);

  const branchService = new BranchService(git);
  const commitService = new CommitService(git);
  const historyService = new HistoryService(git);
  const diffService = new DiffService(git);
  const referenceService = new ReferenceService(git, branchService, commitService);

  const page = await historyService.getHistory({ repositoryPath: '.', limit: 2 });
  assert.equal(page.offset, 0);
  assert.ok(page.commits.length > 0);
  assert.ok(page.commits.length <= 2);

  const detail = await diffService.getCommitDetail('.', page.commits[0].hash);
  assert.equal(detail.hash, page.commits[0].hash);
  assert.ok(Array.isArray(detail.files));
  assert.equal(detail.comparisonBaseHash, page.commits[0].parentHashes[0] || null);
  assert.equal(detail.comparisonMode, page.commits[0].parentHashes.length > 0 ? 'parent' : 'root');

  if (page.commits.length > 1) {
    const rangeDetail = await diffService.getCommitDetail('.', page.commits[0].hash, page.commits[1].hash);
    assert.equal(rangeDetail.comparisonBaseHash, page.commits[1].hash);
    assert.equal(rangeDetail.comparisonMode, 'range');
    if (rangeDetail.files.length > 0) {
      const fileDiff = await diffService.getFileDiff(
        '.', page.commits[0].hash, rangeDetail.files[0].path, page.commits[1].hash
      );
      assert.equal(fileDiff.baseCommitHash, page.commits[1].hash);
      assert.equal(fileDiff.commitHash, page.commits[0].hash);
    }
  }

  const mergeHashes = (await git.execGit(['rev-list', '--merges', '--max-count=10', 'HEAD']))
    .split('\n')
    .filter(Boolean);
  if (mergeHashes.length > 0) {
    const mergeDetails = await Promise.all(mergeHashes.map(hash => diffService.getCommitDetail('.', hash)));
    assert.ok(mergeDetails.some(mergeDetail => mergeDetail.files.length > 0));
    for (const mergeDetail of mergeDetails) {
      assert.equal(mergeDetail.comparisonBaseHash, mergeDetail.parentHashes[0] || null);
    }
  }

  const refs = await referenceService.getRepositoryRefs('.');
  assert.equal(refs.repositoryPath, '.');
  assert.ok(refs.branches.length > 0);
}

async function main(): Promise<void> {
  testParsers();
  testPathBoundary();
  testHistoryGraph();
  testDashboardToolbarHierarchy();
  await testRepositoryIntegration();
  console.log('Repository Manager backend tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
