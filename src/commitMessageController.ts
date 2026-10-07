/**
 * Writes a commit message with Copilot for the files selected in the commit dialog, following the
 * repository's commit convention (see services/commitMessage.ts). The message goes into the dialog
 * for the user to read and edit; nothing is committed here.
 *
 * Sending code to Copilot asks first, as a review does, and shares the review's per-repository
 * "Always allow" and the repositoryManager.review.confirmBeforeSending setting.
 * Nothing here depends on VS Code, so it is tested with a scripted model.
 */

import { GitCommandService } from './services/gitCommandService';
import { buildCommitMessagePrompt, cleanCommitMessage, collectCommitDiff, findCommitConvention } from './services/commitMessage';
import { PartialStagedChoice } from './types';

export interface CommitMessageCancellation {
  token: { isCancellationRequested: boolean };
  cancel(): void;
  dispose(): void;
}

export interface CommitMessageHost {
  workspaceRoot(): string;
  post(message: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
  ask(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  alwaysConfirm(): boolean;
  isConsentRemembered(root: string): boolean;
  rememberConsent(root: string): Promise<void>;
  /** The model's whole reply to `prompt`, and the model's id. */
  complete(prompt: string, modelId: string | undefined, token: CommitMessageCancellation['token']): Promise<{ text: string; model: string }>;
  createCancellation(): CommitMessageCancellation;
}

const WRITE = 'Write message';
const ALWAYS = 'Always allow for this repository';

export class CommitMessageController {
  private running?: { requestId: number; cancellation: CommitMessageCancellation };

  constructor(private readonly host: CommitMessageHost) {}

  handles(type: string): boolean {
    return type === 'generateCommitMessage' || type === 'cancelCommitMessage';
  }

  async handle(message: { type: string; payload?: unknown }): Promise<void> {
    if (message.type === 'cancelCommitMessage') { this.cancel(); return; }
    if (message.type === 'generateCommitMessage') { await this.generate(record(message.payload)); }
  }

  cancel(): void {
    this.running?.cancellation.cancel();
    this.running = undefined;
  }

  private async generate(payload: Record<string, unknown>): Promise<void> {
    const { requestId, repositoryPath } = payload;
    const files = Array.isArray(payload.files) ? payload.files.filter((file): file is string => typeof file === 'string' && file.length > 0) : [];
    const partial: PartialStagedChoice | undefined = payload.partial === 'staged' || payload.partial === 'whole' ? payload.partial : undefined;
    const modelId = typeof payload.modelId === 'string' && payload.modelId ? payload.modelId : undefined;
    if (typeof requestId !== 'number' || typeof repositoryPath !== 'string' || !repositoryPath) { return; }
    this.cancel();
    const cancellation = this.host.createCancellation();
    this.running = { requestId, cancellation };
    const current = () => this.running?.requestId === requestId && !cancellation.token.isCancellationRequested;
    const reply = async (type: string, extra: Record<string, unknown>) => {
      if (current()) { await this.host.post({ type, payload: { requestId, repositoryPath, ...extra } }); }
    };
    try {
      if (!files.length) {
        await reply('commitMessageFailed', { message: 'Select the files to commit first: the message describes them.' });
        return;
      }
      const git = new GitCommandService(this.host.workspaceRoot());
      const root = git.resolveRepositoryPath(repositoryPath);
      const commitDiff = await collectCommitDiff(git, repositoryPath, files, partial, () => !current());
      if (!current()) { return; }
      // Files too large to show are still in the commit: the message can name them.
      if (!commitDiff.files.length && !commitDiff.tooLarge.length) {
        await reply('commitMessageFailed', { message: 'None of the selected files has a diff to describe.' });
        return;
      }
      const convention = findCommitConvention(root);
      if (this.host.alwaysConfirm() || !this.host.isConsentRemembered(root)) {
        await reply('commitMessageProgress', { message: 'Waiting for confirmation…' });
        const actions = this.host.alwaysConfirm() ? [WRITE] : [WRITE, ALWAYS];
        const answer = await this.host.ask(
          `Write a commit message for ${commitDiff.files.length + commitDiff.tooLarge.length} file${commitDiff.files.length + commitDiff.tooLarge.length === 1 ? '' : 's'} with Copilot?`,
          `The diff of the selected files (up to 60 KB) and the repository's commit convention ` +
            `(${convention.sources.length ? convention.sources.join(', ') : 'none found: Conventional Commits'}) are sent to the selected Copilot model. ` +
            'Nothing is committed: the message goes into the dialog for you to read and edit.' +
            (actions.includes(ALWAYS) ? ' "Always allow" is shared with reviews of this repository.' : ''),
          actions);
        if (!current()) { return; }
        if (answer !== WRITE && answer !== ALWAYS) {
          await reply('commitMessageFailed', { cancelled: true, message: 'Cancelled.' });
          return;
        }
        if (answer === ALWAYS) { await this.host.rememberConsent(root); }
      }
      await reply('commitMessageProgress', { message: 'Writing the message…' });
      const { text, model } = await this.host.complete(buildCommitMessagePrompt(convention, commitDiff), modelId, cancellation.token);
      const message = cleanCommitMessage(text);
      if (!message) {
        await reply('commitMessageFailed', { message: 'The model returned no message. Try again, or choose another model.' });
        return;
      }
      await reply('commitMessageGenerated', { message, model, convention: convention.sources, omitted: commitDiff.omitted });
    } catch (error) {
      await reply('commitMessageFailed', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.running?.requestId === requestId) { this.running = undefined; }
      cancellation.dispose();
    }
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
