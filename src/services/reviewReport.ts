/**
 * Release readiness and Markdown reports for security and compliance reviews.
 * Pure functions: no VS Code or Git access, so the dashboard and the exported
 * report always agree.
 */

import { DismissReason, FindingTriage, ReviewFinding, ReviewResult, ReviewTriage } from '../types';

export type ReadinessStatus = 'blocked' | 'needs_attention' | 'no_blocking_findings';

export interface ReadinessItem {
  kind: 'finding' | 'policy' | 'coverage';
  severity?: ReviewFinding['severity'];
  title: string;
  detail: string;
  findingId?: string;
  ruleId?: string;
  triage?: FindingTriage;
}

export interface ReviewReadiness {
  status: ReadinessStatus;
  blocking: ReadinessItem[];
  /** Findings that need a look without blocking (hypotheses, verified medium and low). */
  attention: ReadinessItem[];
  /** What the review could not establish: unconfigured policy, unresolved rules, incomplete coverage. */
  gaps: ReadinessItem[];
  /** Findings the reviewer dismissed; they no longer count toward readiness, but stay on record. */
  dismissed: ReadinessItem[];
  /** Findings fixed (by an applied auto-fix or by hand); like dismissed ones, out of readiness but on record. */
  fixed: ReadinessItem[];
  /** Findings the reviewer marked to fix, and findings with no decision yet. */
  toFix: number;
  untriaged: number;
  coverage: CoverageSummary;
}

/** What happened to the reviewed files, counted once for the report and the dashboard. */
export interface CoverageSummary {
  files: number;
  fully: number;
  /** Files the model saw only part of; `partlyData` of them are data or generated files. */
  partly: number;
  partlyData: number;
  notReviewed: number;
  failedChecks: number;
  /** The review stopped before every component was analyzed. */
  stopped?: { unitsDone: number; unitsTotal: number };
}

// Lockfiles, images and diagrams, minified bundles and test inputs: worth less of the model's
// attention than source, so a partial read of them is reported apart.
const DATA_FILE = [
  /\.(lock|svg|drawio|png|jpe?g|gif|ico|pdf|map)$/i,
  /\.min\.(js|css)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|go\.sum)$/i,
  /(^|\/)(tests?|__tests__|spec)\/(.*\/)?(input|inputs|fixtures?|data|testdata|snapshots?)\//i
];
export const isDataFile = (path: string) => DATA_FILE.some(pattern => pattern.test(path));

export function summarizeCoverage(result: ReviewResult): CoverageSummary {
  const { surveyed, analyzed, skipped, failed } = result.coverage;
  // Older saved reviews have no `partial` flag; their partial reads say "Partly reviewed".
  const partial = [...new Set(skipped.filter(item => item.partial || /^Partly reviewed/.test(item.reason)).map(item => item.path))];
  return { files: surveyed, fully: Math.max(0, analyzed - partial.length), partly: partial.length,
    partlyData: partial.filter(isDataFile).length, notReviewed: Math.max(0, surveyed - analyzed), failedChecks: failed.length,
    ...(result.partial ? { stopped: result.partial } : {}) };
}

export function coverageLine(summary: CoverageSummary): string {
  const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
  return [`${plural(summary.files, 'file')}: ${summary.fully.toLocaleString('en-US')} fully reviewed`,
    `${summary.partly.toLocaleString('en-US')} partly${summary.partlyData ? ` (${summary.partlyData} data or generated)` : ''}`,
    `${summary.notReviewed.toLocaleString('en-US')} not reviewed`, plural(summary.failedChecks, 'failed check')].join(' · ');
}

// The keys are the stored DismissReason values, shared with the dashboard.
/* eslint-disable @typescript-eslint/naming-convention */
export const DISMISS_REASONS: Record<DismissReason, string> = {
  false_positive: 'False positive',
  accepted_risk: 'Accepted risk',
  not_applicable: 'Not applicable'
};
/* eslint-enable @typescript-eslint/naming-convention */

export interface ReviewReportContext {
  /** 'release' for a review of the current branch (Review branch or Review all). */
  kind: 'review' | 'release';
  repositoryName: string;
  /** What the user picked, e.g. a tag or branch name; the resolved SHAs come from the result. */
  baseLabel?: string;
  targetLabel: string;
  generatedAt: Date;
}

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
const BLOCKING_SEVERITIES = new Set<ReviewFinding['severity']>(['critical', 'high']);

function location(finding: ReviewFinding): string {
  const evidence = finding.evidence[0];
  if (!evidence) { return ''; }
  const lines = evidence.startLine === evidence.endLine ? `${evidence.startLine}` : `${evidence.startLine}-${evidence.endLine}`;
  return `${evidence.path}:${lines}`;
}

function findingItem(finding: ReviewFinding): ReadinessItem {
  const rule = finding.ruleId ? ` (${finding.ruleId})` : '';
  return {
    kind: 'finding', severity: finding.severity, findingId: finding.id, ruleId: finding.ruleId,
    title: `${finding.severity} ${finding.category}${rule}: ${finding.explanation}`,
    detail: `${finding.status} · ${location(finding)}`
  };
}

const bySeverity = (a: ReadinessItem, b: ReadinessItem) =>
  SEVERITY_ORDER[a.severity || 'low'] - SEVERITY_ORDER[b.severity || 'low'];

/** Keeps only well-formed decisions for findings that exist in the result. */
export function normalizeTriage(result: ReviewResult, triage: unknown): ReviewTriage {
  const normalized: ReviewTriage = {};
  if (!triage || typeof triage !== 'object') { return normalized; }
  const ids = new Set(result.findings.map(finding => finding.id));
  for (const [id, value] of Object.entries(triage as Record<string, unknown>)) {
    const entry = value as Partial<FindingTriage> | undefined;
    if (!ids.has(id) || !entry || (entry.decision !== 'fix' && entry.decision !== 'dismiss' && entry.decision !== 'fixed')) { continue; }
    if (entry.decision === 'fix' || entry.decision === 'fixed') { normalized[id] = { decision: entry.decision }; continue; }
    const reason = entry.reason && entry.reason in DISMISS_REASONS ? entry.reason : 'false_positive';
    normalized[id] = { decision: 'dismiss', reason };
  }
  return normalized;
}

/**
 * Blocking: verified critical/high findings and policy violations.
 * Needs attention: everything else that is not a clean result, most severe first, so an
 * unconfirmed critical hypothesis is listed ahead of everything else without blocking.
 * A finding the reviewer dismissed moves to `dismissed` and no longer affects readiness.
 */
export function assessReadiness(result: ReviewResult, triage: ReviewTriage = {}): ReviewReadiness {
  const blocking: ReadinessItem[] = [];
  const attention: ReadinessItem[] = [];
  const gaps: ReadinessItem[] = [];
  const dismissed: ReadinessItem[] = [];
  const fixed: ReadinessItem[] = [];
  let toFix = 0;
  let untriaged = 0;
  for (const finding of result.findings) {
    const item = findingItem(finding);
    const decision = triage[finding.id];
    if (decision) { item.triage = decision; }
    if (decision?.decision === 'dismiss') { dismissed.push(item); continue; }
    if (decision?.decision === 'fixed') { fixed.push(item); continue; }
    if (decision?.decision === 'fix') { toFix++; } else { untriaged++; }
    if (finding.status === 'verified' && BLOCKING_SEVERITIES.has(finding.severity)) { blocking.push(item); }
    else { attention.push(item); }
  }
  // A violation is corroborated by its compliance findings; once all of them are fixed or dismissed,
  // the violation no longer blocks either (it would keep a fixed review Blocked).
  const resolvedRule = (ruleId: string) => {
    const related = result.findings.filter(finding => finding.category === 'compliance' && finding.ruleId === ruleId);
    return related.length > 0 && related.every(finding => ['fixed', 'dismiss'].includes(triage[finding.id]?.decision || ''));
  };
  for (const policy of result.policyResults) {
    if (policy.status === 'violation' && resolvedRule(policy.ruleId)) { continue; }
    if (policy.status === 'violation') {
      blocking.push({ kind: 'policy', ruleId: policy.ruleId, title: `Policy violation: ${policy.ruleId}`, detail: policy.reason });
    } else if (policy.status === 'insufficient_evidence') {
      gaps.push({ kind: 'policy', ruleId: policy.ruleId, title: `Not established: ${policy.ruleId}`, detail: policy.reason });
    }
  }
  if (result.request.categories.includes('compliance') && result.policyStatus === 'not_configured') {
    gaps.push({ kind: 'policy', title: 'Compliance policy is not configured',
      detail: 'Add .repository-manager/review-policy.json at the reviewed revision to check team rules.' });
  }
  const coverage = summarizeCoverage(result);
  if (result.partial) {
    gaps.push({ kind: 'coverage', title: `The review stopped after ${result.partial.unitsDone} of ${result.partial.unitsTotal} components`,
      detail: 'The rest was not reviewed. Run the same review again to continue: finished components are reused.' });
  }
  if (!result.coverage.complete) {
    gaps.push({ kind: 'coverage', title: 'Review coverage is incomplete', detail: `${coverageLine(coverage)}.` });
  }
  blocking.sort(bySeverity);
  attention.sort(bySeverity);
  dismissed.sort(bySeverity);
  fixed.sort(bySeverity);
  // A gap still keeps a review from looking clean: what was not checked is not a pass.
  const status: ReadinessStatus = blocking.length ? 'blocked' : attention.length || gaps.length ? 'needs_attention' : 'no_blocking_findings';
  return { status, blocking, attention, gaps, dismissed, fixed, toFix, untriaged, coverage };
}

export function readinessLabel(status: ReadinessStatus): string {
  return status === 'blocked' ? 'Blocked' : status === 'needs_attention' ? 'Needs attention' : 'No blocking findings';
}

/** Model output and file paths are untrusted: keep them from becoming HTML or breaking table cells. */
function text(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s*\n\s*/g, ' ').trim();
}
function cell(value: string): string {
  return text(value).replace(/\|/g, '\\|');
}
function code(value: string): string {
  return `\`${String(value).replace(/`/g, "'")}\``;
}
const short = (sha?: string) => (sha ? sha.slice(0, 8) : '');

function triageLabel(triage?: FindingTriage): string {
  if (!triage) { return 'not triaged'; }
  if (triage.decision === 'fixed') { return 'fixed'; }
  return triage.decision === 'fix' ? 'marked to fix' : `dismissed: ${DISMISS_REASONS[triage.reason || 'false_positive'].toLowerCase()}`;
}

function findingMarkdown(finding: ReviewFinding, triage?: FindingTriage): string[] {
  const rule = finding.ruleId ? ` · ${code(finding.ruleId)}` : '';
  const evidence = finding.evidence
    .map(item => `${code(`${item.path}:${item.startLine === item.endLine ? item.startLine : `${item.startLine}-${item.endLine}`}`)} (${item.side} ${short(item.revision)})`)
    .join(', ');
  return [
    `- **${finding.severity.toUpperCase()} ${finding.category}**${rule} · ${finding.status} · confidence ${finding.confidence} · ${triageLabel(triage)}  `,
    `  ${text(finding.explanation)}  `,
    `  Evidence: ${evidence}  `,
    `  Impact: ${text(finding.impact)}  `,
    `  Suggested action: ${text(finding.suggestedAction)}`
  ];
}

export function renderReviewMarkdown(result: ReviewResult, context: ReviewReportContext, triage: ReviewTriage = {}): string {
  const readiness = assessReadiness(result, triage);
  const { request, coverage } = result;
  const range = request.scope === 'changes'
    ? `${code(context.baseLabel || short(request.baseSha) || 'parent')} (${short(request.baseSha) || 'root'}) → ${code(context.targetLabel)} (${short(request.targetSha)})`
    : `Every file at ${code(context.targetLabel)} (${short(request.targetSha)})`;
  const title = `${context.kind === 'release' ? 'Current branch review' : 'Security and compliance review'} — ${request.scope === 'changes'
    ? `Diff: ${context.baseLabel || short(request.baseSha) || 'parent'} → ${context.targetLabel}`
    : `Branch: ${context.targetLabel}`}`;
  const findingsById = new Map(result.findings.map(finding => [finding.id, finding]));
  const lines: string[] = [
    `# ${text(title)}`,
    '',
    '| | |',
    '|---|---|',
    `| Repository | ${cell(context.repositoryName)} |`,
    `| Range | ${range} |`,
    `| Categories | ${request.categories.join(', ')} |`,
    `| Policy | ${result.policyStatus === 'configured' ? `configured (${short(request.policyHash)})` : 'not configured'} |`,
    `| Model | ${cell(result.modelId || 'n/a')} |`,
    `| Generated | ${context.generatedAt.toISOString()} |`,
    '',
    `**Readiness: ${readinessLabel(readiness.status)}** (${readiness.blocking.length} blocking, ${readiness.attention.length} needing attention, ${readiness.gaps.length} review gaps)`,
    '',
    `Triage: ${readiness.toFix} marked to fix, ${readiness.fixed.length} fixed, ${readiness.dismissed.length} dismissed, ${readiness.untriaged} not triaged.`,
    '',
    '> Advisory AI-assisted review. "Verified" means the cited evidence passed mechanical checks and a second AI ' +
      'assessment supported the finding; it is not proof of exploitability. No findings does not mean no vulnerabilities, ' +
      'and checks that were not run or not completed are not passes.',
    ''
  ];
  const section = (heading: string, items: ReadinessItem[]) => {
    lines.push(`## ${heading}`, '');
    if (!items.length) { lines.push('None.', ''); return; }
    for (const item of items) {
      const finding = item.findingId ? findingsById.get(item.findingId) : undefined;
      if (finding) { lines.push(...findingMarkdown(finding, item.triage)); }
      else { lines.push(`- **${text(item.title)}**  `, `  ${text(item.detail)}`); }
    }
    lines.push('');
  };
  section('Blocking', readiness.blocking);
  section('Needs attention', readiness.attention);
  if (readiness.gaps.length) { section('Review gaps', readiness.gaps); }
  if (readiness.fixed.length) { section('Fixed', readiness.fixed); }
  if (readiness.dismissed.length) { section('Dismissed by reviewer', readiness.dismissed); }
  if (result.policyResults.length) {
    lines.push('## Policy results', '', '| Rule | Result | Reason |', '|---|---|---|');
    for (const policy of result.policyResults) {
      lines.push(`| ${code(policy.ruleId)} | ${policy.status.replace(/_/g, ' ')} | ${cell(policy.reason)} |`);
    }
    lines.push('');
  }
  lines.push('## Coverage', '', `${coverageLine(readiness.coverage)}. Complete: ${coverage.complete ? 'yes' : 'no'}.`, '');
  const gaps = [...coverage.skipped.map(item => ({ ...item, kind: item.partial || /^Partly reviewed/.test(item.reason) ? 'partly reviewed' : 'skipped' })),
    ...coverage.failed.map(item => ({ ...item, kind: 'failed' }))];
  if (gaps.length) {
    lines.push('<details><summary>Partly reviewed, skipped and failed</summary>', '');
    for (const gap of gaps.slice(0, 100)) { lines.push(`- ${gap.kind}: ${code(gap.path)} — ${text(gap.reason)}`); }
    if (gaps.length > 100) { lines.push(`- … and ${gaps.length - 100} more`); }
    lines.push('', '</details>', '');
  }
  if ((result.toVerify || []).length) {
    lines.push('## To verify', '', 'What the model could not see from the reviewed files; check these by hand.', '',
      ...(result.toVerify || []).map(item => `- ${text(item)}`), '');
  }
  if (result.limitations.length) {
    lines.push('## Limitations', '', ...result.limitations.map(item => `- ${text(item)}`), '');
  }
  return lines.join('\n');
}
