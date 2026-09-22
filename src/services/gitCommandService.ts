/**
 * Git Command Service
 * Base service for executing git commands
 */

import { execFile, spawn } from 'child_process';
import * as path from 'path';

export class GitCommandService {
  constructor(protected workspaceRoot: string) {}

  /**
   * Execute a git command and return the output
   */
  async execGit(args: string[], cwd?: string, timeoutMs: number = 30000): Promise<string> {
    const stdout = await this.execGitRaw(args, cwd, timeoutMs);
    return stdout.trim();
  }

  /**
   * Execute Git without a shell and preserve separators/whitespace for parsers.
   */
  async execGitRaw(args: string[], cwd?: string, timeoutMs: number = 30000): Promise<string> {
    const workDir = cwd || this.workspaceRoot;

    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: workDir,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }

        if (error.killed) {
          reject(new Error(`Git command timed out after ${timeoutMs}ms`));
          return;
        }

        reject(new Error(stderr.trim() || error.message || 'Git command failed'));
      });
    });
  }

  /**
   * Resolve a repository path inside the workspace boundary.
   */
  resolveRepositoryPath(repositoryPath: string): string {
    const root = path.resolve(this.workspaceRoot);
    if (!repositoryPath || repositoryPath === '.') {
      return root;
    }

    if (path.isAbsolute(repositoryPath)) {
      throw new Error('Repository path must be relative to the workspace');
    }

    const resolved = path.resolve(root, repositoryPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Repository path escapes the workspace: ${repositoryPath}`);
    }

    return resolved;
  }

  /**
   * Validate an object name before passing it to commands that accept revisions.
   */
  async resolveRevision(repositoryPath: string, revision: string): Promise<string> {
    if (!revision || revision.startsWith('-')) {
      throw new Error('Invalid Git revision');
    }

    const repositoryRoot = this.resolveRepositoryPath(repositoryPath);
    return this.execGit(['rev-parse', '--verify', `${revision}^{commit}`], repositoryRoot, 5000);
  }

  /**
   * Validate a repository-relative file path.
   */
  resolveFilePath(filePath: string): string {
    if (!filePath || path.isAbsolute(filePath)) {
      throw new Error('File path must be repository-relative');
    }
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error('File path escapes the repository');
    }
    return normalized.split(path.sep).join('/');
  }

  /**
   * Execute git command with streaming output
   */
  execGitStream(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const workDir = cwd || this.workspaceRoot;
      const process = spawn('git', args, { cwd: workDir });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Check if the workspace is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.execGit(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the workspace root
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
