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
const { ReviewUnitCache } = require('../../out/reviewUnitCache.js');
Module._load = originalLoad;

// Retry after a failed check asks only for what failed in a component: the second check for findings
// with no verdict, findings whose citations did not check out, rules with no usable result. What
// passed is kept as it was. Only an answer that was unusable as a whole is asked for again in full.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retry-'));
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
    write('.repository-manager/review-policy.json', JSON.stringify({ version: 1, rules: [{ id: 'TEAM-EXEC', description: 'Never run commands built from input.',
      scope: { include: ['gamma/*.js'] }, severity: 'high', verification: 'ai', requiredEvidence: 'Cite the exec call.' }] }));
    git('add', '-A');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-qm', 'three components and a policy');
    const target = git('rev-parse', 'HEAD');

    // The scripted model. Every request is recorded: what kind it was, for which component, and
    // which findings a second check was asked about. `script` breaks one part of an answer.
    let requests = [];
    let script = {};
    const token = { isCancellationRequested: false };
    const cite = (file, line) => [{ revision: target, path: file, side: 'target', startLine: line, endLine: line }];
    const finding = (file, line, words, extra = {}) => ({ category: 'security', severity: 'high', confidence: 'high',
      explanation: `${words} in ${file}`, impact: 'Runs any command', suggestedAction: 'Do not exec input', evidence: cite(file, line), ...extra });
    const reply = value => ({ text: (async function* () { yield JSON.stringify(value); })() });
    const makeModel = version => ({ id: 'mock', version, name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        const packet = JSON.parse(messages[1]);
        if (messages[0].startsWith('Independently')) {
          const items = packet.evidence.map(item => item.finding);
          requests.push({ kind: 'verify', component: items[0].evidence[0].path.split('/')[0], ids: items.map(item => item.id) });
          if (script.cancelVerify) { token.isCancellationRequested = true; throw new Error('Cancelled'); }
          if (script.verifyThrows) { throw new Error('Rate limited'); }
          return reply({ verdicts: items.filter(item => !(script.dropVerdict || []).includes(item.evidence[0].path.split('/')[0]))
            .map(item => ({ id: item.id, decision: 'supported', reason: 'Checked' })) });
        }
        const component = packet.component;
        const file = packet.files[0].path;
        const kind = messages[0].includes('earlierFindings lists') ? 'recite' : messages[0].includes('for the policy rules in rules only') ? 'rules' : 'analyze';
        if (!component.startsWith('.')) requests.push({ kind, component, earlier: packet.earlierFindings, rules: packet.rules.map(rule => rule.id), categories: packet.request.categories });
        if (script.failRequest === component && kind === 'analyze') { throw new Error('Model unavailable'); }
        const answer = { schemaVersion: 1, targetSha: target, findings: [], policyResults: [], limitations: [] };
        if (component.startsWith('.')) {
          // The policy file is a component too; nothing to report there.
        } else if (kind === 'recite') {
          // Re-cited where the code is, unless the script keeps them wrong.
          answer.findings = packet.earlierFindings.map(item => ({ ...item, evidence: cite(file, script.reciteLine || 1) }));
        } else if (kind === 'rules') {
          answer.findings = [finding(file, 1, 'Policy: command from input', { category: 'compliance', ruleId: 'TEAM-EXEC' })];
          answer.policyResults = [{ ruleId: 'TEAM-EXEC', status: 'violation', reason: 'exec of argv', evidence: cite(file, 1) }];
        } else {
          answer.findings = [finding(file, 1, 'Command injection')];
          // Line 9 does not exist: the citation does not check out.
          if ((script.badCitation || []).includes(component)) answer.findings.push(finding(file, 9, 'Second injection'));
          if (packet.rules.length && !script.noPolicyResult) {
            answer.findings.push(finding(file, 1, 'Policy: command from input', { category: 'compliance', ruleId: 'TEAM-EXEC' }));
            answer.policyResults = [{ ruleId: 'TEAM-EXEC', status: 'violation', reason: 'exec of argv', evidence: cite(file, 1) }];
          }
        }
        return reply(answer);
      } });
    let model = makeModel('1');
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const cache = new ReviewUnitCache(memento());
    const service = new SecurityReviewService(new GitCommandService(repo), provider, cache);
    const request = { repositoryPath: '.', targetSha: target, scope: 'branch', categories: ['security', 'compliance'] };
    const review = () => { requests = []; return service.review(request, token, () => {}); };
    const kinds = () => requests.map(item => `${item.kind}:${item.component}`);
    const failures = result => result.coverage.failed.map(item => `${item.path}: ${item.reason}`);
    const ids = (result, component) => result.findings.filter(item => item.evidence[0].path.startsWith(`${component}/`)).map(item => item.id).sort();

    // 1. A finding with no verdict: Retry runs the second check for it alone; nothing is analyzed again.
    script = { dropVerdict: ['beta'] };
    const first = await review();
    assert.deepEqual(kinds(), ['analyze:alpha', 'verify:alpha', 'analyze:beta', 'verify:beta', 'analyze:gamma', 'verify:gamma']);
    assert.deepEqual(failures(first), ['beta: No verification verdict for 1 of 1 finding(s)']);
    assert.equal(first.findings.find(item => item.evidence[0].path === 'beta/run.js').status, 'hypothesis');
    script = {};
    const retried = await review();
    assert.deepEqual(kinds(), ['verify:beta'], 'Retry asked for more than the missing verdict');
    assert.deepEqual(requests[0].ids, ids(first, 'beta'), 'the second check was asked about other findings');
    assert.deepEqual(failures(retried), []);
    assert.equal(retried.coverage.complete, true);
    assert.ok(retried.findings.every(item => item.status === 'verified'));
    assert.deepEqual(retried.findings.map(item => item.id).sort(), first.findings.map(item => item.id).sort(), 'Retry changed findings that had passed');
    assert.ok(retried.log.some(entry => entry.message === 'Asking again for what failed in component 3/4: beta (1 finding(s) without a verdict)'),
      retried.log.map(entry => entry.message).join('\n'));
    // Complete now: nothing is asked any more.
    await review();
    assert.deepEqual(kinds(), []);

    // 2. A finding whose citation did not check out: Retry asks for that finding alone, with the
    //    component's files; the finding that passed keeps its id and verdict, and is not checked again.
    model = makeModel('2');
    script = { badCitation: ['alpha'] };
    const cited = await review();
    assert.deepEqual(failures(cited), ['alpha: AI finding had invalid or ungrounded evidence']);
    const good = ids(cited, 'alpha');
    assert.equal(good.length, 1);
    script = { reciteLine: 9 };
    // Cited wrong again: still a failed check, asked for again next time.
    const stillWrong = await review();
    assert.deepEqual(kinds(), ['recite:alpha']);
    assert.equal(requests[0].earlier.length, 1);
    assert.match(requests[0].earlier[0].explanation, /^Second injection/);
    assert.deepEqual(failures(stillWrong), ['alpha: AI finding had invalid or ungrounded evidence']);
    script = {};
    const recited = await review();
    assert.deepEqual(kinds(), ['recite:alpha', 'verify:alpha']);
    const added = ids(recited, 'alpha').filter(id => !good.includes(id));
    assert.equal(added.length, 1);
    assert.deepEqual(requests[1].ids, added, 'the finding that passed was checked again');
    assert.ok(ids(recited, 'alpha').includes(good[0]), 'the finding that passed was lost');
    assert.deepEqual(failures(recited), []);
    assert.ok(recited.findings.every(item => item.status === 'verified'));

    // 3. A rule with no result: Retry asks for that rule alone (compliance only), then checks its finding.
    model = makeModel('3');
    script = { noPolicyResult: true };
    const unanswered = await review();
    assert.deepEqual(failures(unanswered), ['gamma: No policy result for TEAM-EXEC']);
    assert.equal(unanswered.policyResults.find(item => item.ruleId === 'TEAM-EXEC').status, 'insufficient_evidence');
    script = {};
    const answered = await review();
    assert.deepEqual(kinds(), ['rules:gamma', 'verify:gamma']);
    assert.deepEqual([requests[0].rules, requests[0].categories], [['TEAM-EXEC'], ['compliance']]);
    assert.deepEqual(failures(answered), []);
    // The violation stands: its compliance finding passed the second check.
    assert.equal(answered.policyResults.find(item => item.ruleId === 'TEAM-EXEC').status, 'violation');
    assert.ok(answered.findings.some(item => item.category === 'compliance' && item.status === 'verified'));

    // 4. The second check failed as a whole: one failed check (not two), and Retry runs only it.
    model = makeModel('4');
    script = { verifyThrows: true };
    const unverified = await review();
    assert.deepEqual(failures(unverified).filter(item => item.startsWith('alpha')), ['alpha: Finding verification failed: Error: Rate limited']);
    script = {};
    await review();
    assert.deepEqual(kinds(), ['verify:alpha', 'verify:beta', 'verify:gamma']);

    // 5. Stopped while asking again: what the component had is kept, and the next run asks again.
    model = makeModel('5');
    script = { dropVerdict: ['alpha'] };
    await review();
    script = { cancelVerify: true };
    const stopped = await review();
    assert.deepEqual(kinds(), ['verify:alpha']);
    assert.deepEqual(stopped.partial, { unitsDone: 1, unitsTotal: 4 }, 'it did not stop at alpha');
    token.isCancellationRequested = false;
    script = {};
    const resumed = await review();
    assert.deepEqual(kinds(), ['verify:alpha']);
    assert.deepEqual(failures(resumed), []);

    // 6. An answer unusable as a whole (the request failed) is not kept: that component is asked in full.
    model = makeModel('6');
    script = { failRequest: 'beta' };
    const failedRequest = await review();
    assert.deepEqual(failures(failedRequest), ['beta/run.js: Model unavailable']);
    script = {};
    await review();
    assert.deepEqual(kinds(), ['analyze:beta', 'verify:beta']);
    console.log('Review retry smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
