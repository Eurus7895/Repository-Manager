/**
 * When to ask before code is sent to Copilot (reviews, fixes, explanations, summaries and commit
 * messages): the repositoryManager.copilot.askBeforeSending setting, which the dashboard's Copilot
 * settings menu changes. By default nothing is asked.
 *
 * The older repositoryManager.review.confirmBeforeSending (ask every time) still counts when it is
 * set and the new setting is not. Nothing here depends on VS Code, so it is tested without it.
 */

export type AskBeforeSending = 'never' | 'oncePerRepository' | 'always';
export const ASK_BEFORE_SENDING: readonly AskBeforeSending[] = ['never', 'oncePerRepository', 'always'];
export const ASK_BEFORE_SENDING_KEY = 'copilot.askBeforeSending';
const LEGACY_KEY = 'review.confirmBeforeSending';

/** The part of vscode.WorkspaceConfiguration (for the `repositoryManager` section) read here. */
export interface ConfigurationLike {
  get<T>(section: string): T | undefined;
  inspect<T>(section: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}

function explicitlySet(config: ConfigurationLike, key: string): boolean {
  const values = config.inspect(key);
  return Boolean(values) && [values!.globalValue, values!.workspaceValue, values!.workspaceFolderValue].some(value => value !== undefined);
}

export function askBeforeSending(config: ConfigurationLike): AskBeforeSending {
  if (explicitlySet(config, ASK_BEFORE_SENDING_KEY)) {
    const value = config.get<string>(ASK_BEFORE_SENDING_KEY);
    if (ASK_BEFORE_SENDING.includes(value as AskBeforeSending)) { return value as AskBeforeSending; }
  }
  return explicitlySet(config, LEGACY_KEY) && config.get<boolean>(LEGACY_KEY) === true ? 'always' : 'never';
}

/**
 * Where the menu writes a new choice: the workspace when the workspace sets it (a user-level value
 * would not apply there), otherwise the user settings.
 */
export function askBeforeSendingTarget(config: ConfigurationLike): 'workspace' | 'global' {
  const values = config.inspect(ASK_BEFORE_SENDING_KEY);
  return values && (values.workspaceValue !== undefined || values.workspaceFolderValue !== undefined) ? 'workspace' : 'global';
}

/**
 * The consent hooks the review and commit message controllers take: `never` asks nothing,
 * `oncePerRepository` skips repositories where "Always allow" was chosen, `always` asks every time.
 */
export function consentHooks(mode: () => AskBeforeSending, remembered: (root: string) => boolean):
  { alwaysConfirm(): boolean; isConsentRemembered(root: string): boolean } {
  return {
    alwaysConfirm: () => mode() === 'always',
    isConsentRemembered: root => mode() === 'never' || remembered(root)
  };
}
