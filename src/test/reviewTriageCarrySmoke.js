const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { carryTriage } = require('../../out/reviewTriageCarry.js');
const { ReviewController } = require('../../out/reviewController.js');
const { ReviewHistoryStore, compactResult, MAX_STORED_LOG, MAX_STORED_GAPS } = require('../../out/reviewHistory.js');
const { normalizeTriage, renderReviewMarkdown } = require('../../out/services/reviewReport.js');

const finding = (id, fingerprint, extra = {}) => ({ id, fingerprint, category: 'security', severity: 'high', confidence: 'high', status: 'verified',
  explanation: `Finding ${id}`, impact: 'Impact', suggestedAction: 'Fix it',
  evidence: [{ revision: 'abc', path: 'app.js', side: 'target', startLine: 3, endLine: 3 }], ...extra });

async function main() {
  // 1. Carry rules: dismissed stays dismissed, Needs fix stays, Fixed but reported again needs a fix.
  const earlier = [
    { generatedAt: '2026-10-05T10:00:00.000Z', findings: [finding('old-a', 'fp-a'), finding('old-b', 'fp-b'), finding('old-c', 'fp-c'), finding('old-d')],
      triage: { 'old-a': { decision: 'dismiss', reason: 'accepted_risk' }, 'old-b': { decision: 'fix' }, 'old-c': { decision: 'fixed' }, 'old-d': { decision: 'dismiss' } } },
    // Older still: its decision on fp-a loses to the newer one.
    { generatedAt: '2026-10-01T10:00:00.000Z', findings: [finding('older-a', 'fp-a')], triage: { 'older-a': { decision: 'fix' } } }
  ];
  const now = [finding('new-a', 'fp-a'), finding('new-b', 'fp-b'), finding('new-c', 'fp-c'), finding('new-d'), finding('new-e', 'fp-e')];
  const carried = carryTriage(now, earlier);
  assert.deepEqual(carried['new-a'], { decision: 'dismiss', reason: 'accepted_risk', carried: { at: '2026-10-05T10:00:00.000Z', decision: 'dismiss' } });
  assert.deepEqual(carried['new-b'], { decision: 'fix', carried: { at: '2026-10-05T10:00:00.000Z', decision: 'fix' } });
  assert.deepEqual(carried['new-c'], { decision: 'fix', carried: { at: '2026-10-05T10:00:00.000Z', decision: 'fixed' } }, 'a fixed issue reported again was hidden');
  assert.equal(carried['new-d'], undefined, 'a finding without a fingerprint (older reviews) was matched');
  assert.equal(carried['new-e'], undefined, 'a new issue was triaged');
  // A third review keeps saying where a decision came from, including "reported again after Fixed".
  const third = carryTriage([finding('x-a', 'fp-a'), finding('x-c', 'fp-c')],
    [{ generatedAt: '2026-10-06T10:00:00.000Z', findings: now, triage: carried }]);
  assert.equal(third['x-a'].carried.at, '2026-10-05T10:00:00.000Z');
  assert.deepEqual(third['x-c'], { decision: 'fix', carried: { at: '2026-10-05T10:00:00.000Z', decision: 'fixed' } });
  // Changing one decision keeps where the others came from.
  const kept = normalizeTriage({ findings: now }, { ...carried, 'new-b': { decision: 'dismiss', reason: 'false_positive' } });
  assert.deepEqual(kept['new-a'].carried, { at: '2026-10-05T10:00:00.000Z', decision: 'dismiss' });
  assert.deepEqual(kept['new-b'], { decision: 'dismiss', reason: 'false_positive' }, 'a decision made now still says it came from earlier');

  // 2. A stored review keeps failures before skipped files, and a long log keeps its failures.
  const skipped = Array.from({ length: MAX_STORED_GAPS + 20 }, (_, i) => ({ path: `f${i}.bin`, reason: 'binary' }));
  const log = Array.from({ length: MAX_STORED_LOG + 100 }, (_, i) => ({ at: i, message: i === 5 ? 'Component api failed: Selected model cannot fit review context' : `step ${i}` }));
  const compact = compactResult({ request: {}, findings: [], policyResults: [], limitations: [], log,
    coverage: { surveyed: 1, analyzed: 0, skipped, failed: [{ path: 'api', reason: 'Selected model cannot fit review context' }], complete: false } });
  assert.equal(compact.coverage.failed.length, 1, 'a failure was dropped in favour of skipped files');
  assert.equal(compact.log.length, MAX_STORED_LOG);
  assert.ok(compact.log.some(entry => /failed/.test(entry.message)), 'the failure fell out of the stored log');
  assert.equal(compact.log.at(-1).message, `step ${MAX_STORED_LOG + 99}`, 'the end of the log was not kept');

  // 3. Through the controller: the second review of the same code keeps the first one's decisions,
  //    and the report says why checks failed.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-carry-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'app.js'), 'eval(input);\n');
    git('add', '-A');
    git('commit', '-qm', 'one');
    const posts = [];
    const state = new Map();
    const memento = { get: key => state.get(key), update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); } };
    let next;
    const host = {
      history: new ReviewHistoryStore(memento), workspaceRoot: () => repo, post: async message => { posts.push(message); },
      ask: async () => 'Start review', alwaysConfirm: () => false, isConsentRemembered: () => true, rememberConsent: async () => {},
      createRunner: () => ({ review: async request => ({ request, policyResults: [], policyStatus: 'not_configured', modelId: 'm:1', limitations: [], ...next }) }),
      createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() {}, dispose() {} }),
      copyText: async () => {}, saveText: async () => true, openText: async () => {}, notify: () => {}
    };
    const controller = new ReviewController(host);
    const completed = () => posts.filter(message => message.type === 'reviewCompleted').at(-1).payload;
    const start = requestId => controller.handle({ type: 'startReview', payload: { requestId, repositoryPath: '.', scope: 'branch', targetRevision: 'main' } });
    next = { findings: [finding('run1-eval', 'fp-eval'), finding('run1-other', 'fp-other')],
      coverage: { surveyed: 3, analyzed: 1, skipped: [], complete: false,
        failed: [{ path: 'api/a.js', reason: 'Selected model cannot fit review context' }, { path: 'api/b.js', reason: 'Selected model cannot fit review context' },
          { path: 'web', reason: 'AI finding had invalid or ungrounded evidence' }] },
      log: [{ at: 0, message: 'Planning the review…' }, { at: 900, message: 'Component api failed (2 files): Selected model cannot fit review context' }] };
    await start(1);
    assert.deepEqual(completed().triage, {}, 'the first review of a repository carried decisions from nowhere');
    const markdown = renderReviewMarkdown(completed().result, { kind: 'review', repositoryName: 'r', targetLabel: 'main', generatedAt: new Date() });
    assert.match(markdown, /Failed checks by reason[\s\S]*Selected model cannot fit review context \(2\)[\s\S]*ungrounded evidence \(1\)/);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'run1-eval', decision: 'dismiss', reason: 'accepted_risk' } });

    // Run again: the model words it differently (another id), the code is the same (same fingerprint).
    next = { findings: [finding('run2-eval', 'fp-eval', { explanation: 'eval() runs request input' }), finding('run2-new', 'fp-new')],
      coverage: { surveyed: 3, analyzed: 3, skipped: [], failed: [], complete: true } };
    await start(2);
    const second = completed();
    assert.deepEqual(second.triage['run2-eval'], { decision: 'dismiss', reason: 'accepted_risk', carried: { at: second.triage['run2-eval'].carried.at, decision: 'dismiss' } });
    assert.equal(second.triage['run2-new'], undefined);
    // Readiness counts the carried dismissal, and the saved copy keeps it.
    assert.equal(second.readiness.dismissed.length, 1);
    assert.equal(host.history.get(second.historyId).triage['run2-eval'].decision, 'dismiss');
    console.log('Review triage carry smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
