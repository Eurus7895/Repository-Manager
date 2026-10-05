/**
 * Turns the limitations every component's model response reports into a short "to verify" list.
 *
 * A review asks the model once per component, and each answer tends to restate the same
 * things: which files were in scope, that they contain no sinks, that no flaw was found, that a
 * file was not read, and that content was truncated. The report already states those once (the
 * coverage section, the closing caveat, the partly reviewed files), so those sentences are
 * dropped here and truncation becomes a single note.
 *
 * Each limitation stays one item: a sentence like "The severity depends on that configuration"
 * only makes sense after the one before it, so sentences are classified one by one but kept
 * together. Context sentences ("X was not read") are kept only beside a substantive one.
 * The model's wording, including file names, is never re-capitalized.
 */

export const TRUNCATION_NOTE = 'Some in-scope files were truncated for the model; conclusions cover only the visible content.';

// Restatements the report already makes: dropped wherever they appear.
const NOISE = [
  /^(the )?review (was )?limited to\b/i,
  /^reviewed only\b/i,
  /^only\b.*\b(was|were)\b.*\b(reviewed|in scope|provided|supplied)\b/i,
  /^the requested scope (contains|was|is)\b/i,
  // "The changed files in scope are all reStructuredText documentation", "Changed files are documentation artifacts only".
  /^(the )?(only )?(changed |reviewed )?files?\b(?! paths?).*\b(in scope|under review|reviewed)?\b.*\b(are|is)\b.*\b(documentation|docs?|diagrams?|artifacts?|configuration|config|build scripts?|reStructuredText|\.rst|markdown)\b/i,
  // "The only changed file in scope (.vscode/settings.json) configures editor formatting."
  /^(the )?(only )?(changed )?files? (in scope|under review)\b/i,
  // "None contain executable code…", "It contains no input-to-sink paths…", "No input-to-sink … behavior is present".
  /^(none|it|they|these|this file|these files)\b.*\bcontains?\b.*\bno\b/i,
  /^none (of them )?contains?\b/i,
  /^no (input-to-sink|executable|secret|command|authorization)\b.*\b(is|are) (present|found|evident)\b/i,
  /\bcontains? no (input-to-sink|executable code|secrets|command execution)\b/i,
  /\b(no|not)\b.*\bconcrete\b.*\b(flaw|vulnerabilit|issue|risk)/i,
  /^no (security )?(flaw|vulnerabilit|issue)s? (was|were|is|are) (found|identified|evident|established)/i
];
// Says only that something was outside what the model saw: worth keeping beside a point it explains.
const CONTEXT = /\b(was|were|is|are) not (read|inspected|reviewed|assessed|evaluated|visible|provided|supplied|shown|in scope|part of)\b|\bnot (in|part of) (the )?(scope|change set|changes review)\b|\bout of scope\b/i;
// …but a sentence that also says what follows from it ("…, so whether X cannot be determined") is the point itself.
const CONSEQUENCE = /\b(whether|depends?|depending)\b|,\s*so\b|\b(cannot|could not|can't) be (determined|established|confirmed|ruled out|verified)\b/i;
const NO_POLICY = /\b(polic(y|ies)|compliance|rules?)\b/i;
const NOT_PROVIDED = /\b(no|not|without)\b.*\b(configured|provided|supplied|assess|evaluat|establish|status|available)/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/).map(part => part.trim()).filter(Boolean);
}

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function consolidateLimitations(raw: string[], options: { policyConfigured: boolean }): { toVerify: string[]; truncated: boolean } {
  const toVerify: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of raw) {
    const kept: string[] = [];
    let substantive = false;
    for (const sentence of sentences(item)) {
      // "…truncated; conclusions are limited to the visible evidence" is one point, said once.
      if (/\btruncat/i.test(sentence) || /\bvisible (evidence|content)\b/i.test(sentence)) { truncated = true; continue; }
      if (NOISE.some(pattern => pattern.test(sentence))) { continue; }
      // Without a policy the engine says so once; with one, a model note about rules may matter.
      if (!options.policyConfigured && NO_POLICY.test(sentence) && NOT_PROVIDED.test(sentence)) { continue; }
      if (!CONTEXT.test(sentence) || CONSEQUENCE.test(sentence)) { substantive = true; }
      kept.push(sentence);
    }
    if (!substantive) { continue; }
    // A dropped opening sentence can leave a lowercase start ("callers were…"); a file name
    // ("uv.lock …") keeps its case.
    const joined = kept.join(' ').replace(/[;,]\s*$/, '');
    const text = /^[a-z][a-z-]*(\s|$)/.test(joined) ? joined.charAt(0).toUpperCase() + joined.slice(1) : joined;
    const id = key(text);
    if (id && !seen.has(id)) { seen.add(id); toVerify.push(text); }
  }
  return { toVerify, truncated };
}
