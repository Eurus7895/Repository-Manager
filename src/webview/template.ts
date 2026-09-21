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

function renderDashboardSidebar(repositories: RepositoryInfo[], workspaceFolders: WorkspaceFolderInfo[]): string {
  return `
    <aside class="dashboard-sidebar">
      ${renderWorkspaceFolderSelector(workspaceFolders)}
      <section class="sidebar-section repositories-section">
        <div class="sidebar-section-title"><span>Repositories</span><span>${repositories.length}</span></div>
        <div class="dashboard-repository-list" id="dashboardRepositoryList">
          ${repositories.map((repository, index) => `
            <button class="dashboard-repository-item${index === 0 ? ' active' : ''}" type="button" data-action="selectDashboardRepository" data-repository="${repository.path}">
              <span class="repository-status-dot status-${repository.status}"></span>
              <span class="repository-item-copy"><strong>${repository.name}</strong><small>${repository.currentBranch || '(detached)'}</small></span>
              ${repository.isParentRepo ? '<span class="sidebar-badge">PARENT</span>' : ''}
            </button>
          `).join('')}
        </div>
      </section>
      <section class="sidebar-section compact-ref-section">
        <div class="sidebar-section-title"><span>Tags</span><span id="tagRefCount">—</span></div>
        <div class="sidebar-ref-list" id="dashboardTags"></div>
      </section>
      <section class="sidebar-section compact-ref-section">
        <div class="sidebar-section-title"><span>Remotes</span><span id="remoteRefCount">—</span></div>
        <div class="sidebar-ref-list" id="dashboardRemotes"></div>
      </section>
      <section class="sidebar-section compact-ref-section">
        <div class="sidebar-section-title"><span>Stashes</span><span id="stashRefCount">—</span></div>
        <div class="sidebar-ref-list" id="dashboardStashes"></div>
      </section>
    </aside>
  `;
}

function renderDashboard(repositories: RepositoryInfo[], workspaceFolders: WorkspaceFolderInfo[]): string {
  const activeRepository = repositories[0];
  return `
    <div class="dashboard-shell">
      <header class="dashboard-command-bar">
        <div class="command-cluster">
          <button class="dashboard-command" data-action="refresh"><span>↻</span><small>Refresh</small></button>
          <button class="dashboard-command" data-action="pullActiveRepository"><span>↓</span><small>Pull</small></button>
          <button class="dashboard-command" data-action="pushActiveRepository"><span>↑</span><small>Push</small></button>
          <button class="dashboard-command" data-action="fetchActiveRepository"><span>⇣</span><small>Fetch</small></button>
          <button class="dashboard-command" data-action="openCreateBranchModal"><span>⑂</span><small>Branch</small></button>
        </div>
        <div class="command-context" id="dashboardCommandContext">
          <strong>${activeRepository?.name || 'No repository'}</strong>
          <small>${activeRepository?.path === '.' ? 'workspace root' : activeRepository?.path || ''}</small>
        </div>
        <div class="command-cluster command-cluster-right">
          <button class="dashboard-command" data-action="openActiveRepository"><span>↗</span><small>Explorer</small></button>
          <button class="dashboard-command" data-action="syncAll"><span>⇄</span><small>Sync</small></button>
        </div>
      </header>
      <div class="dashboard-body">
        ${renderDashboardSidebar(repositories, workspaceFolders)}
        <main class="dashboard-main">
          <div class="history-controls">
            <select id="dashboardBranchFilter" aria-label="History branch"><option value="">HEAD</option></select>
            <label class="remote-toggle"><input id="dashboardIncludeRemotes" type="checkbox"> Include remotes</label>
            <div class="dashboard-search"><span>⌕</span><input id="dashboardSearch" type="text" placeholder="Search author, commit, message, or ref"></div>
          </div>
          <section class="history-region">
            <div class="history-table-header"><span class="graph-column"></span><span>Message</span><span>Author</span><span>Date</span><span>Commit</span></div>
            <div class="history-table" id="dashboardHistory"><div class="dashboard-loading">Loading history…</div></div>
            <button class="load-more-button" id="loadMoreHistory" data-action="loadMoreHistory" type="button" hidden>Load more commits</button>
          </section>
          <section class="commit-detail-region">
            <div class="commit-summary" id="dashboardCommitSummary">
              <div class="detail-placeholder">Select a commit to inspect its changed files and diff.</div>
            </div>
            <div class="commit-content">
              <div class="changed-files-panel">
                <div class="panel-title"><span>Changed files</span><span id="changedFileCount">0</span></div>
                <div class="changed-files-list" id="dashboardChangedFiles"></div>
              </div>
              <div class="diff-panel">
                <div class="panel-title"><span id="diffFileName">Diff</span><span id="diffTruncated"></span></div>
                <pre class="diff-viewer" id="dashboardDiff"><span class="diff-placeholder">Select a changed file to load its patch.</span></pre>
              </div>
            </div>
          </section>
        </main>
      </div>
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
  ${renderDashboard(repositories, workspaceFolders)}

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
