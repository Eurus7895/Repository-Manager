/**
 * Component results of earlier reviews, so a review that stopped (cancelled, VS Code closed, the
 * model failed half-way) continues where it left off instead of asking the model again.
 *
 * A component whose checks did not all pass is kept too, with what it still lacks (`repair`): running
 * the review again (Retry failed) asks only for those parts, and keeps everything that passed.
 *
 * A review reads pinned commits, so the same component at the same commits has the same content.
 * The key also holds the model, the prompt version and the instructions, so a result is reused only
 * when the model would have been asked exactly the same thing. Kept in workspace state (private to
 * this machine), at most MAX_ENTRIES and MAX_AGE_MS old; the oldest go first.
 */

import { createHash } from 'crypto';
import { PolicyRuleResult, ReviewFinding } from './types';
import { MementoLike } from './reviewConsent';

const KEY = 'repositoryManager.reviewUnitCache';
export const MAX_ENTRIES = 300;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ReviewVerdict = 'supported' | 'uncertain' | 'rejected';

/**
 * What a component still lacks after a failed check, and what the parts that passed were built
 * from, so that asking for the missing parts gives the same result as a clean first answer.
 */
export interface ReviewUnitRepair {
  /** Every finding that passed validation, before the second check; `findings` holds the kept ones. */
  candidates: ReviewFinding[];
  /** The second check's verdicts by finding id; a candidate with none is checked again. */
  verdicts: Record<string, ReviewVerdict>;
  /** Policy results as validated, before a violation is required to have a supported finding. */
  policyResults: PolicyRuleResult[];
  /** Findings that failed validation, as the model wrote them: asked for again with real citations. */
  invalid: unknown[];
  /** Rules with no valid result, or with conflicting ones: asked for again. */
  recheckRules: string[];
}

/** What one component adds to a review, after validation and verification. */
export interface ReviewUnitOutcome {
  /** Findings kept after the second assessment, with their status set. */
  findings: ReviewFinding[];
  /** Candidates the model reported (shown as progress). */
  candidates: number;
  policyResults: PolicyRuleResult[];
  skipped: { path: string; reason: string; partial?: boolean }[];
  limitations: string[];
  analyzed: number;
  /** Set when a check failed in a way that asking again for part of it can fix. */
  repair?: ReviewUnitRepair;
}

export interface ReviewUnitCacheLike {
  get(key: string): ReviewUnitOutcome | undefined;
  set(key: string, outcome: ReviewUnitOutcome): Promise<void>;
}

interface Entry { key: string; savedAt: number; outcome: ReviewUnitOutcome }

/** Everything that decides what the model is asked about one component. */
export interface ReviewUnitKeyParts {
  modelId: string;
  promptVersion: string;
  /** Extra instructions given to the model (e.g. review skills); empty when there are none. */
  instructions: string;
  targetSha: string;
  baseSha?: string;
  scope: string;
  categories: string[];
  component: string;
  paths: string[];
  rules: unknown;
}

export function reviewUnitKey(parts: ReviewUnitKeyParts): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, ...parts })).digest('hex');
}

export class ReviewUnitCache implements ReviewUnitCacheLike {
  constructor(private readonly memento?: MementoLike, private readonly now = () => Date.now()) {}

  private entries(): Entry[] {
    const value = this.memento?.get<unknown>(KEY);
    if (!Array.isArray(value)) { return []; }
    const oldest = this.now() - MAX_AGE_MS;
    return value.filter((entry): entry is Entry => Boolean(entry && typeof entry.key === 'string' &&
      typeof entry.savedAt === 'number' && entry.savedAt >= oldest && entry.outcome && Array.isArray(entry.outcome.findings)));
  }

  get(key: string): ReviewUnitOutcome | undefined {
    const entry = this.entries().find(item => item.key === key);
    // A copy: the review changes findings it merges.
    return entry ? JSON.parse(JSON.stringify(entry.outcome)) as ReviewUnitOutcome : undefined;
  }

  async set(key: string, outcome: ReviewUnitOutcome): Promise<void> {
    if (!this.memento) { return; }
    const kept = this.entries().filter(item => item.key !== key);
    kept.push({ key, savedAt: this.now(), outcome: JSON.parse(JSON.stringify(outcome)) as ReviewUnitOutcome });
    kept.sort((a, b) => b.savedAt - a.savedAt);
    await this.memento.update(KEY, kept.slice(0, MAX_ENTRIES));
  }

  /** Number of saved component results (for tests and diagnostics). */
  size(): number {
    return this.entries().length;
  }
}
