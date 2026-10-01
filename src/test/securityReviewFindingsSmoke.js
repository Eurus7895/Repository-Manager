// Regression tests for the PR #33 review findings: rule-scoped compliance evidence,
// manual/static rules never verified by AI, rule context for the verifier, complete
// verdict sets, not_applicable aggregation, and linear survey planning.
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
const { ReviewSurveyService } = require('../../out/services/reviewSurveyService.js');
const { validatePolicyResult, validateReviewFinding } = require('../../out/services/reviewFindingValidation.js');
Module._load = originalLoad;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-findings-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }).trim();
function write(file, data) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), data);
}
function commit(message) { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); }

async function main() {
  try {
    git('init', '-q');
    write('src/app.js', 'const x = input;\n');
    write('src/README.md', 'Usage\n');
    write('docs/guide.md', 'Guide\n');
    const base = commit('base');
    write('src/app.js', 'const x = input;\neval(x);\n');
    write('src/README.md', 'Usage\nRun eval on input.\n');
    write('docs/guide.md', 'Guide\nUpdated.\n');
    write('.repository-manager/review-policy.json', JSON.stringify({ version: 1, rules: [
      { id: 'JS-EXEC', description: 'Do not execute untrusted input', scope: { include: ['src/*.js'] },
        severity: 'high', verification: 'ai', requiredEvidence: 'Trace input to execution' },
      { id: 'SRC-MANUAL', description: 'Security sign-off for source changes', scope: { include: ['src/*.js'] },
        severity: 'medium', verification: 'manual', requiredEvidence: 'Approved review record' },
      { id: 'DOCS-LICENSE', description: 'Docs state their license', scope: { include: ['docs/**'] },
        severity: 'low', verification: 'ai', requiredEvidence: 'License line in the document' }
    ] }));
    const target = commit('change');
    const request = { repositoryPath: '.', targetSha: target, baseSha: base, scope: 'changes', categories: ['security', 'compliance'] };

    // The mixed batch: src/app.js is in scope of JS-EXEC, src/README.md is not.
    const plan = await new ReviewSurveyService(new GitCommandService(repo)).plan(request);
    const srcUnit = plan.units.find(unit => unit.paths.includes('src/app.js'));
    assert.ok(srcUnit.paths.includes('src/README.md'), 'fixture needs in- and out-of-scope files in one batch');
    const readmeEvidence = [{ revision: target, path: 'src/README.md', side: 'target', startLine: 2, endLine: 2 }];
    const appEvidence = [{ revision: target, path: 'src/app.js', side: 'target', startLine: 2, endLine: 2 }];
    const compliance = (ruleId, evidence) => ({ category: 'compliance', ruleId, severity: 'high', confidence: 'high',
      explanation: 'Input is executed', impact: 'Code execution', suggestedAction: 'Remove eval', evidence });

    // Finding 2: compliance evidence must lie inside the cited rule's scope.
    assert.equal(await validateReviewFinding(compliance('JS-EXEC', readmeEvidence), plan, srcUnit), undefined,
      'out-of-scope evidence grounded a compliance finding');
    assert.ok(await validateReviewFinding(compliance('JS-EXEC', appEvidence), plan, srcUnit));
    assert.equal(await validatePolicyResult({ ruleId: 'JS-EXEC', status: 'pass', reason: 'ok', evidence: readmeEvidence }, plan, srcUnit),
      undefined, 'out-of-scope evidence grounded a policy result');
    // Security findings are not rule-scoped.
    assert.ok(await validateReviewFinding({ ...compliance('JS-EXEC', readmeEvidence), category: 'security', ruleId: undefined }, plan, srcUnit));

    let omitVerdicts = false;
    const verifierInputs = [];
    const model = { id: 'mock', version: '1', name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        let response;
        const packet = JSON.parse(messages[1]);
        if (messages[0].startsWith('Independently')) {
          verifierInputs.push(packet);
          const ids = packet.evidence.map(item => item.finding.id);
          response = { verdicts: (omitVerdicts ? ids.slice(1) : ids).map(id => ({ id, decision: 'supported', reason: 'Checked' })) };
        } else if (packet.files.some(file => file.path === 'src/app.js')) {
          response = { schemaVersion: 1, targetSha: target, limitations: [],
            findings: [compliance('JS-EXEC', appEvidence), compliance('SRC-MANUAL', appEvidence)],
            policyResults: [{ ruleId: 'JS-EXEC', status: 'violation', reason: 'eval of input', evidence: appEvidence },
              { ruleId: 'SRC-MANUAL', status: 'insufficient_evidence', reason: 'Needs sign-off', evidence: [] }] };
        } else if (packet.files.some(file => file.path === 'docs/guide.md')) {
          response = { schemaVersion: 1, targetSha: target, limitations: [], findings: [],
            policyResults: [{ ruleId: 'DOCS-LICENSE', status: 'not_applicable', reason: 'Not a published document', evidence: [] }] };
        } else {
          response = { schemaVersion: 1, targetSha: target, findings: [], policyResults: [], limitations: [] };
        }
        return { text: (async function* () { yield JSON.stringify(response); })() };
      }
    };
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const service = new SecurityReviewService(new GitCommandService(repo), provider);
    const token = { isCancellationRequested: false };

    const result = await service.review(request, token, () => {});
    const byRule = Object.fromEntries(result.policyResults.map(item => [item.ruleId, item.status]));
    // Finding 3: a manual rule's finding is never promoted to verified by the AI check.
    const manual = result.findings.find(item => item.ruleId === 'SRC-MANUAL');
    assert.ok(manual, 'manual-rule finding missing');
    assert.equal(manual.status, 'hypothesis');
    assert.equal(result.findings.find(item => item.ruleId === 'JS-EXEC').status, 'verified');
    assert.equal(byRule['SRC-MANUAL'], 'insufficient_evidence');
    // Finding 4: the verifier sees the rule it is judging.
    const verifiedRule = verifierInputs[0].evidence.find(item => item.finding.ruleId === 'JS-EXEC').rule;
    assert.deepEqual(verifiedRule && [verifiedRule.id, verifiedRule.description, verifiedRule.requiredEvidence],
      ['JS-EXEC', 'Do not execute untrusted input', 'Trace input to execution']);
    // Finding 6: a rule the model judged not applicable everywhere stays not_applicable.
    assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage));
    assert.equal(byRule['DOCS-LICENSE'], 'not_applicable');
    assert.equal(byRule['JS-EXEC'], 'violation');

    // Finding 5: verdicts missing for some candidates make coverage incomplete.
    omitVerdicts = true;
    const partial = await service.review(request, token, () => {});
    assert.equal(partial.coverage.complete, false);
    assert.ok(partial.coverage.failed.some(item => /verdict/i.test(item.reason)), JSON.stringify(partial.coverage.failed));
    omitVerdicts = false;

    // Finding 1: planning a branch review of a large tree stays linear.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x\n', encoding: 'utf8', env }).trim();
    const indexLines = Array.from({ length: 40000 }, (_, i) => `100644 ${blob}\tbulk/d${i % 200}/f${i}.txt`).join('\n');
    const indexFile = path.join(repo, '.git', 'bulk-index');
    execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: repo, input: indexLines, env: { ...env, GIT_INDEX_FILE: indexFile } });
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8', env: { ...env, GIT_INDEX_FILE: indexFile } }).trim();
    const bulk = execFileSync('git', ['commit-tree', tree, '-m', 'bulk'], { cwd: repo, encoding: 'utf8', env }).trim();
    const started = Date.now();
    const bulkPlan = await new ReviewSurveyService(new GitCommandService(repo)).plan({
      repositoryPath: '.', targetSha: bulk, scope: 'branch', categories: ['security'] });
    const planMs = Date.now() - started;
    assert.equal(bulkPlan.units.reduce((sum, unit) => sum + unit.paths.length, 0), 256);
    assert.equal(bulkPlan.coverage.skipped.length, 40000 - 256);
    assert.ok(planMs < 5000, `planning 40,000 files took ${planMs} ms`);
    console.log(`Security review findings smoke passed (40,000-file plan in ${planMs} ms)`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
