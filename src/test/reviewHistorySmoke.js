const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewHistoryStore, MAX_PER_REPOSITORY, MAX_STORED_GAPS, summarize, shortBranch } = require('../../out/reviewHistory.js');
const { resolveReleaseRange } = require('../../out/services/releaseRange.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');

const state = new Map();
const memento = { get: key => state.get(key), update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); } };
let clock = Date.parse('2026-10-01T00:00:00Z');
const store = new ReviewHistoryStore(memento, () => clock);

const finding = id => ({ id, category: 'security', severity: 'high', confidence: 'high', status: 'verified', explanation: 'x',
  impact: 'y', suggestedAction: 'z', evidence: [{ revision: 'a'.repeat(40), path: 'app.js', side: 'target', startLine: 1, endLine: 1 }] });
const result = (overrides = {}) => ({ request: { repositoryPath: '.', targetSha: 'b'.repeat(40), scope: 'branch', categories: ['security'] },
  findings: [finding('f1')], policyResults: [], policyStatus: 'configured', limitations: [],
  coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true }, ...overrides });
const add = (root, label, extra = {}) => {
  clock += 1000;
  return store.add({ repositoryRoot: root, workspaceRoot: root, repositoryPath: '.', triage: {}, result: result(),
    context: { kind: 'review', repositoryName: path.basename(root), targetLabel: label, generatedAt: new Date(clock).toISOString() }, ...extra });
};

async function main() {
  // Each repository keeps its newest reviews only; another repository's reviews are untouched.
  await add('/work/other', 'other-1');
  for (let i = 1; i <= MAX_PER_REPOSITORY + 3; i++) await add('/work/app', `r${i}`);
  const app = store.list('/work/app');
  assert.equal(app.length, MAX_PER_REPOSITORY);
  assert.equal(app[0].context.targetLabel, `r${MAX_PER_REPOSITORY + 3}`, 'newest first');
  assert.equal(app.at(-1).context.targetLabel, 'r4', 'the oldest were dropped');
  assert.deepEqual(store.list('/work/other').map(entry => entry.context.targetLabel), ['other-1']);
  assert.equal(new Set(app.map(entry => entry.id)).size, app.length, 'ids are unique');

  // Triage is normalized (unknown findings dropped) and summarized for the list.
  await store.setTriage(app[0].id, { f1: { decision: 'dismiss', reason: 'false_positive' }, nope: { decision: 'fix' } });
  const triaged = store.get(app[0].id);
  assert.deepEqual(triaged.triage, { f1: { decision: 'dismiss', reason: 'false_positive' } });
  assert.deepEqual([summarize(triaged).status, summarize(triaged).dismissed, summarize(triaged).blocking], ['no_blocking_findings', 1, 0]);
  assert.equal(summarize(store.get(app[1].id)).status, 'blocked');
  // Outdated: the reviewed commit is not HEAD. An unknown HEAD never marks a review outdated.
  assert.equal(summarize(triaged, 'b'.repeat(40)).outdated, false);
  assert.equal(summarize(triaged, 'c'.repeat(40)).outdated, true);
  assert.equal(summarize(triaged).outdated, false);
  assert.deepEqual([shortBranch('refs/heads/feature/x'), shortBranch('refs/remotes/origin/main')], ['feature/x', 'origin/main']);

  // A huge coverage list is cut before saving, and the cut is noted.
  const skipped = Array.from({ length: MAX_STORED_GAPS + 50 }, (_, i) => ({ path: `f${i}.bin`, reason: 'binary' }));
  const big = await add('/work/big', 'big', { result: result({ coverage: { surveyed: 300, analyzed: 50, skipped, failed: [{ path: 'x', reason: 'y' }], complete: false } }) });
  const stored = store.get(big.id);
  assert.equal(stored.result.coverage.skipped.length + stored.result.coverage.failed.length, MAX_STORED_GAPS);
  assert.match(stored.result.limitations.at(-1), /51 more were left out/);
  assert.equal(stored.result.coverage.surveyed, 300, 'counts are kept');

  // Delete, and junk in workspace state is ignored rather than crashing the list.
  assert.equal(await store.remove(big.id), true);
  assert.equal(await store.remove(big.id), false);
  state.set('repositoryManager.reviewHistory', [...state.get('repositoryManager.reviewHistory'), null, { id: 1 }, 'x']);
  assert.equal(store.list('/work/app').length, MAX_PER_REPOSITORY);
  assert.deepEqual(new ReviewHistoryStore(undefined).list('/work/app'), [], 'no workspace state: nothing saved, nothing listed');

  // Release range: newest release tag reachable from HEAD (annotated tags peel to commits), or none.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-range-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
    const service = new GitCommandService(repo);
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    assert.deepEqual(await resolveReleaseRange(service, repo), { currentBranch: 'main', latestReleaseTag: undefined });
    git('tag', '-a', 'v1.9.0', '-m', 'release');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    git('tag', '1.10.0');
    git('tag', 'nightly');
    git('checkout', '-q', '-b', 'side', 'HEAD~1');
    git('commit', '-q', '--allow-empty', '-m', 'side');
    // 1.10.0 is not on `side`, so its range starts at v1.9.0.
    assert.deepEqual(await resolveReleaseRange(service, repo), { currentBranch: 'side', latestReleaseTag: 'v1.9.0' });
    assert.equal(await service.resolveRevision('.', 'v1.9.0'), git('rev-parse', 'HEAD~1'));
    git('checkout', '-q', 'main');
    assert.equal((await resolveReleaseRange(service, repo)).latestReleaseTag, '1.10.0', 'version order, not name order');
    git('checkout', '-q', '--detach');
    assert.equal((await resolveReleaseRange(service, repo)).currentBranch, 'HEAD');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('Review history smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
