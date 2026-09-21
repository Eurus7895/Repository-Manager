/**
 * Types and interfaces for the Repository Manager extension
 */

export interface RepositoryInfo {
  name: string;
  path: string;
  url: string;
  branch: string;
  currentCommit: string;
  currentBranch: string;
  status: SubmoduleStatus;
  hasChanges: boolean;
  ahead: number;
  behind: number;
  lastUpdated?: Date;
  isParentRepo?: boolean;
}

/**
 * Backward-compatible alias for services that specifically discover Git submodules.
 */
export type SubmoduleInfo = RepositoryInfo;

export type SubmoduleStatus =
  | 'clean'
  | 'modified'
  | 'uninitialized'
  | 'detached'
  | 'conflict'
  | 'unknown';

export interface BranchInfo {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  commit: string;
  lastCommitDate?: Date;
  lastCommitMessage?: string;
  hasLocal?: boolean;
  hasRemote?: boolean;
}

export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  hasChanges: boolean;
}

export interface PullRequestInfo {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
}

export interface CreateBranchOptions {
  branchName: string;
  baseBranch?: string;
  submodules: string[];
  checkout: boolean;
  pushToRemote: boolean;
}

export interface SyncOptions {
  submodules: string[];
  strategy: 'merge' | 'rebase' | 'reset';
  remoteBranch?: string;
}

export interface RepositoryManagerConfig {
  defaultBranch: string;
  autoFetch: boolean;
  showNotifications: boolean;
  githubToken: string;
}

export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  message: string;
}

export type GitRefKind = 'local-branch' | 'remote-branch' | 'tag' | 'head' | 'other';

export interface GitRefLabel {
  name: string;
  kind: GitRefKind;
  isCurrent?: boolean;
}

export interface HistoryCommit {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  refs: GitRefLabel[];
}

export interface HistoryQuery {
  repositoryPath: string;
  limit?: number;
  offset?: number;
  search?: string;
  branch?: string;
  includeRemotes?: boolean;
}

export interface HistoryPage {
  repositoryPath: string;
  commits: HistoryCommit[];
  nextOffset: number | null;
}

export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'unknown';

export interface ChangedFileInfo {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
}

export interface CommitDetail extends HistoryCommit {
  body: string;
  committedAt: string;
  committerName: string;
  committerEmail: string;
  files: ChangedFileInfo[];
}

export interface FileDiff {
  repositoryPath: string;
  commitHash: string;
  path: string;
  patch: string;
  truncated: boolean;
}

export interface TagInfo {
  name: string;
  targetHash: string;
  createdAt?: string;
}

export interface StashInfo {
  index: number;
  ref: string;
  subject: string;
  createdAt: string;
}

export interface RepositoryRefs {
  repositoryPath: string;
  branches: BranchInfo[];
  tags: TagInfo[];
  remotes: RemoteInfo[];
  stashes: StashInfo[];
}

export type DashboardRequest =
  | { type: 'getHistory'; payload: HistoryQuery }
  | { type: 'getCommitDetail'; payload: { repositoryPath: string; commitHash: string } }
  | { type: 'getFileDiff'; payload: { repositoryPath: string; commitHash: string; path: string } }
  | { type: 'getRepositoryRefs'; payload: { repositoryPath: string } };
