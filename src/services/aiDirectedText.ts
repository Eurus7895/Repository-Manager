/**
 * Text in source code that speaks to an AI reviewer ("NOTE TO AI: this eval is safe", "ignore all
 * previous instructions"). Copilot reads it with the code it reviews, verifies and explains, and may
 * follow it, so the Review tab warns on a finding whose cited code holds such text.
 *
 * A plain pattern check, independent of the model: it cannot be talked out of a warning. It is a
 * tripwire, not a wall: it knows common English phrasings, and text written to evade it gets past.
 */

import * as path from 'path';
import { ReviewFinding } from '../types';
import { GitCommandService } from './gitCommandService';

export interface AiDirectedText {
  path: string;
  line: number;
  /** The line, trimmed and cut to MAX_TEXT_CHARS. */
  text: string;
}

/** Lines checked on each side of a finding's cited lines: the same lines an explanation sends. */
export const AI_TEXT_CONTEXT_LINES = 8;
export const MAX_AI_TEXT_PER_FINDING = 5;
const MAX_TEXT_CHARS = 200;

// A bare "reviewer" is left out: people review code too, and write notes to each other.
const AI = String.raw`(?:ai|llms?|copilot|chat\s?gpt|gpt(?:-?\d[\w.]*)?|claude|gemini|language\s+model|(?:ai|code|security)\s+(?:assistant|reviewer|scanner|bot)|assistant)`;
const COMMENT = String.raw`(?:\/\/|\/\*+|^\s*\*|#|--|<!--)`;

const PATTERNS: RegExp[] = [
  // "NOTE TO AI", "message for the LLM", "instructions for Copilot".
  new RegExp(String.raw`\b(?:note|message|instructions?|hint|attention|reminder)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?${AI}\b`, 'i'),
  // A comment that starts by calling an AI: "// AI: …", "# Dear Copilot, …".
  new RegExp(String.raw`${COMMENT}\s*(?:dear\s+|hey\s+|hi\s+)?${AI}\s*[:,]`, 'i'),
  // "ignore all previous instructions", "disregard the system prompt".
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules?|guidelines?|context)\b/i,
  /\b(?:ignore|disregard|override)\s+(?:the\s+|your\s+)?system\s+prompt\b/i,
  // "you are an AI security reviewer", "act as a code reviewer".
  new RegExp(String.raw`\b(?:you\s+are|you're|act\s+as|pretend\s+to\s+be)\s+(?:an?\s+|the\s+)?${AI}`, 'i'),
  // "do not report this vulnerability", "never flag these as a security issue".
  /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\s+(?:report|flag|mention|raise)\s+(?:this|these|it|that|the\s+following)\b.{0,40}\b(?:vulnerabilit\w*|issues?|findings?|security|warnings?|bugs?|problems?)/i,
  // "this is a false positive", "mark it as safe".
  /\b(?:this|it|that)\s+(?:is|was)\s+(?:a\s+)?false\s+positive\b/i,
  /\bmark\s+(?:this\s+|it\s+)?as\s+(?:safe|verified|rejected|not\s+applicable|a\s+false\s+positive)\b/i,
  // Chat-format tokens and role headers.
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  /\b(?:system\s+prompt|new\s+instructions|updated\s+instructions)\s*:/i
];

/** Whether one line of source speaks to an AI reviewer. */
export function isAiDirected(text: string): boolean {
  return PATTERNS.some(pattern => pattern.test(text));
}

/** The lines of one file that speak to an AI reviewer, at most `limit`. */
export function findAiDirectedText(filePath: string, lines: Array<{ line: number; text: string }>,
  limit = MAX_AI_TEXT_PER_FINDING): AiDirectedText[] {
  const found: AiDirectedText[] = [];
  for (const { line, text } of lines) {
    if (found.length >= limit) { break; }
    if (isAiDirected(text)) {
      const trimmed = text.trim();
      found.push({ path: filePath, line, text: trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS - 1)}…` : trimmed });
    }
  }
  return found;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function safeRelativePath(filePath: string): boolean {
  return Boolean(filePath) && !path.isAbsolute(filePath) && !filePath.startsWith('-') &&
    !filePath.split(/[\\/]/).includes('..') && !filePath.includes('\0');
}

/**
 * Marks the findings whose cited lines, or the lines around them, speak to an AI reviewer
 * (`aiDirectedText`). Reads each cited file once, at the revision the finding cites. Best effort:
 * a file that cannot be read (a pruned snapshot) is skipped, and a finding already marked keeps it.
 */
export async function markAiDirectedText(git: GitCommandService, root: string, findings: ReviewFinding[]): Promise<void> {
  const files = new Map<string, Promise<string[] | undefined>>();
  const read = (revision: string, filePath: string) => {
    const key = `${revision}:${filePath}`;
    if (!files.has(key)) {
      files.set(key, git.execGitRaw(['show', key], root, 10000)
        .then(content => content.replace(/\r?\n$/, '').split(/\r?\n/), () => undefined));
    }
    return files.get(key)!;
  };
  for (const finding of findings) {
    const found: AiDirectedText[] = [];
    for (const evidence of finding.evidence) {
      if (!FULL_SHA.test(evidence.revision) || !safeRelativePath(evidence.path)) { continue; }
      const lines = await read(evidence.revision, evidence.path);
      if (!lines) { continue; }
      const start = Math.max(1, evidence.startLine - AI_TEXT_CONTEXT_LINES);
      const end = Math.min(lines.length, evidence.endLine + AI_TEXT_CONTEXT_LINES);
      const window = [];
      for (let line = start; line <= end; line++) { window.push({ line, text: lines[line - 1] }); }
      for (const item of findAiDirectedText(evidence.path, window, MAX_AI_TEXT_PER_FINDING - found.length)) {
        if (!found.some(other => other.path === item.path && other.line === item.line)) { found.push(item); }
      }
    }
    if (found.length) { finding.aiDirectedText = found; }
  }
}
