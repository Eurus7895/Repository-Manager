/**
 * HTML template for the webview panel
 */

import { RepositoryInfo } from '../types';
import * as vscode from 'vscode';
import { renderDashboardToolbar } from './toolbar';

/**
 * URIs for external webview resources
 */
export interface WebviewResourceUris {
  graphScriptUri: vscode.Uri;
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

function escapeHtml(value: string | undefined): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderRepositoryMark(className: string = 'repository-mark'): string {
  return `<svg class="${className}" viewBox="0 0 128 128" fill="none" aria-hidden="true">
    <rect width="128" height="128" rx="28" fill="#12161C"></rect>
    <rect x="1.5" y="1.5" width="125" height="125" rx="26.5" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="3"></rect>
    <path d="M20 99H108" stroke="#3CC7A6" stroke-width="3" stroke-linecap="round" stroke-opacity="0.55"></path>
    <path d="M64 42V87M64 52C64 66 34 60 34 74V87M64 52C64 66 94 60 94 74V87" stroke="#E8ECF1" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="64" cy="31" r="12" fill="#3CC7A6"></circle>
    <rect x="24" y="89" width="20" height="20" rx="5.5" fill="#12161C" stroke="#E8ECF1" stroke-width="6"></rect>
    <rect x="54" y="89" width="20" height="20" rx="5.5" fill="#12161C" stroke="#E8ECF1" stroke-width="6"></rect>
    <rect x="84" y="89" width="20" height="20" rx="5.5" fill="#12161C" stroke="#E8ECF1" stroke-width="6"></rect>
  </svg>`;
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
          <div class="modal-heading"><span class="modal-title">Branch across repositories</span><span>One branch name, created from the same base in every selected repository.</span></div>
          <button class="modal-close" data-action="closeModal" data-modal="createBranchModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Repositories</label>
            <div id="repositoryCheckboxes" class="branch-repository-list">
              ${repositories.map(repository => `
                <label class="branch-repository-row">
                  <input type="checkbox" class="branch-repository" value="${escapeHtml(repository.path)}" ${repository.status === 'conflict' ? 'disabled' : 'checked'}>
                  <strong>${escapeHtml(repository.name)}</strong>
                  <code>${escapeHtml(repository.currentBranch || `(detached) ${repository.currentCommit || ''}`)}</code>
                  <span class="repository-modal-status status-${repository.status}">${repository.isParentRepo ? 'parent' : repository.status}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="branch-form-grid branch-form-grid-equal">
            <div class="form-group">
              <label class="form-label">Base branch</label>
              <div class="branch-dropdown" id="baseBranchDropdown">
                <input type="text" class="branch-dropdown-input" id="baseBranchInput" placeholder="Loading branches..." readonly>
                <span class="branch-dropdown-arrow">▼</span>
                <div class="branch-dropdown-list" id="baseBranchList"><!-- Populated dynamically --></div>
              </div>
              <input type="hidden" id="baseBranch" value="">
              <div id="baseBranchHint" class="form-hint"></div>
            </div>
            <div class="form-group">
              <label class="form-label">Type</label>
              <select class="form-select" id="branchPrefix">
                <option value="bugfix">bugfix</option>
                <option value="release">release</option>
                <option value="dev">dev</option>
                <option value="none">None</option>
              </select>
              <div id="prefixRuleHint" class="form-hint"></div>
            </div>
          </div>
          <div class="branch-form-grid">
            <div class="form-group" id="ticketIdGroup">
              <label class="form-label">Ticket ID <span>optional</span></label>
              <input type="text" class="form-input" id="ticketId" placeholder="e.g., ECPT-15474">
            </div>
            <div class="form-group" id="taskTitleGroup">
              <label class="form-label">Task title</label>
              <input type="text" class="form-input" id="taskTitle" placeholder="e.g., CAN timeout handling">
            </div>
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
            <label class="form-label branch-name-label">Branch name</label>
            <div id="branchPreview" class="branch-name-preview">
              bugfix/your-branch-name
            </div>
            <input type="hidden" id="branchName">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="createBranchModal">Cancel</button>
          <button class="btn btn-primary" data-action="createBranch">Review &amp; create</button>
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

    <!-- Commit Changes Modal -->
    <div class="modal-overlay" id="commitChangesModal">
      <div class="modal commit-changes-modal">
        <div class="modal-header">
          <div class="modal-heading">
            <span class="modal-title">Create Commit</span>
            <span id="commitChangesRepository">Repository</span>
          </div>
          <button class="modal-close" data-action="closeModal" data-modal="commitChangesModal">&times;</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="commitChangesRepositoryPath">
          <div class="commit-changes-toolbar">
            <label><input type="checkbox" id="commitSelectAll" checked> Select all</label>
            <span id="commitSelectionCount">0 selected</span>
          </div>
          <div class="commit-preview-layout">
            <div class="commit-changes-list" id="commitChangesList">
              <div class="dashboard-loading">Loading changed files…</div>
            </div>
            <div class="commit-preview-panel">
              <div class="commit-preview-heading">
                <span id="commitPreviewPath">Select a file to preview its changes</span>
                <div class="commit-preview-modes" id="commitPreviewModes" hidden>
                  <button type="button" data-action="previewWorkingTreeMode" data-mode="staged">Staged</button>
                  <button type="button" data-action="previewWorkingTreeMode" data-mode="unstaged">Unstaged</button>
                </div>
              </div>
              <pre class="diff-viewer commit-preview-diff" id="commitPreviewDiff"><span class="diff-placeholder">Select a file to preview its changes.</span></pre>
              <span class="commit-preview-truncated" id="commitPreviewTruncated"></span>
            </div>
          </div>
          <div class="form-group commit-message-group">
            <label class="form-label" for="commitMessage">Commit message</label>
            <textarea class="form-input commit-message-input" id="commitMessage" rows="3" placeholder="Describe the changes"></textarea>
          </div>
          <div class="commit-result" id="commitChangesResult" role="status" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="commitChangesModal">Cancel</button>
          <button class="btn btn-primary" id="commitSelectedFilesButton" data-action="commitSelectedChanges">Commit selected</button>
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

    <!-- Compare Branches Modal -->
    <div class="modal-overlay" id="branchCompareModal">
      <div class="modal branch-compare-modal">
        <div class="modal-header">
          <div class="modal-heading"><span class="modal-title">Compare branches</span><span>Show the changes required to move from the base branch to the target branch.</span></div>
          <button class="modal-close" data-action="closeModal" data-modal="branchCompareModal">&times;</button>
        </div>
        <div class="modal-body branch-compare-fields">
          <div class="form-group">
            <label class="form-label" for="compareBaseBranch">Base branch</label>
            <select class="form-select" id="compareBaseBranch"><option value="">Loading branches...</option></select>
          </div>
          <span class="compare-direction" aria-hidden="true">→</span>
          <div class="form-group">
            <label class="form-label" for="compareTargetBranch">Target branch</label>
            <select class="form-select" id="compareTargetBranch"><option value="">Loading branches...</option></select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="branchCompareModal">Cancel</button>
          <button class="btn btn-primary" data-action="compareBranches">Compare branches</button>
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
  if (folders.length === 0) {
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

function renderDashboardSidebar(): string {
  return `
    <aside class="dashboard-sidebar">
      <section class="sidebar-section branches-section">
        <div class="sidebar-section-title"><span>Branches</span><span id="branchRefCount">—</span></div>
        <div class="sidebar-ref-list" id="dashboardBranches"><span class="sidebar-placeholder">Loading branches…</span></div>
      </section>
      <footer class="sidebar-reference-summary">
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="tags"><span>Tags</span><span id="tagRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardTags" data-reference-panel="tags" hidden></div>
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="remotes"><span>Remotes</span><span id="remoteRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardRemotes" data-reference-panel="remotes" hidden></div>
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="stashes"><span>Stashes</span><span id="stashRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardStashes" data-reference-panel="stashes" hidden></div>
      </footer>
    </aside>
  `;
}

function renderDashboard(repositories: RepositoryInfo[], workspaceFolders: WorkspaceFolderInfo[]): string {
  const activeRepository = repositories[0];
  return `
    <div class="dashboard-shell">
      <header class="dashboard-command-bar">
        <div class="dashboard-brand">
          ${renderRepositoryMark()}
          <strong>Repository Manager</strong>
        </div>
        ${renderWorkspaceFolderSelector(workspaceFolders)}
        ${renderDashboardToolbar(activeRepository)}
      </header>
      <div class="dashboard-body">
        ${renderDashboardSidebar()}
        <main class="dashboard-main">
          <div class="history-controls">
            <label class="remote-toggle"><input id="dashboardIncludeRemotes" type="checkbox" checked> Include remotes</label>
            <button class="compare-branches-button" type="button" data-action="openBranchCompareModal">⇄ Compare branches</button>
            <div class="commit-compare-status" id="commitCompareStatus" role="status" aria-live="polite" hidden></div>
            <div class="dashboard-search"><span>⌕</span><input id="dashboardSearch" type="text" placeholder="Search author, commit, message, or ref"></div>
          </div>
          <section class="history-region">
            <div class="history-table-header" id="historyTableHeader">
              <span class="history-column-header graph-column">Graph<span class="history-column-resizer" data-column-index="0" role="separator" aria-label="Resize Graph column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Message<span class="history-column-resizer" data-column-index="1" role="separator" aria-label="Resize Message column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Author<span class="history-column-resizer" data-column-index="2" role="separator" aria-label="Resize Author column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Date<span class="history-column-resizer" data-column-index="3" role="separator" aria-label="Resize Date column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Commit<span class="history-column-resizer" data-column-index="4" role="separator" aria-label="Resize Commit column" aria-orientation="vertical" tabindex="0"></span></span>
            </div>
            <div class="history-table" id="dashboardHistory"><div class="dashboard-loading">Loading history…</div></div>
            <button class="load-more-button" id="loadMoreHistory" data-action="loadMoreHistory" type="button" hidden>Load more commits</button>
          </section>
          <div class="dashboard-splitter dashboard-splitter-horizontal" id="historyDiffSplitter" role="separator" aria-label="Resize history and diff panels" aria-orientation="horizontal" tabindex="0"></div>
          <section class="commit-detail-region">
            <div class="commit-summary" id="dashboardCommitSummary">
              <div class="detail-placeholder">Select a commit to inspect its changed files and diff.</div>
            </div>
            <div class="change-summary" id="changeSummary" hidden>
              <div class="change-summary-toolbar"><button type="button" class="btn" data-action="summarizeChanges" id="summarizeChangesButton">Summarize changes</button><button type="button" class="btn" data-action="cancelChangeSummary" id="cancelChangeSummaryButton" hidden>Cancel</button><span id="changeSummaryStatus" role="status"></span></div>
              <div class="change-summary-result" id="changeSummaryResult"></div>
            </div>
            <div class="commit-content">
              <div class="changed-files-panel">
                <div class="panel-title"><span>Changed files</span><span id="changedFileCount">0</span></div>
                <div class="changed-files-list" id="dashboardChangedFiles"></div>
              </div>
              <div class="dashboard-splitter dashboard-splitter-vertical" id="filesDiffSplitter" role="separator" aria-label="Resize changed files and diff panels" aria-orientation="vertical" tabindex="0"></div>
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
  <script nonce="${nonce}" src="${resourceUris.graphScriptUri}"></script>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}
