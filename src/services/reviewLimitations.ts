/**
 * Turns the limitations every component's model response reports into a short list.
 *
 * A review asks the model once per component, and each answer tends to restate the same
 * things: that no policy is configured, which files were in scope, that no flaw was found,
 * and that content was truncated. The report already states each of those once (the policy
 * status line, the coverage section, the closing caveat, the skipped files), so those
 * sentences are dropped here and truncation becomes a single note. Anything else, such as
 * "behaviour depends on callers that were not supplied", is kept, once.
 */

const TRUNCATION_NOTE = 'Some in-scope files were truncated for the model; conclusions cover only the visible content.';

// Each pattern matches one whole sentence or clause.
const SCOPE = [
  /^(the )?review (was )?limited to\b/i,
  /^reviewed only\b/i,
  /^only\b.*\b(was|were)\b.*\b(reviewed|in scope|provided|supplied)\b/i,
  /^the requested scope (contains|was|is)\b/i
];
const NO_FLAW = [
  /\b(no|not)\b.*\bconcrete\b.*\b(flaw|vulnerabilit|issue|risk)/i,
  /^no (security )?(flaw|vulnerabilit|issue)s? (was|were|is|are) (found|identified|evident|established)/i
];
const NO_POLICY = /\b(polic(y|ies)|compliance|rules?)\b/i;
const NOT_PROVIDED = /\b(no|not|without)\b.*\b(configured|provided|supplied|assess|evaluat|establish|status|available)/i;

function clauses(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/).map(part => part.trim()).filter(Boolean);
}

function sentence(clause: string): string {
  const trimmed = clause.replace(/[;,]\s*$/, '').trim();
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function consolidateLimitations(raw: string[], options: { policyConfigured: boolean }): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of raw) {
    for (const clause of clauses(item)) {
      // "…truncated; conclusions are limited to the visible evidence" is one point, said once below.
      if (/\btruncat/i.test(clause) || /\bvisible (evidence|content)\b/i.test(clause)) { truncated = true; continue; }
      if (SCOPE.some(pattern => pattern.test(clause))) { continue; }
      if (NO_FLAW.some(pattern => pattern.test(clause))) { continue; }
      // Without a policy the engine says so once; with one, a model note about rules may matter.
      if (!options.policyConfigured && NO_POLICY.test(clause) && NOT_PROVIDED.test(clause)) { continue; }
      const text = sentence(clause);
      const id = key(text);
      if (id && !seen.has(id)) { seen.add(id); kept.push(text); }
    }
  }
  if (truncated) { kept.push(TRUNCATION_NOTE); }
  return kept;
}
