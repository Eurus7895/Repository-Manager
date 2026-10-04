/**
 * Read-only commit history service used by the dashboard.
 */

import { GitCommandService } from './gitCommandService';
import { GitRefLabel, GitRefKind, HistoryCommit, HistoryPage, HistoryQuery } from '../types';

const FIELD_SEPARATOR = '\x1f';
const RECORD_SEPARATOR = '\x1e';
const HISTORY_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%s',
  '%D'
].join('%x1f') + '%x1e';

function classifyRef(name: string): { name: string; kind: GitRefKind; isCurrent?: boolean } {
  const trimmed = name.trim();
  if (trimmed.startsWith('HEAD -> ')) {
    return { name: trimmed.slice('HEAD -> '.length).replace(/^refs\/heads\//, ''), kind: 'head', isCurrent: true };
  }
  if (trimmed.startsWith('tag: ')) {
    return { name: trimmed.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' };
  }
  if (trimmed.startsWith('refs/heads/')) {
    return { name: trimmed.slice('refs/heads/'.length), kind: 'local-branch' };
  }
  if (trimmed.startsWith('refs/remotes/')) {
    return { name: trimmed.slice('refs/remotes/'.length), kind: 'remote-branch' };
  }
  return { name: trimmed, kind: 'other' };
}

export function parseDecorations(value: string): GitRefLabel[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(classifyRef);
}

export function parseHistoryOutput(output: string): HistoryCommit[] {
  return output
    .split(RECORD_SEPARATOR)
    .map(record => record.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
    .map(record => {
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length < 8) {
        throw new Error('Unexpected Git history record');
      }
      const [hash, shortHash, parents, authorName, authorEmail, authoredAt, subject, decorations] = fields;
      return {
        hash,
        shortHash,
        parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
        authorName,
        authorEmail,
        authoredAt,
        subject,
        refs: parseDecorations(decorations)
      };
    });
}

/** What a history search looks in: hashes, author, subject and ref names, ignoring case. */
function matchesSearch(commit: HistoryCommit, search: string): boolean {
  return [commit.hash, commit.shortHash, commit.authorName, commit.authorEmail, commit.subject, ...commit.refs.map(ref => ref.name)]
    .join('\n').toLowerCase().includes(search);
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

export class HistoryService {
  constructor(private gitCmd: GitCommandService) {}

  async getHistory(query: HistoryQuery): Promise<HistoryPage> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(query.repositoryPath);
    const limit = clamp(query.limit, 100, 1, 200);
    const offset = clamp(query.offset, 0, 0, 100000);
    const search = query.search?.trim().toLowerCase() || '';
    const args = search
      // A search reads the whole history, in Git's own order so the first matches arrive at once;
      // it stops as soon as it has this page and one more match.
      ? ['log', '--date=iso-strict', '--decorate=full', `--format=${HISTORY_FORMAT}`]
      : ['log', `--max-count=${limit + 1}`, '--topo-order', '--date=iso-strict', '--decorate=full', `--format=${HISTORY_FORMAT}`];

    if (!search && offset > 0) {
      args.push(`--skip=${offset}`);
    }

    if (query.branch) {
      args.push(await this.gitCmd.resolveRevision(query.repositoryPath, query.branch));
    } else if (query.includeRemotes) {
      args.push('--all');
    } else {
      args.push('HEAD');
    }

    let commits: HistoryCommit[];
    if (search) {
      const matches: HistoryCommit[] = [];
      const wanted = offset + limit + 1;
      await this.gitCmd.scanGitRecords(args, repositoryRoot, RECORD_SEPARATOR, record => {
        const [commit] = parseHistoryOutput(record);
        if (commit && matchesSearch(commit, search)) { matches.push(commit); }
        return matches.length >= wanted;
      }, 30000);
      commits = matches.slice(offset);
    } else {
      commits = parseHistoryOutput(await this.gitCmd.execGitRaw(args, repositoryRoot, 15000));
    }

    const hasMore = commits.length > limit;
    // The configured upstream, not a same-named guess: `work` may track `upstream/release`.
    // A detached HEAD or a branch without one has none.
    const upstream = (await this.gitCmd.execGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repositoryRoot, 5000
    ).catch(() => '')).trim() || null;
    return {
      repositoryPath: query.repositoryPath,
      offset,
      commits: commits.slice(0, limit),
      nextOffset: hasMore ? offset + limit : null,
      upstream
    };
  }
}
