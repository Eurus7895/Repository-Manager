/**
 * Decisions taken on a finding in an earlier review of the same repository carry over to the same
 * finding in a new review, so a dismissed or known issue is not triaged again. "The same" is the
 * finding's fingerprint: category, rule, file and the text of the cited lines, not the model's
 * wording, so it survives a re-run and moved lines, and changes once the cited code is edited.
 *
 * - Dismissed earlier: dismissed again, with the same reason.
 * - Marked Needs fix earlier: Needs fix again.
 * - Fixed earlier, yet reported again on the same code: Needs fix, flagged as reported again, since
 *   the fix did not reach this commit or did not remove the issue.
 */

import { ReviewFinding, ReviewTriage } from './types';

export interface EarlierReview {
  generatedAt: string;
  findings: ReviewFinding[];
  triage: ReviewTriage;
}

/** `earlier` is newest first; the newest decision on a fingerprint wins. */
export function carryTriage(findings: ReviewFinding[], earlier: EarlierReview[]): ReviewTriage {
  const known = new Map<string, { decision: 'fix' | 'dismiss' | 'fixed'; reason?: ReviewTriage[string]['reason']; at: string }>();
  for (const review of earlier) {
    for (const finding of review.findings) {
      const decision = finding.fingerprint ? review.triage[finding.id] : undefined;
      if (decision && !known.has(finding.fingerprint!)) {
        // A carried "reported again after Fixed" keeps saying where it came from.
        const origin = decision.carried?.decision === 'fixed' && decision.decision === 'fix' ? decision.carried : undefined;
        known.set(finding.fingerprint!, origin ? { decision: 'fixed', at: origin.at }
          : { decision: decision.decision, reason: decision.reason, at: decision.carried?.at || review.generatedAt });
      }
    }
  }
  const triage: ReviewTriage = {};
  for (const finding of findings) {
    const previous = finding.fingerprint ? known.get(finding.fingerprint) : undefined;
    if (!previous) { continue; }
    const carried = { at: previous.at, decision: previous.decision };
    triage[finding.id] = previous.decision === 'dismiss'
      ? { decision: 'dismiss', ...(previous.reason ? { reason: previous.reason } : {}), carried }
      : { decision: 'fix', carried };
  }
  return triage;
}
