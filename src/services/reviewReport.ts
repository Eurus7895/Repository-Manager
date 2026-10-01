/**
 * Release readiness and Markdown reports for security and compliance reviews.
 * Pure functions: no VS Code or Git access, so the dashboard and the exported
 * report always agree.
 */

import { ReviewFinding, ReviewResult } from '../types';

export type ReadinessStatus = 'blocked' | 'needs_attention' | 'no_blocking_findings';

export interface ReadinessItem {
  kind: 'finding' | 'policy' | 'coverage';
  severity?: ReviewFinding['severity'];
  title: string;
  detail: string;
  findingId?: string;
  ruleId?: string;
}

export interface ReviewReadiness {
  status: ReadinessStatus;
  blocking: ReadinessItem[];
  attention: ReadinessItem[];
}

export interface ReviewReportContext {
  /** 'release' for a release-range review. */
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

/**
 * Blocking: verified critical/high findings and policy violations.
 * Needs attention: everything else that is not a clean result, most severe first, so an
 * unconfirmed critical hypothesis is listed ahead of everything else without blocking.
 */
export function assessReadiness(result: ReviewResult): ReviewReadiness {
  const blocking: ReadinessItem[] = [];
  const attention: ReadinessItem[] = [];
  for (const finding of result.findings) {
    const item = findingItem(finding);
    if (finding.status === 'verified' && BLOCKING_SEVERITIES.has(finding.severity)) { blocking.push(item); }
    else { attention.push(item); }
  }
  for (const policy of result.policyResults) {
    if (policy.status === 'violation') {
      blocking.push({ kind: 'policy', ruleId: policy.ruleId, title: `Policy violation: ${policy.ruleId}`, detail: policy.reason });
    } else if (policy.status === 'insufficient_evidence') {
      attention.push({ kind: 'policy', ruleId: policy.ruleId, title: `Not established: ${policy.ruleId}`, detail: policy.reason });
    }
  }
  if (result.request.categories.includes('compliance') && result.policyStatus === 'not_configured') {
    attention.push({ kind: 'policy', title: 'Compliance policy is not configured',
      detail: 'Add .repository-manager/review-policy.json at the reviewed revision to check team rules.' });
  }
  if (!result.coverage.complete) {
    const { surveyed, analyzed, skipped, failed } = result.coverage;
    attention.push({ kind: 'coverage', title: 'Review coverage is incomplete',
      detail: `${analyzed} of ${surveyed} files analyzed; ${skipped.length} skipped, ${failed.length} failed checks.` });
  }
  blocking.sort(bySeverity);
  attention.sort(bySeverity);
  const status: ReadinessStatus = blocking.length ? 'blocked' : attention.length ? 'needs_attention' : 'no_blocking_findings';
  return { status, blocking, attention };
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

function findingMarkdown(finding: ReviewFinding): string[] {
  const rule = finding.ruleId ? ` · ${code(finding.ruleId)}` : '';
  const evidence = finding.evidence
    .map(item => `${code(`${item.path}:${item.startLine === item.endLine ? item.startLine : `${item.startLine}-${item.endLine}`}`)} (${item.side} ${short(item.revision)})`)
    .join(', ');
  return [
    `- **${finding.severity.toUpperCase()} ${finding.category}**${rule} · ${finding.status} · confidence ${finding.confidence}  `,
    `  ${text(finding.explanation)}  `,
    `  Evidence: ${evidence}  `,
    `  Impact: ${text(finding.impact)}  `,
    `  Suggested action: ${text(finding.suggestedAction)}`
  ];
}

export function renderReviewMarkdown(result: ReviewResult, context: ReviewReportContext): string {
  const readiness = assessReadiness(result);
  const { request, coverage } = result;
  const range = request.scope === 'changes'
    ? `${code(context.baseLabel || short(request.baseSha) || 'parent')} (${short(request.baseSha) || 'root'}) → ${code(context.targetLabel)} (${short(request.targetSha)})`
    : `Whole branch at ${code(context.targetLabel)} (${short(request.targetSha)})`;
  const title = context.kind === 'release'
    ? `Release review: ${context.baseLabel || short(request.baseSha)} → ${context.targetLabel}`
    : `Security and compliance review: ${context.targetLabel}`;
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
    `**Readiness: ${readinessLabel(readiness.status)}** (${readiness.blocking.length} blocking, ${readiness.attention.length} needing attention)`,
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
      if (finding) { lines.push(...findingMarkdown(finding)); }
      else { lines.push(`- **${text(item.title)}**  `, `  ${text(item.detail)}`); }
    }
    lines.push('');
  };
  section('Blocking', readiness.blocking);
  section('Needs attention', readiness.attention);
  if (result.policyResults.length) {
    lines.push('## Policy results', '', '| Rule | Result | Reason |', '|---|---|---|');
    for (const policy of result.policyResults) {
      lines.push(`| ${code(policy.ruleId)} | ${policy.status.replace(/_/g, ' ')} | ${cell(policy.reason)} |`);
    }
    lines.push('');
  }
  lines.push('## Coverage', '',
    `Surveyed ${coverage.surveyed}, analyzed ${coverage.analyzed}, skipped ${coverage.skipped.length}, failed checks ${coverage.failed.length}. ` +
      `Complete: ${coverage.complete ? 'yes' : 'no'}.`, '');
  const gaps = [...coverage.skipped.map(item => ({ ...item, kind: 'skipped' })), ...coverage.failed.map(item => ({ ...item, kind: 'failed' }))];
  if (gaps.length) {
    lines.push('<details><summary>Skipped and failed</summary>', '');
    for (const gap of gaps.slice(0, 100)) { lines.push(`- ${gap.kind}: ${code(gap.path)} — ${text(gap.reason)}`); }
    if (gaps.length > 100) { lines.push(`- … and ${gaps.length - 100} more`); }
    lines.push('', '</details>', '');
  }
  if (result.limitations.length) {
    lines.push('## Limitations', '', ...result.limitations.map(item => `- ${text(item)}`), '');
  }
  return lines.join('\n');
}
