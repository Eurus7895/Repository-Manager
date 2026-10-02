/**
 * Completed reviews kept for checking later: findings, coverage and triage, in workspace state
 * (private to this machine and workspace, never in the repository). Keyed by absolute
 * repository root; the newest MAX_PER_REPOSITORY reviews of each repository are kept.
 */

import { ReviewResult, ReviewTriage } from './types';
import { MementoLike } from './reviewConsent';
import { assessReadiness, normalizeTriage } from './services/reviewReport';

const KEY = 'repositoryManager.reviewHistory';
export const MAX_PER_REPOSITORY = 20;
/** Skipped and failed files beyond this are dropped from a stored review (the dashboard shows 200). */
export const MAX_STORED_GAPS = 200;

export interface StoredReviewContext {
  kind: 'review' | 'release';
  repositoryName: string;
  baseLabel?: string;
  targetLabel: string;
  /** ISO 8601. */
  generatedAt: string;
}

export interface ReviewHistoryEntry {
  id: string;
  /** Absolute root of the reviewed repository. */
  repositoryRoot: string;
  /** The workspace folder the review ran in, and the repository path relative to it. */
  workspaceRoot: string;
  repositoryPath: string;
  context: StoredReviewContext;
  result: ReviewResult;
  triage: ReviewTriage;
}

/** One row of the Past reviews list. */
export interface ReviewHistorySummary {
  id: string;
  generatedAt: string;
  kind: 'review' | 'release';
  scope: 'changes' | 'branch';
  baseLabel?: string;
  targetLabel: string;
  targetSha: string;
  status: ReturnType<typeof assessReadiness>['status'];
  blocking: number;
  attention: number;
  dismissed: number;
  toFix: number;
  findings: number;
  modelId?: string;
  /** The reviewed commit is no longer the repository's HEAD (unknown HEAD: false). */
  outdated: boolean;
}

function isEntry(value: unknown): value is ReviewHistoryEntry {
  const entry = value as ReviewHistoryEntry;
  return Boolean(entry && typeof entry.id === 'string' && typeof entry.repositoryRoot === 'string' &&
    typeof entry.workspaceRoot === 'string' && typeof entry.repositoryPath === 'string' &&
    entry.context && typeof entry.context.generatedAt === 'string' && entry.result && Array.isArray(entry.result.findings) &&
    entry.result.request && entry.result.coverage);
}

/** Keeps a stored review small: long skipped/failed lists are cut, with a count of what was dropped. */
export function compactResult(result: ReviewResult): ReviewResult {
  const { skipped, failed } = result.coverage;
  if (skipped.length + failed.length <= MAX_STORED_GAPS) { return result; }
  const keptSkipped = skipped.slice(0, MAX_STORED_GAPS);
  const keptFailed = failed.slice(0, Math.max(0, MAX_STORED_GAPS - keptSkipped.length));
  const dropped = skipped.length + failed.length - keptSkipped.length - keptFailed.length;
  return { ...result,
    coverage: { ...result.coverage, skipped: keptSkipped, failed: keptFailed },
    limitations: [...result.limitations, `The saved review lists ${MAX_STORED_GAPS} skipped or failed files; ${dropped} more were left out to keep it small.`] };
}

export function summarize(entry: ReviewHistoryEntry, head?: string): ReviewHistorySummary {
  const readiness = assessReadiness(entry.result, entry.triage);
  return {
    id: entry.id, generatedAt: entry.context.generatedAt, kind: entry.context.kind, scope: entry.result.request.scope,
    baseLabel: entry.context.baseLabel, targetLabel: entry.context.targetLabel, targetSha: entry.result.request.targetSha,
    status: readiness.status, blocking: readiness.blocking.length, attention: readiness.attention.length,
    dismissed: readiness.dismissed.length, toFix: readiness.toFix, findings: entry.result.findings.length, modelId: entry.result.modelId,
    outdated: Boolean(head) && entry.result.request.targetSha !== head
  };
}

export class ReviewHistoryStore {
  private counter = 0;

  constructor(private readonly memento?: MementoLike, private readonly now: () => number = Date.now) {}

  private all(): ReviewHistoryEntry[] {
    const value = this.memento?.get<unknown>(KEY);
    return Array.isArray(value) ? value.filter(isEntry) : [];
  }

  private async write(entries: ReviewHistoryEntry[]): Promise<void> {
    if (this.memento) { await this.memento.update(KEY, entries); }
  }

  /** Newest first. */
  list(repositoryRoot: string): ReviewHistoryEntry[] {
    return this.all().filter(entry => entry.repositoryRoot === repositoryRoot)
      .sort((a, b) => b.context.generatedAt.localeCompare(a.context.generatedAt));
  }

  get(id: string): ReviewHistoryEntry | undefined {
    return this.all().find(entry => entry.id === id);
  }

  async add(entry: Omit<ReviewHistoryEntry, 'id' | 'result'> & { result: ReviewResult }): Promise<ReviewHistoryEntry> {
    const stored: ReviewHistoryEntry = { ...entry, id: `${this.now().toString(36)}-${(this.counter++).toString(36)}`,
      result: compactResult(entry.result), triage: normalizeTriage(entry.result, entry.triage) };
    const others = this.all();
    const keep = new Set([stored, ...this.list(entry.repositoryRoot)].slice(0, MAX_PER_REPOSITORY).map(item => item.id));
    await this.write([...others.filter(item => item.repositoryRoot !== entry.repositoryRoot || keep.has(item.id)), stored]);
    return stored;
  }

  async setTriage(id: string, triage: ReviewTriage): Promise<void> {
    const entries = this.all();
    const entry = entries.find(item => item.id === id);
    if (!entry) { return; }
    entry.triage = normalizeTriage(entry.result, triage);
    await this.write(entries);
  }

  async remove(id: string): Promise<boolean> {
    const entries = this.all();
    const next = entries.filter(entry => entry.id !== id);
    if (next.length === entries.length) { return false; }
    await this.write(next);
    return true;
  }
}
