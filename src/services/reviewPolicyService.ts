import { createHash } from 'crypto';
import { ReviewSnapshot } from './reviewSnapshotService';

export const REVIEW_POLICY_PATH = '.repository-manager/review-policy.json';
export interface ReviewPolicyRule {
  id: string;
  description: string;
  scope: { include: string[]; exclude?: string[] };
  severity: 'critical' | 'high' | 'medium' | 'low';
  verification: 'static' | 'ai' | 'manual';
  requiredEvidence: string;
}
export interface ReviewPolicy { version: 1; rules: ReviewPolicyRule[] }
export type LoadedReviewPolicy =
  | { status: 'not_configured'; revision: string }
  | { status: 'configured'; revision: string; hash: string; policy: ReviewPolicy };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function patterns(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 100 &&
    value.every(pattern => typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 200 &&
      !pattern.includes('\0') && !pattern.startsWith('/') && !pattern.split('/').includes('..'));
}

export function parseReviewPolicy(text: string): ReviewPolicy {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`${REVIEW_POLICY_PATH}: invalid JSON`); }
  if (!record(data) || data.version !== 1 || !Array.isArray(data.rules) || data.rules.length > 200) {
    throw new Error(`${REVIEW_POLICY_PATH}: expected version 1 and a rules array (max 200)`);
  }
  const ids = new Set<string>();
  for (const [index, value] of data.rules.entries()) {
    const where = `${REVIEW_POLICY_PATH}: rule ${index + 1}`;
    if (!record(value) || typeof value.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.id)) {
      throw new Error(`${where} needs a valid id`);
    }
    if (ids.has(value.id)) {throw new Error(`${where} duplicates id ${value.id}`);}
    ids.add(value.id);
    if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2000 ||
        typeof value.requiredEvidence !== 'string' || !value.requiredEvidence.trim() || value.requiredEvidence.length > 2000) {
      throw new Error(`${where} needs description and requiredEvidence`);
    }
    if (!record(value.scope) || !patterns(value.scope.include) ||
        (value.scope.exclude !== undefined && !patterns(value.scope.exclude, true))) {
      throw new Error(`${where} needs a valid scope.include and optional scope.exclude`);
    }
    if (!['critical', 'high', 'medium', 'low'].includes(String(value.severity)) ||
        !['static', 'ai', 'manual'].includes(String(value.verification))) {
      throw new Error(`${where} needs valid severity and verification`);
    }
  }
  return data as unknown as ReviewPolicy;
}

/** Read only committed policy from the same revision as the source being reviewed. */
export class ReviewPolicyService {
  async load(snapshot: ReviewSnapshot): Promise<LoadedReviewPolicy> {
    if (!snapshot.fileExists(REVIEW_POLICY_PATH)) {
      if (snapshot.tree.truncated) {
        throw new Error(`${REVIEW_POLICY_PATH}: cannot determine policy presence because the snapshot tree was truncated`);
      }
      return { status: 'not_configured', revision: snapshot.targetSha };
    }
    const file = await snapshot.readFile(REVIEW_POLICY_PATH, 1, 500);
    if (file.truncated) {throw new Error(`${REVIEW_POLICY_PATH}: policy exceeds 500 lines`);}
    const policy = parseReviewPolicy(file.content);
    return {
      status: 'configured', revision: snapshot.targetSha,
      hash: createHash('sha256').update(file.content).digest('hex'), policy
    };
  }
}
