const assert = require('node:assert/strict');
const { assessReadiness, renderReviewMarkdown } = require('../../out/services/reviewReport.js');

const target = 'b'.repeat(40);
const base = 'a'.repeat(40);
const finding = (id, severity, status, extra = {}) => ({
  id, category: 'security', severity, confidence: 'medium', status,
  explanation: `Finding ${id}`, impact: 'Impact', suggestedAction: 'Fix it',
  evidence: [{ revision: target, path: 'src/app.js', side: 'target', startLine: 3, endLine: 3 }], ...extra
});
const result = (overrides = {}) => ({
  request: { repositoryPath: '.', targetSha: target, baseSha: base, scope: 'changes', categories: ['security'] },
  findings: [], policyResults: [], policyStatus: 'not_configured', modelId: 'mock:1', limitations: [],
  coverage: { surveyed: 2, analyzed: 2, skipped: [], failed: [], complete: true }, ...overrides
});

// Clean result.
assert.equal(assessReadiness(result()).status, 'no_blocking_findings');

// A policy violation stops blocking once every compliance finding behind it is fixed or dismissed.
const compliance = id => finding(id, 'high', 'verified', { category: 'compliance', ruleId: 'R-9' });
const violated = result({ findings: [compliance('c1'), compliance('c2')],
  policyResults: [{ ruleId: 'R-9', status: 'violation', reason: 'secret in config', evidence: [] }] });
assert.deepEqual(assessReadiness(violated).blocking.map(item => item.findingId || item.ruleId), ['c1', 'c2', 'R-9']);
assert.deepEqual(assessReadiness(violated, { c1: { decision: 'fixed' } }).blocking.map(item => item.findingId || item.ruleId), ['c2', 'R-9'],
  'the violation stopped blocking while one of its findings is still open');
assert.equal(assessReadiness(violated, { c1: { decision: 'fixed' }, c2: { decision: 'dismiss', reason: 'accepted_risk' } }).status, 'no_blocking_findings');

// Verified critical/high and violations block; hypotheses and lower severities need attention,
// most severe first, so a critical hypothesis leads the attention list without blocking.
const mixed = assessReadiness(result({
  findings: [finding('low-verified', 'low', 'verified'), finding('high-verified', 'high', 'verified'),
    finding('crit-hypo', 'critical', 'hypothesis'), finding('med-verified', 'medium', 'verified')],
  policyResults: [{ ruleId: 'R-1', status: 'violation', reason: 'eval', evidence: [] },
    { ruleId: 'R-2', status: 'insufficient_evidence', reason: 'manual', evidence: [] },
    { ruleId: 'R-3', status: 'pass', reason: 'ok', evidence: [] }]
}));
assert.equal(mixed.status, 'blocked');
assert.deepEqual(mixed.blocking.map(item => item.findingId || item.ruleId), ['high-verified', 'R-1']);
assert.equal(mixed.attention[0].findingId, 'crit-hypo');
// Findings and review gaps are kept apart: an unresolved rule is a gap, not a finding.
assert.deepEqual(mixed.attention.map(item => item.findingId).sort(), ['crit-hypo', 'low-verified', 'med-verified']);
assert.deepEqual(mixed.gaps.map(item => item.ruleId), ['R-2']);

// Unconfigured compliance and incomplete coverage are never silently clean.
const gaps = assessReadiness(result({
  request: { ...result().request, categories: ['security', 'compliance'] },
  coverage: { surveyed: 3, analyzed: 1, skipped: [{ path: 'x', reason: 'budget' }], failed: [], complete: false }
}));
assert.equal(gaps.status, 'needs_attention');
assert.deepEqual(gaps.attention, []);
assert.deepEqual(gaps.gaps.map(item => item.kind).sort(), ['coverage', 'policy']);

// Markdown names the range and readiness, and escapes untrusted model text.
const markdown = renderReviewMarkdown(result({
  findings: [finding('x', 'high', 'verified', { explanation: '<script>alert(1)</script> a|b' })],
  policyResults: [{ ruleId: 'R-1', status: 'violation', reason: 'pipe | in reason', evidence: [] }],
  policyStatus: 'configured', request: { ...result().request, policyHash: 'c'.repeat(64) }
}), { kind: 'release', repositoryName: 'repo', baseLabel: '1.5.0', targetLabel: 'main', generatedAt: new Date('2026-10-01T00:00:00Z') });
assert.match(markdown, /^# Current branch review — Diff: 1\.5\.0 → main/);
assert.match(markdown, /\*\*Readiness: Blocked\*\* \(2 blocking/);
assert.match(markdown, /`1\.5\.0` \(aaaaaaaa\) → `main` \(bbbbbbbb\)/);
assert.doesNotMatch(markdown, /<script>/);
assert.match(markdown, /&lt;script&gt;/);
assert.match(markdown, /pipe \\\| in reason/);
assert.match(markdown, /No findings does not mean no vulnerabilities/);
// A branch release review names only the target, never an "undefined" base.
const branch = renderReviewMarkdown(result({ request: { ...result().request, scope: 'branch', baseSha: undefined } }),
  { kind: 'release', repositoryName: 'repo', targetLabel: 'main', generatedAt: new Date('2026-10-01T00:00:00Z') });
assert.match(branch, /^# Current branch review — Branch: main\n/);
assert.match(branch, /Every file at `main` \(bbbbbbbb\)/);
console.log('Review report smoke passed');
