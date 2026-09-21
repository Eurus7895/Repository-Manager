import * as assert from 'assert/strict';
import { BranchService } from '../services/branchService';
import { CommitService } from '../services/commitService';
import { DiffService, parseChangedFilesOutput } from '../services/diffService';
import { GitCommandService } from '../services/gitCommandService';
import { HistoryService, parseDecorations, parseHistoryOutput } from '../services/historyService';
import { parseStashesOutput, parseTagsOutput, ReferenceService } from '../services/referenceService';

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
}

function testPathBoundary(): void {
  const git = new GitCommandService('/workspace/project');
  assert.equal(git.resolveRepositoryPath('.'), '/workspace/project');
  assert.equal(git.resolveRepositoryPath('packages/app'), '/workspace/project/packages/app');
  assert.throws(() => git.resolveRepositoryPath('../outside'));
  assert.throws(() => git.resolveRepositoryPath('/tmp/outside'));
  assert.equal(git.resolveFilePath('src/index.ts'), 'src/index.ts');
  assert.throws(() => git.resolveFilePath('../secret'));
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
  await testRepositoryIntegration();
  console.log('Repository Manager backend tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
