import * as vscode from 'vscode';
import { PolicyRuleResult, ReviewFinding, ReviewProgressCallback, ReviewProgressDetail, ReviewRequest, ReviewResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { trimReviewLog } from './reviewLog';
import { findingFingerprint, validatePolicyResult, validateReviewFinding } from './reviewFindingValidation';
import { appliesToPath, component, ReviewPlan, ReviewSurveyService, ReviewWorkUnit } from './reviewSurveyService';
import { consolidateLimitations, TRUNCATION_NOTE } from './reviewLimitations';
import { PROMPT_VERSION, ReviewChatModel, SecurityReviewProvider } from './securityReviewProvider';
import { ReviewUnitCacheLike, ReviewUnitOutcome, reviewUnitKey } from '../reviewUnitCache';
import { AppliedSkills, ReviewSkill, selectReviewSkills } from './reviewSkills';

/** Steps kept in a result's log; a long review keeps its first ones. */
const MAX_LOG = 400;

/**
 * The components a review covers, each with its files, for the progress list; files left out when
 * planning (binary, lockfile, symlink, budget) are listed under their component with the reason,
 * and components with only such files come last with no files to review.
 */
export function progressComponents(plan: ReviewPlan): ReviewProgressComponent[] {
  const steps: ReviewProgressComponent[] = plan.units.map(unit => ({ component: unit.component, files: unit.paths.length, paths: unit.paths }));
  for (const item of plan.coverage.skipped.slice(0, 200)) {
    const name = component(item.path);
    let step = steps.find(entry => entry.component === name);
    if (!step) { step = { component: name, files: 0, paths: [] }; steps.push(step); }
    (step.skipped = step.skipped || []).push({ path: item.path, reason: item.reason });
  }
  return steps;
}

export interface ReviewProgressComponent {
  component: string;
  files: number;
  paths: string[];
  skipped?: Array<{ path: string; reason: string }>;
}

export class SecurityReviewService {
  private survey: ReviewSurveyService;
  constructor(git: GitCommandService, private provider = new SecurityReviewProvider(), private cache?: ReviewUnitCacheLike,
    private skills: () => { skills: ReviewSkill[]; disabled: ReadonlySet<string> } = () => ({ skills: [], disabled: new Set() })) {
    this.survey = new ReviewSurveyService(git);
  }

  async review(request: ReviewRequest, token: vscode.CancellationToken,
    progress: ReviewProgressCallback, selectedModelId?: string): Promise<ReviewResult> {
    // Every step is also kept in the result, so a review that went wrong can be read afterwards.
    const log: NonNullable<ReviewResult['log']> = [];
    const started = Date.now();
    const notify = progress;
    progress = (message, detail) => {
      log.push({ at: Date.now() - started, message: message.slice(0, 300) });
      // Keep the failures and the newest steps, so a long review still shows how it ended.
      if (log.length > MAX_LOG * 2) { log.splice(0, log.length, ...trimReviewLog(log, MAX_LOG)); }
      notify(message, detail);
    };
    const state: ReviewProgressDetail = { phase: 'planning', unit: 0, units: 0, filesDone: 0, filesTotal: 0, candidates: 0 };
    progress('Planning the review…', { ...state });
    const plan = await this.survey.plan(request);
    const { coverage, policy } = plan;
    state.units = plan.units.length;
    state.filesTotal = plan.units.reduce((total, unit) => total + unit.paths.length, 0);
    // Messages from inside a step (tool reads, verification) carry the step's position.
    const report = (message: string) => progress(message, { ...state });
    const findings = new Map<string, ReviewFinding>();
    const results = new Map<string, PolicyRuleResult[]>();
    const limitations: string[] = [];
    // What the model reports per component; merged into a short list at the end.
    const modelLimitations: string[] = [];
    if (plan.request.categories.includes('compliance') && policy.status === 'not_configured') {
      limitations.push('Compliance policy is not configured at the target revision.');
      // Nothing else to review: compliance was the only category asked for.
      if (!plan.request.categories.some(category => category !== 'compliance')) {
        coverage.complete = false;
        return { request: plan.request, findings: [], policyResults: [], coverage,
          policyStatus: policy.status, limitations };
      }
    }
    const model = await this.provider.selectModel(selectedModelId);
    const modelId = `${model.id}:${model.version}`;
    state.model = model.name || model.id;
    progress(`Planned ${plan.units.length} component(s), ${state.filesTotal} file(s)`, { ...state,
      components: progressComponents(plan) });
    // Components already reviewed at these commits with this model and these prompts are reused.
    // Skills are chosen per component by its paths; what was sent is part of the cache key.
    const available = this.skills();
    const skillsFor = (unit: ReviewWorkUnit): AppliedSkills =>
      selectReviewSkills(available.skills, unit.paths, plan.request.categories, available.disabled);
    const skillsApplied: NonNullable<ReviewResult['skillsApplied']> = [];
    const keyFor = (unit: ReviewWorkUnit, applied: AppliedSkills) => reviewUnitKey({ modelId, promptVersion: PROMPT_VERSION, instructions: applied.hash,
      targetSha: plan.request.targetSha, baseSha: plan.request.baseSha, scope: plan.request.scope,
      categories: plan.request.categories, component: unit.component, paths: unit.paths, rules: unit.rules });
    let unitsDone = 0;
    let stopped = false;
    for (const [index, unit] of plan.units.entries()) {
      if (token.isCancellationRequested) { stopped = true; break; }
      Object.assign(state, { phase: 'analyzing', unit: index + 1, component: unit.component });
      const applied = skillsFor(unit);
      const key = keyFor(unit, applied);
      let outcome = this.cache?.get(key);
      if (outcome) {
        report(`Reusing the saved result for component ${index + 1}/${plan.units.length}: ${unit.component}`);
        // Saved before findings had fingerprints: add them, so decisions on them can carry over.
        for (const finding of outcome.findings) {
          if (!finding.fingerprint) {
            const fingerprint = await findingFingerprint(finding, plan);
            if (fingerprint) { finding.fingerprint = fingerprint; }
          }
        }
      } else {
        report(`Reviewing component ${index + 1}/${plan.units.length}: ${unit.component}`);
        const failed: { path: string; reason: string }[] = [];
        try {
          outcome = await this.reviewUnit(plan, unit, model, token, report, state, failed, applied);
        } catch (error) {
          if (token.isCancellationRequested) { stopped = true; break; }
          for (const path of unit.paths) {
            failed.push({ path, reason: error instanceof Error ? error.message : 'Review failed' });
          }
        }
        // One entry per file and reason: several bad findings from one component are one failed check.
        const unique = failed.filter((item, index) => failed.findIndex(other => other.path === item.path && other.reason === item.reason) === index);
        failed.splice(0, failed.length, ...unique);
        coverage.failed.push(...failed);
        // One line per reason, not per file: a component that failed as a whole lists all its files.
        for (const reason of new Set(failed.map(item => item.reason))) {
          const files = failed.filter(item => item.reason === reason).length;
          report(`Component ${unit.component} failed${files > 1 ? ` (${files} files)` : ''}: ${reason}`);
        }
        // Only a clean result is kept: anything that failed is asked again next time.
        if (outcome && !failed.length) { await this.cache?.set(key, outcome).catch(() => undefined); }
      }
      if (outcome && (applied.skills.length || applied.omitted.length)) {
        skillsApplied.push({ component: unit.component, skills: applied.skills.map(skill => skill.id),
          ...(applied.omitted.length ? { omitted: applied.omitted } : {}) });
      }
      if (outcome) {
        state.candidates += outcome.candidates;
        for (const finding of outcome.findings) {
          if (!findings.has(finding.id) || finding.status === 'verified') { findings.set(finding.id, finding); }
        }
        for (const result of outcome.policyResults) {
          results.set(result.ruleId, [...(results.get(result.ruleId) || []), result]);
        }
        coverage.skipped.push(...outcome.skipped);
        modelLimitations.push(...outcome.limitations);
        coverage.analyzed += outcome.analyzed;
      }
      unitsDone = index + 1;
      state.filesDone += unit.paths.length;
    }
    // Cancelled before anything was reviewed: nothing to show or keep.
    if (stopped && unitsDone === 0) { throw new Error('Cancelled'); }
    Object.assign(state, { phase: 'finishing', component: undefined });
    report('Collecting results…');
    const policyResults: PolicyRuleResult[] = [];
    if (policy.status === 'configured') {
      for (const rule of policy.policy.rules) {
        const entries = results.get(rule.id) || [];
        if (!entries.length) {
          const selected = plan.request.scope === 'changes' ? plan.changedPaths : plan.snapshot.tree.entries.map(entry => entry.path);
          const potentiallyApplies = plan.snapshot.tree.truncated || selected.some(path => appliesToPath(rule, path));
          policyResults.push({ ruleId: rule.id,
            status: potentiallyApplies ? 'insufficient_evidence' : 'not_applicable',
            reason: potentiallyApplies ? 'Applicable files were not fully reviewed.' : 'No selected file matches this rule.',
            evidence: [] });
          continue;
        }
        const violations = entries.filter(item => item.status === 'violation');
        // not_applicable is a definitive answer for that batch; only insufficient evidence or
        // incomplete coverage leaves the rule unresolved.
        const unavailable = rule.verification !== 'ai' || entries.some(item => item.status === 'insufficient_evidence') ||
          coverage.failed.length > 0 || coverage.skipped.some(item => appliesToPath(rule, item.path));
        const allNotApplicable = entries.every(item => item.status === 'not_applicable');
        policyResults.push(rule.verification === 'ai' && violations.length
          ? { ruleId: rule.id, status: 'violation', reason: violations.map(item => item.reason).join('; ').slice(0, 1000),
            evidence: violations.flatMap(item => item.evidence).slice(0, 8) }
          : unavailable
            ? { ruleId: rule.id, status: 'insufficient_evidence',
              reason: rule.verification === 'ai' ? 'Some applicable files or checks were incomplete.' : `${rule.verification} verification has not been run.`, evidence: [] }
            : allNotApplicable
              ? { ruleId: rule.id, status: 'not_applicable', reason: entries.map(item => item.reason).join('; ').slice(0, 1000), evidence: [] }
              : { ruleId: rule.id, status: 'pass', reason: 'AI assessed all selected files covered by this rule.',
                evidence: entries.flatMap(item => item.evidence).slice(0, 8) });
      }
    }
    coverage.complete = !stopped && coverage.complete && !coverage.skipped.length && !coverage.failed.length &&
      coverage.analyzed === coverage.surveyed;
    const consolidated = consolidateLimitations(modelLimitations, { policyConfigured: policy.status === 'configured' });
    if (consolidated.truncated) { limitations.push(TRUNCATION_NOTE); }
    if (stopped) {
      limitations.push(`The review stopped after ${unitsDone} of ${plan.units.length} components; the rest was not reviewed. Run it again to continue: finished components are reused.`);
    }
    if (!coverage.complete) { limitations.push('Review coverage is incomplete; missing checks are not a pass.'); }
    limitations.push('Verified findings have source and diff citations and a second AI check; this does not prove absence of other vulnerabilities.');
    return { request: plan.request, findings: [...findings.values()], policyResults, coverage,
      policyStatus: policy.status, modelId, modelName: state.model, log: trimReviewLog(log, MAX_LOG), limitations: [...new Set(limitations)].slice(0, 40),
      toVerify: consolidated.toVerify.slice(0, 20),
      ...(skillsApplied.length ? { skillsApplied } : {}),
      ...(stopped ? { partial: { unitsDone, unitsTotal: plan.units.length } } : {}) };
  }

  /** Analyzes and verifies one component. Problems that leave it incomplete go into `failed`. */
  private async reviewUnit(plan: ReviewPlan, unit: ReviewWorkUnit, model: ReviewChatModel, token: vscode.CancellationToken,
    report: (message: string) => void, state: ReviewProgressDetail, failed: { path: string; reason: string }[],
    applied: AppliedSkills): Promise<ReviewUnitOutcome> {
    const raw = await this.provider.analyze(plan, unit, model, token, report, applied.skills);
    const candidates: ReviewFinding[] = [];
    for (const item of raw.findings.slice(0, 20)) {
      const finding = await validateReviewFinding(item, plan, unit);
      if (finding) {
        // Only a skill this component was given; the model may name one it was not. A finding from a
        // clean code skill is a quality note whatever category the model gave it, so it cannot block.
        const source = finding.skill ? applied.skills.find(skill => skill.id === finding.skill) : undefined;
        if (finding.skill && !source) { delete finding.skill; }
        if (source?.category === 'quality' && finding.category !== 'quality') {
          finding.category = 'quality';
          delete finding.ruleId;
          if (finding.severity === 'critical' || finding.severity === 'high') { finding.severity = 'medium'; }
        }
        if (finding.category === 'compliance') {
          finding.severity = unit.rules.find(rule => rule.id === finding.ruleId)!.severity;
        }
        const fingerprint = await findingFingerprint(finding, plan);
        if (fingerprint) { finding.fingerprint = fingerprint; }
        candidates.push(finding);
      }
      else { failed.push({ path: unit.component, reason: 'AI finding had invalid or ungrounded evidence' }); }
    }
    if (raw.findings.length > 20) {
      failed.push({ path: unit.component, reason: 'AI finding limit exceeded' });
    }
    let verdicts = new Map<string, 'supported' | 'uncertain' | 'rejected'>();
    if (candidates.length) {
      state.phase = 'verifying';
      try {
        verdicts = await this.provider.verify(plan, candidates, model, token, report);
        // The second assessment must cover every candidate; a missing verdict is a gap, not a pass.
        const missing = candidates.filter(candidate => !verdicts.has(candidate.id)).length;
        if (missing) {
          failed.push({ path: unit.component, reason: `No verification verdict for ${missing} of ${candidates.length} finding(s)` });
        }
      } catch (error) {
        if (token.isCancellationRequested) { throw error; }
        failed.push({ path: unit.component, reason: `Finding verification failed: ${String(error)}` });
      }
    }
    const kept: ReviewFinding[] = [];
    for (const candidate of candidates) {
      const verdict = verdicts.get(candidate.id);
      if (verdict === 'rejected') { continue; }
      // A rule the policy marks manual or static cannot be verified by an AI check.
      const rule = candidate.category === 'compliance' ? unit.rules.find(item => item.id === candidate.ruleId) : undefined;
      candidate.status = verdict === 'supported' && (!rule || rule.verification === 'ai') ? 'verified' : 'hypothesis';
      kept.push(candidate);
    }
    const policyResults: PolicyRuleResult[] = [];
    const seenRules = new Set<string>();
    if (raw.policyResults.length > 200) {
      failed.push({ path: unit.component, reason: 'AI policy result limit exceeded' });
    }
    for (const item of raw.policyResults.slice(0, 200)) {
      const result = await validatePolicyResult(item, plan, unit);
      if (!result || seenRules.has(result.ruleId)) {
        failed.push({ path: unit.component, reason: 'Invalid or duplicate policy result' });
        continue;
      }
      seenRules.add(result.ruleId);
      if (result.status === 'violation' && !candidates.some(candidate =>
        candidate.category === 'compliance' && candidate.ruleId === result.ruleId &&
        verdicts.get(candidate.id) === 'supported')) {
        result.status = 'insufficient_evidence';
        result.reason = 'Violation has no corroborated compliance finding.';
      }
      policyResults.push(result);
    }
    for (const rule of unit.rules) {
      if (!seenRules.has(rule.id)) {
        policyResults.push({ ruleId: rule.id, status: 'insufficient_evidence',
          reason: 'AI did not return a result for this scope.', evidence: [] });
        failed.push({ path: unit.component, reason: `No policy result for ${rule.id}` });
      }
    }
    const skipped = raw.partialPaths.map(file => ({ path: file.path, partial: true, reason: file.characters
      ? `Partly reviewed: the model saw the first ${file.characters.toLocaleString('en-US')} characters of line 1 (of ${file.total.toLocaleString('en-US')})`
      : `Partly reviewed: the model saw ${file.seen.toLocaleString('en-US')} of ${file.total.toLocaleString('en-US')} lines` }));
    const limitations = (Array.isArray(raw.limitations) ? raw.limitations.filter((item): item is string =>
      typeof item === 'string' && item.length <= 500) : []).slice(0, 10);
    return { findings: kept, candidates: candidates.length, policyResults, skipped, limitations, analyzed: unit.paths.length };
  }
}
