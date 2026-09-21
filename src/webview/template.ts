/**
 * HTML template for the webview panel
 */

import { SubmoduleInfo } from '../types';
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
 * Get status icon for submodule status
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
 * Get status tooltip for submodule status
 */
function getStatusTooltip(status: string): string {
  const tooltips: Record<string, string> = {
    'clean': 'Clean: On a branch with no uncommitted changes',
    'modified': 'Modified: Has uncommitted changes inside the submodule',
    'uninitialized': 'Uninitialized: Submodule has not been cloned yet. Run Init All to initialize.',
    'detached': 'Detached HEAD: Checked out to a specific commit, not on any branch. This is normal when synced to the parent repo\'s recorded commit.',
    'conflict': 'Conflict: Merge conflict detected',
    'unknown': 'Unknown: Could not determine status'
  };
  return tooltips[status] || 'Unknown status';
}

/**
 * Render a single submodule row
 */
export function renderSubmoduleRow(submodule: SubmoduleInfo, index: number): string {
  const statusClass = `status-${submodule.status}`;
  const statusIcon = getStatusIcon(submodule.status);
  const statusTooltip = getStatusTooltip(submodule.status);
  const branchDisplay = submodule.currentBranch || '(detached)';
  const branchTooltip = submodule.currentBranch
    ? `Currently on branch: ${submodule.currentBranch}`
    : `Detached HEAD: Not on any branch, checked out to commit ${submodule.currentCommit}`;

  const isParent = submodule.isParentRepo === true;
  const cardClass = isParent ? 'submodule-card parent-repo' : 'submodule-card';
  const parentBadge = isParent ? '<span class="parent-badge">PARENT</span>' : '';
  const pathDisplay = isParent ? '(root)' : submodule.path;

  return `
    <div class="${cardClass}" data-name="${submodule.name}" data-path="${submodule.path}" style="animation-delay: ${index * 0.02}s">
      <div class="submodule-row">
        <input type="checkbox" class="row-checkbox" data-action="toggleSelection" data-submodule="${submodule.path}">
        <span class="row-name" title="${submodule.name}">${submodule.name}${parentBadge}</span>
        <span class="row-path" title="${submodule.path}">${pathDisplay}</span>
        <span class="row-branch branch" title="${branchTooltip}">${branchDisplay}</span>
        <span class="row-commit commit">${submodule.currentCommit || 'N/A'}</span>
        <span class="row-status ${statusClass}" title="${statusTooltip}">${statusIcon} ${submodule.status.toUpperCase()}</span>
        <div class="row-sync">
          ${submodule.ahead > 0 ? `<span class="ahead">↑${submodule.ahead}</span>` : ''}
          ${submodule.behind > 0 ? `<span class="behind">↓${submodule.behind}</span>` : ''}
        </div>
        <span class="rebase-badge rebase-indicator" style="display: none;">REBASING</span>
        <div class="row-actions">
          ${!isParent ? `<button class="btn btn-sm" data-action="openCommitModal" data-submodule="${submodule.path}" title="Checkout specific commit">⎔</button>` : ''}
          <button class="btn btn-sm" data-action="pullChanges" data-submodule="${submodule.path}" title="Pull changes">↓</button>
          <button class="btn btn-sm" data-action="pushChanges" data-submodule="${submodule.path}" title="Push changes">↑</button>
          <button class="btn btn-sm" data-action="openSubmodule" data-submodule="${submodule.path}" title="Open in explorer">📂</button>
          ${submodule.hasChanges && !isParent ? `<button class="btn btn-sm" data-action="stageSubmodule" data-submodule="${submodule.path}" title="Stage submodule pointer">+</button>` : ''}
        </div>
      </div>
      <div class="branches-panel" id="branches-${submodule.path.replace(/[/.]/g, '-')}" style="display: none;">
        <div class="branches-loading">Loading branches...</div>
      </div>
    </div>
  `;
}

/**
 * Render the stats section
 */
function renderStats(submodules: SubmoduleInfo[]): string {
  // Filter out parent repo for stats calculation
  const submodulesOnly = submodules.filter(s => !s.isParentRepo);

  return `
    <div class="stats">
      <div class="stat-card" title="Total number of submodules configured in this repository">
        <div class="stat-label">Total Submodules</div>
        <div class="stat-value">${submodulesOnly.length}</div>
        <div class="stat-desc">All configured submodules</div>
      </div>
      <div class="stat-card" title="Submodules on a branch with no uncommitted changes">
        <div class="stat-label">Clean</div>
        <div class="stat-value success">${submodulesOnly.filter(s => s.status === 'clean').length}</div>
        <div class="stat-desc">On branch, no changes</div>
      </div>
      <div class="stat-card" title="Submodules with uncommitted changes (staged or unstaged files)">
        <div class="stat-label">Modified</div>
        <div class="stat-value warning">${submodulesOnly.filter(s => s.status === 'modified').length}</div>
        <div class="stat-desc">Has uncommitted changes</div>
      </div>
      <div class="stat-card" title="Submodules that are detached (not on a branch), uninitialized, or have conflicts">
        <div class="stat-label">Needs Attention</div>
        <div class="stat-value error">${submodulesOnly.filter(s => ['uninitialized', 'conflict', 'detached'].includes(s.status)).length}</div>
        <div class="stat-desc">Detached, uninitialized, or conflict</div>
      </div>
    </div>
  `;
}

/**
 * Render the submodule list or empty state
 */
function renderSubmoduleList(submodules: SubmoduleInfo[]): string {
  if (submodules.length > 0) {
    return `
      <div class="submodule-list" id="submoduleList">
        ${submodules.map((s, i) => renderSubmoduleRow(s, i)).join('')}
      </div>
    `;
  }
  return `
    <div class="empty-state">
      <h2>No Submodules Found</h2>
      <p>This workspace doesn't have any Git submodules yet.</p>
      <button class="btn btn-primary" data-action="initAll">Initialize Submodules</button>
    </div>
  `;
}

/**
 * Render the modals
 */
function renderModals(submodules: SubmoduleInfo[]): string {
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
            <div id="submoduleCheckboxes" style="max-height: 200px; overflow-y: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
              ${submodules.map(s => `
                <label style="display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer;">
                  <input type="checkbox" class="branch-submodule" value="${s.path}" checked>
                  <span>${s.name}${s.isParentRepo ? ' <span class="parent-badge">PARENT</span>' : ''}</span>
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
          <input type="hidden" id="checkoutSubmodule">
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
          <input type="hidden" id="commitSubmodule">
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
export function getHtmlForWebview(submodules: SubmoduleInfo[], resourceUris: WebviewResourceUris, workspaceFolders: WorkspaceFolderInfo[] = []): string {
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

    ${renderStats(submodules)}

    <div class="toolbar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="Search submodules...">
      </div>
      <button class="btn" data-action="selectAll">☑ Select All</button>
      <button class="btn" data-action="deselectAll">☐ Deselect All</button>
      <button class="btn" data-action="initAll">↓ Init All</button>
      <button class="btn" data-action="updateAll">⟳ Update All</button>
      <button class="btn" data-action="syncAll">⟲ Sync Versions</button>
    </div>

    ${renderSubmoduleList(submodules)}
  </div>

  <div class="selection-bar" id="selectionBar">
    <span class="selection-count"><span id="selectedCount">0</span> selected</span>
    <button class="btn btn-primary btn-sm" data-action="createBranchForSelected">Create Branch</button>
    <button class="btn btn-sm" data-action="syncSelected">Sync</button>
    <button class="btn btn-sm" data-action="deselectAll">Cancel</button>
  </div>

  ${renderModals(submodules)}

  <script nonce="${nonce}">window.__initialSubmodules = ${JSON.stringify(submodules)};</script>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}
