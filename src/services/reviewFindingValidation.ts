import { createHash } from 'crypto';
import { PolicyRuleResult, ReviewEvidence, ReviewFinding } from '../types';
import { ReviewPolicyRule } from './reviewPolicyService';
import { appliesToPath, ReviewPlan, ReviewWorkUnit } from './reviewSurveyService';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function validateReviewEvidence(value: unknown, plan: ReviewPlan): Promise<ReviewEvidence | undefined> {
  if (!record(value) || typeof value.path !== 'string' ||
      !['base', 'target'].includes(String(value.side)) ||
      !Number.isInteger(value.startLine) || !Number.isInteger(value.endLine)) {
    return undefined;
  }
  const startLine = value.startLine as number;
  const endLine = value.endLine as number;
  if (startLine < 1 || endLine < startLine || endLine - startLine > 20) { return undefined; }
  const side = value.side as 'base' | 'target';
  const source = side === 'base' ? plan.base : plan.snapshot;
  if (!source || value.revision !== source.targetSha ||
      (plan.request.scope === 'changes' && !plan.changedPaths.includes(value.path) &&
        !(side === 'base' && Object.values(plan.oldPaths).includes(value.path)))) {
    return undefined;
  }
  try {
    const file = await source.readFile(value.path, startLine, endLine - startLine + 1);
    if (file.endLine !== endLine) { return undefined; }
    if (plan.request.scope === 'changes' && plan.base) {
      const diff = await plan.snapshot.readDiff(plan.base.targetSha, value.path);
      if (diff.truncated) { return undefined; }
      const changed = changedLines(diff.patch, side);
      if (![...changed].some(line => line >= startLine && line <= endLine)) { return undefined; }
    }
    return { revision: source.targetSha, path: file.path, side, startLine, endLine };
  } catch {
    return undefined;
  }
}

/** Track actual +/- lines rather than accepting arbitrary context lines from a diff hunk. */
export function changedLines(patch: string, side: 'base' | 'target'): Set<number> {
  const changed = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      if (side === 'target') { changed.add(newLine); }
      newLine++;
    } else if (inHunk && line.startsWith('-')) {
      if (side === 'base') { changed.add(oldLine); }
      oldLine++;
    } else if (inHunk && line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return changed;
}

/** Evidence must come from a file in the batch; base-side evidence may use a renamed file's old path. */
function inUnit(evidence: ReviewEvidence, plan: ReviewPlan, unit: ReviewWorkUnit): boolean {
  return unit.paths.includes(evidence.path) ||
    (evidence.side === 'base' && unit.paths.some(path => plan.oldPaths[path] === evidence.path));
}

/** Compliance evidence must also lie inside the cited rule's scope (by the file's current path). */
function inRuleScope(evidence: ReviewEvidence, rule: ReviewPolicyRule, plan: ReviewPlan, unit: ReviewWorkUnit): boolean {
  return appliesToPath(rule, evidence.path) || (evidence.side === 'base' &&
    unit.paths.some(path => plan.oldPaths[path] === evidence.path && appliesToPath(rule, path)));
}

export async function validateReviewFinding(raw: unknown, plan: ReviewPlan, unit: ReviewWorkUnit): Promise<ReviewFinding | undefined> {
  if (!record(raw) || !['security', 'compliance'].includes(String(raw.category)) ||
      !plan.request.categories.includes(raw.category as 'security' | 'compliance') ||
      !['critical', 'high', 'medium', 'low'].includes(String(raw.severity)) ||
      !['high', 'medium', 'low'].includes(String(raw.confidence)) ||
      !Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 8) {
    return undefined;
  }
  const fields = ['explanation', 'impact', 'suggestedAction'] as const;
  if (fields.some(key => typeof raw[key] !== 'string' || !(raw[key] as string).trim() || (raw[key] as string).length > 2000)) {
    return undefined;
  }
  if (raw.category === 'compliance' && (typeof raw.ruleId !== 'string' || !unit.rules.some(rule => rule.id === raw.ruleId))) {
    return undefined;
  }
  const rule = raw.category === 'compliance' ? unit.rules.find(item => item.id === raw.ruleId) : undefined;
  const evidence: ReviewEvidence[] = [];
  for (const item of raw.evidence) {
    const verified = await validateReviewEvidence(item, plan);
    if (!verified || !inUnit(verified, plan, unit) || (rule && !inRuleScope(verified, rule, plan, unit))) {
      return undefined;
    }
    evidence.push(verified);
  }
  const id = createHash('sha256').update(JSON.stringify([raw.category, raw.ruleId, raw.explanation, evidence])).digest('hex').slice(0, 16);
  return { id, category: raw.category as ReviewFinding['category'],
    ruleId: raw.category === 'compliance' ? raw.ruleId as string : undefined,
    severity: raw.severity as ReviewFinding['severity'], confidence: raw.confidence as ReviewFinding['confidence'],
    explanation: (raw.explanation as string).trim(), impact: (raw.impact as string).trim(),
    suggestedAction: (raw.suggestedAction as string).trim(), evidence, status: 'candidate' };
}

export async function validatePolicyResult(raw: unknown, plan: ReviewPlan, unit: ReviewWorkUnit): Promise<PolicyRuleResult | undefined> {
  if (!record(raw) || typeof raw.ruleId !== 'string' || !unit.rules.some(rule => rule.id === raw.ruleId) ||
      !['pass', 'violation', 'insufficient_evidence', 'not_applicable'].includes(String(raw.status)) ||
      typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 1000 ||
      !Array.isArray(raw.evidence) || raw.evidence.length > 8) { return undefined; }
  const rule = unit.rules.find(item => item.id === raw.ruleId)!;
  const evidence: ReviewEvidence[] = [];
  for (const value of raw.evidence) {
    const verified = await validateReviewEvidence(value, plan);
    if (!verified || !inUnit(verified, plan, unit) || !inRuleScope(verified, rule, plan, unit)) { return undefined; }
    evidence.push(verified);
  }
  if (['pass', 'violation'].includes(raw.status as string) && !evidence.length) { return undefined; }
  return { ruleId: raw.ruleId, status: raw.status as PolicyRuleResult['status'],
    reason: raw.reason.trim(), evidence };
}
