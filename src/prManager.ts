/**
 * Pull Request Manager for GitHub integration
 */

/* eslint-disable @typescript-eslint/naming-convention -- GitHub payload and HTTP header names are external contracts. */

import * as vscode from 'vscode';
import * as https from 'https';
import { GitOperations } from './gitOperations';
import { PullRequestInfo, CommandResult } from './types';

interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export class PRManager {
  private gitOps: GitOperations;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.gitOps = new GitOperations(workspaceRoot);
  }

  private getToken(): string | undefined {
    const config = vscode.workspace.getConfiguration('repositoryManager');
    const token = config.get<string>('githubToken');
    return token && token.length > 0 ? token : undefined;
  }

  private async makeGitHubRequest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = this.getToken();
    if (!token) {
      throw new Error('GitHub token not configured. Please set repositoryManager.githubToken in settings.');
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        port: 443,
        path: path,
        method: method,
        headers: {
          'Authorization': `token ${token}`,
          'User-Agent': 'VSCode-Repository-Manager',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data ? JSON.parse(data) : {} as T);
            } else {
              const error = data ? JSON.parse(data) : { message: 'Unknown error' };
              reject(new Error(error.message || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Create a pull request for a submodule
   */
  async createPullRequest(
    submodulePath: string,
    prInfo: PullRequestInfo
  ): Promise<CommandResult> {
    try {
      // Get remote URL
      const remotes = await this.gitOps.getRemotes(submodulePath);
      const origin = remotes.find(r => r.name === 'origin');

      if (!origin) {
        return { success: false, message: 'No origin remote found' };
      }

      // Parse GitHub URL
      const repoInfo = this.gitOps.parseGitHubUrl(origin.fetchUrl);
      if (!repoInfo) {
        return { success: false, message: 'Could not parse GitHub URL from remote' };
      }

      // Push the branch first
      const pushResult = await this.gitOps.pushChanges(submodulePath, prInfo.headBranch);
      if (!pushResult.success) {
        return pushResult;
      }

      // Create the PR
      const pr = await this.makeGitHubRequest<GitHubPR>(
        'POST',
        `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
        {
          title: prInfo.title,
          body: prInfo.body,
          head: prInfo.headBranch,
          base: prInfo.baseBranch,
          draft: prInfo.draft
        }
      );

      return {
        success: true,
        message: `Pull request #${pr.number} created successfully`,
        data: { url: pr.html_url, number: pr.number }
      };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to create PR: ${err.message}` };
    }
  }

  /**
   * Get open pull requests for a submodule
   */
  async getPullRequests(submodulePath: string): Promise<GitHubPR[]> {
    try {
      const remotes = await this.gitOps.getRemotes(submodulePath);
      const origin = remotes.find(r => r.name === 'origin');

      if (!origin) {
        return [];
      }

      const repoInfo = this.gitOps.parseGitHubUrl(origin.fetchUrl);
      if (!repoInfo) {
        return [];
      }

      const prs = await this.makeGitHubRequest<GitHubPR[]>(
        'GET',
        `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls?state=open`
      );

      return prs;
    } catch {
      return [];
    }
  }

  /**
   * Open PR in browser
   */
  async openPRInBrowser(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Create PR using VS Code's built-in Git extension
   */
  async createPRWithGitHub(submodulePath: string): Promise<void> {
    // Get remote URL to construct GitHub new PR URL
    const remotes = await this.gitOps.getRemotes(submodulePath);
    const origin = remotes.find(r => r.name === 'origin');

    if (!origin) {
      vscode.window.showErrorMessage('No origin remote found');
      return;
    }

    const repoInfo = this.gitOps.parseGitHubUrl(origin.fetchUrl);
    if (!repoInfo) {
      vscode.window.showErrorMessage('Could not parse GitHub URL');
      return;
    }

    // Get current branch
    const submodule = await this.gitOps.getSubmoduleInfo(
      submodulePath.split('/').pop() || submodulePath,
      submodulePath
    );

    if (!submodule.currentBranch) {
      vscode.window.showErrorMessage('No branch checked out');
      return;
    }

    // Open GitHub new PR page
    const prUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/compare/${submodule.currentBranch}?expand=1`;
    await vscode.env.openExternal(vscode.Uri.parse(prUrl));
  }

  /**
   * Check if GitHub token is configured
   */
  hasToken(): boolean {
    return !!this.getToken();
  }

  /**
   * Prompt user to configure GitHub token
   */
  async promptForToken(): Promise<boolean> {
    const action = await vscode.window.showInformationMessage(
      'GitHub token is required for PR operations. Would you like to configure it now?',
      'Open Settings',
      'Cancel'
    );

    if (action === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'repositoryManager.githubToken'
      );
      return true;
    }

    return false;
  }
}
