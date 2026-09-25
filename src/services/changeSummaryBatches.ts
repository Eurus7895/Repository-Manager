import { ChangeContextPacket, ChangeSummary, SummaryClaim } from '../types';

export const SUMMARY_BATCH_BYTES = 22000;
export const MAX_SUMMARY_BATCHES = 16;

/** Split a patch on line boundaries; oversized individual lines are split on UTF-8 character boundaries. */
export function splitPatch(patch: string, limit = SUMMARY_BATCH_BYTES): string[] {
  if (!Number.isInteger(limit) || limit < 4) {throw new Error('Invalid summary batch size');}
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const line of patch.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (current && bytes + lineBytes > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    if (lineBytes > limit) {
      for (const character of line) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > limit) {
          parts.push(current);
          current = '';
          bytes = 0;
        }
        current += character;
        bytes += size;
      }
    } else {
      current += line;
      bytes += lineBytes;
    }
  }
  if (current) {parts.push(current);}
  return parts;
}

/** Bound each model request while preserving every included patch byte. */
export function buildSummaryBatches(packet: ChangeContextPacket, limit = SUMMARY_BATCH_BYTES): ChangeContextPacket[] {
  const groups: ChangeContextPacket['patches'][] = [];
  const omittedPaths = new Set<string>();
  let group: ChangeContextPacket['patches'] = [];
  let bytes = 0;
  for (const { path, patch } of packet.patches) {
    for (const segment of splitPatch(patch, limit)) {
      const size = Buffer.byteLength(segment, 'utf8');
      if (group.length && bytes + size > limit) {
        groups.push(group);
        group = [];
        bytes = 0;
      }
      if (groups.length >= MAX_SUMMARY_BATCHES) {
        omittedPaths.add(path);
        continue;
      }
      group.push({ path, patch: segment });
      bytes += size;
    }
  }
  if (group.length) {groups.push(group);}
  for (const path of omittedPaths) {
    packet.coverage.omitted.push(`${path}: some patch segments exceed the model request limit`);
  }
  const represented = new Set(groups.flatMap(patches => patches.map(part => part.path)));
  packet.coverage.includedFiles = represented.size;
  return groups.map(patches => {
    const names = new Set(patches.map(part => part.path));
    return { ...packet, files: packet.files.filter(file => names.has(file.path)), patches,
      coverage: { ...packet.coverage, includedFiles: names.size, omitted: [] } };
  });
}

/** Synthesize only validated claims from the independent batches, without another ungrounded model pass. */
export function combineBatchSummaries(packet: ChangeContextPacket, summaries: ChangeSummary[]): ChangeSummary {
  const unique = (claims: SummaryClaim[]) => {
    const seen = new Set<string>();
    return claims.filter(item => {
      const key = JSON.stringify([item.text, item.evidence]);
      if (seen.has(key)) {return false;}
      seen.add(key);
      return true;
    }).slice(0, 20);
  };
  const intents = unique(summaries.map(summary => summary.intent));
  const intent = intents[0] || { text: 'No patch content was available for an AI summary.', evidence: [] };
  const keys = ['behaviorChanges', 'affectedAreas', 'dependencyConfigChanges', 'possibleBreakingChanges', 'riskHints', 'suggestedTests'] as const;
  const sections = {} as Pick<ChangeSummary, typeof keys[number]>;
  for (const key of keys) {
    sections[key] = unique(summaries.flatMap(summary => summary[key]));
  }
  sections.behaviorChanges = unique([...intents.slice(1), ...sections.behaviorChanges]);
  return { ...sections, intent, repositoryPath: packet.repositoryPath, baseSha: packet.baseSha,
    targetSha: packet.targetSha, root: packet.root, coverage: packet.coverage,
    limitations: [...new Set(summaries.flatMap(summary => summary.limitations))].slice(0, 20) };
}
