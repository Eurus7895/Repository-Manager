const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewController } = require('../../out/reviewController.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-controller-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
const commit = (file, content, message) => {
  fs.writeFileSync(path.join(repo, file), content);
  git('add', file);
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};
// Resolves once the controller has handed a review to the runner (it awaits real git calls first).
async function untilRuns(runs, count) {
  for (let i = 0; i < 500 && runs.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runs.length, count, 'review never reached the runner');
}

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    commit('app.js', 'v1\n', 'one');
    git('tag', '1.4.0');
    const release = commit('app.js', 'v2\n', 'two');
    git('tag', '1.5.0');
    git('tag', 'not-a-release');
    const head = commit('app.js', 'line 1\nline 2\neval(input);\n', 'three');

    const posts = [];
    const notices = [];
    let confirmAnswer = true;
    let copied = null;
    let saved = null;
    let saveAnswer = true;
    let opened = null;
    let runnerScript = async () => { throw new Error('no script'); };
    const runs = [];
    const host = {
      workspaceRoot: () => repo,
      post: async message => { posts.push(message); },
      confirm: async () => confirmAnswer,
      createRunner: () => ({ review: (request, token, progress, modelId) => {
        const run = { request, token, modelId };
        runs.push(run);
        return runnerScript(run, progress);
      } }),
      createCancellation: () => {
        const token = { isCancellationRequested: false };
        return { token, cancel() { token.isCancellationRequested = true; }, dispose() {} };
      },
      copyText: async text => { copied = text; },
      saveText: async (name, text) => { saved = { name, text }; return saveAnswer; },
      openText: async (content, revision, filePath, line) => { opened = { content, revision, filePath, line }; },
      notify: (message, isError) => { notices.push({ message, isError: Boolean(isError) }); }
    };
    const controller = new ReviewController(host);
    const of = type => posts.filter(message => message.type === type);
    assert.equal(controller.handles('startReview'), true);
    assert.equal(controller.handles('getHistory'), false);

    // Release defaults: newest version tag on the current branch, ignoring non-version tags.
    await controller.handle({ type: 'getReviewDefaults', payload: { repositoryPath: '.' } });
    const defaults = of('reviewDefaultsLoaded')[0].payload;
    assert.equal(defaults.latestReleaseTag, '1.5.0');
    assert.equal(defaults.currentBranch, 'main');
    assert.ok(defaults.tags.includes('1.4.0') && defaults.branches.includes('main'));

    const start = (requestId, extra = {}) => controller.handle({ type: 'startReview', payload: {
      requestId, repositoryPath: '.', scope: 'changes', baseRevision: '1.5.0', targetRevision: 'main',
      categories: ['security', 'compliance'], kind: 'release', modelId: 'deep', ...extra } });

    // Declining consent sends nothing to the model.
    confirmAnswer = false;
    await start(1);
    assert.equal(runs.length, 0);
    assert.equal(of('reviewFailed').at(-1).payload.cancelled, true);
    confirmAnswer = true;

    // A completed review reports progress, resolved commits, and readiness.
    const finding = { id: 'f1', category: 'security', severity: 'high', confidence: 'high', status: 'verified',
      explanation: 'Input reaches eval', impact: 'Code execution', suggestedAction: 'Remove eval',
      evidence: [{ revision: head, path: 'app.js', side: 'target', startLine: 3, endLine: 3 }] };
    runnerScript = async (run, progress) => {
      progress('Reviewing component 1/1: app');
      return { request: { ...run.request, policyHash: undefined }, findings: [finding], policyResults: [],
        policyStatus: 'not_configured', modelId: 'deep:1', limitations: [],
        coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } };
    };
    await start(2);
    assert.equal(runs.at(-1).request.baseSha, release);
    assert.equal(runs.at(-1).request.targetSha, head);
    assert.equal(runs.at(-1).modelId, 'deep');
    assert.ok(of('reviewProgress').some(message => message.payload.message.includes('component 1/1')));
    const completed = of('reviewCompleted').at(-1).payload;
    assert.equal(completed.requestId, 2);
    assert.equal(completed.readiness.status, 'blocked');
    assert.deepEqual([completed.context.kind, completed.context.baseLabel, completed.context.targetLabel], ['release', '1.5.0', 'main']);

    // Export: copy and save (dismissing the save dialog reports nothing).
    await controller.handle({ type: 'exportReviewReport', payload: { requestId: 2, format: 'copy' } });
    assert.match(copied, /^# Release review: 1\.5\.0 → main/);
    saveAnswer = false;
    await controller.handle({ type: 'exportReviewReport', payload: { requestId: 2, format: 'save' } });
    assert.equal(saved.name, 'release-review-1.5.0-main.md');
    assert.ok(!notices.some(notice => /saved/.test(notice.message)));
    await controller.handle({ type: 'exportReviewReport', payload: { requestId: 99, format: 'copy' } });
    assert.equal(notices.at(-1).isError, true);

    // Starting a new review supersedes a running one; the old result is never posted.
    let releaseFirst;
    runnerScript = (run) => new Promise((resolve, reject) => {
      releaseFirst = () => (run.token.isCancellationRequested ? reject(new Error('Cancelled')) : resolve(null));
    });
    const before = runs.length;
    const first = start(3);
    await untilRuns(runs, before + 1);
    const superseded = runs.at(-1);
    runnerScript = async run => ({ request: run.request, findings: [], policyResults: [], policyStatus: 'not_configured',
      limitations: [], coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } });
    await start(4, { categories: ['security'] });
    assert.equal(superseded.token.isCancellationRequested, true);
    releaseFirst();
    await first;
    assert.equal(posts.filter(message => message.payload && message.payload.requestId === 3 &&
      ['reviewCompleted', 'reviewFailed'].includes(message.type)).length, 0);
    assert.equal(of('reviewCompleted').at(-1).payload.readiness.status, 'no_blocking_findings');

    // Cancel while running.
    runnerScript = (run) => new Promise((resolve, reject) => { releaseFirst = () => reject(new Error('Cancelled')); });
    const beforeCancel = runs.length;
    const cancelled = start(5);
    await untilRuns(runs, beforeCancel + 1);
    controller.cancel();
    assert.equal(runs.at(-1).token.isCancellationRequested, true);
    releaseFirst();
    await cancelled;

    // Cancel from the dashboard tells the dashboard, even though the run's own reply is dropped.
    runnerScript = (run) => new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (run.token.isCancellationRequested) { clearInterval(timer); reject(new Error('Cancelled')); } }, 5);
    });
    const beforeUserCancel = runs.length;
    const userCancelled = start(7);
    await untilRuns(runs, beforeUserCancel + 1);
    await controller.handle({ type: 'cancelReview', payload: {} });
    await userCancelled;
    const cancelReplies = posts.filter(message => message.payload && message.payload.requestId === 7 && message.type === 'reviewFailed');
    assert.equal(cancelReplies.length, 1);
    assert.equal(cancelReplies[0].payload.cancelled, true);
    // Nothing is running any more, so a second cancel says nothing.
    await controller.handle({ type: 'cancelReview', payload: {} });
    assert.equal(posts.filter(message => message.type === 'reviewFailed' && message.payload.requestId === 7).length, 1);

    // Unknown revision.
    await start(6, { baseRevision: 'no-such-tag' });
    assert.match(of('reviewFailed').at(-1).payload.message, /Cannot resolve revision/);

    // Evidence opens the file as it was at the reviewed commit; unsafe input is ignored.
    await controller.handle({ type: 'openReviewEvidence', payload: { repositoryPath: '.', revision: release, path: 'app.js', line: 1 } });
    assert.deepEqual([opened.content, opened.revision, opened.filePath, opened.line], ['v2\n', release, 'app.js', 1]);
    opened = null;
    for (const unsafe of [{ path: '../secret' }, { path: '-p' }, { revision: 'HEAD' }, { line: 0 }]) {
      await controller.handle({ type: 'openReviewEvidence', payload: { repositoryPath: '.', revision: release, path: 'app.js', line: 1, ...unsafe } });
      assert.equal(opened, null, `accepted ${JSON.stringify(unsafe)}`);
    }
    console.log('Review controller smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
