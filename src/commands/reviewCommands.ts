/**
 * Repository Manager: Forget Review Permissions — choose which repositories ask again before a
 * review sends code to Copilot.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewConsentStore } from '../reviewConsent';

export interface ForgetPermissionsUi {
  /** Multi-select pick; resolves the chosen values, or undefined when dismissed. */
  pick(items: Array<{ label: string; description: string; value: string }>, placeHolder: string): Promise<string[] | undefined>;
  notify(message: string): void;
}

export async function forgetReviewPermissions(store: ReviewConsentStore, workspaceRoot: string, ui: ForgetPermissionsUi): Promise<void> {
  const roots = store.list();
  if (!roots.length) {
    ui.notify('No repository skips the review question. Reviews already ask before sending code to Copilot.');
    return;
  }
  const items = roots.map(root => ({
    label: path.basename(root),
    description: path.relative(workspaceRoot, root) || '.',
    value: root
  }));
  const chosen = await ui.pick(items, 'Repositories that should ask again before a review sends code to Copilot');
  if (!chosen || !chosen.length) { return; }
  await store.forget(chosen);
  const names = chosen.map(root => path.basename(root)).join(', ');
  ui.notify(`Reviews in ${names} will ask before sending code to Copilot again.`);
}

export function registerReviewCommands(context: vscode.ExtensionContext, workspaceRoot: string): void {
  const store = new ReviewConsentStore(context.workspaceState);
  context.subscriptions.push(vscode.commands.registerCommand('repositoryManager.forgetReviewPermissions', () =>
    forgetReviewPermissions(store, workspaceRoot, {
      pick: async (items, placeHolder) => {
        // Every repository starts selected: forgetting is the reason the command was run.
        const picked = await vscode.window.showQuickPick(items.map(item => ({ ...item, picked: true })),
          { canPickMany: true, placeHolder, title: 'Forget review permissions' });
        return picked?.map(item => item.value);
      },
      notify: message => { void vscode.window.showInformationMessage(message); }
    })));
}
