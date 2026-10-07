/**
 * Keeps the dashboard's view of local changes current while you edit: file events in the
 * workspace (saves, creates, deletes, and Git's own index and ref updates) schedule one repository
 * refresh after they settle, instead of a `git status` per event.
 *
 * Git's internal churn (objects, logs, lock files) is ignored. While the dashboard is hidden, or a
 * user action is running, the refresh waits and runs once when it can. Nothing here depends on
 * VS Code, so it is tested with a fake clock.
 */

export interface LiveChangesDeps {
  /** Refreshes the repository list (status and change counts of every repository). */
  refresh(): Promise<void>;
  /** Whether a refresh may run now: the dashboard is visible and no user action is running. */
  canRefresh(): boolean;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** How long file events must be quiet before the refresh runs. */
export const LIVE_CHANGES_DELAY_MS = 800;

/**
 * Whether a changed path can change what `git status` reports. Inside `.git`, only the index, HEAD
 * and refs do; objects, logs, hooks and lock files only churn while Git works.
 */
export function affectsStatus(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/.git/');
  if (at < 0) { return !normalized.endsWith('/.git'); }
  const inner = normalized.slice(at + '/.git/'.length);
  if (inner.endsWith('.lock')) { return false; }
  // A submodule's Git directory lives under .git/modules/<name>/: the same rule applies inside it.
  const own = inner.replace(/^(modules\/.+?\/)+/, '');
  return own === 'index' || own === 'HEAD' || own.startsWith('refs/');
}

export class LiveChanges {
  private timer: unknown;
  private pending = false;
  private running = false;
  private disposed = false;

  constructor(private readonly deps: LiveChangesDeps, private readonly delayMs = LIVE_CHANGES_DELAY_MS) {}

  /** A file event: the refresh runs once the events have been quiet for the delay. */
  notify(filePath: string): void {
    if (this.disposed || !affectsStatus(filePath)) { return; }
    this.pending = true;
    if (this.timer !== undefined) { this.deps.clearTimer(this.timer); }
    this.timer = this.deps.setTimer(() => { this.timer = undefined; void this.flush(); }, this.delayMs);
  }

  /** The dashboard became visible, or an action finished: run a refresh that had to wait. */
  resume(): void {
    if (this.pending && this.timer === undefined) { void this.flush(); }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) { this.deps.clearTimer(this.timer); }
    this.timer = undefined;
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.pending || this.running || !this.deps.canRefresh()) { return; }
    this.pending = false;
    this.running = true;
    try {
      await this.deps.refresh();
    } catch {
      // The next file event, or the next action, refreshes again.
    } finally {
      this.running = false;
    }
    // Events during the refresh asked for another one.
    if (this.pending && this.timer === undefined) { void this.flush(); }
  }
}
