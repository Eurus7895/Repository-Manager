/**
 * Decisions taken on a finding in an earlier review of the same repository carry over to the same
 * finding in a new review, so a dismissed or known issue is not triaged again. "The same" is the
 * finding's fingerprint (category, rule, file and the text of the cited lines, not the model's
 * wording), confirmed by what the finding is about: two different issues can cite the same line.
 *
 * - Dismissed earlier: dismissed again, with the same reason.
 * - Marked Needs fix earlier: Needs fix again.
 * - Fixed earlier, yet reported again on the same code: Needs fix, flagged as reported again, since
 *   the fix did not reach this commit or did not remove the issue.
 * - Undone earlier (the newest review with the finding has no decision): nothing is carried, not
 *   even an older decision.
 */

import { ReviewFinding, ReviewTriage } from './types';

export interface EarlierReview {
  generatedAt: string;
  findings: ReviewFinding[];
  triage: ReviewTriage;
}

type Known = { finding: ReviewFinding; decision?: 'fix' | 'dismiss' | 'fixed'; reason?: ReviewTriage[string]['reason']; at?: string };

const STOP = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'which', 'where', 'there', 'their', 'than', 'then', 'have', 'been',
  'line', 'lines', 'file', 'code', 'value', 'values', 'uses', 'used', 'using', 'without', 'through', 'could', 'would', 'should', 'because']);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g)?.filter(word => !STOP.has(word)) || []);

/**
 * Whether two findings with one fingerprint are one issue: the same skill when both name one, and
 * explanations that share their key words (a secret and an injection on one line share none).
 */
export function sameIssue(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.skill && b.skill && a.skill !== b.skill) { return false; }
  const left = words(a.explanation);
  const right = words(b.explanation);
  if (!left.size || !right.size) { return false; }
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / Math.min(left.size, right.size) >= 0.25;
}

/** `earlier` is newest first; the newest review that has the finding decides. */
export function carryTriage(findings: ReviewFinding[], earlier: EarlierReview[]): ReviewTriage {
  const known = new Map<string, Known[]>();
  const seen = new Set<string>();
  for (const review of earlier) {
    const here = new Map<string, Known[]>();
    for (const finding of review.findings) {
      if (!finding.fingerprint || seen.has(finding.fingerprint)) { continue; }
      const decision = review.triage[finding.id];
      // A carried "reported again after Fixed" keeps saying where it came from.
      const origin = decision?.carried?.decision === 'fixed' && decision.decision === 'fix' ? decision.carried : undefined;
      const entry: Known = !decision ? { finding }
        : origin ? { finding, decision: 'fixed', at: origin.at }
          : { finding, decision: decision.decision, reason: decision.reason, at: decision.carried?.at || review.generatedAt };
      here.set(finding.fingerprint, [...(here.get(finding.fingerprint) || []), entry]);
    }
    for (const [fingerprint, entries] of here) { known.set(fingerprint, entries); seen.add(fingerprint); }
  }
  const triage: ReviewTriage = {};
  for (const finding of findings) {
    const candidates = (finding.fingerprint ? known.get(finding.fingerprint) : undefined)?.filter(entry => sameIssue(entry.finding, finding)) || [];
    // Nothing matches, the match was undone, or more than one earlier issue could be meant.
    if (candidates.length !== 1 || !candidates[0].decision) { continue; }
    const previous = candidates[0];
    const carried = { at: previous.at!, decision: previous.decision! };
    triage[finding.id] = previous.decision === 'dismiss'
      ? { decision: 'dismiss', ...(previous.reason ? { reason: previous.reason } : {}), carried }
      : { decision: 'fix', carried };
  }
  return triage;
}
