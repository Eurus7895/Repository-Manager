/**
 * Repositories whose security and compliance reviews start without the consent question
 * ("Always allow for this repository"). Kept in workspace state, keyed by absolute repository
 * root, and shared by the dashboard and the Forget Review Permissions command.
 */

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'repositoryManager.reviewConsent';

export class ReviewConsentStore {
  constructor(private readonly memento?: MementoLike) {}

  list(): string[] {
    const value = this.memento?.get<unknown>(KEY);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  has(root: string): boolean {
    return this.list().includes(root);
  }

  async allow(root: string): Promise<void> {
    const roots = this.list();
    if (this.memento && !roots.includes(root)) { await this.memento.update(KEY, [...roots, root]); }
  }

  async forget(roots: string[]): Promise<void> {
    if (this.memento) { await this.memento.update(KEY, this.list().filter(root => !roots.includes(root))); }
  }
}
