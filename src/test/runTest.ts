import * as assert from 'assert/strict';
import * as path from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { BranchService } from '../services/branchService';
import { CommitService, parseWorkingTreeStatus } from '../services/commitService';
import { DiffService, parseChangedFilesOutput } from '../services/diffService';
import { GitCommandService } from '../services/gitCommandService';
import { ChangeContextService, EMPTY_TREE } from '../services/changeContextService';
import { validateSummary } from '../services/changeSummaryValidation';
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

async function testWorkingTreePreview(): Promise<void> {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'repository-manager-preview-'));
  const git = new GitCommandService(repositoryRoot);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Preview Test']);
    await git.execGit(['config', 'user.email', 'preview@example.com']);
    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'original\n');
    await git.execGit(['add', '--', 'example file.txt']);
    await git.execGit(['commit', '-m', 'initial']);

    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'staged change\n');
    await git.execGit(['add', '--', 'example file.txt']);
    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'unstaged change\n');
    writeFileSync(path.join(repositoryRoot, 'new file.txt'), 'untracked content\n');

    const service = new CommitService(git);
    const staged = await service.getWorkingTreePreview('.', 'example file.txt', 'staged', 1);
    assert.equal(staged.mode, 'staged');
    assert.equal(staged.requestId, 1);
    assert.match(staged.patch, /\+staged change/);
    assert.doesNotMatch(staged.patch, /unstaged change/);

    const unstaged = await service.getWorkingTreePreview('.', 'example file.txt', 'unstaged', 2);
    assert.match(unstaged.patch, /\+unstaged change/);
    assert.match(unstaged.patch, /-staged change/);

    const untracked = await service.getWorkingTreePreview('.', 'new file.txt', 'unstaged', 3);
    assert.match(untracked.patch, /\+untracked content/);

    const nestedRoot = path.join(repositoryRoot, 'nested');
    mkdirSync(nestedRoot);
    const nestedGit = new GitCommandService(nestedRoot);
    await nestedGit.execGit(['init', '-q']);
    await nestedGit.execGit(['config', 'user.name', 'Nested Preview Test']);
    await nestedGit.execGit(['config', 'user.email', 'nested@example.com']);
    writeFileSync(path.join(nestedRoot, 'inner.txt'), 'committed content\n');
    await nestedGit.execGit(['add', '--', 'inner.txt']);
    await nestedGit.execGit(['commit', '-m', 'nested initial']);
    const nestedHead = await nestedGit.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(nestedRoot, 'inner.txt'), 'uncommitted nested change\n');

    const nestedStatus = await service.getWorkingTreeChanges('.');
    assert.ok(nestedStatus.some(change => change.path === 'nested/' && change.untracked));
    const nested = await service.getWorkingTreePreview('.', 'nested/', 'unstaged', 6);
    assert.match(nested.patch, new RegExp('Subproject commit ' + nestedHead));
    assert.match(nested.patch, /Only the HEAD commit is included/);
    assert.doesNotMatch(nested.patch, /uncommitted nested change/);
    assert.notEqual(nested.patch, '');
    await assert.rejects(service.getWorkingTreePreview('.', 'nested/', 'staged', 7));
    await assert.rejects(service.getWorkingTreePreview('.', 'new file.txt', 'staged', 4));
    await assert.rejects(service.getWorkingTreePreview('.', '../outside', 'unstaged', 5));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

async function testChangeSummaryContext(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-summary-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Summary Test']);
    await git.execGit(['config', 'user.email', 'summary@example.com']);
    writeFileSync(path.join(root, 'old.txt'), 'first\nsecond\nthird\nfourth\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-m', 'root']);
    const first = await git.execGit(['rev-parse', 'HEAD']);
    const service = new ChangeContextService(git);
    const initial = await service.collect('.', first);
    assert.equal(initial.baseSha, EMPTY_TREE);
    assert.equal(initial.root, true);
    assert.deepEqual(initial.files.map(file => file.path), ['old.txt']);
    assert.match(initial.patches[0].patch, /\+first/);

    await git.execGit(['mv', 'old.txt', 'new.txt']);
    writeFileSync(path.join(root, 'new.txt'), 'first\nsecond\nthird\nfourth\nfifth\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-m', 'rename and edit']);
    const second = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'new.txt'), 'uncommitted secret\n');
    const packet = await service.collect('.', second, first);
    assert.equal(packet.baseSha, first);
    assert.equal(packet.targetSha, second);
    assert.deepEqual(packet.files, [{ oldPath: 'old.txt', path: 'new.txt', status: 'renamed' }]);
    assert.doesNotMatch(JSON.stringify(packet), /uncommitted secret/);
    const reply = {
      schemaVersion: 1, baseSha: first, targetSha: second,
      intent: { text: 'Rename', evidence: ['new.txt'] },
      behaviorChanges: [], affectedAreas: [], dependencyConfigChanges: [],
      possibleBreakingChanges: [], riskHints: [], suggestedTests: [], limitations: []
    };
    assert.equal(validateSummary(JSON.stringify(reply), packet).intent.text, 'Rename');
    assert.throws(() => validateSummary(JSON.stringify({ ...reply, targetSha: first }), packet));
    const partial = validateSummary(JSON.stringify({ ...reply,
      intent: { text: 'Wrong', evidence: ['outside.txt'] },
      behaviorChanges: [{ text: 'New path', evidence: ['b/new.txt:3'] },
        { text: 'Unsupported', evidence: ['missing.txt'] }]
    }), packet);
    assert.match(partial.intent.text, /AI intent could not be verified/);
    assert.deepEqual(partial.behaviorChanges, [{ text: 'New path', evidence: ['new.txt'] }]);
    assert.equal(partial.limitations.length, 1);
    const shortCommit = validateSummary(JSON.stringify({ ...reply,
      intent: { text: 'Rename', evidence: [second.slice(0, 10)] }
    }), packet);
    assert.deepEqual(shortCommit.intent.evidence, [second]);
    writeFileSync(path.join(root, 'large.txt'), Array.from({ length: 1000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n'));
    await git.execGit(['add', 'large.txt']);
    await git.execGit(['commit', '-m', 'large file']);
    const large = await service.collect('.', 'HEAD', second);
    assert.ok(large.coverage.omitted.some(item => item.startsWith('large.txt: patch exceeds budget')));
    assert.ok(!large.patches.some(item => item.path === 'large.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testParsers();
  testPathBoundary();
  testHistoryGraph();
  testDashboardToolbarHierarchy();
  await testWorkingTreePreview();
  await testChangeSummaryContext();
  await testRepositoryIntegration();
  console.log('Repository Manager backend tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
