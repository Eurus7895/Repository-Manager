import * as vscode from 'vscode';
import { PolicyRuleResult, ReviewFinding, ReviewProgressCallback, ReviewProgressDetail, ReviewRequest, ReviewResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { validatePolicyResult, validateReviewFinding } from './reviewFindingValidation';
import { appliesToPath, ReviewSurveyService } from './reviewSurveyService';
import { consolidateLimitations } from './reviewLimitations';
import { SecurityReviewProvider } from './securityReviewProvider';

export class SecurityReviewService {
  private survey: ReviewSurveyService;
  constructor(git: GitCommandService, private provider = new SecurityReviewProvider()) {
    this.survey = new ReviewSurveyService(git);
  }

  async review(request: ReviewRequest, token: vscode.CancellationToken,
    progress: ReviewProgressCallback, selectedModelId?: string): Promise<ReviewResult> {
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
      if (!plan.request.categories.includes('security')) {
        coverage.complete = false;
        return { request: plan.request, findings: [], policyResults: [], coverage,
          policyStatus: policy.status, limitations };
      }
    }
    const model = await this.provider.selectModel(selectedModelId);
    const modelId = `${model.id}:${model.version}`;
    progress(`Planned ${plan.units.length} component(s), ${state.filesTotal} file(s)`, { ...state,
      components: plan.units.map(unit => ({ component: unit.component, files: unit.paths.length })) });
    for (const [index, unit] of plan.units.entries()) {
      if (token.isCancellationRequested) { throw new Error('Cancelled'); }
      Object.assign(state, { phase: 'analyzing', unit: index + 1, component: unit.component });
      report(`Reviewing component ${index + 1}/${plan.units.length}: ${unit.component}`);
      try {
        const raw = await this.provider.analyze(plan, unit, model, token, report);
        const candidates: ReviewFinding[] = [];
        for (const item of raw.findings.slice(0, 20)) {
          const finding = await validateReviewFinding(item, plan, unit);
          if (finding) {
            if (finding.category === 'compliance') {
              finding.severity = unit.rules.find(rule => rule.id === finding.ruleId)!.severity;
            }
            candidates.push(finding);
          }
          else { coverage.failed.push({ path: unit.component, reason: 'AI finding had invalid or ungrounded evidence' }); }
        }
        if (raw.findings.length > 20) {
          coverage.failed.push({ path: unit.component, reason: 'AI finding limit exceeded' });
        }
        let verdicts = new Map<string, 'supported' | 'uncertain' | 'rejected'>();
        state.candidates += candidates.length;
        if (candidates.length) {
          state.phase = 'verifying';
          try {
            verdicts = await this.provider.verify(plan, candidates, model, token, report);
            // The second assessment must cover every candidate; a missing verdict is a gap, not a pass.
            const missing = candidates.filter(candidate => !verdicts.has(candidate.id)).length;
            if (missing) {
              coverage.failed.push({ path: unit.component, reason: `No verification verdict for ${missing} of ${candidates.length} finding(s)` });
            }
          } catch (error) {
            if (token.isCancellationRequested) { throw error; }
            coverage.failed.push({ path: unit.component, reason: `Finding verification failed: ${String(error)}` });
          }
        }
        for (const candidate of candidates) {
          const verdict = verdicts.get(candidate.id);
          if (verdict === 'rejected') { continue; }
          // A rule the policy marks manual or static cannot be verified by an AI check.
          const rule = candidate.category === 'compliance' ? unit.rules.find(item => item.id === candidate.ruleId) : undefined;
          candidate.status = verdict === 'supported' && (!rule || rule.verification === 'ai') ? 'verified' : 'hypothesis';
          if (!findings.has(candidate.id) || candidate.status === 'verified') {
            findings.set(candidate.id, candidate);
          }
        }
        const seenRules = new Set<string>();
        if (raw.policyResults.length > 200) {
          coverage.failed.push({ path: unit.component, reason: 'AI policy result limit exceeded' });
        }
        for (const item of raw.policyResults.slice(0, 200)) {
          const result = await validatePolicyResult(item, plan, unit);
          if (!result || seenRules.has(result.ruleId)) {
            coverage.failed.push({ path: unit.component, reason: 'Invalid or duplicate policy result' });
            continue;
          }
          seenRules.add(result.ruleId);
          if (result.status === 'violation' && !candidates.some(candidate =>
            candidate.category === 'compliance' && candidate.ruleId === result.ruleId &&
            verdicts.get(candidate.id) === 'supported')) {
            result.status = 'insufficient_evidence';
            result.reason = 'Violation has no corroborated compliance finding.';
          }
          const current = results.get(result.ruleId) || [];
          current.push(result);
          results.set(result.ruleId, current);
        }
        for (const rule of unit.rules) {
          if (!seenRules.has(rule.id)) {
            const current = results.get(rule.id) || [];
            current.push({ ruleId: rule.id, status: 'insufficient_evidence',
              reason: 'AI did not return a result for this scope.', evidence: [] });
            results.set(rule.id, current);
            coverage.failed.push({ path: unit.component, reason: `No policy result for ${rule.id}` });
          }
        }
        for (const file of raw.partialPaths) {
          coverage.skipped.push({ path: file.path, reason: `Partly reviewed: the model saw ${file.seen.toLocaleString('en-US')} of ${file.total.toLocaleString('en-US')} lines` });
        }
        modelLimitations.push(...(Array.isArray(raw.limitations) ? raw.limitations.filter((item): item is string =>
          typeof item === 'string' && item.length <= 500) : []).slice(0, 10));
        coverage.analyzed += unit.paths.length;
      } catch (error) {
        if (token.isCancellationRequested) { throw error; }
        for (const path of unit.paths) {
          coverage.failed.push({ path, reason: error instanceof Error ? error.message : 'Review failed' });
        }
      }
      state.filesDone += unit.paths.length;
    }
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
    coverage.complete = coverage.complete && !coverage.skipped.length && !coverage.failed.length &&
      coverage.analyzed === coverage.surveyed;
    limitations.push(...consolidateLimitations(modelLimitations, { policyConfigured: policy.status === 'configured' }));
    if (!coverage.complete) { limitations.push('Review coverage is incomplete; missing checks are not a pass.'); }
    limitations.push('Verified findings have source and diff citations and a second AI check; this does not prove absence of other vulnerabilities.');
    return { request: plan.request, findings: [...findings.values()], policyResults, coverage,
      policyStatus: policy.status, modelId, limitations: [...new Set(limitations)].slice(0, 40) };
  }
}
