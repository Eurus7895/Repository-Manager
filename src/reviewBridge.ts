/**
 * Carries review messages between the dashboard, the Repository Review tab and the
 * ReviewController, so that reviews have their own editor tab while the dashboard starts them.
 *
 * - The dashboard asks for a review (`requestReview`); the bridge opens the review tab and hands
 *   the request over (`beginReview`) once the tab says it is ready (`reviewReady`). Whatever the
 *   tab sends goes to the controller, and whatever the controller posts goes to the tab.
 * - A review keeps running when the tab is closed. The bridge keeps the messages of the review the
 *   tab showed, and replays them (`reviewRestore`) when the tab opens again.
 * - The dashboard gets a short status for its Review button (`reviewStatus`): the progress while a
 *   review runs, then the number of blocking items.
 * - The tab follows the dashboard: its repository, folder and model (`dashboardContext`).
 * - Evidence of a diff review opens in the dashboard's diff (`showReviewEvidence`).
 *
 * Nothing here depends on VS Code, so it is tested without it.
 */

export interface BridgeMessage { type: string; payload?: unknown }

export interface ReviewView {
  post(message: BridgeMessage): unknown;
}

export interface ReviewBridgeDeps {
  controller: { handles(type: string): boolean; handle(message: BridgeMessage): Promise<void> };
  postDashboard(message: BridgeMessage): unknown;
  /** Creates the review tab, or reveals it; a new one attaches itself when its webview loads. */
  openView(): void;
  revealDashboard(): void;
}

export interface DashboardReviewStatus {
  /** The review the button reports on: running, or the last one completed in the tab. */
  state: 'idle' | 'running' | 'completed' | 'failed';
  percent?: number;
  /** Blocking items of a completed review. */
  blocking?: number;
  repositoryPath?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The review messages a restored tab needs, in order (fix messages are not kept: see detach). */
const REPLAYED = new Set(['reviewProgress', 'reviewCompleted', 'reviewFailed', 'reviewTriageUpdated']);

export class ReviewBridge {
  private view?: ReviewView;
  private ready = false;
  private pending: Record<string, unknown>[] = [];
  private context?: Record<string, unknown>;
  /** The review the tab shows: how it started, and what the controller said about it since. */
  private current?: { start: Record<string, unknown>; messages: BridgeMessage[] };
  private status: DashboardReviewStatus = { state: 'idle' };

  constructor(private readonly deps: ReviewBridgeDeps) {}

  /** A review tab was created; it is ready once its script reports `reviewReady`. */
  attach(view: ReviewView): void {
    this.view = view;
    this.ready = false;
  }

  /**
   * The review tab closed. A running review goes on (its result is kept for the next tab); an
   * auto-fix proposal lives only on screen, so it is cancelled rather than left to be applied blind.
   */
  detach(): void {
    this.view = undefined;
    this.ready = false;
    void this.deps.controller.handle({ type: 'cancelReviewFix', payload: {} });
    if (this.current) {
      void this.deps.controller.handle({ type: 'discardReviewFix', payload: { requestId: this.current.start.requestId } });
    }
  }

  isOpen(): boolean {
    return Boolean(this.view);
  }

  /** Messages from the dashboard webview; returns false for the ones that are not about reviews. */
  fromDashboard(message: BridgeMessage): boolean {
    const payload = record(message.payload);
    switch (message.type) {
      case 'requestReview':
        this.pending.push(payload);
        this.open();
        return true;
      case 'openReviewTab':
        this.open();
        return true;
      case 'dashboardContext':
        this.context = payload;
        if (this.view && this.ready) { void this.view.post({ type: 'dashboardContext', payload }); }
        return true;
      case 'getReviewStatus':
        void this.deps.postDashboard({ type: 'reviewStatus', payload: this.status });
        return true;
      default:
        return false;
    }
  }

  /** Messages from the review tab. */
  async fromReview(message: BridgeMessage): Promise<void> {
    const payload = record(message.payload);
    switch (message.type) {
      case 'reviewReady':
        this.ready = true;
        if (this.context) { await this.view?.post({ type: 'dashboardContext', payload: this.context }); }
        if (this.current) { await this.view?.post({ type: 'reviewRestore', payload: this.current }); }
        for (const request of this.pending.splice(0)) { await this.view?.post({ type: 'beginReview', payload: request }); }
        return;
      case 'showReviewEvidence':
        this.deps.revealDashboard();
        await this.deps.postDashboard({ type: 'showReviewEvidence', payload });
        return;
      case 'startReview':
        this.current = { start: payload, messages: [] };
        this.setStatus({ state: 'running', percent: 0, repositoryPath: String(payload.repositoryPath || '') });
        break;
      case 'openStoredReview':
        this.current = { start: { ...payload, opening: true }, messages: [] };
        break;
    }
    if (this.deps.controller.handles(message.type)) { await this.deps.controller.handle(message); }
  }

  /** The controller's messages: to the tab, and the dashboard's button status from them. */
  async toReview(message: BridgeMessage): Promise<void> {
    const payload = record(message.payload);
    const current = this.current;
    if (current && REPLAYED.has(message.type) && payload.requestId === current.start.requestId) {
      current.messages.push(message);
      this.updateStatus(message.type, payload);
    }
    if (this.view && this.ready) { await this.view.post(message); }
  }

  private open(): void {
    if (this.view && this.ready) {
      for (const request of this.pending.splice(0)) { void this.view.post({ type: 'beginReview', payload: request }); }
    }
    this.deps.openView();
  }

  private updateStatus(type: string, payload: Record<string, unknown>): void {
    const repositoryPath = String(this.current?.start.repositoryPath || '');
    if (type === 'reviewProgress') {
      // Only a review that runs reports progress; an opened saved review goes straight to completed.
      if (this.current?.start.opening) { return; }
      this.setStatus({ state: 'running', percent: progressPercent(record(payload.detail)), repositoryPath });
    } else if (type === 'reviewCompleted' || type === 'reviewTriageUpdated') {
      const readiness = record(payload.readiness);
      const blocking = Array.isArray(readiness.blocking) ? readiness.blocking.length : 0;
      this.setStatus({ state: 'completed', blocking, repositoryPath });
    } else if (type === 'reviewFailed') {
      this.setStatus({ state: 'failed', repositoryPath });
    }
  }

  private setStatus(status: DashboardReviewStatus): void {
    this.status = status;
    void this.deps.postDashboard({ type: 'reviewStatus', payload: status });
  }
}

/** The same measure the review tab's progress bar shows. */
export function progressPercent(detail: Record<string, unknown>): number {
  const filesTotal = Number(detail.filesTotal) || 0;
  if (detail.phase === 'finishing') { return 100; }
  if (filesTotal) { return Math.round((100 * (Number(detail.filesDone) || 0)) / filesTotal); }
  const units = Number(detail.units) || 0;
  return units ? Math.round((100 * Math.max(0, (Number(detail.unit) || 0) - 1)) / units) : 0;
}
