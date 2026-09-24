import { ChangeContextPacket, ChangeSummary, SummaryClaim } from '../types';

const SECTIONS = ['behaviorChanges', 'affectedAreas', 'dependencyConfigChanges', 'possibleBreakingChanges', 'riskHints', 'suggestedTests'] as const;

export function validateSummary(raw: string, packet: ChangeContextPacket): ChangeSummary {
  const source = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
  if (!source || source.schemaVersion !== 1 || source.baseSha !== packet.baseSha || source.targetSha !== packet.targetSha) {
    throw new Error('AI response does not match selected revisions or schema.');
  }
  const allowed = new Set([...packet.files.map(file => file.path), ...packet.commits.map(commit => commit.hash)]);
  const claim = (value: unknown): SummaryClaim => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid AI claim.');
    }
    const item = value as Record<string, unknown>;
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1600 ||
      !Array.isArray(item.evidence) || item.evidence.length > 12 ||
      !item.evidence.every(ref => typeof ref === 'string' && allowed.has(ref))) {
      throw new Error('AI response contains unsupported claims or evidence.');
    }
    return { text: item.text.trim(), evidence: item.evidence as string[] };
  };
  const intent = claim(source.intent);
  const sections = {} as Record<typeof SECTIONS[number], SummaryClaim[]>;
  for (const section of SECTIONS) {
    const items = source[section];
    if (!Array.isArray(items) || items.length > 20) {
      throw new Error('Invalid AI response section.');
    }
    sections[section] = items.map(claim);
  }
  if (!Array.isArray(source.limitations) || source.limitations.length > 20 ||
    !source.limitations.every(value => typeof value === 'string' && value.length <= 500)) {
    throw new Error('Invalid AI coverage limitations.');
  }
  return { ...sections, intent, limitations: source.limitations as string[],
    repositoryPath: packet.repositoryPath, baseSha: packet.baseSha, targetSha: packet.targetSha,
    root: packet.root, coverage: packet.coverage };
}
