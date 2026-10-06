/**
 * Review skills: short checklists given to the model with the files of a component, chosen by the
 * files' paths. The extension ships a set (resources/review-skills, written for this extension from
 * public standards such as OWASP ASVS, CWE Top 25, OpenSSF Scorecard and the AWS Security Pillar);
 * users can import their own Markdown file with the same header and turn any skill off.
 *
 * Skills are instructions the user chose, unlike text in the reviewed repository: the prompt treats
 * them as trusted guidance, so they are never read from the repository itself.
 */

import { createHash } from 'crypto';
import { matchesReviewPattern } from './reviewSurveyService';

export type ReviewSkillCategory = 'security' | 'quality';

export interface ReviewSkill {
  id: string;
  name: string;
  category: ReviewSkillCategory;
  appliesTo: string[];
  references: string;
  guidance: string;
  source: 'bundled' | 'imported';
}

/** What a component's model request receives, and what the report names. */
export interface AppliedSkills {
  skills: { id: string; name: string; category: ReviewSkillCategory; guidance: string }[];
  /** Skills that matched but did not fit in MAX_SKILL_CHARS. */
  omitted: string[];
  /** Hash of the guidance sent, part of the component cache key. */
  hash: string;
}

/** Guidance per component request, so skills cannot crowd out the code itself. */
export const MAX_SKILL_CHARS = 8000;
const MAX_IMPORTED_CHARS = 6000;
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;

/**
 * Reads a skill file: a header between `---` lines with `id`, `name`, `category`, `appliesTo` (a JSON
 * array of globs) and optional `references`, then the guidance. Returns an error message instead of
 * throwing, for import feedback.
 */
export function parseReviewSkill(text: string, source: ReviewSkill['source']): ReviewSkill | string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!match) { return 'The file must start with a header between --- lines.'; }
  const header: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (field) { header[field[1]] = field[2].trim(); }
  }
  const id = header.id || '';
  if (!ID.test(id)) { return 'id must be 2–49 lowercase letters, digits or dashes.'; }
  const category = header.category || 'security';
  if (category !== 'security' && category !== 'quality') { return 'category must be security or quality.'; }
  let appliesTo: unknown;
  try { appliesTo = JSON.parse(header.appliesTo || '["**/*"]'); } catch { return 'appliesTo must be a JSON array of globs, e.g. ["**/*.py"].'; }
  if (!Array.isArray(appliesTo) || !appliesTo.length || appliesTo.some(item => typeof item !== 'string' || !item || item.length > 200)) {
    return 'appliesTo must be a non-empty JSON array of globs.';
  }
  const guidance = match[2].trim();
  if (!guidance) { return 'The skill has no guidance after the header.'; }
  if (source === 'imported' && guidance.length > MAX_IMPORTED_CHARS) {
    return `The guidance is ${guidance.length} characters; keep it under ${MAX_IMPORTED_CHARS} so it leaves room for the code.`;
  }
  return { id, name: (header.name || id).slice(0, 80), category, appliesTo: appliesTo.slice(0, 50),
    references: (header.references || '').slice(0, 300), guidance, source };
}

/**
 * The skills for one component: enabled ones whose globs match any of its paths, for the categories
 * reviewed, bundled before imported, within MAX_SKILL_CHARS.
 */
export function selectReviewSkills(skills: ReviewSkill[], paths: string[], categories: string[], disabled: ReadonlySet<string>): AppliedSkills {
  const wanted = skills.filter(skill => !disabled.has(skill.id) &&
    (skill.category === 'quality' ? categories.includes('quality') : categories.includes('security')) &&
    paths.some(path => skill.appliesTo.some(pattern => matchesReviewPattern(pattern, path))));
  const chosen: AppliedSkills['skills'] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const skill of wanted) {
    if (used + skill.guidance.length > MAX_SKILL_CHARS) { omitted.push(skill.id); continue; }
    used += skill.guidance.length;
    chosen.push({ id: skill.id, name: skill.name, category: skill.category, guidance: skill.guidance });
  }
  const hash = chosen.length
    ? createHash('sha256').update(JSON.stringify(chosen.map(skill => [skill.id, skill.name, skill.category, skill.guidance]))).digest('hex').slice(0, 16) : '';
  return { skills: chosen, omitted, hash };
}
