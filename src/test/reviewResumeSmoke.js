const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'vscode') return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { SecurityReviewProvider } = require('../../out/services/securityReviewProvider.js');
const { SecurityReviewService } = require('../../out/services/securityReviewService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewUnitCache, MAX_ENTRIES, MAX_AGE_MS } = require('../../out/reviewUnitCache.js');
const { assessReadiness, renderReviewMarkdown } = require('../../out/services/reviewReport.js');
Module._load = originalLoad;

// A stopped review keeps what it finished, and the next run continues from there.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-resume-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function write(file, data) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), data);
}

function memento() {
  const state = new Map();
  return { get: key => state.get(key), update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); } };
}

async function main() {
  try {
    git('init', '-q');
    for (const name of ['alpha', 'beta', 'gamma']) write(`${name}/run.js`, `exec(process.argv[2]); // ${name}\n`);
    git('add', '-A');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-qm', 'three components');
    let target = git('rev-parse', 'HEAD');

    // The scripted model: one finding per component, every one supported by the second check.
    const asked = [];
    let stopAt = null;
    let broken = null;
    let wording = 'Command injection';
    const token = { isCancellationRequested: false };
    const makeModel = version => ({ id: 'mock', version, name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        if (messages[0].startsWith('Independently')) {
          const ids = JSON.parse(messages[1]).evidence.map(item => item.finding.id);
          return { text: (async function* () { yield JSON.stringify({ verdicts: ids.map(id => ({ id, decision: 'supported', reason: 'Checked' })) }); })() };
        }
        const packet = JSON.parse(messages[1]);
        const file = packet.files[0].path;
        asked.push(packet.component);
        // "Cancel" pressed while this component is with the model.
        if (stopAt === packet.component) { token.isCancellationRequested = true; throw new Error('Cancelled'); }
        const line = broken === packet.component ? 9 : 1; // line 9 does not exist: ungrounded evidence
        const response = { schemaVersion: 1, targetSha: target, policyResults: [],
          findings: [{ category: 'security', severity: 'high', confidence: 'high', explanation: `${wording} in ${file}`,
            impact: 'Runs any command', suggestedAction: 'Do not exec input',
            evidence: [{ revision: target, path: file, side: 'target', startLine: line, endLine: line }] }],
          limitations: [`Whether callers of ${file} pass untrusted input depends on code that was not supplied.`] };
        return { text: (async function* () { yield JSON.stringify(response); })() };
      } });
    let model = makeModel('1');
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const cache = new ReviewUnitCache(memento());
    const service = new SecurityReviewService(new GitCommandService(repo), provider, cache);
    const request = { repositoryPath: '.', targetSha: target, scope: 'branch', categories: ['security'] };
    const updates = [];
    const review = () => service.review(request, token, message => updates.push(message));

    // 1. Cancelled while the second component is with the model: the first one is kept.
    stopAt = 'beta';
    const stopped = await review();
    assert.deepEqual(asked, ['alpha', 'beta']);
    assert.deepEqual(stopped.partial, { unitsDone: 1, unitsTotal: 3 });
    assert.equal(stopped.coverage.complete, false);
    assert.deepEqual(stopped.findings.map(finding => [finding.evidence[0].path, finding.status]), [['alpha/run.js', 'verified']]);
    assert.ok(stopped.limitations.some(item => /stopped after 1 of 3 components/.test(item)));
    assert.ok(stopped.toVerify.some(item => item.includes('alpha/run.js')));
    const readiness = assessReadiness(stopped);
    assert.equal(readiness.coverage.stopped.unitsDone, 1);
    assert.ok(readiness.gaps.some(item => /stopped after 1 of 3 components/.test(item.title)), 'the stop is not a review gap');
    assert.match(renderReviewMarkdown(stopped, { kind: 'review', repositoryName: 'r', targetLabel: 'main', generatedAt: new Date() }), /## To verify/);
    assert.equal(cache.size(), 1, 'the cancelled component was cached');

    // 2. Run again: the finished component is reused, only the other two are asked.
    stopAt = null;
    token.isCancellationRequested = false;
    asked.length = 0;
    updates.length = 0;
    const resumed = await review();
    assert.deepEqual(asked, ['beta', 'gamma']);
    assert.ok(updates.some(message => /^Reusing the saved result for component 1\/3: alpha/.test(message)));
    assert.equal(resumed.partial, undefined);
    assert.equal(resumed.coverage.complete, true);
    assert.equal(resumed.findings.length, 3);
    assert.ok(resumed.findings.every(finding => finding.status === 'verified'), 'a reused finding lost its verification');

    // 3. Nothing left to ask: the whole review comes from the saved components.
    asked.length = 0;
    const again = await review();
    assert.deepEqual(asked, []);
    assert.deepEqual(again.findings.map(finding => finding.id).sort(), resumed.findings.map(finding => finding.id).sort());

    // 4. Another model (or model version) asks again; so would changed prompts.
    assert.ok(resumed.findings.every(finding => finding.fingerprint), 'a finding has no fingerprint');
    model = makeModel('2');
    wording = 'Shell command built from argv';
    asked.length = 0;
    const reworded = await review();
    assert.deepEqual(asked, ['alpha', 'beta', 'gamma']);
    // Other words, same code: the same fingerprints (the ids differ, since they hash the wording).
    const prints = result => result.findings.map(finding => [finding.evidence[0].path, finding.fingerprint]).sort();
    assert.deepEqual(prints(reworded), prints(resumed));
    assert.notDeepEqual(reworded.findings.map(finding => finding.id).sort(), resumed.findings.map(finding => finding.id).sort());

    // 5. A component that failed a check is not saved, so it is asked again next time.
    model = makeModel('3');
    broken = 'gamma';
    asked.length = 0;
    const failed = await review();
    assert.ok(failed.coverage.failed.some(item => item.path === 'gamma'));
    // The log says which component failed and why, once, and keeps the steps before it.
    assert.ok(failed.log.some(entry => entry.message === 'Component gamma failed: AI finding had invalid or ungrounded evidence'), failed.log.map(entry => entry.message).join('\n'));
    assert.ok(failed.log[0].message.startsWith('Planning') && failed.log.every((entry, i, all) => i === 0 || entry.at >= all[i - 1].at));
    broken = null;
    asked.length = 0;
    await review();
    assert.deepEqual(asked, ['gamma']);

    // 6. Cancelled before any component finished: nothing to keep, the review fails as cancelled.
    model = makeModel('4');
    stopAt = 'alpha';
    await assert.rejects(review(), /Cancelled/);
    stopAt = null;
    token.isCancellationRequested = false;

    // 6b. Editing the cited line changes that finding's fingerprint, and only that one.
    write('alpha/run.js', 'execFile(process.argv[2], []); // alpha\n');
    git('add', '-A');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-qm', 'alpha changed');
    const before = await review();
    target = request.targetSha = git('rev-parse', 'HEAD');
    const edited = await review();
    const byPath = result => Object.fromEntries(result.findings.map(finding => [finding.evidence[0].path, finding.fingerprint]));
    assert.notEqual(byPath(edited)['alpha/run.js'], byPath(before)['alpha/run.js'], 'an edited line kept its fingerprint');
    assert.equal(byPath(edited)['beta/run.js'], byPath(before)['beta/run.js']);

    // 7. The cache is bounded: the newest MAX_ENTRIES, none older than MAX_AGE_MS.
    let now = 1_000_000_000_000;
    const bounded = new ReviewUnitCache(memento(), () => now);
    const outcome = { findings: [], candidates: 0, policyResults: [], skipped: [], limitations: [], analyzed: 1 };
    for (let i = 0; i <= MAX_ENTRIES; i++) { now += 1; await bounded.set(`k${i}`, outcome); }
    assert.equal(bounded.size(), MAX_ENTRIES);
    assert.equal(bounded.get('k0'), undefined, 'the oldest entry was kept');
    assert.ok(bounded.get(`k${MAX_ENTRIES}`));
    now += MAX_AGE_MS + 1;
    assert.equal(bounded.get(`k${MAX_ENTRIES}`), undefined, 'an expired entry was reused');
    assert.equal(bounded.size(), 0);
    console.log('Review resume smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
