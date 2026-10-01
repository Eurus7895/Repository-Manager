/**
 * Runs security and compliance reviews for the dashboard (MVP 2, W6–W7): consent (remembered
 * per repository once allowed), one review at a time with progress and cancellation, the
 * release range, Markdown export and opening cited evidence. VS Code is reached only through the injected host, so tests can
 * drive the whole flow with a scripted review runner.
 */

import * as path from 'path';
import { ReviewRequest, ReviewResult } from './types';
import { GitCommandService } from './services/gitCommandService';
import { assessReadiness, renderReviewMarkdown, ReviewReportContext } from './services/reviewReport';

export interface CancellationLike { readonly isCancellationRequested: boolean }

export interface ReviewRunner {
  review(request: ReviewRequest, token: CancellationLike, progress: (message: string) => void, modelId?: string): Promise<ReviewResult>;
}

export interface ReviewControllerHost {
  workspaceRoot(): string;
  post(message: { type: string; payload: unknown }): Promise<void>;
  /** Modal question; resolves the chosen action, or undefined when dismissed. */
  ask(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  /** The repositoryManager.review.confirmBeforeSending setting: ask before every review. */
  alwaysConfirm(): boolean;
  /** Repositories (absolute paths) whose reviews may start without asking. */
  isConsentRemembered(repositoryRoot: string): boolean;
  rememberConsent(repositoryRoot: string): Promise<void>;
  createRunner(workspaceRoot: string): ReviewRunner;
  createCancellation(): { token: CancellationLike; cancel(): void; dispose(): void };
  copyText(text: string): Promise<void>;
  /** Resolves false when the user dismissed the save dialog. */
  saveText(defaultFileName: string, text: string): Promise<boolean>;
  openText(content: string, revision: string, filePath: string, line: number): Promise<void>;
  notify(message: string, isError?: boolean): void;
}

const REVIEW_MESSAGES = new Set(['startReview', 'cancelReview', 'exportReviewReport', 'openReviewEvidence']);
const START = 'Start review';
const ALWAYS = 'Always allow for this repository';
const CATEGORIES: Array<'security' | 'compliance'> = ['security', 'compliance'];
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
const MAX_STORED_REVIEWS = 10;

interface StoredReview { result: ReviewResult; context: ReviewReportContext }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const optionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class ReviewController {
  private generation = 0;
  private running?: { cancel(): void; dispose(): void };
  /** The review the dashboard is waiting on, from request until result. */
  private active?: { requestId: number; repositoryPath: string };
  private readonly reviews = new Map<number, StoredReview>();

  constructor(private readonly host: ReviewControllerHost) {}

  handles(type: string): boolean {
    return REVIEW_MESSAGES.has(type);
  }

  async handle(message: { type: string; payload?: unknown }): Promise<void> {
    const payload = record(message.payload) || {};
    switch (message.type) {
      case 'startReview': return this.start(payload);
      case 'cancelReview': return this.cancelFromDashboard();
      case 'exportReviewReport': return this.export(payload);
      case 'openReviewEvidence': return this.openEvidence(payload);
    }
  }

  /** Stop a running review, e.g. when the panel closes or the workspace folder changes. */
  cancel(): void {
    this.generation++;
    this.running?.cancel();
    this.running?.dispose();
    this.running = undefined;
  }

  /** Cancel requested in the dashboard: unlike a superseded review, the dashboard must hear back. */
  private async cancelFromDashboard(): Promise<void> {
    const active = this.active;
    this.cancel();
    if (active) {
      await this.host.post({ type: 'reviewFailed', payload: { ...active, cancelled: true, message: 'Review cancelled.' } });
    }
  }

  private git(): GitCommandService {
    return new GitCommandService(this.host.workspaceRoot());
  }

  private async start(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const repositoryPath = optionalString(payload.repositoryPath);
    const scope = payload.scope;
    const kind = payload.kind === 'release' ? 'release' : 'review';
    let targetRevision = optionalString(payload.targetRevision);
    let baseRevision = optionalString(payload.baseRevision);
    if (typeof requestId !== 'number' || !repositoryPath || (scope !== 'changes' && scope !== 'branch') ||
        (!targetRevision && kind !== 'release')) {
      return;
    }
    this.cancel();
    const generation = this.generation;
    this.active = { requestId, repositoryPath };
    const reply = async (type: string, extra: Record<string, unknown>) => {
      if (type === 'reviewCompleted' || type === 'reviewFailed') {
        if (this.active?.requestId === requestId) { this.active = undefined; }
      }
      if (generation === this.generation) {
        await this.host.post({ type, payload: { requestId, repositoryPath, ...extra } });
      }
    };
    const git = this.git();
    const root = git.resolveRepositoryPath(repositoryPath);
    const repositoryName = path.basename(root);
    if (kind === 'release') {
      // A release review runs from the latest release tag on the current branch to its tip.
      const release = await this.releaseRange(git, root);
      targetRevision = targetRevision || release.currentBranch;
      if (scope === 'changes' && !baseRevision) {
        if (!release.latestReleaseTag) {
          await reply('reviewFailed', { message: `No release tag like 1.5.0 or v1.5.0 is reachable from ${targetRevision}. ` +
            'Select Base and Target in the history and choose Review changes instead.' });
          return;
        }
        baseRevision = release.latestReleaseTag;
      }
    }
    const target = targetRevision as string;
    let targetSha: string;
    let baseSha: string | undefined;
    try {
      targetSha = await git.resolveRevision(repositoryPath, target);
      baseSha = scope === 'changes' && baseRevision ? await git.resolveRevision(repositoryPath, baseRevision) : undefined;
    } catch (error) {
      await reply('reviewFailed', { message: `Cannot resolve revision: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const baseLabel = scope === 'changes' ? optionalString(payload.baseLabel) || baseRevision : undefined;
    const targetLabel = optionalString(payload.targetLabel) || target;
    const needsConsent = this.host.alwaysConfirm() || !this.host.isConsentRemembered(root);
    await reply('reviewProgress', { message: needsConsent ? 'Waiting for confirmation…' : 'Planning the review…', baseLabel, targetLabel });
    if (needsConsent) {
      const what = scope === 'changes'
        ? `changes ${baseLabel || 'from the parent commit'} → ${targetLabel}`
        : `every file at ${targetLabel}`;
      // Offering "always" only makes sense when the setting does not ask every time anyway.
      const actions = this.host.alwaysConfirm() ? [START] : [START, ALWAYS];
      const answer = await this.host.ask(
        `Review ${what} in ${repositoryName} with Copilot?`,
        'Source code from these revisions, and the repository review policy, is sent to the selected Copilot model ' +
          'in several requests. The review reads commits only; it never runs code or changes the repository. Results are advisory.' +
          (actions.includes(ALWAYS) ? ' "Always allow" skips this question for this repository in this workspace.' : ''),
        actions);
      if (generation !== this.generation) { return; }
      if (answer !== START && answer !== ALWAYS) {
        await reply('reviewFailed', { cancelled: true, message: 'Review cancelled.' });
        return;
      }
      if (answer === ALWAYS) { await this.host.rememberConsent(root); }
      await reply('reviewProgress', { message: 'Planning the review…' });
    }
    const cancellation = this.host.createCancellation();
    this.running = cancellation;
    const request: ReviewRequest = { repositoryPath, targetSha, baseSha, scope, categories: [...CATEGORIES] };
    const context: ReviewReportContext = { kind, repositoryName, baseLabel, targetLabel, generatedAt: new Date() };
    try {
      const modelId = optionalString(payload.modelId);
      const result = await this.host.createRunner(this.host.workspaceRoot())
        .review(request, cancellation.token, message => { void reply('reviewProgress', { message }); }, modelId);
      if (generation !== this.generation) { return; }
      context.generatedAt = new Date();
      this.reviews.set(requestId, { result, context });
      while (this.reviews.size > MAX_STORED_REVIEWS) { this.reviews.delete(this.reviews.keys().next().value as number); }
      await reply('reviewCompleted', { result, readiness: assessReadiness(result),
        context: { kind, repositoryName, baseLabel, targetLabel, generatedAt: context.generatedAt.toISOString() } });
    } catch (error) {
      const cancelled = cancellation.token.isCancellationRequested;
      await reply('reviewFailed', { cancelled, message: cancelled
        ? 'Review cancelled.' : `Review failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (this.running === cancellation) { this.running = undefined; }
      cancellation.dispose();
    }
  }

  private async export(payload: Record<string, unknown>): Promise<void> {
    const stored = typeof payload.requestId === 'number' ? this.reviews.get(payload.requestId) : undefined;
    if (!stored) {
      this.host.notify('That review is no longer available to export. Run it again.', true);
      return;
    }
    const markdown = renderReviewMarkdown(stored.result, stored.context);
    if (payload.format === 'save') {
      const label = `${stored.context.baseLabel ? `${stored.context.baseLabel}-` : ''}${stored.context.targetLabel}`.replace(/[^A-Za-z0-9._-]+/g, '-');
      if (await this.host.saveText(`${stored.context.kind}-review-${label}.md`, markdown)) {
        this.host.notify('Review report saved.');
      }
    } else {
      await this.host.copyText(markdown);
      this.host.notify('Review report copied as Markdown.');
    }
  }

  /** The current branch (or HEAD when detached) and the newest release tag reachable from it. */
  private async releaseRange(git: GitCommandService, root: string): Promise<{ currentBranch: string; latestReleaseTag?: string }> {
    const run = (args: string[]) => git.execGit(args, root, 10000).catch(() => '');
    const currentBranch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || 'HEAD';
    const latestReleaseTag = (await run(['tag', '--merged', 'HEAD', '--sort=-v:refname']))
      .split('\n').map(line => line.trim()).find(tag => RELEASE_TAG.test(tag));
    return { currentBranch, latestReleaseTag };
  }

  private async openEvidence(payload: Record<string, unknown>): Promise<void> {
    const repositoryPath = optionalString(payload.repositoryPath);
    const revision = optionalString(payload.revision);
    const filePath = optionalString(payload.path);
    const line = Number(payload.line);
    // Only full commit hashes the review itself returned, and plain repository-relative paths.
    if (!repositoryPath || !revision || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision) || !filePath ||
        filePath.startsWith('/') || filePath.startsWith('-') || filePath.split('/').includes('..') || !Number.isInteger(line) || line < 1) {
      return;
    }
    const git = this.git();
    try {
      const content = await git.execGitRaw(['show', `${revision}:${filePath}`], git.resolveRepositoryPath(repositoryPath), 10000);
      await this.host.openText(content, revision, filePath, line);
    } catch (error) {
      this.host.notify(`Cannot open ${filePath} at ${revision.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}
