/**
 * Commit metadata and patch service. Large patches are capped for webview safety.
 */

import { ChangedFileInfo, ChangedFileStatus, CommitDetail, FileDiff } from '../types';
import { GitCommandService } from './gitCommandService';
import { parseDecorations } from './historyService';

const FIELD_SEPARATOR = '\x1f';
const DETAIL_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%s',
  '%D',
  '%B'
].join('%x1f');
const MAX_PATCH_LENGTH = 1024 * 1024;

function mapStatus(code: string): ChangedFileStatus {
  switch (code.charAt(0)) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

export function parseChangedFilesOutput(output: string): ChangedFileInfo[] {
  const tokens = output.split('\0');
  const files: ChangedFileInfo[] = [];
  let index = 0;

  while (index < tokens.length) {
    const code = tokens[index++];
    if (!code) {
      continue;
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath && newPath) {
        files.push({ oldPath, path: newPath, status: mapStatus(code) });
      }
      continue;
    }

    const filePath = tokens[index++];
    if (filePath) {
      files.push({ path: filePath, status: mapStatus(code) });
    }
  }

  return files;
}

export class DiffService {
  constructor(private gitCmd: GitCommandService) {}

  async getCommitDetail(repositoryPath: string, revision: string): Promise<CommitDetail> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitHash = await this.gitCmd.resolveRevision(repositoryPath, revision);
    const [metadata, changedFiles] = await Promise.all([
      this.gitCmd.execGitRaw(['show', '-s', `--format=${DETAIL_FORMAT}`, commitHash], repositoryRoot, 10000),
      this.gitCmd.execGitRaw([
        'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', commitHash, '--'
      ], repositoryRoot, 10000)
    ]);

    const fields = metadata.split(FIELD_SEPARATOR);
    if (fields.length < 12) {
      throw new Error('Unexpected Git commit detail record');
    }
    const [
      hash, shortHash, parents, authorName, authorEmail, authoredAt,
      committerName, committerEmail, committedAt, subject, decorations, ...bodyParts
    ] = fields;

    return {
      hash,
      shortHash,
      parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
      authorName,
      authorEmail,
      authoredAt,
      committerName,
      committerEmail,
      committedAt,
      subject,
      refs: parseDecorations(decorations),
      body: bodyParts.join(FIELD_SEPARATOR).trim(),
      files: parseChangedFilesOutput(changedFiles)
    };
  }

  async getFileDiff(repositoryPath: string, revision: string, filePath: string): Promise<FileDiff> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitHash = await this.gitCmd.resolveRevision(repositoryPath, revision);
    const safePath = this.gitCmd.resolveFilePath(filePath);
    const output = await this.gitCmd.execGitRaw([
      'show', '--format=', '--no-ext-diff', '--find-renames', '--unified=80', commitHash, '--', safePath
    ], repositoryRoot, 15000);
    const truncated = output.length > MAX_PATCH_LENGTH;

    return {
      repositoryPath,
      commitHash,
      path: safePath,
      patch: truncated ? output.slice(0, MAX_PATCH_LENGTH) : output,
      truncated
    };
  }
}
