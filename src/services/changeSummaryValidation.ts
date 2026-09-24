import { ChangeContextPacket, ChangeSummary, SummaryClaim } from '../types';

const SECTIONS = ['behaviorChanges', 'affectedAreas', 'dependencyConfigChanges', 'possibleBreakingChanges', 'riskHints', 'suggestedTests'] as const;

/** Normalize references the model may format as links, paths with line numbers, or short SHAs. */
function resolveEvidence(value: unknown, packet: ChangeContextPacket): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    value = item.path ?? item.file ?? item.commit ?? item.sha;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const ref = value.trim().replace(/^[`"']|[`"']$/g, '').replace(/^file:\s*/i, '');
  const pathRef = ref.replace(/(?:#L\d+|:\d+(?::\d+)?)$/, '');
  for (const file of packet.files) {
    if ([file.path, file.oldPath].filter(Boolean).some(path =>
      pathRef === path || pathRef === `a/${path}` || pathRef === `b/${path}`)) {
      return file.path;
    }
  }
  if (/^[a-f0-9]{7,40}$/i.test(ref)) {
    const matches = packet.commits.filter(commit => commit.hash.startsWith(ref));
    if (matches.length === 1) {
      return matches[0].hash;
    }
  }
  return undefined;
}

export function validateSummary(raw: string, packet: ChangeContextPacket): ChangeSummary {
  const source = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
  if (!source || source.schemaVersion !== 1 || source.baseSha !== packet.baseSha || source.targetSha !== packet.targetSha) {
    throw new Error('AI response does not match selected revisions or schema.');
  }
  let omittedClaims = 0;
  const claim = (value: unknown): SummaryClaim | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      omittedClaims++;
      return undefined;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1600 ||
      !Array.isArray(item.evidence) || item.evidence.length > 12) {
      omittedClaims++;
      return undefined;
    }
    const evidence = item.evidence.map(ref => resolveEvidence(ref, packet));
    if (evidence.some(ref => !ref) || (packet.files.length > 0 && evidence.length === 0)) {
      omittedClaims++;
      return undefined;
    }
    return { text: item.text.trim(), evidence: [...new Set(evidence as string[])] };
  };
  const predictedIntent = claim(source.intent);
  const intent = predictedIntent || {
    text: packet.files.length ? `Changes to ${packet.files.length} files (AI intent could not be verified).` : 'No changed files in this comparison.',
    evidence: packet.files.length ? [packet.files[0].path] : []
  };
  const sections = {} as Record<typeof SECTIONS[number], SummaryClaim[]>;
  for (const section of SECTIONS) {
    const items = source[section];
    if (!Array.isArray(items)) {
      omittedClaims++;
      sections[section] = [];
      continue;
    }
    sections[section] = items.slice(0, 20).map(claim).filter((item): item is SummaryClaim => Boolean(item));
    omittedClaims += Math.max(0, items.length - 20);
  }
  const limitations = Array.isArray(source.limitations)
    ? source.limitations.filter((item): item is string => typeof item === 'string' && item.length <= 500).slice(0, 20)
    : [];
  if (omittedClaims) {
    limitations.push(`${omittedClaims} AI claim(s) omitted because their format or evidence could not be verified.`);
  }
  return { ...sections, intent, limitations,
    repositoryPath: packet.repositoryPath, baseSha: packet.baseSha, targetSha: packet.targetSha,
    root: packet.root, coverage: packet.coverage };
}
