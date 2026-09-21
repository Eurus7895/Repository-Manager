/**
 * HTML template for the webview panel
 */

import { RepositoryInfo } from '../types';
import * as vscode from 'vscode';

/**
 * URIs for external webview resources
 */
export interface WebviewResourceUris {
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
}

/**
 * Workspace folder info for folder selector
 */
export interface WorkspaceFolderInfo {
  name: string;
  path: string;
  isCurrent: boolean;
}

/**
 * Get status icon for repository status
 */
function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    'clean': '✓',
    'modified': '●',
    'uninitialized': '○',
    'detached': '◎',
    'conflict': '⚠',
    'unknown': '?'
  };
  return icons[status] || '?';
}

/**
 * Get status tooltip for repository status
 */
function getStatusTooltip(status: string): string {
  const tooltips: Record<string, string> = {
    'clean': 'Clean: On a branch with no uncommitted changes',
    'modified': 'Modified: Has uncommitted changes in this repository',
    'uninitialized': 'Uninitialized: This linked repository has not been cloned yet. Run Init Submodules to initialize it.',
    'detached': 'Detached HEAD: Checked out to a specific commit, not on any branch. This is normal when synced to the parent repo\'s recorded commit.',
    'conflict': 'Conflict: Merge conflict detected',
    'unknown': 'Unknown: Could not determine status'
  };
  return tooltips[status] || 'Unknown status';
}

/**
 * Render a single repository row
 */
export function renderRepositoryRow(repository: RepositoryInfo, index: number): string {
  const statusClass = `status-${repository.status}`;
  const statusIcon = getStatusIcon(repository.status);
  const statusTooltip = getStatusTooltip(repository.status);
  const branchDisplay = repository.currentBranch || '(detached)';
  const branchTooltip = repository.currentBranch
    ? `Currently on branch: ${repository.currentBranch}`
    : `Detached HEAD: Not on any branch, checked out to commit ${repository.currentCommit}`;

  const isParent = repository.isParentRepo === true;
  const cardClass = isParent ? 'repository-card parent-repo' : 'repository-card';
  const parentBadge = isParent ? '<span class="parent-badge">PARENT</span>' : '';
  const pathDisplay = isParent ? '(root)' : repository.path;

  return `
    <div class="${cardClass}" data-name="${repository.name}" data-path="${repository.path}" style="animation-delay: ${index * 0.02}s">
      <div class="repository-row">
        <input type="checkbox" class="row-checkbox" data-action="toggleSelection" data-repository="${repository.path}">
        <span class="row-name" title="${repository.name}">${repository.name}${parentBadge}</span>
        <span class="row-path" title="${repository.path}">${pathDisplay}</span>
        <span class="row-branch branch" title="${branchTooltip}">${branchDisplay}</span>
        <span class="row-commit commit">${repository.currentCommit || 'N/A'}</span>
        <span class="row-status ${statusClass}" title="${statusTooltip}">${statusIcon} ${repository.status.toUpperCase()}</span>
        <div class="row-sync">
          ${repository.ahead > 0 ? `<span class="ahead">↑${repository.ahead}</span>` : ''}
          ${repository.behind > 0 ? `<span class="behind">↓${repository.behind}</span>` : ''}
        </div>
        <span class="rebase-badge rebase-indicator" style="display: none;">REBASING</span>
        <div class="row-actions">
          ${!isParent ? `<button class="btn btn-sm" data-action="openCommitModal" data-repository="${repository.path}" title="Checkout specific commit">⎔</button>` : ''}
          <button class="btn btn-sm" data-action="pullChanges" data-repository="${repository.path}" title="Pull changes">↓</button>
          <button class="btn btn-sm" data-action="pushChanges" data-repository="${repository.path}" title="Push changes">↑</button>
          <button class="btn btn-sm" data-action="openRepository" data-repository="${repository.path}" title="Open in explorer">📂</button>
          ${repository.hasChanges && !isParent ? `<button class="btn btn-sm" data-action="stageSubmodule" data-repository="${repository.path}" title="Stage submodule pointer">+</button>` : ''}
        </div>
      </div>
      <div class="branches-panel" id="branches-${repository.path.replace(/[/.]/g, '-')}" style="display: none;">
        <div class="branches-loading">Loading branches...</div>
      </div>
    </div>
  `;
}

/**
 * Render the stats section
 */
function renderStats(repositories: RepositoryInfo[]): string {

  return `
    <div class="stats">
      <div class="stat-card" title="Total number of repositories in this workspace">
        <div class="stat-label">Total Repositories</div>
        <div class="stat-value">${repositories.length}</div>
        <div class="stat-desc">Parent and linked repositories</div>
      </div>
      <div class="stat-card" title="Repositories on a branch with no uncommitted changes">
        <div class="stat-label">Clean</div>
        <div class="stat-value success">${repositories.filter(s => s.status === 'clean').length}</div>
        <div class="stat-desc">On branch, no changes</div>
      </div>
      <div class="stat-card" title="Repositories with uncommitted changes (staged or unstaged files)">
        <div class="stat-label">Modified</div>
        <div class="stat-value warning">${repositories.filter(s => s.status === 'modified').length}</div>
        <div class="stat-desc">Has uncommitted changes</div>
      </div>
      <div class="stat-card" title="Repositories that are detached, uninitialized, or have conflicts">
        <div class="stat-label">Needs Attention</div>
        <div class="stat-value error">${repositories.filter(s => ['uninitialized', 'conflict', 'detached'].includes(s.status)).length}</div>
        <div class="stat-desc">Detached, uninitialized, or conflict</div>
      </div>
    </div>
  `;
}

/**
 * Render the repository list or empty state
 */
function renderRepositoryList(repositories: RepositoryInfo[]): string {
  if (repositories.length > 0) {
    return `
      <div class="repository-list" id="repositoryList">
        ${repositories.map((repository, index) => renderRepositoryRow(repository, index)).join('')}
      </div>
    `;
  }
  return `
    <div class="empty-state">
      <h2>No Repositories Available</h2>
      <p>Repository data could not be loaded for this workspace.</p>
      <button class="btn btn-primary" data-action="refresh">Refresh Repositories</button>
    </div>
  `;
}

/**
 * Render the modals
 */
function renderModals(repositories: RepositoryInfo[]): string {
  return `
    <!-- Create Branch Modal -->
    <div class="modal-overlay" id="createBranchModal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Create Branch</span>
          <button class="modal-close" data-action="closeModal" data-modal="createBranchModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Select Repositories</label>
            <div id="repositoryCheckboxes" style="max-height: 200px; overflow-y: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
              ${repositories.map(repository => `
                <label style="display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer;">
                  <input type="checkbox" class="branch-repository" value="${repository.path}" checked>
                  <span>${repository.name}${repository.isParentRepo ? ' <span class="parent-badge">PARENT</span>' : ''}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Base Branch</label>
            <div class="branch-dropdown" id="baseBranchDropdown">
              <input type="text" class="branch-dropdown-input" id="baseBranchInput" placeholder="Loading branches..." readonly>
              <span class="branch-dropdown-arrow">▼</span>
              <div class="branch-dropdown-list" id="baseBranchList">
                <!-- Populated dynamically -->
              </div>
            </div>
            <input type="hidden" id="baseBranch" value="">
            <div id="baseBranchHint" style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;"></div>
          </div>
          <div class="form-group">
            <label class="form-label">Branch Prefix</label>
            <select class="form-select" id="branchPrefix">
              <option value="bugfix">bugfix/</option>
              <option value="release">release/</option>
              <option value="dev">dev/</option>
            </select>
            <div id="prefixRuleHint" style="font-size: 11px; color: var(--info); margin-top: 4px;"></div>
          </div>
          <div class="form-group" id="ticketIdGroup">
            <label class="form-label">Ticket ID (optional)</label>
            <input type="text" class="form-input" id="ticketId" placeholder="e.g., ECPT-15474">
          </div>
          <div class="form-group" id="taskTitleGroup">
            <label class="form-label">Task Title</label>
            <input type="text" class="form-input" id="taskTitle" placeholder="e.g., Design and Implement XML Parser Abstraction Class">
          </div>
          <div class="form-group" id="releaseInfoGroup" style="display: none;">
            <label class="form-label">Product Name</label>
            <input type="text" class="form-input" id="productName" placeholder="e.g., HexOGen">
            <label class="form-label" style="margin-top: 12px;">Version</label>
            <input type="text" class="form-input" id="releaseVersion" placeholder="e.g., 10.54.0">
          </div>
          <div class="form-group" id="devBranchGroup" style="display: none;">
            <label class="form-label">Development Branch Name</label>
            <input type="text" class="form-input" id="devBranchName" placeholder="e.g., sprint-42 or v2-refactor">
          </div>
          <div class="form-group">
            <label class="form-label">Generated Branch Name</label>
            <div id="branchPreview" style="padding: 10px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; font-family: var(--vscode-editor-font-family); word-break: break-all; min-height: 20px; color: var(--text-secondary);">
              bugfix/your-branch-name
            </div>
            <input type="hidden" id="branchName">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="createBranchModal">Cancel</button>
          <button class="btn btn-primary" data-action="createBranch">Create Branch</button>
        </div>
      </div>
    </div>

    <!-- Review Branch Modal -->
    <div class="modal-overlay" id="reviewBranchModal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Review Created Branch</span>
          <button class="modal-close" data-action="closeModal" data-modal="reviewBranchModal">&times;</button>
        </div>
        <div class="modal-body">
          <div id="branchCreationResults" style="margin-bottom: 16px;"></div>
          <div class="form-group">
            <label class="form-label">Branch Name</label>
            <div id="reviewBranchName" style="padding: 10px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; font-family: var(--vscode-editor-font-family); word-break: break-all;"></div>
          </div>
          <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="pushAfterCreate" checked>
              <span>Push branch to remote after confirmation</span>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="reviewBranchModal">Close</button>
          <button class="btn btn-primary" data-action="confirmAndPush">Confirm & Push</button>
        </div>
      </div>
    </div>

    <!-- Checkout Branch Modal -->
    <div class="modal-overlay" id="checkoutModal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Checkout Branch</span>
          <button class="modal-close" data-action="closeModal" data-modal="checkoutModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Select Branch</label>
            <select class="form-select" id="branchSelect">
              <option value="">Loading branches...</option>
            </select>
          </div>
          <input type="hidden" id="checkoutRepository">
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="checkoutModal">Cancel</button>
          <button class="btn btn-primary" data-action="checkoutBranch">Checkout</button>
        </div>
      </div>
    </div>

    <!-- Checkout Commit Modal -->
    <div class="modal-overlay" id="commitModal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Checkout Specific Commit</span>
          <button class="modal-close" data-action="closeModal" data-modal="commitModal">&times;</button>
        </div>
        <div class="modal-body">
          <div id="recordedCommitInfo" class="form-group">
            <!-- Will be populated dynamically -->
          </div>
          <div class="form-group">
            <label class="form-label">Enter Commit Hash</label>
            <input type="text" class="form-input" id="commitInput" placeholder="e.g., abc123def or full hash">
          </div>
          <div class="form-group">
            <label class="form-label">Or Select Recent Commit</label>
            <select class="form-select" id="commitSelect">
              <option value="">Loading commits...</option>
            </select>
          </div>
          <input type="hidden" id="commitRepository">
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="commitModal">Cancel</button>
          <button class="btn" data-action="useRecorded">Use Recorded</button>
          <button class="btn btn-primary" data-action="checkoutCommit">Checkout</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate a nonce for CSP
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Render workspace folder selector (only shown if multiple folders exist)
 */
function renderWorkspaceFolderSelector(folders: WorkspaceFolderInfo[]): string {
  if (folders.length <= 1) {
    return '';
  }

  const currentFolder = folders.find(f => f.isCurrent);

  return `
    <div class="workspace-folder-bar">
      <span class="workspace-folder-label">Workspace Folder:</span>
      <div class="workspace-folder-selector">
        <select class="workspace-folder-select" id="workspaceFolderSelect">
          ${folders.map(f => `
            <option value="${f.path}" ${f.isCurrent ? 'selected' : ''} title="${f.path}">
              ${f.name}
            </option>
          `).join('')}
        </select>
      </div>
      <span class="workspace-folder-path" title="${currentFolder?.path || ''}">${currentFolder?.path || ''}</span>
    </div>
  `;
}

/**
 * Generate the full HTML for the webview
 */
export function getHtmlForWebview(repositories: RepositoryInfo[], resourceUris: WebviewResourceUris, workspaceFolders: WorkspaceFolderInfo[] = []): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resourceUris.styleUri.scheme}:; script-src 'nonce-${nonce}';">
  <title>Repository Manager</title>
  <link rel="stylesheet" href="${resourceUris.styleUri}">
</head>
<body>
  <div class="container">
    <header>
      <h1>Repository Manager</h1>
      <div class="header-actions">
        <button class="btn" data-action="refresh">↻ Refresh</button>
        <button class="btn btn-primary" data-action="openCreateBranchModal">+ Create Branch</button>
      </div>
    </header>

    ${renderWorkspaceFolderSelector(workspaceFolders)}

    ${renderStats(repositories)}

    <div class="toolbar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="Search repositories...">
      </div>
      <button class="btn" data-action="selectAll">☑ Select All</button>
      <button class="btn" data-action="deselectAll">☐ Deselect All</button>
      <button class="btn" data-action="initAll" title="Initialize configured Git submodules">↓ Init Submodules</button>
      <button class="btn" data-action="updateAll" title="Update configured Git submodules">⟳ Update Submodules</button>
      <button class="btn" data-action="syncAll">⟲ Sync Versions</button>
    </div>

    ${renderRepositoryList(repositories)}
  </div>

  <div class="selection-bar" id="selectionBar">
    <span class="selection-count"><span id="selectedCount">0</span> selected</span>
    <button class="btn btn-primary btn-sm" data-action="createBranchForSelected">Create Branch</button>
    <button class="btn btn-sm" data-action="syncSelected">Sync</button>
    <button class="btn btn-sm" data-action="deselectAll">Cancel</button>
  </div>

  ${renderModals(repositories)}

  <script nonce="${nonce}">window.__initialRepositories = ${JSON.stringify(repositories)};</script>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}
