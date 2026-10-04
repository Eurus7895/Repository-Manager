// Webview script for Repository Manager
// This file is loaded as an external script by the webview panel.
// Initial repository data is provided via window.__initialRepositories (set by inline script).

(function () {
  const vscode = acquireVsCodeApi();

  // Restore state from previous session
  const previousState = vscode.getState() || {};
  let repositoryData = previousState.repositoryData || previousState.submoduleData || (window.__initialRepositories || []);
  let activeDashboardRepository = previousState.activeDashboardRepository || (repositoryData[0] && repositoryData[0].path) || '.';
  let selectedDashboardCommit = previousState.selectedDashboardCommit || null;
  let historyNextOffset = null;
  let historySearchTimer = null;
  let historyRequestId = 0;
  let selectedDashboardFile = null;
  let comparisonBaseHash = null;
  let activeComparisonTarget = null;
  let comparisonSource = null;
  let commitCompareSelection = Array.isArray(previousState.commitCompareSelection)
    ? previousState.commitCompareSelection.slice(0, 2)
    : [];
  let comparisonRepository = previousState.comparisonRepository || activeDashboardRepository;
  let dashboardHistoryState = previousState.dashboardHistoryState || {};
  let dashboardActivated = false;
  let loadedHistoryCommits = [];
  let repositoryRefs = { branches: [], tags: [], remotes: [], stashes: [] };
  // The checked-out branch's configured upstream, from the latest first history page.
  let loadedHistoryUpstream = null;
  let pendingBranchCheckout = null;
  let pendingHistoryViewport = null;
  let historyPanelHeight = Number(previousState.historyPanelHeight) || 0;
  let historyAppendPending = false; // a Load more page is on its way (also started by scrolling)
  let summaryModelsState = 'idle'; // the Model menu's list: idle (not loaded), loading, loaded
  // The Review tab can take the whole dashboard (history hidden); remembered across reloads.
  let reviewExpanded = Boolean(previousState.reviewExpanded);
  let filesPanelWidth = Number(previousState.filesPanelWidth) || 0;
  const defaultHistoryColumnWidths = [76, 420, 150, 110, 80];
  let historyColumnWidths = Array.isArray(previousState.historyColumnWidths)
    && previousState.historyColumnWidths.length === defaultHistoryColumnWidths.length
    ? previousState.historyColumnWidths.map(Number)
    : [];
  let renderedHistoryColumnWidths = defaultHistoryColumnWidths.slice();
  let historyGraphWidth = 76;
  let loadedHistoryGraphModel = null;
  let historyGraphGeometryFrame = 0;
  let historyGraphGeometrySignature = '';
  let historyColumnMinimums = [52, 80, 58, 54, 52];
  const runningToolbarOperations = new Set();
  let workingTreeChanges = [];
  // Repository whose unsent commit message is kept in the Commit dialog (Escape or Cancel keep the draft).
  let commitDraftRepository = null;
  let previewedWorkingTreeFile = null;
  let workingTreePreviewMode = 'unstaged';
  let workingTreePreviewRequestId = 0;
  let changeSummaryRequestId = 0;
  let changeSummarySelection = null;
  let selectedSummaryModelId = '';
  // Security and compliance review; declared early because rendering checks the review lock.
  let reviewRequestId = 0;
  let historyDateFormat = null; // shared by every history row (see formatHistoryDate)
  let repositoryDataAt = Date.now(); // when the repository list was last received (the page starts with it)
  // Release › Load range: the request resolving the range since the latest release tag.
  let releaseRange = null; // { requestId, repositoryPath }
  // Names for the ends of the loaded comparison (e.g. a release tag and a branch), for reviews of it.
  let comparisonLabels = null;
  let releaseRangeRequestId = 0;
  // Past reviews of the active repository, as listed by the extension.
  let reviewHistory = { repositoryPath: null, entries: [] };
  let reviewHistoryListId = 0;
  let reviewState = null; // { requestId, repositoryPath, scope, kind, status, progress, result, readiness, context, message }
  const changeSummaries = new Map();
  let activeChangeSummaryKey = null;
  let historyContextTarget = null;
  let branchFromCommitTarget = null;

  function hideHistoryContextMenu() {
    document.getElementById('historyContextMenu').hidden = true;
  }

  // Operation paused in each repository ('rebase', 'merge', ...), as last reported by the extension.
  const pendingOperations = {};
  let historyContextMenuPoint = null;

  // Show menu items such as Continue/Abort rebase only while their operation is in progress.
  function applyHistoryMenuOperation() {
    const operation = pendingOperations[activeDashboardRepository] || null;
    document.querySelectorAll('#historyContextMenu [data-requires-operation]').forEach(item => {
      item.hidden = item.dataset.requiresOperation !== operation;
    });
  }

  function positionHistoryContextMenu() {
    const menu = document.getElementById('historyContextMenu');
    if (!menu || !historyContextMenuPoint) return;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(0, Math.min(historyContextMenuPoint.x, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(0, Math.min(historyContextMenuPoint.y, height - menu.offsetHeight - 8))}px`;
  }

  function showHistoryContextMenu(element, x, y) {
    const commit = loadedHistoryCommits.find(item => item.hash === element.dataset.commit);
    if (!commit) return false;
    historyContextTarget = { repositoryPath: activeDashboardRepository, hash: commit.hash };
    const menu = document.getElementById('historyContextMenu');
    historyContextMenuPoint = { x, y };
    applyHistoryMenuOperation();
    menu.hidden = false;
    positionHistoryContextMenu();
    menu.querySelector('button:not([hidden])').focus();
    // The cached state can be stale (e.g. a rebase continued in a terminal); refresh it while the menu is open.
    postMessage('getPendingOperation', { repositoryPath: activeDashboardRepository });
    return true;
  }

  function restoreBranchModalControls() {
    branchFromCommitTarget = null;
    const baseInput = document.getElementById('baseBranchInput');
    baseInput.disabled = false;
    baseInput.value = '';
    baseInput.placeholder = 'Loading branches...';
    document.getElementById('baseBranch').value = '';
    document.getElementById('baseBranchHint').textContent = '';
    document.getElementById('baseBranchDropdown').style.pointerEvents = '';
    document.getElementById('branchFromCommitCheckoutRow').hidden = true;
    document.querySelectorAll('.branch-repository').forEach(cb => {
      if (cb.dataset.originalDisabled !== undefined) {
        cb.disabled = cb.dataset.originalDisabled === 'true';
      }
    });
  }

  function changeSummaryKey(selection, repositoryPath = activeDashboardRepository) {
    return JSON.stringify([repositoryPath, selection.baseSha, selection.targetSha, selectedSummaryModelId]);
  }

  function cancelPendingChangeSummary() {
    if (!activeChangeSummaryKey) return;
    const record = changeSummaries.get(activeChangeSummaryKey);
    if (record && record.pending) {
      record.pending = false;
      record.status = 'Summary cancelled.';
      postMessage('cancelChangeSummary', {});
    }
    activeChangeSummaryKey = null;
  }

  function resetChangeSummary(cancelPending = false) {
    if (cancelPending) cancelPendingChangeSummary();
    changeSummarySelection = null;
    const area = document.getElementById('changeSummary');
    const result = document.getElementById('changeSummaryResult');
    const status = document.getElementById('changeSummaryStatus');
    const cancel = document.getElementById('cancelChangeSummaryButton');
    const start = document.getElementById('summarizeChangesButton');
    if (area) area.hidden = true;
    if (result) result.innerHTML = '';
    if (status) status.textContent = '';
    if (cancel) cancel.hidden = true;
    if (start) start.disabled = false;
  }

  function restoreChangeSummary() {
    if (!changeSummarySelection) return;
    const record = changeSummaries.get(changeSummaryKey(changeSummarySelection));
    document.getElementById('changeSummary').hidden = false;
    document.getElementById('changeSummaryResult').innerHTML = '';
    document.getElementById('changeSummaryStatus').textContent = record ? record.status : '';
    document.getElementById('summarizeChangesButton').disabled = Boolean(record && record.pending);
    document.getElementById('cancelChangeSummaryButton').hidden = !record || !record.pending;
    if (record && record.summary) {
      renderChangeSummary({ requestId: record.requestId, repositoryPath: record.repositoryPath,
        summary: record.summary, model: record.model });
    }
  }

  function isCurrentChangeSummary(payload) {
    return payload && changeSummarySelection && payload.repositoryPath === activeDashboardRepository &&
      changeSummarySelection.targetSha === selectedDashboardCommit &&
      changeSummarySelection.baseSha === comparisonBaseHash &&
      changeSummaries.get(changeSummaryKey(changeSummarySelection))?.requestId === payload.requestId;
  }

  function finishChangeSummary() {
    document.getElementById('cancelChangeSummaryButton').hidden = true;
    document.getElementById('summarizeChangesButton').disabled = false;
  }

  function renderChangeSummary(payload) {
    if (!isCurrentChangeSummary(payload)) return;
    const data = payload.summary;
    if (!data || data.targetSha !== changeSummarySelection.targetSha ||
        data.baseSha !== (changeSummarySelection.baseSha || '4b825dc642cb6eb9a060e54bf8d69288fbee4904')) return;
    finishChangeSummary();
    document.getElementById('changeSummaryStatus').textContent = `Completed · ${payload.model}`;
    const changed = new Set(changeSummarySelection.files.map(file => file.path));
    function claim(item) {
      const refs = (item.evidence || []).map(ref => changed.has(ref)
        ? `<button class="change-summary-evidence" type="button" data-action="selectChangedFile" data-path="${escapeHtml(ref)}">${escapeHtml(ref)}</button>`
        : `<button class="change-summary-evidence" type="button" data-action="selectHistoryCommit" data-commit="${escapeHtml(ref)}">${escapeHtml(ref.slice(0, 12))}</button>`).join('');
      return `<li>${escapeHtml(item.text)}${refs ? `<div>${refs}</div>` : ''}</li>`;
    }
    function section(title, items) {
      return `<section><h4>${title}</h4>${items.length ? `<ul>${items.map(claim).join('')}</ul>` : '<p>None identified from the provided context.</p>'}</section>`;
    }
    const limitations = [...(data.limitations || []), ...(data.coverage.omitted || []),
      ...(data.coverage.truncatedCommits ? ['Commit history was truncated.'] : [])];
    document.getElementById('changeSummaryResult').innerHTML =
      `<p class="change-summary-revisions">${escapeHtml(data.repositoryPath)} · ${data.root ? 'Empty tree' : escapeHtml(data.baseSha)} → ${escapeHtml(data.targetSha)}</p>` +
      `<p>Coverage: ${data.coverage.includedFiles}/${data.coverage.totalFiles} file patches.</p>` +
      section('Summary', [data.intent, ...data.behaviorChanges]) + section('Affected areas', data.affectedAreas) +
      section('Dependency / config', data.dependencyConfigChanges) +
      section('Possible breaking changes', data.possibleBreakingChanges) + section('Risk hints', data.riskHints) +
      section('Suggested tests', data.suggestedTests) +
      `<section><h4>Coverage limitations</h4><ul>${limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None reported.</li>'}</ul></section>`;
  }

  // Save state helper
  function saveState() {
    vscode.setState({
      repositoryData,
      activeDashboardRepository,
      selectedDashboardCommit,
      commitCompareSelection,
      comparisonRepository,
      dashboardHistoryState,
      historyPanelHeight,
      reviewExpanded,
      filesPanelWidth,
      historyColumnWidths
    });
  }

  function postMessage(type, payload) {
    vscode.postMessage({ type, payload });
  }

  function setToolbarOperationState(operation, state, message) {
    const button = document.querySelector(`[data-operation="${operation}"]`);
    if (!button) return;
    button.classList.remove('is-busy', 'is-success', 'is-error');
    if (state === 'running') {
      runningToolbarOperations.add(operation);
      button.classList.add('is-busy');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      runningToolbarOperations.delete(operation);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (state === 'success') button.classList.add('is-success');
      if (state === 'error') button.classList.add('is-error');
      window.setTimeout(function () {
        button.classList.remove('is-success', 'is-error');
      }, 900);
    }
    // Keep the button's own label in its tooltip; append only the latest failure.
    if (!button.dataset.baseTitle) button.dataset.baseTitle = button.title;
    button.title = state === 'error' && message
      ? `${button.dataset.baseTitle}: ${message}`
      : button.dataset.baseTitle;
  }

  function runToolbarOperation(operation, type) {
    if (runningToolbarOperations.has(operation)) return;
    setToolbarOperationState(operation, 'running');
    postMessage(type, { submodule: activeDashboardRepository });
  }

  function reloadActiveDashboardData() {
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath: activeDashboardRepository });
  }

  // Action handlers
  const actions = {
    contextCherryPick: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'cherry-pick' });
      hideHistoryContextMenu();
    },
    contextRevert: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'revert' });
      hideHistoryContextMenu();
    },
    contextMerge: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'merge' });
      hideHistoryContextMenu();
    },
    contextRebase: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'rebase' });
      hideHistoryContextMenu();
    },
    contextReset: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'reset' });
      hideHistoryContextMenu();
    },
    contextDrop: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'drop' });
      hideHistoryContextMenu();
    },
    contextContinueRebase: () => {
      if (!historyContextTarget) return;
      postMessage('resolveHistoryRebase', { repositoryPath: historyContextTarget.repositoryPath, command: 'continue' });
      hideHistoryContextMenu();
    },
    contextAbortRebase: () => {
      if (!historyContextTarget) return;
      postMessage('resolveHistoryRebase', { repositoryPath: historyContextTarget.repositoryPath, command: 'abort' });
      hideHistoryContextMenu();
    },
    contextAddTag: () => {
      if (!historyContextTarget) return;
      postMessage('createTagFromCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash });
      hideHistoryContextMenu();
    },
    contextCopyHash: () => {
      if (!historyContextTarget) return;
      postMessage('copyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, field: 'hash' });
      hideHistoryContextMenu();
    },
    contextCopySubject: () => {
      if (!historyContextTarget) return;
      postMessage('copyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, field: 'subject' });
      hideHistoryContextMenu();
    },
    contextCheckoutCommit: () => {
      if (!historyContextTarget) return;
      postMessage('checkoutCommit', { submodule: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, fromHistory: true });
      hideHistoryContextMenu();
    },
    contextCreateBranch: () => {
      if (!historyContextTarget) return;
      branchFromCommitTarget = { ...historyContextTarget };
      hideHistoryContextMenu();
      actions.openCreateBranchModal(true);
    },
    // The model list loads when the Model menu is first opened (no separate button).
    loadSummaryModels: () => {
      if (summaryModelsState === 'loading') return;
      summaryModelsState = 'loading';
      const select = document.getElementById('summaryModelSelect');
      if (select && select.options && select.options[0]) select.options[0].textContent = 'Default Copilot model (loading list…)';
      postMessage('loadSummaryModels', {});
    },
    summarizeChanges: () => {
      if (!changeSummarySelection) return;
      const key = changeSummaryKey(changeSummarySelection);
      if (changeSummaries.get(key)?.pending) return;
      cancelPendingChangeSummary();
      const requestId = ++changeSummaryRequestId;
      changeSummaries.set(key, { requestId, repositoryPath: activeDashboardRepository,
        pending: true, status: 'Collecting context…', summary: null, model: null });
      activeChangeSummaryKey = key;
      document.getElementById('changeSummaryResult').innerHTML = '';
      restoreChangeSummary();
      postMessage('summarizeChanges', { repositoryPath: activeDashboardRepository,
        baseSha: changeSummarySelection.baseSha, targetSha: changeSummarySelection.targetSha,
        requestId, modelId: selectedSummaryModelId });
    },
    cancelChangeSummary: () => {
      cancelPendingChangeSummary();
      restoreChangeSummary();
    },
    refresh: () => runToolbarOperation('refresh', 'refresh'),

    pullActiveRepository: () => runToolbarOperation('pull', 'pullChanges'),
    pushActiveRepository: () => runToolbarOperation('push', 'pushChanges'),
    fetchActiveRepository: () => runToolbarOperation('fetch', 'fetchUpdates'),

    loadMoreHistory: () => {
      if (historyNextOffset !== null && !historyAppendPending) requestDashboardHistory(historyNextOffset, true);
    },

    selectHistoryCommit: (el, event) => {
      const commitHash = el.dataset.commit;
      // Rows of a history being replaced may belong to the previous repository.
      if (!commitHash || (el.closest && el.closest('.history-stale'))) return;
      // Ctrl/Cmd-click or Shift-click picks the row for a comparison, like the graph node (as Git Graph does).
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
        toggleCommitCompareNode(commitHash);
        return;
      }
      clearCommitComparison(false);
      loadParentCommitDetail(commitHash);
      showDetailTab('changes');
    },

    selectChangedFile: (el) => {
      const filePath = el.dataset.path;
      if (!filePath || !selectedDashboardCommit) return;
      selectedDashboardFile = filePath;
      document.querySelectorAll('.changed-file-item').forEach(item => {
        item.classList.toggle('active', item.dataset.path === filePath);
      });
      const fileName = document.getElementById('diffFileName');
      const diff = document.getElementById('dashboardDiff');
      if (fileName) fileName.textContent = filePath;
      if (diff) diff.innerHTML = '<span class="diff-placeholder">Loading patch…</span>';
      postMessage('getFileDiff', {
        repositoryPath: activeDashboardRepository,
        commitHash: selectedDashboardCommit,
        baseRevision: comparisonBaseHash || undefined,
        path: filePath
      });
    },

    toggleReferenceSection: (el) => {
      const section = el.dataset.section;
      if (!section) return;
      const panel = document.querySelector(`[data-reference-panel="${section}"]`);
      if (!panel) return;
      const willOpen = panel.hidden;
      document.querySelectorAll('[data-reference-panel]').forEach(item => { item.hidden = true; });
      document.querySelectorAll('.reference-summary-row').forEach(item => item.classList.remove('expanded'));
      panel.hidden = !willOpen;
      el.classList.toggle('expanded', willOpen);
    },

    selectReference: (el) => {
      const revision = el.dataset.revision;
      if (!revision) return;
      setHistoryRevision(revision);
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
    },

    toggleBranchFolder: (el) => {
      const folder = el.dataset.folder;
      if (!folder) return;
      const key = `${activeDashboardRepository}\u0000${folder}`;
      if (collapsedBranchFolders.has(key)) collapsedBranchFolders.delete(key); else collapsedBranchFolders.add(key);
      if (repositoryRefs) renderRepositoryRefs(Object.assign({ repositoryPath: activeDashboardRepository }, repositoryRefs));
    },

    selectDashboardBranch: (el) => {
      requestBranchCheckout(el.dataset.branch);
    },

    selectDashboardRepository: (el) => {
      const repositoryPath = el.dataset.path;
      if (!repositoryPath || repositoryPath === activeDashboardRepository) return;
      activateDashboardRepository(repositoryPath);
      renderRepositorySwitcher();
    },

    // The extension host asks for confirmation before moving HEAD.
    syncRepositoryToRecorded: (el) => {
      if (el.dataset.path) postMessage('syncRepositoryToRecorded', { repositoryPath: el.dataset.path });
    },

    replaceLocalBranchFromRemote: (el) => {
      requestBranchCheckout(el.dataset.branch, true);
    },

    deleteDashboardBranch: (el) => {
      const branch = el.dataset.branch;
      if (!branch || !activeDashboardRepository) return;
      const deleteRemote = el.dataset.hasRemote === 'true'
        && confirm(`Also delete 'origin/${branch}'?\n\nChoose Cancel to delete the local branch only.`);
      postMessage('deleteBranch', {
        submodule: activeDashboardRepository,
        branch,
        deleteRemote
      });
    },

    openBranchCompareModal: () => {
      const modal = document.getElementById('branchCompareModal');
      const base = document.getElementById('compareBaseBranch');
      const target = document.getElementById('compareTargetBranch');
      populateBranchCompareSelects(base, target);
      if (modal) modal.classList.add('active');
    },

    compareBranches: () => {
      const base = document.getElementById('compareBaseBranch');
      const target = document.getElementById('compareTargetBranch');
      if (!base || !target || !base.value || !target.value || base.value === target.value) {
        alert('Select two different branches to compare.');
        return;
      }
      const modal = document.getElementById('branchCompareModal');
      if (modal) modal.classList.remove('active');
      commitCompareSelection = [];
      comparisonRepository = activeDashboardRepository;
      // The picked names label the comparison and any review of it (not the resolved hashes).
      loadComparison(base.value, target.value, 'branches', { base: base.value, target: target.value });
    },

    clearCommitComparison: () => clearCommitComparison(true),

    toggleCommitCompareNode: (el) => toggleCommitCompareNode(el.dataset.commit),

    previewWorkingTreeFile: (el) => {
      selectWorkingTreePreview(el.dataset.path);
    },

    previewWorkingTreeMode: (el) => {
      requestWorkingTreePreview(el.dataset.mode);
    },

    openCommitChangesModal: () => {
      const repository = getRepository(activeDashboardRepository);
      const modal = document.getElementById('commitChangesModal');
      const repositoryLabel = document.getElementById('commitChangesRepository');
      const repositoryPath = document.getElementById('commitChangesRepositoryPath');
      const changesList = document.getElementById('commitChangesList');
      const message = document.getElementById('commitMessage');
      const result = document.getElementById('commitChangesResult');
      const selectAll = document.getElementById('commitSelectAll');
      const commitButton = document.getElementById('commitSelectedFilesButton');

      if (repositoryLabel) repositoryLabel.textContent = repository ? repository.name : activeDashboardRepository;
      if (repositoryPath) repositoryPath.value = activeDashboardRepository;
      if (changesList) changesList.innerHTML = '<div class="dashboard-loading">Loading changed files…</div>';
      workingTreeChanges = [];
      previewedWorkingTreeFile = null;
      workingTreePreviewRequestId++;
      const previewPath = document.getElementById('commitPreviewPath');
      const previewModes = document.getElementById('commitPreviewModes');
      const previewDiff = document.getElementById('commitPreviewDiff');
      const truncated = document.getElementById('commitPreviewTruncated');
      if (previewPath) previewPath.textContent = 'Select a file to preview its changes';
      if (previewModes) previewModes.hidden = true;
      if (previewDiff) previewDiff.innerHTML = '<span class="diff-placeholder">Select a file to preview its changes.</span>';
      if (truncated) truncated.textContent = '';
      if (message && commitDraftRepository !== activeDashboardRepository) message.value = '';
      commitDraftRepository = activeDashboardRepository;
      if (result) result.textContent = '';
      if (selectAll) selectAll.checked = true;
      if (commitButton) commitButton.disabled = false;
      if (modal) modal.classList.add('active');

      postMessage('getWorkingTreeChanges', { repositoryPath: activeDashboardRepository });
    },

    commitSelectedChanges: () => {
      const repositoryPath = document.getElementById('commitChangesRepositoryPath').value;
      const message = document.getElementById('commitMessage').value.trim();
      const files = Array.from(document.querySelectorAll('.commit-change-checkbox:checked'))
        .map(checkbox => checkbox.dataset.path)
        .filter(Boolean);
      const result = document.getElementById('commitChangesResult');
      const commitButton = document.getElementById('commitSelectedFilesButton');

      if (files.length === 0) {
        if (result) result.textContent = 'Select at least one changed file.';
        return;
      }
      if (!message) {
        if (result) result.textContent = 'Enter a commit message.';
        return;
      }

      if (result) result.textContent = 'Creating commit…';
      if (commitButton) commitButton.disabled = true;
      postMessage('commitFiles', { repositoryPath, files, message });
    },

    openCreateBranchModal: (fromHistory = false) => {
      const fromCommit = fromHistory === true && branchFromCommitTarget;
      restoreBranchModalControls();
      if (fromCommit) branchFromCommitTarget = fromCommit;
      // Reset form fields
      document.getElementById('ticketId').value = '';
      document.getElementById('taskTitle').value = '';
      document.getElementById('productName').value = '';
      document.getElementById('releaseVersion').value = '';
      document.getElementById('devBranchName').value = '';
      document.getElementById('baseBranch').value = '';
      const baseBranchInput = document.getElementById('baseBranchInput');
      if (baseBranchInput) {
        baseBranchInput.value = '';
        baseBranchInput.placeholder = 'Loading branches...';
        baseBranchInput.disabled = Boolean(fromCommit);
      }
      document.getElementById('baseBranchDropdown').style.pointerEvents = fromCommit ? 'none' : '';
      document.getElementById('branchFromCommitCheckoutRow').hidden = !fromCommit;
      document.getElementById('branchFromCommitCheckout').checked = true;
      document.querySelectorAll('.branch-repository').forEach(cb => {
        if (cb.dataset.originalDisabled === undefined) cb.dataset.originalDisabled = cb.disabled ? 'true' : 'false';
        cb.disabled = fromCommit ? cb.value !== fromCommit.repositoryPath : cb.dataset.originalDisabled === 'true';
        cb.checked = fromCommit ? cb.value === fromCommit.repositoryPath : !cb.disabled;
      });
      const baseBranchList = document.getElementById('baseBranchList');
      if (baseBranchList) {
        baseBranchList.innerHTML = '';
      }
      const baseBranchDropdown = document.getElementById('baseBranchDropdown');
      if (baseBranchDropdown) {
        baseBranchDropdown.classList.remove('open');
      }
      // Request branches from the first available repository.
      if (fromCommit) {
        document.getElementById('baseBranch').value = fromCommit.hash;
        baseBranchInput.value = `Commit ${fromCommit.hash.slice(0, 12)}`;
        baseBranchInput.placeholder = '';
        updatePrefixOptions();
        document.getElementById('baseBranchHint').textContent = 'Branch starts at the selected commit.';
      } else {
        postMessage('getBaseBranchesForCreate', {});
      }
      document.getElementById('createBranchModal').classList.add('active');
      // Retry if branches haven't loaded after 2s
      if (!fromCommit) retryLoadBaseBranches(3);
    },

    closeModal: (el) => {
      const modalId = el.dataset.modal;
      document.getElementById(modalId).classList.remove('active');
      if (modalId === 'createBranchModal') restoreBranchModalControls();
    },

    createBranch: () => {
      const branchName = document.getElementById('branchName').value.trim();
      const baseBranch = document.getElementById('baseBranch').value.trim() || 'main';

      // Validate branch name
      if (!branchName ||
          branchName.includes('your-branch-name') ||
          branchName.endsWith('-') ||
          branchName.endsWith('_') ||
          branchName.includes('x.x.x')) {
        alert('Please fill in all required fields to generate a valid branch name.');
        return;
      }

      if (branchFromCommitTarget) {
        postMessage('createBranchFromCommit', { repositoryPath: branchFromCommitTarget.repositoryPath,
          commit: branchFromCommitTarget.hash, branchName,
          checkout: document.getElementById('branchFromCommitCheckout').checked });
        document.getElementById('createBranchModal').classList.remove('active');
        restoreBranchModalControls();
        return;
      }

      const checkboxes = document.querySelectorAll('.branch-repository:checked');
      const repositories = Array.from(checkboxes).map(cb => cb.value);
      if (repositories.length === 0) {
        alert('Please select at least one repository.');
        return;
      }

      // Store pending info for review
      pendingBranchInfo = { repositories, branchName, baseBranch };
      postMessage('createBranchWithReview', { submodules: repositories, branchName, baseBranch });
      document.getElementById('createBranchModal').classList.remove('active');
    },

    confirmAndPush: () => {
      if (!pendingBranchInfo) return;
      const shouldPush = document.getElementById('pushAfterCreate').checked;
      if (shouldPush) {
        postMessage('pushCreatedBranches', {
          submodules: pendingBranchInfo.repositories,
          branchName: pendingBranchInfo.branchName
        });
      }
      pendingBranchInfo = null;
      document.getElementById('reviewBranchModal').classList.remove('active');
    },

    // Reviews start at once: "changes" reviews the diff Base → Target, "branch" every file at Target.
    // The current branch: what it adds since the default branch ('changes'), or every file at its tip.
    reviewRelease: (el) => startReview({ kind: 'release', scope: el.dataset.scope === 'changes' ? 'changes' : 'branch' }),
    loadReleaseRange: () => {
      if (!activeDashboardRepository) return;
      releaseRange = { requestId: ++releaseRangeRequestId, repositoryPath: activeDashboardRepository };
      showReleaseStatus('Release: finding the latest release tag…');
      postMessage('resolveReleaseRange', { requestId: releaseRange.requestId, repositoryPath: activeDashboardRepository });
    },
    // Review the changes the detail pane shows: the selected commit against its parent, or the
    // loaded comparison from Base to Target. Every file is reviewed from Release › Review branch.
    reviewSelection: () => {
      if (!changeSummarySelection) return;
      const { baseSha, targetSha } = changeSummarySelection;
      const labels = comparisonLabels || {};
      startReview({ scope: 'changes', base: comparisonSource ? baseSha || undefined : undefined, target: targetSha,
        baseLabel: labels.base, targetLabel: labels.target });
    },


    contextReviewCommit: () => {
      if (!historyContextTarget) return;
      hideHistoryContextMenu();
      // No base: the extension reviews the commit against its parent.
      startReview({ scope: 'changes', target: historyContextTarget.hash });
    },

    contextReviewSnapshot: () => {
      if (!historyContextTarget) return;
      hideHistoryContextMenu();
      startReview({ scope: 'branch', target: historyContextTarget.hash });
    },

    toggleReviewExpanded: () => {
      reviewExpanded = !reviewExpanded;
      applyReviewExpanded();
      saveState();
    },
    cancelReview: () => postMessage('cancelReview', {}),

    openStoredReview: (el) => {
      if (!activeDashboardRepository || reviewLocked() || !el.dataset.historyId) return;
      const entry = reviewHistory.entries.find(item => item.id === el.dataset.historyId);
      if (!entry) return;
      reviewRequestId += 1;
      const repository = getRepository(activeDashboardRepository);
      reviewState = { requestId: reviewRequestId, repositoryPath: activeDashboardRepository, folder: currentWorkspaceFolder(),
        repositoryName: repository ? repository.name : activeDashboardRepository, scope: entry.scope, kind: entry.kind,
        baseLabel: entry.baseLabel || '', targetLabel: entry.targetLabel, status: 'opening', cancelled: true, message: 'Opening the saved review…' };
      renderReviewPanel();
      showDetailTab('review');
      postMessage('openStoredReview', { requestId: reviewRequestId, id: entry.id, repositoryPath: activeDashboardRepository });
    },
    deleteStoredReview: (el) => {
      if (!activeDashboardRepository || !el.dataset.historyId) return;
      if (reviewState && reviewState.historyId === el.dataset.historyId) reviewState.historyId = null;
      postMessage('deleteStoredReview', { id: el.dataset.historyId, repositoryPath: activeDashboardRepository, listId: ++reviewHistoryListId });
    },
    exportReview: (el) => {
      if (reviewState && reviewState.status === 'completed') {
        postMessage('exportReviewReport', { requestId: reviewState.requestId, format: el.dataset.format === 'save' ? 'save' : 'copy' });
      }
    },

    showDetailTab: (el) => showDetailTab(el.dataset.tab === 'review' ? 'review' : 'changes'),

    reviewEvidence: (el) => jumpToReviewEvidence(Number(el.dataset.finding), Number(el.dataset.evidence)),

    proposeReviewFix: () => {
      if (!reviewState || reviewState.status !== 'completed') return;
      reviewState.fix = { status: 'running', message: 'Checking the cited files in your working tree…', startedAt: Date.now() };
      renderReviewPanel();
      postMessage('proposeReviewFix', { requestId: reviewState.requestId, modelId: selectedSummaryModelId || undefined });
    },
    // Apply all, or only the files ticked in the proposal (Apply selected).
    applyReviewFix: (el) => {
      if (!reviewState || !reviewState.fix || !reviewState.fix.files) return;
      const paths = el.dataset.selection === 'selected' ? reviewState.fix.files.map(file => file.path).filter(item => reviewState.fix.selected.has(item)) : undefined;
      if (paths && !paths.length) return;
      postMessage('applyReviewFix', { requestId: reviewState.requestId, paths });
    },
    discardReviewFix: () => { if (reviewState) postMessage('discardReviewFix', { requestId: reviewState.requestId }); },
    cancelReviewFix: () => postMessage('cancelReviewFix', {}),

    triageFinding: (el) => {
      if (!reviewState || reviewState.status !== 'completed') return;
      const current = (reviewState.triage || {})[el.dataset.findingId];
      const decision = current && current.decision === el.dataset.decision ? null : el.dataset.decision;
      postMessage('setFindingTriage', { requestId: reviewState.requestId, findingId: el.dataset.findingId, decision,
        reason: decision === 'dismiss' ? 'false_positive' : undefined });
    },

    syncAll: () => postMessage('syncVersions', { submodules: [] })
  };

  function updateCommitSelectionCount() {
    const selected = document.querySelectorAll('.commit-change-checkbox:checked').length;
    const count = document.getElementById('commitSelectionCount');
    if (count) count.textContent = selected + ' selected';
  }

  // Renders a unified patch with old/new file line numbers. Git's file headers
  // (diff/index/---/+++) are dropped because the panel title already names the file.
  function renderPatchLines(patch) {
    const lines = String(patch || '').replace(/\n$/, '').split('\n');
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const row = (className, oldNumber, newNumber, text) => `<span class="diff-line ${className}"><i class="diff-ln">${oldNumber}</i><i class="diff-ln">${newNumber}</i><span class="diff-text">${escapeHtml(text) || ' '}</span></span>`;
    return lines.map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return row('diff-hunk', '', '', line);
      }
      if (!inHunk || line.startsWith('diff --git ')) {
        inHunk = false;
        if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) return '';
        return row('diff-meta', '', '', line);
      }
      if (line.startsWith('+')) return row('diff-addition', '', newLine++, line);
      if (line.startsWith('-')) return row('diff-deletion', oldLine++, '', line);
      if (line.startsWith('\\')) return row('diff-meta', '', '', line);
      return row('diff-context', oldLine++, newLine++, line);
    }).join('');
  }

  function selectWorkingTreePreview(filePath) {
    const change = workingTreeChanges.find(item => item.path === filePath);
    if (!change) return;
    previewedWorkingTreeFile = filePath;
    document.querySelectorAll('.commit-change-preview-button').forEach(button => {
      button.classList.toggle('active', button.dataset.path === filePath);
    });
    const heading = document.getElementById('commitPreviewPath');
    const modes = document.getElementById('commitPreviewModes');
    if (heading) heading.textContent = filePath;
    if (modes) {
      modes.hidden = false;
      modes.querySelectorAll('button').forEach(button => {
        button.hidden = button.dataset.mode === 'staged'
          ? !change.staged
          : !change.unstaged && !change.untracked;
      });
    }
    requestWorkingTreePreview(change.unstaged || change.untracked ? 'unstaged' : 'staged');
  }

  function requestWorkingTreePreview(mode) {
    const change = workingTreeChanges.find(item => item.path === previewedWorkingTreeFile);
    if (!change || (mode === 'staged' && !change.staged)
      || (mode === 'unstaged' && !change.unstaged && !change.untracked)) return;
    workingTreePreviewMode = mode;
    workingTreePreviewRequestId++;
    const modes = document.getElementById('commitPreviewModes');
    if (modes) modes.querySelectorAll('button').forEach(button => {
      button.classList.toggle('active', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
    });
    const diff = document.getElementById('commitPreviewDiff');
    const truncated = document.getElementById('commitPreviewTruncated');
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Loading diff…</span>';
    if (truncated) truncated.textContent = '';
    postMessage('getWorkingTreePreview', {
      repositoryPath: document.getElementById('commitChangesRepositoryPath').value,
      path: previewedWorkingTreeFile,
      mode,
      requestId: workingTreePreviewRequestId
    });
  }

  function isCurrentWorkingTreePreview(payload) {
    const modal = document.getElementById('commitChangesModal');
    const repositoryPath = document.getElementById('commitChangesRepositoryPath');
    return modal && modal.classList.contains('active') && repositoryPath
      && payload.repositoryPath === repositoryPath.value
      && payload.path === previewedWorkingTreeFile
      && payload.mode === workingTreePreviewMode
      && payload.requestId === workingTreePreviewRequestId;
  }

  function renderWorkingTreeChanges(payload) {
    const repositoryPath = document.getElementById('commitChangesRepositoryPath');
    if (!repositoryPath || repositoryPath.value !== payload.repositoryPath) return;

    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    workingTreeChanges = changes;
    const list = document.getElementById('commitChangesList');
    if (!list) return;
    if (changes.length === 0) {
      list.innerHTML = '<div class="dashboard-empty">Working tree is clean.</div>';
      updateCommitSelectionCount();
      return;
    }

    list.innerHTML = changes.map(change => {
      const state = change.conflicted
        ? 'conflict'
        : change.untracked
          ? 'untracked'
          : change.staged && change.unstaged
            ? 'staged + modified'
            : change.staged
              ? 'staged'
              : 'modified';
      const rename = change.originalPath
        ? '<small>' + escapeHtml(change.originalPath) + ' →</small>'
        : '';
      return '<div class="commit-change-row' + (change.conflicted ? ' conflicted' : '') + '">' +
        '<input type="checkbox" class="commit-change-checkbox" data-path="' + escapeHtml(change.path) + '"' +
          ' aria-label="Include ' + escapeHtml(change.path) + ' in commit"' +
          (change.conflicted ? ' disabled' : ' checked') + '>' +
        '<button type="button" class="commit-change-preview-button" data-action="previewWorkingTreeFile"' +
          ' data-path="' + escapeHtml(change.path) + '" title="' + escapeHtml(change.path) + '">' +
          '<span class="commit-change-path">' + rename + '<strong>' + escapeHtml(change.path) + '</strong></span>' +
          '<span class="commit-change-state">' + state + '</span>' +
        '</button>' +
      '</div>';
    }).join('');
    updateCommitSelectionCount();
    selectWorkingTreePreview(changes[0].path);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getRepository(path) {
    return repositoryData.find(repository => repository.path === path);
  }

  // Branch alignment: linked repositories should be on the parent repository's branch.
  // Commit alignment (atRecordedCommit) is tracked separately.
  function getRepositoryAlignment(repository, targetBranch) {
    if (repository.isParentRepo) return 'parent';
    if (repository.status === 'uninitialized') return 'uninitialized';
    if (!repository.currentBranch) return 'detached';
    return targetBranch && repository.currentBranch !== targetBranch ? 'drifted' : 'aligned';
  }

  function renderRepositorySwitcher() {
    const list = document.getElementById('dashboardRepositories');
    const summary = document.getElementById('repositoryAlignment');
    if (!list) return;
    const parent = repositoryData.find(repository => repository.isParentRepo) || repositoryData[0];
    const targetBranch = parent ? parent.currentBranch : '';
    const linked = repositoryData.filter(repository => repository !== parent);
    const aligned = linked.filter(repository => getRepositoryAlignment(repository, targetBranch) === 'aligned'
      && repository.atRecordedCommit === true).length;
    if (summary) {
      // The word is hidden in a narrow sidebar; the tooltip keeps the full meaning.
      summary.innerHTML = linked.length ? `${aligned}/${linked.length}<span class="alignment-word"> aligned</span>` : '';
      summary.classList.toggle('drifted', aligned < linked.length);
    }

    list.innerHTML = repositoryData.map(repository => {
      const alignment = getRepositoryAlignment(repository, targetBranch);
      const active = repository.path === activeDashboardRepository;
      const unavailable = alignment === 'uninitialized';
      const branch = repository.currentBranch || `(detached) ${repository.currentCommit || ''}`.trim();
      const badges = [
        repository.behind > 0 ? `<span class="repo-badge" title="${repository.behind} behind upstream">↓${repository.behind}</span>` : '',
        repository.ahead > 0 ? `<span class="repo-badge" title="${repository.ahead} ahead of upstream">↑${repository.ahead}</span>` : '',
        alignment === 'drifted' || alignment === 'detached'
          ? `<span class="repo-badge repo-badge-drift" title="Not on ${escapeHtml(targetBranch || 'the parent branch')}">${alignment === 'detached' ? 'detached' : 'drift'}</span>`
          : '',
        repository.atRecordedCommit === false
          ? `<span class="repo-badge repo-badge-drift" title="HEAD ${escapeHtml(repository.currentCommit)} differs from the commit ${escapeHtml(repository.recordedCommit)} recorded by the parent">≠ recorded</span>`
          : '',
        !repository.isParentRepo && alignment !== 'uninitialized' && repository.atRecordedCommit === undefined
          ? '<span class="repo-badge repo-badge-drift" title="The parent repository has no recorded commit for this repository yet (for example, it was added but not committed)">unrecorded</span>'
          : '',
        alignment === 'uninitialized' ? '<span class="repo-badge repo-badge-muted">not initialized</span>' : ''
      ].join('');
      const title = unavailable
        ? `${repository.name} is not initialized`
        : `${repository.name} · ${branch} · ${repository.status}${alignment === 'drifted' ? ` (parent is on ${targetBranch})` : ''}`;
      const resetAction = repository.atRecordedCommit === false
        ? `<button class="sidebar-repository-action" type="button" data-action="syncRepositoryToRecorded" data-path="${escapeHtml(repository.path)}" title="Reset ${escapeHtml(repository.name)} to the recorded commit ${escapeHtml(repository.recordedCommit)}">Reset to recorded</button>`
        : '';
      return `<div class="sidebar-repository-row"><button class="sidebar-repository-item${active ? ' active' : ''}" type="button"${active ? ' aria-current="true"' : ''} data-action="selectDashboardRepository" data-path="${escapeHtml(repository.path)}" title="${escapeHtml(title)}"${unavailable ? ' disabled' : ''}>
        <span class="repo-status-dot status-${escapeHtml(repository.status)}" aria-hidden="true"></span>
        <span class="repo-copy"><strong>${escapeHtml(repository.name)}${repository.isParentRepo ? ' <small>parent</small>' : ''}</strong><code>${escapeHtml(branch)}</code></span>
        <span class="repo-badges">${badges}</span>
      </button>${resetAction}</div>`;
    }).join('') || '<span class="sidebar-placeholder">No repositories</span>';
    applyReviewLock();
  }

  function shortRevision(revision) {
    if (!revision) return '';
    return revision.length >= 12 && /^[0-9a-f]+$/i.test(revision) ? revision.slice(0, 8) : revision;
  }

  function checkoutBranchFromRef(ref) {
    if (!ref || !ref.name) return '';
    if (ref.kind === 'head' || ref.kind === 'local-branch') return ref.name;
    if (ref.kind === 'remote-branch') {
      const separator = ref.name.indexOf('/');
      return separator >= 0 ? ref.name.slice(separator + 1) : ref.name;
    }
    return '';
  }

  function renderHistoryRefs(refs, interactive) {
    return (refs || []).map(ref => {
      const className = `history-ref ref-${escapeHtml(ref.kind)}`;
      const branch = interactive ? checkoutBranchFromRef(ref) : '';
      if (!branch) return `<span class="${className}" title="${escapeHtml(ref.name)}">${escapeHtml(ref.name)}</span>`;
      return `<button class="${className}" type="button" data-branch="${escapeHtml(branch)}" title="Double-click to checkout ${escapeHtml(branch)}">${escapeHtml(ref.name)}</button>`;
    }).join('');
  }

  function setBranchCheckoutPending(isPending) {
    document.querySelectorAll('[data-branch]').forEach(item => {
      const matches = pendingBranchCheckout && item.dataset.branch === pendingBranchCheckout.branch;
      item.classList.toggle('checkout-pending', Boolean(isPending && matches));
      if (isPending && matches) item.setAttribute('aria-busy', 'true');
      else item.removeAttribute('aria-busy');
    });
  }

  function requestBranchCheckout(branch, replaceWithRemote = false) {
    if (!branch || pendingBranchCheckout) return;
    const current = getRepository(activeDashboardRepository);
    if (current && current.currentBranch === branch && !replaceWithRemote) {
      setHistoryRevision('');
      requestDashboardHistory(0, false);
      return;
    }
    pendingBranchCheckout = { repositoryPath: activeDashboardRepository, branch, replaceWithRemote };
    setBranchCheckoutPending(true);
    postMessage('checkoutBranch', {
      submodule: activeDashboardRepository,
      branch,
      replaceWithRemote
    });
  }

  function updateCommitCompareUI() {
    document.querySelectorAll('.history-row').forEach(row => {
      const marker = commitCompareSelection[0] === row.dataset.commit
        ? 'B'
        : commitCompareSelection[1] === row.dataset.commit
          ? 'T'
          : '';
      row.classList.toggle('compare-base', marker === 'B');
      row.classList.toggle('compare-target', marker === 'T');
    });
    document.querySelectorAll('.graph-node-control').forEach(node => {
      const marker = commitCompareSelection[0] === node.dataset.commit
        ? 'B'
        : commitCompareSelection[1] === node.dataset.commit
          ? 'T'
          : '';
      node.dataset.marker = marker;
      node.setAttribute('aria-pressed', marker ? 'true' : 'false');
      const accessibleLabel = marker
        ? `${marker === 'B' ? 'Base' : 'Target'} commit ${shortRevision(node.dataset.commit)}. Press to remove from comparison.`
        : `Select commit ${shortRevision(node.dataset.commit)} for comparison.`;
      node.setAttribute('aria-label', accessibleLabel);
      const markerLabel = node.querySelector('.graph-node-marker');
      const title = node.querySelector('title');
      if (markerLabel) markerLabel.textContent = marker;
      if (title) title.textContent = accessibleLabel;
    });
    const status = document.getElementById('commitCompareStatus');
    if (!status) return;
    if (commitCompareSelection.length === 0) {
      status.hidden = true;
      status.innerHTML = '';
      return;
    }
    status.hidden = false;
    status.innerHTML = commitCompareSelection.length === 1
      ? `<span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} · Ctrl+click a second commit <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`
      : `<span class="compare-range"><span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} → <span class="compare-role compare-role-target">T</span> ${escapeHtml(shortRevision(commitCompareSelection[1]))}</span> <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
    applyReviewLock();
  }

  function loadParentCommitDetail(commitHash) {
    if (!commitHash) return;
    resetChangeSummary();
    selectedDashboardCommit = commitHash;
    activeComparisonTarget = commitHash;
    comparisonBaseHash = null;
    comparisonSource = null;
    comparisonLabels = null;
    document.querySelectorAll('.history-row').forEach(row => {
      row.classList.toggle('active', row.dataset.commit === commitHash);
    });
    updateCommitCompareUI();
    saveState();
    showCommitDetailLoading();
    postMessage('getCommitDetail', {
      repositoryPath: activeDashboardRepository,
      commitHash
    });
  }

  function clearCommitComparison(restoreParent) {
    releaseRange = null;
    const shouldRestoreParent = Boolean(restoreParent && comparisonSource && selectedDashboardCommit);
    commitCompareSelection = [];
    comparisonRepository = activeDashboardRepository;
    updateCommitCompareUI();
    saveState();
    if (shouldRestoreParent) loadParentCommitDetail(selectedDashboardCommit);
  }

  function toggleCommitCompareNode(commitHash) {
    if (!commitHash) return;
    const transition = window.RepositoryHistoryGraph.transitionCompareSelection(
      commitCompareSelection,
      commitHash,
      Boolean(comparisonSource)
    );
    commitCompareSelection = transition.selection;
    comparisonRepository = activeDashboardRepository;
    updateCommitCompareUI();
    saveState();
    if (transition.action === 'compare') {
      loadComparison(commitCompareSelection[0], commitCompareSelection[1], 'commits');
    } else if (transition.action === 'parent') {
      const remainingCommit = commitCompareSelection[0] || selectedDashboardCommit;
      if (remainingCommit) loadParentCommitDetail(remainingCommit);
    }
  }

  function showReleaseStatus(text, isError) {
    const status = document.getElementById('commitCompareStatus');
    if (!status) return;
    status.hidden = false;
    status.innerHTML = `<span class="compare-range${isError ? ' compare-error' : ''}">${escapeHtml(text)}</span> <button type="button" data-action="clearCommitComparison" aria-label="Clear">×</button>`;
  }

  function loadComparison(baseRevision, targetRevision, source, labels) {
    if (source !== 'release') releaseRange = null;
    comparisonLabels = labels || null;
    resetChangeSummary();
    selectedDashboardCommit = targetRevision;
    activeComparisonTarget = targetRevision;
    comparisonBaseHash = baseRevision;
    comparisonSource = source;
    document.querySelectorAll('.history-row').forEach(row => {
      row.classList.toggle('active', row.dataset.commit === targetRevision);
    });
    showCommitDetailLoading();
    const status = document.getElementById('commitCompareStatus');
    if (status) {
      status.hidden = false;
      const kind = { branches: 'Branches', review: 'Review', release: 'Release' }[source] || 'Commits';
      const base = labels && labels.base ? labels.base : shortRevision(baseRevision);
      const target = labels && labels.target ? labels.target : shortRevision(targetRevision);
      status.innerHTML = `<span class="compare-range">${kind}: ${escapeHtml(base)} → ${escapeHtml(target)}</span> <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
      applyReviewLock();
    }
    saveState();
    postMessage('getCommitDetail', {
      repositoryPath: activeDashboardRepository,
      commitHash: targetRevision,
      baseRevision
    });
  }

  function populateBranchCompareSelects(baseSelect, targetSelect) {
    if (!baseSelect || !targetSelect) return;
    const branches = repositoryRefs.branches || [];
    const options = branches.map(branch => {
      const revision = branch.isRemote ? `origin/${branch.name}` : branch.name;
      return `<option value="${escapeHtml(revision)}">${escapeHtml(branch.name)}${branch.isRemote ? ' (remote)' : ''}</option>`;
    }).join('');
    baseSelect.innerHTML = options || '<option value="">No branches available</option>';
    targetSelect.innerHTML = options || '<option value="">No branches available</option>';
    const current = branches.find(branch => branch.isCurrent);
    const alternative = branches.find(branch => !branch.isCurrent && !branch.isRemote) || branches.find(branch => !branch.isCurrent);
    if (current) baseSelect.value = current.name;
    if (alternative) targetSelect.value = alternative.isRemote ? `origin/${alternative.name}` : alternative.name;
  }

  function getDashboardFilters(repositoryPath) {
    return window.RepositoryHistoryGraph.normalizeHistoryFilters(dashboardHistoryState[repositoryPath]);
  }

  function setHistoryRevision(revision) {
    if (!activeDashboardRepository) return;
    const current = getDashboardFilters(activeDashboardRepository);
    dashboardHistoryState[activeDashboardRepository] = Object.assign({}, current, {
      branch: revision || ''
    });
  }

  function captureDashboardFilters() {
    if (!activeDashboardRepository) return;
    const current = getDashboardFilters(activeDashboardRepository);
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    dashboardHistoryState[activeDashboardRepository] = {
      branch: current.branch,
      includeRemotes: Boolean(includeRemotes && includeRemotes.checked),
      search: search ? search.value : ''
    };
  }

  function applyDashboardFilters(repositoryPath) {
    const filters = getDashboardFilters(repositoryPath);
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    if (includeRemotes) includeRemotes.checked = filters.includeRemotes;
    if (search) search.value = filters.search;
  }

  function activateDashboardRepository(repositoryPath) {
    const repository = getRepository(repositoryPath);
    if (!repository) return;

    if (dashboardActivated) captureDashboardFilters();
    if (repositoryPath !== activeDashboardRepository) {
      cancelPendingChangeSummary();
      changeSummaries.clear();
    }
    activeDashboardRepository = repositoryPath;
    resetChangeSummary();
    const canRestoreComparison = !dashboardActivated && comparisonRepository === repositoryPath;
    if (!canRestoreComparison) {
      selectedDashboardCommit = null;
      commitCompareSelection = [];
      comparisonRepository = repositoryPath;
    }
    selectedDashboardFile = null;
    historyNextOffset = null;
    loadedHistoryCommits = [];
    comparisonBaseHash = null;
    activeComparisonTarget = null;
    comparisonSource = null;
    comparisonLabels = null;
    repositoryRefs = { branches: [], tags: [], remotes: [], stashes: [] };
    applyDashboardFilters(repositoryPath);
    dashboardActivated = true;
    updateCommitCompareUI();
    releaseRange = null;
    reviewHistory = { repositoryPath: null, entries: [] };
    requestReviewHistory();
    // The Review header names the reviewed repository once the dashboard shows another one.
    renderReviewPanel();
    const behindCount = document.getElementById('dashboardBehindCount');
    const aheadCount = document.getElementById('dashboardAheadCount');
    if (behindCount) {
      behindCount.textContent = repository.behind > 0 ? String(repository.behind) : '';
      behindCount.hidden = repository.behind <= 0;
    }
    if (aheadCount) {
      aheadCount.textContent = repository.ahead > 0 ? String(repository.ahead) : '';
      aheadCount.hidden = repository.ahead <= 0;
    }

    const history = document.getElementById('dashboardHistory');
    showHistoryLoading(history);
    clearCommitDetail();
    saveState();
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath });
    // Update the repository list (ahead/behind, changes) only when it is not fresh. It used to send
    // 'refresh', whose result reloads history and refs: opening the dashboard loaded everything twice.
    if (Date.now() - repositoryDataAt > 5000) postMessage('refreshRepositories', {});
  }

  // While new history loads, the old rows stay (dimmed, not clickable) instead of the list
  // flashing to a loading message; with nothing shown yet, the message appears.
  function showHistoryLoading(history) {
    if (!history) return;
    // inert keeps keyboard focus and Enter off the old rows too, not only the pointer.
    if (history.querySelector('.history-row')) { history.classList.add('history-stale'); history.inert = true; }
    else history.innerHTML = '<div class="dashboard-loading">Loading history…</div>';
  }

  function captureHistoryViewport(history) {
    if (!history) return null;
    const scrollTop = history.scrollTop;
    const rows = Array.from(history.querySelectorAll('.history-row'));
    const anchor = rows.find(row => row.offsetTop + row.offsetHeight > scrollTop);
    return {
      commit: anchor ? anchor.dataset.commit : null,
      offset: anchor ? anchor.offsetTop - scrollTop : 0,
      scrollTop
    };
  }

  function requestDashboardHistory(offset, append, options) {
    const search = document.getElementById('dashboardSearch');
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const history = document.getElementById('dashboardHistory');
    const preserveViewport = Boolean(options && options.preserveViewport && !append);
    const viewport = preserveViewport ? captureHistoryViewport(history) : null;
    if (!append && !preserveViewport) loadedHistoryCommits = [];
    captureDashboardFilters();
    const filters = getDashboardFilters(activeDashboardRepository);
    saveState();
    if (!append && !preserveViewport) showHistoryLoading(history);
    // A fresh load supersedes a page still on its way, whose reply will be dropped.
    historyAppendPending = Boolean(append);
    if (!append) historyRequestId += 1;
    pendingHistoryViewport = viewport
      ? Object.assign({}, viewport, { requestId: historyRequestId, repositoryPath: activeDashboardRepository })
      : null;
    postMessage('getHistory', {
      repositoryPath: activeDashboardRepository,
      limit: 100,
      offset: offset || 0,
      search: search ? search.value.trim() : '',
      branch: filters.branch || undefined,
      includeRemotes: Boolean(includeRemotes && includeRemotes.checked),
      append: Boolean(append),
      requestId: historyRequestId
    });
  }

  // Branch names grouped by '/' into folders: feature/a and feature/b sit under "feature".
  // Folders come first, then branches, each alphabetically.
  function buildBranchTree(branches) {
    const root = { folders: new Map(), branches: [], path: '' };
    branches.forEach(branch => {
      const parts = branch.name.split('/');
      let node = root;
      parts.slice(0, -1).forEach(part => {
        if (!part) return;
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), branches: [], path: node.path ? `${node.path}/${part}` : part });
        node = node.folders.get(part);
      });
      node.branches.push(branch);
    });
    return root;
  }

  function countBranches(node) {
    let count = node.branches.length;
    node.folders.forEach(child => { count += countBranches(child); });
    return count;
  }

  function hasCurrentBranch(node) {
    return node.branches.some(branch => branch.isCurrent) || Array.from(node.folders.values()).some(hasCurrentBranch);
  }

  const collapsedBranchFolders = new Set(); // `${repositoryPath}\0${folder}`

  function renderBranchTree(node, depth, renderBranch) {
    const folders = Array.from(node.folders.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
      // The folder holding the checked-out branch is never collapsed out of sight.
      const expanded = !collapsedBranchFolders.has(`${activeDashboardRepository}\u0000${child.path}`) || hasCurrentBranch(child);
      return `<div class="sidebar-branch-folder-row branch-depth-${Math.min(depth, 6)}"><button type="button" class="sidebar-branch-folder" data-action="toggleBranchFolder" data-folder="${escapeHtml(child.path)}" aria-expanded="${expanded}" title="${escapeHtml(child.path)}/"><span class="sidebar-branch-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span>${escapeHtml(name)}</span><small>${countBranches(child)}</small></button></div>` +
        (expanded ? `<div role="group" aria-label="${escapeHtml(child.path)}">${renderBranchTree(child, depth + 1, renderBranch)}</div>` : '');
    }).join('');
    const leaves = node.branches.slice().sort((a, b) => a.name.localeCompare(b.name)).map(branch => renderBranch(branch, depth)).join('');
    return folders + leaves;
  }

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    const ageMs = Date.now() - date.getTime();
    if (ageMs >= 0 && ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.floor(ageMs / 60000))} min ago`;
    if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)} h ago`;
    if (ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 86400000)} d ago`;
    // One formatter for every row: building an Intl.DateTimeFormat per date cost ~140 ms per 2000 rows.
    if (!historyDateFormat) historyDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
    return historyDateFormat.format(date);
  }

  function renderHistoryGraph(commits, graphModel, rowHeights = []) {
    const paths = [];
    const nodes = [];
    const controls = [];
    let top = 0;
    graphModel.rows.forEach((layout, index) => {
      const commit = commits[index];
      const rowHeight = rowHeights[index] || graphModel.rowHeight;
      const middle = top + (rowHeight / 2);
      const bottom = top + rowHeight;
      const currentX = window.RepositoryHistoryGraph.laneX(layout.lane);
      // Colours follow branches, not columns: each branch path keeps its colour.
      const tone = value => `graph-lane-${(value === undefined ? 0 : value) % 8}`;
      const color = layout.color === undefined ? layout.lane : layout.color;
      const beforeColors = layout.beforeColors || [];
      const afterColors = layout.afterColors || [];
      const continuingLaneCount = Math.max(layout.before.length, layout.after.length);
      for (let lane = 0; lane < continuingLaneCount; lane += 1) {
        if (lane === layout.lane) continue;
        if (layout.before[lane] && layout.after[lane] && layout.before[lane] === layout.after[lane]) {
          const x = window.RepositoryHistoryGraph.laneX(lane);
          paths.push(`<path class="graph-edge ${tone(afterColors[lane] === undefined ? lane : afterColors[lane])}" d="M ${x} ${top} V ${bottom}"/>`);
        }
      }

      if (!layout.startsHere) {
        paths.push(`<path class="graph-edge ${tone(color)}" d="M ${currentX} ${top} V ${middle}"/>`);
      }
      // Other children of this commit arrive from their own columns.
      (layout.incomingLanes || []).forEach(lane => {
        const x = window.RepositoryHistoryGraph.laneX(lane);
        paths.push(`<path class="graph-edge ${tone(beforeColors[lane] === undefined ? lane : beforeColors[lane])}" d="M ${x} ${top} C ${x} ${top + 9}, ${currentX} ${middle - 9}, ${currentX} ${middle}"/>`);
      });
      layout.parentLanes.forEach((parentLane, parentIndex) => {
        const parentX = window.RepositoryHistoryGraph.laneX(parentLane);
        const edgeColor = layout.parentColors ? layout.parentColors[parentIndex] : parentIndex === 0 ? layout.lane : parentLane;
        paths.push(parentLane === layout.lane
          ? `<path class="graph-edge ${tone(edgeColor)}" d="M ${currentX} ${middle} V ${bottom}"/>`
          : `<path class="graph-edge ${tone(edgeColor)}" d="M ${currentX} ${middle} C ${currentX} ${middle + 9}, ${parentX} ${bottom - 9}, ${parentX} ${bottom}"/>`);
      });

      const decorated = (commit.refs || []).length > 0 || layout.isMerge;
      nodes.push(layout.isHead
        ? `<circle class="graph-node graph-node-head ${tone(color)}" cx="${currentX}" cy="${middle}" r="6"/>`
        : decorated
          ? `<circle class="graph-node ${tone(color)}" cx="${currentX}" cy="${middle}" r="5.5"/><circle class="graph-node-core ${tone(color)}" cx="${currentX}" cy="${middle}" r="2.3"/>`
          : `<circle class="graph-node-core ${tone(color)}" cx="${currentX}" cy="${middle}" r="4"/>`);
      controls.push(`<g class="graph-node-control" data-action="toggleCommitCompareNode" data-commit="${escapeHtml(commit.hash)}" transform="translate(${currentX} ${middle})" role="button" tabindex="0" aria-label="Select commit ${escapeHtml(commit.shortHash)} for comparison" aria-pressed="false" data-marker=""><title>Select ${escapeHtml(commit.shortHash)} for comparison</title><circle class="graph-node-hit" r="12"/><circle class="graph-node-selection" r="10"/><text class="graph-node-marker" text-anchor="middle" dominant-baseline="central"></text></g>`);
      top = bottom;
    });
    return `<svg class="history-graph-overlay" width="${graphModel.width}" height="${top}" viewBox="0 0 ${graphModel.width} ${top}" preserveAspectRatio="none">${paths.join('')}${nodes.join('')}${controls.join('')}</svg>`;
  }

  function renderGraphCell() {
    return '<span class="history-graph-cell" aria-hidden="true"></span>';
  }

  function scheduleHistoryGraphGeometry() {
    if (historyGraphGeometryFrame) return;
    historyGraphGeometryFrame = requestAnimationFrame(() => {
      historyGraphGeometryFrame = 0;
      const history = document.getElementById('dashboardHistory');
      if (!history || !loadedHistoryGraphModel) return;
      const rows = Array.from(history.querySelectorAll('.history-row'));
      if (!rows.length || rows.length !== loadedHistoryCommits.length) return;
      const heights = rows.map(row => row.offsetHeight);
      const signature = heights.join(',');
      if (signature === historyGraphGeometrySignature) return;
      const overlay = history.querySelector('.history-graph-overlay');
      if (!overlay) return;
      overlay.outerHTML = renderHistoryGraph(loadedHistoryCommits, loadedHistoryGraphModel, heights);
      historyGraphGeometrySignature = signature;
      updateCommitCompareUI();
    });
  }

  function renderHistoryPage(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || payload.requestId !== historyRequestId) return;
    const history = document.getElementById('dashboardHistory');
    const loadMore = document.getElementById('loadMoreHistory');
    if (!history) return;

    history.classList.remove('history-stale');
    history.inert = false;
    if (payload.offset > 0) historyAppendPending = false;
    const renderedCount = loadedHistoryCommits.length;
    let addedCommits = [];
    if (payload.offset > 0) {
      const knownHashes = new Set(loadedHistoryCommits.map(commit => commit.hash));
      addedCommits = (payload.commits || []).filter(commit => !knownHashes.has(commit.hash));
      loadedHistoryCommits = loadedHistoryCommits.concat(addedCommits);
    } else {
      loadedHistoryCommits = payload.commits || [];
      loadedHistoryUpstream = typeof payload.upstream === 'string' ? payload.upstream : null;
    }
    const graphModel = window.RepositoryHistoryGraph.buildGraphModel(loadedHistoryCommits, { upstream: loadedHistoryUpstream });
    loadedHistoryGraphModel = graphModel;
    historyGraphGeometrySignature = '';
    const historyRegion = history.closest('.history-region');
    historyGraphWidth = graphModel.width;
    if (historyRegion) historyRegion.style.setProperty('--graph-width', `${graphModel.width}px`);
    const renderRows = commits => commits.map(commit => {
      const refs = renderHistoryRefs(commit.refs, true);
      return `<div class="history-row" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}" tabindex="0" title="Ctrl+click or Shift+click to compare">
        ${renderGraphCell()}
        <span class="history-message">${refs ? `<span class="history-refs">${refs}</span>` : ''}<button class="history-subject" type="button" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}">${escapeHtml(commit.subject)}</button></span>
        <span class="history-author" title="${escapeHtml(commit.authorEmail)}">${escapeHtml(commit.authorName)}</span>
        <span class="history-date">${escapeHtml(formatHistoryDate(commit.authoredAt))}</span>
        <code class="history-hash">${escapeHtml(commit.shortHash)}</code>
      </div>`;
    }).join('');

    const append = payload.offset > 0;
    // Column widths read the current layout, so they are set before the rows change: reading it
    // after writing 2000 rows forced a full layout right away (~160 ms).
    applyHistoryColumnWidths(historyColumnWidths);
    const content = history.querySelector('.history-table-content');
    if (append && content && content.querySelectorAll('.history-row').length === renderedCount) {
      // Load more adds only the new rows; the graph is redrawn once, from the rows' real heights,
      // by the geometry pass in the next frame. Re-rendering every row made each page slower.
      if (addedCommits.length) content.insertAdjacentHTML('beforeend', renderRows(addedCommits));
      scheduleHistoryGraphGeometry();
    } else {
      const rows = renderRows(loadedHistoryCommits);
      history.innerHTML = rows
        ? `<div class="history-table-content">${renderHistoryGraph(loadedHistoryCommits, graphModel)}${rows}</div>`
        : '<div class="dashboard-empty">No commits match this view.</div>';
    }
    const viewport = pendingHistoryViewport;
    if (viewport && viewport.requestId === payload.requestId && viewport.repositoryPath === payload.repositoryPath) {
      const anchor = viewport.commit
        ? Array.from(history.querySelectorAll('.history-row')).find(row => row.dataset.commit === viewport.commit)
        : null;
      history.scrollTop = anchor ? Math.max(0, anchor.offsetTop - viewport.offset) : 0;
      pendingHistoryViewport = null;
    }
    historyNextOffset = payload.nextOffset;
    if (loadMore) loadMore.hidden = historyNextOffset === null;
    updateCommitCompareUI();

    if (!append && payload.commits && payload.commits.length > 0) {
      const visibleHashes = new Set(loadedHistoryCommits.map(commit => commit.hash));
      commitCompareSelection = comparisonRepository === activeDashboardRepository
        ? commitCompareSelection.filter(hash => visibleHashes.has(hash)).slice(0, 2)
        : [];
      const preferred = payload.commits.find(commit => commit.hash === selectedDashboardCommit) || payload.commits[0];
      updateCommitCompareUI();
      if (commitCompareSelection.length === 2) {
        loadComparison(commitCompareSelection[0], commitCompareSelection[1], 'commits');
      } else {
        loadParentCommitDetail(preferred.hash);
      }
    }
  }

  function renderRepositoryRefs(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    const branches = payload.branches || [];
    const tags = payload.tags || [];
    const remotes = payload.remotes || [];
    const stashes = payload.stashes || [];
    repositoryRefs = { branches, tags, remotes, stashes };
    const branchList = document.getElementById('dashboardBranches');
    const tagList = document.getElementById('dashboardTags');
    const remoteList = document.getElementById('dashboardRemotes');
    const stashList = document.getElementById('dashboardStashes');

    const branchCount = document.getElementById('branchRefCount');
    const tagCount = document.getElementById('tagRefCount');
    const remoteCount = document.getElementById('remoteRefCount');
    const stashCount = document.getElementById('stashRefCount');
    if (branchCount) branchCount.textContent = branches.length;
    if (tagCount) tagCount.textContent = tags.length;
    if (remoteCount) remoteCount.textContent = remotes.length;
    if (stashCount) stashCount.textContent = stashes.length;

    if (branchList) {
      const renderBranch = (branch, depth) => {
        const useOrigin = branch.hasRemote
          ? `<button class="sidebar-ref-origin-action" type="button" data-action="replaceLocalBranchFromRemote" data-branch="${escapeHtml(branch.name)}" title="Reset local branch to origin/${escapeHtml(branch.name)}">Reset to origin</button>`
          : '';
        const deleteBranch = !branch.isCurrent && !branch.isRemote
          ? `<button class="sidebar-ref-delete-action" type="button" data-action="deleteDashboardBranch" data-branch="${escapeHtml(branch.name)}" data-has-remote="${branch.hasRemote ? 'true' : 'false'}" title="Delete local branch ${escapeHtml(branch.name)}" aria-label="Delete local branch ${escapeHtml(branch.name)}">×</button>`
          : '';
        const branchActions = useOrigin || deleteBranch
          ? `<span class="sidebar-ref-actions">${useOrigin}${deleteBranch}</span>`
          : '';
        const leaf = branch.name.split('/').pop();
        return `<div class="sidebar-ref-row branch-depth-${Math.min(depth, 6)}"><button class="sidebar-ref-item${branch.isCurrent ? ' current' : ''}" type="button" data-action="selectDashboardBranch" data-branch="${escapeHtml(branch.name)}" title="${escapeHtml(branch.name)}" aria-pressed="${branch.isCurrent ? 'true' : 'false'}"><span>⑂</span><span>${escapeHtml(leaf)}</span>${branch.isCurrent ? '<small>HEAD</small>' : ''}</button>${branchActions}</div>`;
      };
      branchList.innerHTML = renderBranchTree(buildBranchTree(branches), 0, renderBranch) || '<span class="sidebar-placeholder">No branches</span>';
    }
    if (tagList) {
      tagList.innerHTML = tags.map(tag => `<button class="reference-detail-item" type="button" data-action="selectReference" data-revision="${escapeHtml(tag.name)}"><span>◇</span><span class="reference-detail-copy"><strong>${escapeHtml(tag.name)}</strong><small>${escapeHtml(shortRevision(tag.targetHash))}${tag.createdAt ? ` · ${escapeHtml(formatHistoryDate(tag.createdAt))}` : ''}</small></span></button>`).join('') || '<span class="sidebar-placeholder">No tags</span>';
    }
    if (remoteList) {
      remoteList.innerHTML = remotes.map(remote => `<div class="reference-detail-item" title="Fetch: ${escapeHtml(remote.fetchUrl)}&#10;Push: ${escapeHtml(remote.pushUrl)}"><span>☁</span><span class="reference-detail-copy"><strong>${escapeHtml(remote.name)}</strong><small>fetch · ${escapeHtml(remote.fetchUrl || 'not configured')}</small><small>push · ${escapeHtml(remote.pushUrl || 'not configured')}</small></span></div>`).join('') || '<span class="sidebar-placeholder">No remotes</span>';
    }
    if (stashList) {
      stashList.innerHTML = stashes.map(stash => `<button class="reference-detail-item" type="button" data-action="selectReference" data-revision="${escapeHtml(stash.ref)}"><span>▱</span><span class="reference-detail-copy"><strong>${escapeHtml(stash.ref)} · ${escapeHtml(stash.subject)}</strong><small>${escapeHtml(formatHistoryDate(stash.createdAt))}</small></span></button>`).join('') || '<span class="sidebar-placeholder">No stashes</span>';
    }
    updateSelectedBranchUI();
    populateBranchCompareSelects(document.getElementById('compareBaseBranch'), document.getElementById('compareTargetBranch'));
  }

  function updateSelectedBranchUI(revision) {
    const currentBranch = (repositoryRefs.branches || []).find(branch => branch.isCurrent);
    const selectedRevision = revision || (currentBranch ? currentBranch.name : '');
    document.querySelectorAll('#dashboardBranches .sidebar-ref-item').forEach(item => {
      const selected = item.dataset.branch === selectedRevision;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function clearCommitDetail() {
    selectedDashboardFile = null;
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const diff = document.getElementById('dashboardDiff');
    if (summary) summary.innerHTML = '<div class="detail-placeholder">Select a commit to inspect its changed files and diff.</div>';
    if (files) files.innerHTML = '';
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Select a changed file to load its patch.</span>';
    const count = document.getElementById('changedFileCount');
    if (count) count.textContent = '0';
  }

  function showCommitDetailLoading() {
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const diff = document.getElementById('dashboardDiff');
    if (summary) summary.innerHTML = '<div class="dashboard-loading">Loading commit detail…</div>';
    if (files) files.innerHTML = '';
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Select a changed file to load its patch.</span>';
  }

  function changedFileGlyph(status) {
    const glyphs = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: '!', unknown: '?' };
    return glyphs[status] || '?';
  }

  function renderCommitDetail(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || !payload.detail) return;
    const detail = payload.detail;
    const expectedTarget = activeComparisonTarget || selectedDashboardCommit;
    if (payload.targetRevision !== expectedTarget && detail.hash !== expectedTarget) return;
    selectedDashboardCommit = detail.hash;
    activeComparisonTarget = detail.hash;
    comparisonBaseHash = detail.comparisonBaseHash || null;
    resetChangeSummary();
    changeSummarySelection = { baseSha: comparisonBaseHash, targetSha: detail.hash, files: detail.files || [] };
    restoreChangeSummary();
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const count = document.getElementById('changedFileCount');
    if (summary) {
      const refs = (detail.refs || []).map(ref => `<span class="history-ref ref-${escapeHtml(ref.kind)}">${escapeHtml(ref.name)}</span>`).join('');
      const initials = (detail.authorName || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase();
      const comparisonText = detail.comparisonBaseHash
        ? `${detail.comparisonMode === 'parent' ? 'Parent' : 'Compare'} ${escapeHtml(shortRevision(detail.comparisonBaseHash))} → ${escapeHtml(detail.shortHash)}`
        : `Root commit → ${escapeHtml(detail.shortHash)}`;
      summary.innerHTML = `<div class="commit-avatar">${escapeHtml(initials)}</div><div class="commit-summary-copy"><strong>${escapeHtml(detail.subject)}</strong><span>${escapeHtml(detail.authorName)} · ${escapeHtml(formatHistoryDate(detail.authoredAt))} · ${comparisonText}</span>${detail.body && detail.body !== detail.subject ? `<p>${escapeHtml(detail.body)}</p>` : ''}</div><code>${escapeHtml(detail.shortHash)}</code><div class="commit-summary-refs">${refs}</div>`;
    }
    if (count) count.textContent = String((detail.files || []).length);
    if (files) {
      files.innerHTML = (detail.files || []).map(file => `<button class="changed-file-item status-${escapeHtml(file.status)}" type="button" data-action="selectChangedFile" data-path="${escapeHtml(file.path)}"><span class="file-status-glyph">${changedFileGlyph(file.status)}</span><span class="file-path"><strong>${escapeHtml(file.path.split('/').pop())}</strong><small>${escapeHtml(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}</small></span><span>›</span></button>`).join('') || '<div class="dashboard-empty">No changed files.</div>';
      const jumpFile = pendingEvidenceJump && (detail.files || []).find(file =>
        file.path === pendingEvidenceJump.path || file.oldPath === pendingEvidenceJump.path);
      const firstFile = jumpFile
        ? Array.from(files.querySelectorAll('.changed-file-item')).find(item => item.dataset.path === jumpFile.path)
        : files.querySelector('.changed-file-item');
      if (!jumpFile) pendingEvidenceJump = null;
      if (firstFile) actions.selectChangedFile(firstFile);
    }
  }

  function renderFileDiff(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || payload.commitHash !== selectedDashboardCommit || payload.path !== selectedDashboardFile) return;
    const diff = document.getElementById('dashboardDiff');
    const truncated = document.getElementById('diffTruncated');
    if (!diff) return;
    diff.innerHTML = renderPatchLines(payload.patch);
    if (truncated) truncated.textContent = payload.truncated ? 'Patch truncated at 1 MiB' : '';
    highlightEvidenceLine();
  }

  function renderDashboardError(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    const history = document.getElementById('dashboardHistory');
    if (payload.request === 'getHistory' && history) {
      historyAppendPending = false;
      history.classList.remove('history-stale');
      history.inert = false;
      history.innerHTML = `<div class="dashboard-error">${escapeHtml(payload.message)}</div>`;
      return;
    }
    const target = payload.request === 'getCommitDetail'
      ? document.getElementById('dashboardCommitSummary')
      : payload.request === 'getFileDiff'
        ? document.getElementById('dashboardDiff')
        : null;
    if (target) target.innerHTML = `<div class="dashboard-error">${escapeHtml(payload.message)}</div>`;
  }

  // Ripple effect for buttons
  document.body.addEventListener('mousedown', function (e) {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  });

  // Event delegation - handle all clicks
  document.body.addEventListener('click', function (e) {
    if (!e.target.closest('#historyContextMenu')) hideHistoryContextMenu();
    let el = e.target;

    // Walk up the DOM tree to find element with data-action
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        const action = el.dataset.action;
        if (actions[action]) {
          e.preventDefault();
          actions[action](el, e);
        }
        return;
      }
      el = el.parentElement;
    }
  });

  document.body.addEventListener('contextmenu', function (e) {
    const commitElement = e.target.closest('.history-row, .graph-node-control[data-commit]');
    if (!commitElement) {
      hideHistoryContextMenu();
      return;
    }
    if (showHistoryContextMenu(commitElement, e.clientX, e.clientY)) e.preventDefault();
  });
  window.addEventListener('scroll', hideHistoryContextMenu, true);
  window.addEventListener('blur', hideHistoryContextMenu);
  // Once the user opens or closes Past reviews, the dashboard stops choosing for them.
  const reviewHistoryDetails = document.getElementById('reviewHistory');
  if (reviewHistoryDetails) reviewHistoryDetails.addEventListener('click', event => {
    if (event.target.closest('summary')) reviewHistoryDetails.dataset.touched = 'true';
  });
  document.body.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideHistoryContextMenu();
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && e.target.closest('.history-row')) {
      e.preventDefault();
      const rect = e.target.getBoundingClientRect();
      showHistoryContextMenu(e.target.closest('.history-row'), rect.left + 10, rect.top + 10);
    }
  });

  document.body.addEventListener('dblclick', function (e) {
    const branchRef = e.target.closest('.history-ref[data-branch]');
    if (!branchRef) return;
    e.preventDefault();
    e.stopPropagation();
    requestBranchCheckout(branchRef.dataset.branch);
  });

  document.body.addEventListener('keydown', function (e) {
    const graphNode = e.target.closest && e.target.closest('.graph-node-control');
    if (!graphNode || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggleCommitCompareNode(graphNode.dataset.commit);
  });

  // The reason for a dismissal is a select inside the finding, so it reports through 'change'.
  document.addEventListener('change', event => {
    const select = event.target;
    // A file ticked or unticked in a proposed fix: only the selection and Apply selected change.
    if (select && select.classList && select.classList.contains('review-fix-select')) {
      const fix = reviewState && reviewState.fix;
      if (!fix || !fix.selected) return;
      if (select.checked) fix.selected.add(select.dataset.path); else fix.selected.delete(select.dataset.path);
      renderReviewPanel();
      return;
    }
    if (!select || !select.classList || !select.classList.contains('review-dismiss-reason')) return;
    if (!reviewState || reviewState.status !== 'completed') return;
    postMessage('setFindingTriage', { requestId: reviewState.requestId, findingId: select.dataset.findingId,
      decision: 'dismiss', reason: select.value });
  });

  // Handle workspace folder switching
  const workspaceFolderSelect = document.getElementById('workspaceFolderSelect');
  if (workspaceFolderSelect) {
    workspaceFolderSelect.addEventListener('change', function (e) {
      const folderPath = e.target.value;
      if (folderPath) {
        postMessage('switchWorkspaceFolder', { folderPath });
      }
    });
  }

  // Handle messages from extension
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || !message.type) return;

    try {
      switch (message.type) {
        case 'summaryModelsLoaded': {
          const select = document.getElementById('summaryModelSelect');
          const models = Array.isArray(message.payload?.models) ? message.payload.models : [];
          select.innerHTML = '<option value="">Default Copilot model</option>' + models
            .filter(model => typeof model.id === 'string' && typeof model.name === 'string')
            .map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('');
          if (selectedSummaryModelId && !models.some(model => model.id === selectedSummaryModelId)) {
            cancelPendingChangeSummary();
            selectedSummaryModelId = '';
          }
          select.innerHTML += '<option value="__reload__">↻ Reload model list</option>';
          select.value = selectedSummaryModelId;
          summaryModelsState = 'loaded';
          restoreChangeSummary();
          break;
        }
        case 'summaryModelsError': {
          // Opening the menu again retries.
          summaryModelsState = 'idle';
          const select = document.getElementById('summaryModelSelect');
          if (select && select.options && select.options[0]) select.options[0].textContent = 'Default Copilot model';
          document.getElementById('changeSummaryStatus').textContent = message.payload?.message || 'Unable to load models.';
          break;
        }
        case 'changeSummaryProgress':
        case 'changeSummaryLoaded':
        case 'changeSummaryError': {
          const payload = message.payload;
          const entry = Array.from(changeSummaries.entries()).find(([, record]) =>
            record.requestId === payload?.requestId && record.repositoryPath === payload.repositoryPath);
          if (!entry || !entry[1].pending) break;
          const [key, record] = entry;
          if (message.type === 'changeSummaryProgress') {
            record.status = payload.status;
          } else {
            record.pending = false;
            if (activeChangeSummaryKey === key) activeChangeSummaryKey = null;
            if (message.type === 'changeSummaryLoaded') {
              record.summary = payload.summary;
              record.model = payload.model;
              record.status = `Completed · ${payload.model}`;
            } else {
              record.status = payload.message;
            }
          }
          if (isCurrentChangeSummary(payload)) {
            if (record.summary) renderChangeSummary(payload);
            else restoreChangeSummary();
          }
          break;
        }
        case 'workingTreeChangesLoaded':
          renderWorkingTreeChanges(message.payload);
          break;

        case 'workingTreePreviewLoaded': {
          const payload = message.payload;
          if (!isCurrentWorkingTreePreview(payload)) break;
          const diff = document.getElementById('commitPreviewDiff');
          const truncated = document.getElementById('commitPreviewTruncated');
          if (diff) diff.innerHTML = payload.patch
            ? renderPatchLines(payload.patch)
            : '<span class="diff-placeholder">No changes in this view.</span>';
          if (truncated) truncated.textContent = payload.truncated ? 'Patch truncated at 1 MiB' : '';
          break;
        }

        case 'workingTreePreviewError': {
          const payload = message.payload;
          if (!isCurrentWorkingTreePreview(payload)) break;
          const diff = document.getElementById('commitPreviewDiff');
          if (diff) diff.innerHTML = '<span class="dashboard-error">' + escapeHtml(payload.message) + '</span>';
          break;
        }

        case 'commitFilesResult': {
          const repositoryPath = document.getElementById('commitChangesRepositoryPath');
          if (!repositoryPath || repositoryPath.value !== message.payload.repositoryPath) break;
          const result = document.getElementById('commitChangesResult');
          const commitButton = document.getElementById('commitSelectedFilesButton');
          if (result) result.textContent = message.payload.message || '';
          if (commitButton) commitButton.disabled = false;
          if (message.payload.success) {
            const draft = document.getElementById('commitMessage');
            if (draft) draft.value = '';
            document.getElementById('commitChangesModal').classList.remove('active');
          }
          break;
        }

        case 'releaseRangeResolved': {
          const payload = message.payload || {};
          if (!releaseRange || payload.requestId !== releaseRange.requestId ||
              payload.repositoryPath !== activeDashboardRepository) break;
          if (!payload.baseSha) {
            releaseRange = null;
            showReleaseStatus(payload.message || 'No release range.', true);
            break;
          }
          releaseRange = null;
          commitCompareSelection = [];
          loadComparison(payload.baseSha, payload.targetSha, 'release', { base: payload.baseLabel, target: payload.targetLabel });
          break;
        }

        case 'reviewHistoryLoaded': {
          const payload = message.payload || {};
          if (payload.listId !== reviewHistoryListId) break;
          reviewHistory = { repositoryPath: payload.repositoryPath, entries: Array.isArray(payload.entries) ? payload.entries : [] };
          renderReviewPanel();
          break;
        }

        case 'reviewProgress':
        case 'reviewCompleted':
        case 'reviewFailed': {
          const payload = message.payload || {};
          if (!reviewState || payload.requestId !== reviewState.requestId) break;
          if (message.type === 'reviewProgress') {
            reviewState.progress = payload.message;
            if (payload.detail) {
              reviewState.detail = payload.detail;
              if (payload.detail.components) reviewState.components = payload.detail.components;
              if (!reviewState.startedAt) reviewState.startedAt = Date.now();
            }
            // The extension resolves the release range, so it reports the labels it settled on.
            if (payload.targetLabel) Object.assign(reviewState, { baseLabel: payload.baseLabel || '', targetLabel: payload.targetLabel });
          } else if (message.type === 'reviewCompleted') {
            Object.assign(reviewState, { status: 'completed', result: payload.result, readiness: payload.readiness, context: payload.context,
              triage: payload.triage || {}, historyId: payload.historyId || null });
            if (payload.context) Object.assign(reviewState, { baseLabel: payload.context.baseLabel || '', targetLabel: payload.context.targetLabel });
            requestReviewHistory();
          } else {
            Object.assign(reviewState, { status: payload.cancelled ? 'cancelled' : 'failed', cancelled: Boolean(payload.cancelled), message: payload.message });
          }
          renderReviewPanel();
          break;
        }

        case 'reviewFixProgress':
        case 'reviewFixProposed':
        case 'reviewFixFailed':
        case 'reviewFixApplied':
        case 'reviewFixDiscarded': {
          const payload = message.payload || {};
          if (!reviewState || payload.requestId !== reviewState.requestId) break;
          const previous = reviewState.fix || {};
          reviewState.fix = {
            reviewFixProgress: () => ({ status: 'running', message: payload.message, detail: payload.detail || previous.detail,
              startedAt: previous.startedAt || Date.now() }),
            reviewFixProposed: () => ({ status: 'proposed', files: payload.files || [], notes: payload.notes || [], rejected: payload.rejected || [],
              selected: new Set((payload.files || []).map(file => file.path)) }),
            // A failed Apply keeps the proposal on screen with the reason.
            reviewFixFailed: () => (payload.keepProposal ? Object.assign({}, previous, { message: payload.message })
              : payload.cancelled ? null : { status: 'failed', message: payload.message }),
            // Apply selected leaves the other files proposed, still ticked as they were.
            reviewFixApplied: () => ((payload.remaining || []).length
              ? Object.assign({}, previous, { files: payload.remaining, message: '', applied: (previous.applied || []).concat(payload.paths || []),
                selected: new Set(payload.remaining.map(file => file.path).filter(item => previous.selected && previous.selected.has(item))) })
              : { status: 'applied', paths: (previous.applied || []).concat(payload.paths || []) }),
            reviewFixDiscarded: () => null
          }[message.type]();
          renderReviewPanel();
          break;
        }

        case 'reviewTriageUpdated': {
          const payload = message.payload || {};
          if (!reviewState || payload.requestId !== reviewState.requestId || reviewState.status !== 'completed') break;
          Object.assign(reviewState, { triage: payload.triage || {}, readiness: payload.readiness });
          renderReviewPanel();
          if (reviewState.historyId) requestReviewHistory();
          break;
        }

        case 'pendingOperationLoaded': {
          const payload = message.payload || {};
          pendingOperations[payload.repositoryPath] = payload.operation || null;
          const menu = document.getElementById('historyContextMenu');
          if (menu && !menu.hidden && payload.repositoryPath === activeDashboardRepository) {
            applyHistoryMenuOperation();
            positionHistoryContextMenu();
          }
          break;
        }

        case 'workspaceFolderChanged': {
          // Paths such as '.' now point into a different folder: forget everything tied to the old one.
          repositoryData = (message.payload && message.payload.repositories) || [];
          repositoryDataAt = Date.now();
          dashboardHistoryState = {};
          Object.keys(pendingOperations).forEach(key => delete pendingOperations[key]);
          // A review keeps running (and its results stay) across folders: it is pinned to its own folder.
          renderReviewPanel();
          cancelPendingChangeSummary();
          changeSummaries.clear();
          activeDashboardRepository = null;
          if (repositoryData.length > 0) {
            activateDashboardRepository(repositoryData[0].path);
          } else {
            loadedHistoryCommits = [];
            clearCommitDetail();
            const history = document.getElementById('dashboardHistory');
            if (history) history.innerHTML = '<div class="dashboard-empty">No Git repository in this folder.</div>';
            saveState();
          }
          renderRepositorySwitcher();
          break;
        }

        case 'updateSubmodules': {
          repositoryData = message.payload.submodules;
          repositoryDataAt = Date.now();
          saveState();
          updateRepositoryRows(repositoryData);
          // The active repository can vanish (e.g. removed from .gitmodules); fall back to one that exists.
          if (repositoryData.length > 0 && !getRepository(activeDashboardRepository)) {
            activateDashboardRepository(repositoryData[0].path);
          }
          renderRepositorySwitcher();
          break;
        }

        case 'repositoryOperationResult': {
          const payload = message.payload || {};
          setToolbarOperationState(payload.operation, payload.success ? 'success' : 'error', payload.message);
          if (payload.success) reloadActiveDashboardData();
          break;
        }

        case 'branchCheckoutResult': {
          const payload = message.payload || {};
          const matchesPending = pendingBranchCheckout
            && pendingBranchCheckout.repositoryPath === payload.repositoryPath
            && pendingBranchCheckout.branch === payload.branch;
          if (matchesPending) {
            setBranchCheckoutPending(false);
            pendingBranchCheckout = null;
          }
          if (payload.success && payload.repositoryPath === activeDashboardRepository) {
            setHistoryRevision('');
            commitCompareSelection = [];
            comparisonBaseHash = null;
            activeComparisonTarget = null;
            comparisonSource = null;
            comparisonLabels = null;
            saveState();
            requestDashboardHistory(0, false, { preserveViewport: true });
            postMessage('getRepositoryRefs', { repositoryPath: activeDashboardRepository });
          }
          break;
        }

        case 'reloadDashboardHistory': {
          const repositoryPaths = Array.isArray(message.payload && message.payload.repositoryPaths)
            ? message.payload.repositoryPaths
            : [];
          if (repositoryPaths.length === 0 || repositoryPaths.includes(activeDashboardRepository)) {
            reloadActiveDashboardData();
          }
          break;
        }

        case 'historyLoaded':
          renderHistoryPage(message.payload);
          break;

        case 'repositoryRefsLoaded':
          renderRepositoryRefs(message.payload);
          break;

        case 'commitDetailLoaded':
          renderCommitDetail(message.payload);
          break;

        case 'fileDiffLoaded':
          renderFileDiff(message.payload);
          break;

        case 'dashboardError':
          renderDashboardError(message.payload);
          break;

        case 'branchCreationResults': {
          const createdBranch = message.payload.branchName;
          const results = message.payload.results;
          showReviewModal(createdBranch, results);
          break;
        }

        case 'pushResults': {
          const pushResults = message.payload.results || [];
          const pushSuccessCount = pushResults.filter(r => r.success).length;
          if (pushSuccessCount === pushResults.length) {
            alert('Successfully pushed branch to ' + pushSuccessCount + ' remote(s)');
          } else {
            alert('Pushed to ' + pushSuccessCount + '/' + pushResults.length + ' remotes. Some pushes failed.');
          }
          break;
        }

        case 'baseBranchesForCreate': {
          const baseBranchHidden = document.getElementById('baseBranch');
          const baseBranchInput = document.getElementById('baseBranchInput');
          const baseBranchList = document.getElementById('baseBranchList');
          const availableBranches = (message.payload && message.payload.branches) || [];

          if (baseBranchList && baseBranchInput && baseBranchHidden) {
            if (availableBranches.length === 0) {
              baseBranchList.innerHTML = '<div class="branch-dropdown-item" data-value="main"><span class="branch-name">main</span></div>';
              baseBranchInput.value = 'main';
              baseBranchHidden.value = 'main';
            } else {
              baseBranchList.innerHTML = availableBranches.map(b => {
                let tags = '';
                if (b.isRemote) {
                  tags += '<span class="branch-tag tag-remote">remote</span>';
                } else {
                  tags += '<span class="branch-tag tag-local">local</span>';
                }
                return `<div class="branch-dropdown-item" data-value="${b.name}">
                  <span class="branch-name">${b.name}</span>
                  <span class="branch-tags">${tags}</span>
                </div>`;
              }).join('');

              // Set default value to first branch
              const firstBranch = availableBranches[0];
              baseBranchInput.value = firstBranch.name;
              baseBranchHidden.value = firstBranch.name;
            }
            baseBranchInput.placeholder = 'Select base branch...';
            updatePrefixOptions();
          }
          break;
        }
      }
    } catch (err) {
      console.error('Error handling message:', message.type, err);
    }
  });

  function updateRepositoryRows(repositories) {
    repositories.forEach(repository => {
      if (repository.path === activeDashboardRepository) {
        const behindCount = document.getElementById('dashboardBehindCount');
        const aheadCount = document.getElementById('dashboardAheadCount');
        if (behindCount) {
          behindCount.textContent = repository.behind > 0 ? String(repository.behind) : '';
          behindCount.hidden = repository.behind <= 0;
        }
        if (aheadCount) {
          aheadCount.textContent = repository.ahead > 0 ? String(repository.ahead) : '';
          aheadCount.hidden = repository.ahead <= 0;
        }
      }
    });
  }

  // Branch naming tool functions
  // Branch hierarchy rules:
  // - main/master -> bugfix/, release/, dev/
  // - dev -> feature/, release/
  // - feature -> feature/, task/
  // - task -> task/
  // - unknown -> no type hint, all prefixes available
  const branchHierarchy = {
    'main': { prefixes: ['bugfix', 'release', 'dev'], hint: 'From main: Create bugfix, release, or dev branches' },
    'master': { prefixes: ['bugfix', 'release', 'dev'], hint: 'From master: Create bugfix, release, or dev branches' },
    'dev': { prefixes: ['feature', 'release'], hint: 'From dev: Create feature or release branches' },
    'feature': { prefixes: ['feature', 'task'], hint: 'From feature: Create feature or task branches' },
    'task': { prefixes: ['task'], hint: 'From task: Create task branches' }
  };

  // Store created branch info for review
  let pendingBranchInfo = null;

  function toKebabCase(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function getBaseBranchType(baseBranch) {
    const lower = baseBranch.toLowerCase();
    if (lower === 'main' || lower === 'master') return 'main';
    if (lower === 'dev' || lower.startsWith('dev/') || lower.startsWith('dev-')) return 'dev';
    if (lower.startsWith('feature/') || lower.startsWith('feature-')) return 'feature';
    if (lower === 'task' || lower.startsWith('task/') || lower.startsWith('task-')) return 'task';
    return 'unknown';
  }

  function updatePrefixOptions() {
    const baseBranchEl = document.getElementById('baseBranch');
    const baseBranch = (baseBranchEl ? baseBranchEl.value.trim() : '') || 'main';
    const branchType = getBaseBranchType(baseBranch);
    const rules = branchHierarchy[branchType];

    const prefixSelect = document.getElementById('branchPrefix');
    const currentValue = prefixSelect.value;

    let prefixes;
    if (rules) {
      prefixes = [...rules.prefixes, 'none'];
      // Update hints only for known branch types
      document.getElementById('baseBranchHint').textContent = 'Type: ' + branchType;
      document.getElementById('prefixRuleHint').textContent = rules.hint + '. None creates a branch without a prefix';
    } else {
      // Unknown branch type - don't show type hint, show all prefix options
      prefixes = ['bugfix', 'feature', 'task', 'release', 'dev', 'none'];
      document.getElementById('baseBranchHint').textContent = '';
      document.getElementById('prefixRuleHint').textContent = 'None creates a branch without a prefix';
    }

    // Update options based on rules
    prefixSelect.innerHTML = prefixes.map(p => {
      const label = p === 'none' ? 'None' : p + '/';
      return `<option value="${p}">${label}</option>`;
    }).join('');

    // Try to keep current selection if valid, otherwise use first option
    if (prefixes.includes(currentValue)) {
      prefixSelect.value = currentValue;
    } else {
      prefixSelect.value = prefixes[0];
    }

    toggleBranchFormFields();
  }

  function updateBranchPreview() {
    const prefix = document.getElementById('branchPrefix').value;
    const preview = document.getElementById('branchPreview');
    const branchNameInput = document.getElementById('branchName');
    let branchName = '';

    if (prefix === 'release') {
      const productName = document.getElementById('productName').value.trim();
      const version = document.getElementById('releaseVersion').value.trim();
      if (productName && version) {
        branchName = 'release/' + productName + '_' + version;
      } else if (productName) {
        branchName = 'release/' + productName + '_';
      } else {
        branchName = 'release/ProductName_x.x.x';
      }
    } else if (prefix === 'dev') {
      const devName = document.getElementById('devBranchName').value.trim();
      const kebabDevName = toKebabCase(devName);
      if (kebabDevName) {
        branchName = 'dev/' + kebabDevName;
      } else {
        branchName = 'dev/your-branch-name';
      }
    } else {
      const ticketId = document.getElementById('ticketId').value.trim();
      const taskTitle = document.getElementById('taskTitle').value.trim();
      const kebabTitle = toKebabCase(taskTitle);
      const prefixStr = prefix === 'none' ? '' : prefix + '/';

      if (ticketId && kebabTitle) {
        branchName = prefixStr + ticketId + '-' + kebabTitle;
      } else if (ticketId) {
        branchName = prefix === 'none' ? ticketId : prefixStr + ticketId + '-';
      } else if (kebabTitle) {
        branchName = prefixStr + kebabTitle;
      } else {
        branchName = prefixStr + 'your-branch-name';
      }
    }

    preview.textContent = branchName;
    preview.style.color = (branchName.includes('your-branch-name') || branchName.endsWith('_') || branchName.endsWith('-') || branchName.endsWith('x.x.x'))
      ? 'var(--text-secondary)'
      : 'var(--text-primary)';
    branchNameInput.value = branchName;
  }

  function toggleBranchFormFields() {
    const prefix = document.getElementById('branchPrefix').value;
    const ticketIdGroup = document.getElementById('ticketIdGroup');
    const taskTitleGroup = document.getElementById('taskTitleGroup');
    const releaseInfoGroup = document.getElementById('releaseInfoGroup');
    const devBranchGroup = document.getElementById('devBranchGroup');

    // Hide all first
    ticketIdGroup.style.display = 'none';
    taskTitleGroup.style.display = 'none';
    releaseInfoGroup.style.display = 'none';
    devBranchGroup.style.display = 'none';

    if (prefix === 'release') {
      releaseInfoGroup.style.display = 'block';
    } else if (prefix === 'dev') {
      devBranchGroup.style.display = 'block';
    } else {
      // feature, task, bugfix, or no prefix
      ticketIdGroup.style.display = 'block';
      taskTitleGroup.style.display = 'block';
    }
    updateBranchPreview();
  }

  function showReviewModal(branchName, results) {
    const resultsDiv = document.getElementById('branchCreationResults');
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    let html = '<div style="margin-bottom: 12px;">';
    if (failCount === 0) {
      html += `<span style="color: var(--success);">\u2713 Branch created successfully in ${successCount} repository/repositories</span>`;
    } else {
      html += `<span style="color: var(--warning);">\u26A0 Created in ${successCount}, failed in ${failCount} repository/repositories</span>`;
    }
    html += '</div>';

    // Show per-repository results.
    html += '<div style="max-height: 150px; overflow-y: auto; font-size: 12px;">';
    results.forEach(r => {
      const icon = r.success ? '\u2713' : '\u2717';
      const color = r.success ? 'var(--success)' : 'var(--error)';
      html += `<div style="padding: 4px 0; color: ${color};">${icon} ${r.repository}: ${r.message}</div>`;
    });
    html += '</div>';

    resultsDiv.innerHTML = html;
    document.getElementById('reviewBranchName').textContent = branchName;
    document.getElementById('reviewBranchModal').classList.add('active');
  }

  // Retry mechanism for base branch loading
  let branchRetryTimer = null;
  function retryLoadBaseBranches(retriesLeft) {
    if (branchRetryTimer) {
      clearTimeout(branchRetryTimer);
      branchRetryTimer = null;
    }
    if (retriesLeft <= 0) return;
    branchRetryTimer = setTimeout(function () {
      branchRetryTimer = null;
      const baseBranchList = document.getElementById('baseBranchList');
      if (!baseBranchList) return;
      // Check if still showing loading text (branches not received yet)
      const loadingEl = baseBranchList.querySelector('.branch-select-loading');
      if (loadingEl) {
        console.log('[RepositoryManager] Retrying base branch load, retries left:', retriesLeft - 1);
        postMessage('getBaseBranchesForCreate', {});
        retryLoadBaseBranches(retriesLeft - 1);
      }
    }, 2000);
  }

  // Event listeners for branch naming inputs
  document.getElementById('branchPrefix').addEventListener('change', toggleBranchFormFields);
  document.getElementById('ticketId').addEventListener('input', updateBranchPreview);
  document.getElementById('taskTitle').addEventListener('input', updateBranchPreview);
  document.getElementById('productName').addEventListener('input', updateBranchPreview);
  document.getElementById('releaseVersion').addEventListener('input', updateBranchPreview);
  document.getElementById('devBranchName').addEventListener('input', updateBranchPreview);

  // Custom branch dropdown event handlers
  const baseBranchDropdown = document.getElementById('baseBranchDropdown');
  const baseBranchInput = document.getElementById('baseBranchInput');
  const baseBranchList = document.getElementById('baseBranchList');
  const baseBranchHidden = document.getElementById('baseBranch');

  if (baseBranchInput && baseBranchDropdown) {
    // Toggle dropdown on input click
    baseBranchInput.addEventListener('click', function(e) {
      e.stopPropagation();
      baseBranchDropdown.classList.toggle('open');
    });

    // Handle branch selection
    baseBranchList.addEventListener('click', function(e) {
      const item = e.target.closest('.branch-dropdown-item');
      if (item) {
        const value = item.dataset.value;
        baseBranchInput.value = value;
        baseBranchHidden.value = value;
        baseBranchDropdown.classList.remove('open');
        updatePrefixOptions();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!baseBranchDropdown.contains(e.target)) {
        baseBranchDropdown.classList.remove('open');
      }
    });
  }

  // Scrolling near the end loads the next page; the Load more button stays for keyboard use.
  const historyList = document.getElementById('dashboardHistory');
  if (historyList) historyList.addEventListener('scroll', function () {
    if (historyNextOffset === null || historyAppendPending) return;
    if (historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 400) actions.loadMoreHistory();
  }, { passive: true });

  const dashboardSearch = document.getElementById('dashboardSearch');
  const summaryModelSelect = document.getElementById('summaryModelSelect');
  if (summaryModelSelect) {
    const loadOnOpen = function () { if (summaryModelsState === 'idle') actions.loadSummaryModels(); };
    summaryModelSelect.addEventListener('focus', loadOnOpen);
    summaryModelSelect.addEventListener('mousedown', loadOnOpen);
    summaryModelSelect.addEventListener('change', function () {
      if (summaryModelSelect.value === '__reload__') {
        summaryModelSelect.value = selectedSummaryModelId;
        summaryModelsState = 'idle';
        actions.loadSummaryModels();
        return;
      }
      if (summaryModelSelect.value === selectedSummaryModelId) return;
      cancelPendingChangeSummary();
      selectedSummaryModelId = summaryModelSelect.value;
      restoreChangeSummary();
    });
  }
  if (dashboardSearch) {
    dashboardSearch.addEventListener('input', function () {
      captureDashboardFilters();
      saveState();
      if (historySearchTimer) clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(function () {
        requestDashboardHistory(0, false);
      }, 250);
    });
  }

  const commitSelectAll = document.getElementById('commitSelectAll');
  if (commitSelectAll) {
    commitSelectAll.addEventListener('change', function () {
      document.querySelectorAll('.commit-change-checkbox:not(:disabled)').forEach(checkbox => {
        checkbox.checked = commitSelectAll.checked;
      });
      updateCommitSelectionCount();
    });
  }

  const commitChangesList = document.getElementById('commitChangesList');
  if (commitChangesList) {
    commitChangesList.addEventListener('change', function (event) {
      if (!event.target.classList.contains('commit-change-checkbox')) return;
      const selectable = Array.from(document.querySelectorAll('.commit-change-checkbox:not(:disabled)'));
      if (commitSelectAll) {
        commitSelectAll.checked = selectable.length > 0 && selectable.every(checkbox => checkbox.checked);
      }
      updateCommitSelectionCount();
    });
  }

  const dashboardIncludeRemotes = document.getElementById('dashboardIncludeRemotes');
  if (dashboardIncludeRemotes) {
    dashboardIncludeRemotes.addEventListener('change', function () {
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
    });
  }

  function clampPanelSize(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getHistoryColumnMinimum(index) {
    return historyColumnMinimums[index] || 1;
  }

  function applyHistoryColumnWidths(widths) {
    const region = document.querySelector('.history-region');
    const history = document.getElementById('dashboardHistory');
    if (!region || !history) return;

    const contentWidth = history.clientWidth || region.clientWidth;
    const padding = parseFloat(getComputedStyle(region).getPropertyValue('--history-horizontal-padding')) || 12;
    const available = Math.max(1, contentWidth - 2 * padding - 4 * 8);
    const baseMinimums = [
      Math.min(historyGraphWidth, Math.max(34, Math.floor(available * .24))),
      80, 58, 54, 52
    ];
    const minimumTotal = baseMinimums.reduce((sum, value) => sum + value, 0);
    const factor = Math.min(1, available / minimumTotal);
    historyColumnMinimums = baseMinimums.map(value => value * factor);

    const requested = Array.isArray(widths) && widths.length === defaultHistoryColumnWidths.length
      ? widths : defaultHistoryColumnWidths;
    const next = requested.map((width, index) => {
      const normalized = Number.isFinite(Number(width)) ? Number(width) : defaultHistoryColumnWidths[index];
      return Math.max(historyColumnMinimums[index], normalized);
    });
    let remaining = available - next.reduce((sum, width) => sum + width, 0);
    if (remaining < 0) {
      // When space runs out, give up Author and Date before Message, then Commit, then Graph.
      // Message keeps a proportional share here (it is the column people read), but a user can
      // still drag it narrower: the resize minimum stays historyColumnMinimums.
      const messageShare = Math.max(historyColumnMinimums[1], Math.floor(available * .35));
      // Second pass drops the Message share so the columns always fit.
      for (const floorOf of [index => (index === 1 ? messageShare : historyColumnMinimums[index]), index => historyColumnMinimums[index]]) {
        for (const index of [2, 3, 1, 4, 0]) {
          if (remaining >= 0) break;
          const reduction = Math.max(0, Math.min(-remaining, next[index] - floorOf(index)));
          next[index] -= reduction;
          remaining += reduction;
        }
      }
    } else {
      next[1] += remaining;
    }
    renderedHistoryColumnWidths = next;
    region.style.setProperty('--history-content-width', `${contentWidth}px`);
    ['graph', 'message', 'author', 'date', 'commit'].forEach((name, index) => {
      region.style.setProperty(`--history-${name}-column-width`, `${next[index]}px`);
    });
    scheduleHistoryGraphGeometry();
  }

  function setupHistoryColumnResizers() {
    const header = document.getElementById('historyTableHeader');
    const history = document.getElementById('dashboardHistory');
    if (!header || !history) return;

    applyHistoryColumnWidths(historyColumnWidths);

    history.scrollLeft = 0;
    new ResizeObserver(() => applyHistoryColumnWidths(historyColumnWidths))
      .observe(history);

    header.querySelectorAll('.history-column-resizer').forEach(handle => {
      const columnIndex = Number(handle.dataset.columnIndex);
      if (columnIndex === 4) {
        handle.remove();
        return;
      }
      let startX = 0;
      let startWidth = 0;
      let adjacentWidth = 0;
      const adjacentIndex = columnIndex + 1;

      handle.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        startX = event.clientX;
        startWidth = renderedHistoryColumnWidths[columnIndex];
        adjacentWidth = renderedHistoryColumnWidths[adjacentIndex];
        handle.classList.add('dragging');
        handle.setPointerCapture(event.pointerId);
      });

      handle.addEventListener('pointermove', function (event) {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const pairWidth = startWidth + adjacentWidth;
        const nextWidth = clampPanelSize(
          startWidth + event.clientX - startX,
          getHistoryColumnMinimum(columnIndex),
          pairWidth - getHistoryColumnMinimum(adjacentIndex)
        );
        historyColumnWidths = (historyColumnWidths.length ? historyColumnWidths : defaultHistoryColumnWidths).slice();
        historyColumnWidths[columnIndex] = nextWidth;
        historyColumnWidths[adjacentIndex] = pairWidth - nextWidth;
        applyHistoryColumnWidths(historyColumnWidths);
      });

      handle.addEventListener('pointerup', function (event) {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('dragging');
        saveState();
      });

      handle.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 16 : -16;
        const pairWidth = renderedHistoryColumnWidths[columnIndex] + renderedHistoryColumnWidths[adjacentIndex];
        historyColumnWidths = (historyColumnWidths.length ? historyColumnWidths : defaultHistoryColumnWidths).slice();
        historyColumnWidths[columnIndex] = clampPanelSize(
          renderedHistoryColumnWidths[columnIndex] + delta,
          getHistoryColumnMinimum(columnIndex),
          pairWidth - getHistoryColumnMinimum(adjacentIndex)
        );
        historyColumnWidths[adjacentIndex] = pairWidth - historyColumnWidths[columnIndex];
        applyHistoryColumnWidths(historyColumnWidths);
        saveState();
      });
    });
  }

  function applyHistoryPanelHeight(height) {
    const main = document.querySelector('.dashboard-main');
    const controls = document.querySelector('.history-controls');
    if (!main || !controls) return;
    const max = main.clientHeight - controls.offsetHeight - 6 - 120;
    historyPanelHeight = clampPanelSize(height, 120, Math.max(120, max));
    main.style.gridTemplateRows = `${controls.offsetHeight}px ${historyPanelHeight}px 6px minmax(120px, 1fr)`;
  }

  function applyFilesPanelWidth(width) {
    const content = document.querySelector('.commit-content');
    if (!content) return;
    const max = content.clientWidth - 6 - 220;
    filesPanelWidth = clampPanelSize(width, 170, Math.max(170, max));
    content.style.gridTemplateColumns = `${filesPanelWidth}px 6px minmax(220px, 1fr)`;
  }

  function setupDashboardSplitters() {
    const historySplitter = document.getElementById('historyDiffSplitter');
    const filesSplitter = document.getElementById('filesDiffSplitter');
    const historyRegion = document.querySelector('.history-region');
    const commitContent = document.querySelector('.commit-content');

    if (historyPanelHeight > 0) applyHistoryPanelHeight(historyPanelHeight);
    if (filesPanelWidth > 0) applyFilesPanelWidth(filesPanelWidth);

    if (historySplitter && historyRegion) {
      historySplitter.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        historySplitter.classList.add('dragging');
        historySplitter.setPointerCapture(event.pointerId);
      });
      historySplitter.addEventListener('pointermove', function (event) {
        if (!historySplitter.hasPointerCapture(event.pointerId)) return;
        applyHistoryPanelHeight(event.clientY - historyRegion.getBoundingClientRect().top);
      });
      historySplitter.addEventListener('pointerup', function (event) {
        if (historySplitter.hasPointerCapture(event.pointerId)) historySplitter.releasePointerCapture(event.pointerId);
        historySplitter.classList.remove('dragging');
        saveState();
      });
      historySplitter.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        applyHistoryPanelHeight((historyPanelHeight || historyRegion.offsetHeight) + (event.key === 'ArrowDown' ? 24 : -24));
        saveState();
      });
    }

    if (filesSplitter && commitContent) {
      filesSplitter.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        filesSplitter.classList.add('dragging');
        filesSplitter.setPointerCapture(event.pointerId);
      });
      filesSplitter.addEventListener('pointermove', function (event) {
        if (!filesSplitter.hasPointerCapture(event.pointerId)) return;
        applyFilesPanelWidth(event.clientX - commitContent.getBoundingClientRect().left);
      });
      filesSplitter.addEventListener('pointerup', function (event) {
        if (filesSplitter.hasPointerCapture(event.pointerId)) filesSplitter.releasePointerCapture(event.pointerId);
        filesSplitter.classList.remove('dragging');
        saveState();
      });
      filesSplitter.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        applyFilesPanelWidth((filesPanelWidth || 300) + (event.key === 'ArrowRight' ? 24 : -24));
        saveState();
      });
    }

    window.addEventListener('resize', function () {
      if (historyPanelHeight > 0) applyHistoryPanelHeight(historyPanelHeight);
      if (filesPanelWidth > 0) applyFilesPanelWidth(filesPanelWidth);
    });
  }

  // ---- Security and compliance review (MVP 2, W6–W7) ----
  // The extension runs the review and classifies readiness; this code only collects input
  // and displays results, so the dashboard and the exported report always agree.
  let pendingEvidenceJump = null;
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

  // Starts at once with security and team policy, using the model chosen for AI summaries;
  // the extension asks for consent until it is allowed for the repository.
  function startReview(options) {
    if (!activeDashboardRepository || reviewLocked()) return;
    const scope = options.scope;
    const kind = options.kind || 'review';
    reviewRequestId += 1;
    const repository = getRepository(activeDashboardRepository);
    reviewState = { requestId: reviewRequestId, repositoryPath: activeDashboardRepository, folder: currentWorkspaceFolder(),
      repositoryName: repository ? repository.name : activeDashboardRepository, scope, kind,
      baseLabel: scope === 'changes' ? (options.baseLabel || options.base || '') : '', targetLabel: options.targetLabel || options.target || '', status: 'running' };
    renderReviewPanel();
    showDetailTab('review');
    postMessage('startReview', { requestId: reviewRequestId, repositoryPath: activeDashboardRepository, scope, kind,
      baseRevision: scope === 'changes' ? options.base : undefined, targetRevision: options.target,
      baseLabel: scope === 'changes' && options.base ? options.baseLabel || shortRevision(options.base) : undefined,
      targetLabel: options.target ? options.targetLabel || shortRevision(options.target) : undefined, modelId: selectedSummaryModelId || undefined });
  }

  // A review runs in the background: the rest of the dashboard stays usable (other repositories,
  // folders, tabs and commits). Only starting a second review waits, since it would replace this one.
  function currentWorkspaceFolder() {
    const select = document.getElementById('workspaceFolderSelect');
    return select ? select.value : '';
  }

  // Whether the dashboard currently shows the repository the review is about.
  function reviewIsForActiveRepository() {
    return Boolean(reviewState && reviewState.folder === currentWorkspaceFolder() && reviewState.repositoryPath === activeDashboardRepository);
  }

  function reviewProgressPercent() {
    const detail = reviewState && reviewState.detail;
    if (!detail) return 0;
    if (detail.phase === 'finishing') return 100;
    if (detail.filesTotal) return Math.round((100 * detail.filesDone) / detail.filesTotal);
    return detail.units ? Math.round((100 * Math.max(0, detail.unit - 1)) / detail.units) : 0;
  }

  function reviewLocked() {
    return Boolean(reviewState && reviewState.status === 'running');
  }

  const REVIEW_LOCK_HINT = 'A review is running. Wait for it, or cancel it to start another.';

  function applyReviewLock() {
    const locked = reviewLocked();
    if (document.body && document.body.classList) document.body.classList.toggle('review-running', locked);
    const lockable = '[data-action="reviewRelease"], [data-action="reviewSelection"], ' +
      '#historyContextMenu [data-action="contextReviewCommit"], #historyContextMenu [data-action="contextReviewSnapshot"]';
    document.querySelectorAll(lockable).forEach(element => {
      if (locked) {
        element.setAttribute('aria-disabled', 'true');
        if (!element.dataset.unlockedTitle) element.dataset.unlockedTitle = element.getAttribute('title') || '';
        element.setAttribute('title', REVIEW_LOCK_HINT);
      } else if (element.getAttribute('aria-disabled') === 'true') {
        element.removeAttribute('aria-disabled');
        const title = element.dataset.unlockedTitle;
        delete element.dataset.unlockedTitle;
        if (title) element.setAttribute('title', title); else element.removeAttribute('title');
      }
    });
  }

  function applyReviewExpanded() {
    if (document.body && document.body.classList) document.body.classList.toggle('review-expanded', reviewExpanded);
    const button = document.getElementById('expandReviewButton');
    if (button) {
      button.setAttribute('aria-pressed', String(reviewExpanded));
      button.textContent = reviewExpanded ? 'Collapse' : 'Expand';
      button.title = reviewExpanded ? 'Show the history again' : 'Give the review the whole dashboard';
    }
  }

  function showDetailTab(tab) {
    const review = tab === 'review';
    // On the Review tab the commit header and its summary toolbar make room for the review.
    if (document.body && document.body.classList) document.body.classList.toggle('review-tab', review);
    applyReviewExpanded();
    const panel = document.getElementById('reviewPanel');
    const content = document.getElementById('commitContent');
    if (panel) panel.hidden = !review;
    if (content) content.hidden = review;
    document.querySelectorAll('#detailTabs [role="tab"]').forEach(button => {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    });
  }

  const REVIEW_PHASES = { planning: 'Planning', analyzing: 'Analyzing', verifying: 'Checking candidate findings', finishing: 'Collecting results' };
  let reviewClock = null;

  function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function stopReviewClock() {
    if (reviewClock) clearInterval(reviewClock);
    reviewClock = null;
  }

  // Progress while a review runs: overall bar, where it is, and every component with its state.
  function renderReviewProgress(body) {
    const detail = reviewState.detail;
    const components = reviewState.components || [];
    const list = body.querySelector('.review-steps');
    const scrollTop = list ? list.scrollTop : 0;
    const finishing = detail && detail.phase === 'finishing';
    const percent = reviewProgressPercent();
    const phase = detail ? REVIEW_PHASES[detail.phase] || 'Reviewing' : 'Waiting';
    const where = detail && detail.unit && !finishing
      ? `Component ${detail.unit} of ${detail.units}: <code>${escapeHtml(detail.component || '')}</code> · ${escapeHtml(phase)}`
      : escapeHtml(detail ? phase : reviewState.progress || 'Starting…');
    const counts = detail
      ? `${detail.filesDone} of ${detail.filesTotal} files · ${detail.candidates} candidate finding${detail.candidates === 1 ? '' : 's'} · <span id="reviewElapsed"></span>`
      : '';
    const steps = components.map((component, index) => {
      const state = finishing || (detail && index + 1 < detail.unit) ? 'done' : detail && index + 1 === detail.unit ? 'current' : 'pending';
      const mark = { done: '✓', current: '●', pending: '○' }[state];
      return `<li class="review-step review-step-${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="review-step-mark" aria-hidden="true">${mark}</span><code>${escapeHtml(component.component)}</code><span>${component.files} file${component.files === 1 ? '' : 's'}</span></li>`;
    }).join('');
    body.innerHTML = `<div class="review-progress-block">
        <div class="review-progress-where">${where}</div>
        <div class="review-progress" role="progressbar" aria-label="Review progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="review-progress-fill"></span></div>
        <div class="review-progress-counts">${counts}</div>
        <div class="review-progress-message" aria-live="polite">${escapeHtml(reviewState.progress || '')}</div>
      </div>
      ${steps ? `<ol class="review-steps">${steps}</ol>` : ''}
      <p class="review-lock-note">The review keeps running while you use the rest of the dashboard; its progress shows on the Review tab.</p>`;
    body.querySelector('.review-progress-fill').style.width = `${percent}%`;
    const newList = body.querySelector('.review-steps');
    if (newList) {
      newList.scrollTop = scrollTop;
      const current = newList.querySelector('[aria-current="step"]');
      if (current && (current.offsetTop < newList.scrollTop || current.offsetTop > newList.scrollTop + newList.clientHeight - 24)) {
        newList.scrollTop = current.offsetTop - newList.clientHeight / 2;
      }
    }
    const tick = () => {
      const elapsed = document.getElementById('reviewElapsed');
      if (elapsed && reviewState && reviewState.startedAt) elapsed.textContent = `${formatElapsed(Date.now() - reviewState.startedAt)} elapsed`;
    };
    tick();
    if (!reviewClock) reviewClock = setInterval(tick, 1000);
  }

  function reviewEvidenceButton(evidence, findingIndex, evidenceIndex) {
    const lines = evidence.startLine === evidence.endLine ? `${evidence.startLine}` : `${evidence.startLine}-${evidence.endLine}`;
    return `<button type="button" class="review-evidence" data-action="reviewEvidence" data-finding="${findingIndex}" data-evidence="${evidenceIndex}" title="${escapeHtml(`${evidence.side} ${shortRevision(evidence.revision)}`)}">${escapeHtml(`${evidence.path}:${lines}`)}</button>`;
  }

  // Auto-fix: one button in the triage summary, and the proposal (or its outcome) below it.
  function renderFixAction(readiness) {
    const count = readiness.toFix || 0;
    const busy = reviewState.fix && reviewState.fix.status === 'running';
    const title = count ? 'Copilot proposes edits for the findings marked Needs fix; you see the diff before anything is written'
      : 'Mark findings "Needs fix" first';
    return `<button type="button" class="btn review-fix-action" data-action="proposeReviewFix" title="${title}"${count && !busy ? '' : ' disabled'}>Fix ${count || ''} with Copilot…</button>`;
  }

  const FIX_STEPS = [
    ['checking', 'Check the cited files'],
    ['sending', 'Send findings and files to Copilot'],
    ['receiving', 'Receive the proposed edits'],
    ['validating', 'Check the edits against the files']
  ];

  function formatSize(characters) {
    return characters >= 1024 ? `${(characters / 1024).toFixed(1)} KB` : `${characters} B`;
  }

  // Auto-fix progress: each step with its state, what was sent, how much has arrived, elapsed time.
  function renderFixProgress(fix) {
    const detail = fix.detail || { step: 'checking' };
    const current = FIX_STEPS.findIndex(([step]) => step === detail.step);
    const extra = {
      sending: detail.files ? `${detail.findings} finding${detail.findings === 1 ? '' : 's'}, ${detail.files} file${detail.files === 1 ? '' : 's'} · ${formatSize(detail.sentCharacters || 0)}` : '',
      receiving: detail.receivedCharacters ? `${formatSize(detail.receivedCharacters)} so far` : current === 1 ? 'waiting for Copilot' : ''
    };
    const steps = FIX_STEPS.map(([step, label], index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'pending';
      const mark = { done: '✓', current: '●', pending: '○' }[state];
      const note = extra[step] && (state !== 'pending' || step === 'receiving' && current === 1) ? `<span>${escapeHtml(extra[step])}</span>` : '';
      return `<li class="review-step review-step-${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="review-step-mark" aria-hidden="true">${mark}</span><span>${escapeHtml(label)}</span>${note}</li>`;
    }).join('');
    return `<section class="review-fix review-fix-running"><h4>Auto-fix · <span id="reviewFixElapsed"></span></h4>
      <p aria-live="polite">${escapeHtml(fix.message || 'Asking Copilot for a fix…')}</p>
      <ol class="review-steps review-fix-steps">${steps}</ol>
      <button type="button" class="btn" data-action="cancelReviewFix">Cancel</button></section>`;
  }

  let fixClock = null;
  // Ticks the auto-fix elapsed time while a proposal is running; stops itself otherwise.
  function tickFixClock() {
    const fix = reviewState && reviewState.fix;
    const elapsed = document.getElementById('reviewFixElapsed');
    if (!fix || fix.status !== 'running' || !elapsed) { if (fixClock) clearInterval(fixClock); fixClock = null; return; }
    elapsed.textContent = `${formatElapsed(Date.now() - (fix.startedAt || Date.now()))} elapsed`;
    if (!fixClock) fixClock = setInterval(tickFixClock, 1000);
  }

  function renderFixPanel() {
    const fix = reviewState.fix;
    if (!fix) return '';
    if (fix.status === 'running') return renderFixProgress(fix);
    if (fix.status === 'applied') {
      return `<section class="review-fix review-fix-applied" role="status"><h4>Auto-fix applied</h4><p>Changed ${fix.paths.map(item => `<code>${escapeHtml(item)}</code>`).join(', ')} in your working tree. Nothing was staged or committed: check the changes, run your tests, then commit.</p></section>`;
    }
    const error = fix.message ? `<div class="dashboard-error" role="alert">${escapeHtml(fix.message)}</div>` : '';
    if (!fix.files) return `<section class="review-fix"><h4>Auto-fix</h4>${error}</section>`;
    const list = (items, className) => items && items.length ? `<ul class="${className}">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
    const selected = fix.selected || new Set();
    const count = fix.files.filter(file => selected.has(file.path)).length;
    const applied = (fix.applied || []).length
      ? `<p class="review-fix-applied-note" role="status">Applied to ${fix.applied.map(item => `<code>${escapeHtml(item)}</code>`).join(', ')}. The files below are still only proposed.</p>` : '';
    const findingText = file => {
      const titles = (file.findingIds || []).map(id => (reviewState.result.findings || []).find(finding => finding.id === id))
        .filter(Boolean).map(finding => `${finding.severity} ${finding.category}`);
      return titles.length ? `<span class="review-fix-fixes">fixes ${escapeHtml(titles.join(', '))}</span>` : '';
    };
    return `<section class="review-fix"><h4>Proposed fix · ${fix.files.length} file${fix.files.length === 1 ? '' : 's'}</h4>
      ${error}${applied}
      <p class="review-fix-note">Nothing is written until you apply it. Applying edits your working tree only; it does not stage or commit. Untick a file to leave it out.</p>
      ${list(fix.notes, 'review-gaps')}${list(fix.rejected, 'review-gaps review-fix-rejected')}
      ${fix.files.map(file => `<details class="review-fix-file" open><summary><input type="checkbox" class="review-fix-select" data-path="${escapeHtml(file.path)}" aria-label="Apply ${escapeHtml(file.path)}"${selected.has(file.path) ? ' checked' : ''}> <code>${escapeHtml(file.path)}</code>${findingText(file)}</summary><pre class="diff-viewer">${renderPatchLines(file.patch)}</pre></details>`).join('')}
      <div class="review-fix-buttons"><button type="button" class="btn btn-primary" data-action="applyReviewFix" data-selection="all">Apply all</button><button type="button" class="btn" data-action="applyReviewFix" data-selection="selected"${count && count < fix.files.length ? '' : ' disabled'}>Apply selected (${count})</button><button type="button" class="btn" data-action="discardReviewFix">Discard</button></div>
    </section>`;
  }

  const DISMISS_REASONS = { false_positive: 'False positive', accepted_risk: 'Accepted risk', not_applicable: 'Not applicable' };

  // Needs fix / Dismiss for one finding; pressing the active choice again clears it.
  function renderTriageControls(finding) {
    const triage = (reviewState.triage || {})[finding.id];
    const decision = triage ? triage.decision : '';
    const id = escapeHtml(finding.id);
    const reason = decision === 'dismiss'
      ? `<select class="review-dismiss-reason" data-finding-id="${id}" aria-label="Why it is dismissed">${Object.entries(DISMISS_REASONS)
        .map(([value, label]) => `<option value="${value}"${triage.reason === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`
      : '';
    return `<div class="review-triage" role="group" aria-label="Triage this finding">
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="fix" aria-pressed="${decision === 'fix'}">Needs fix</button>
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="dismiss" aria-pressed="${decision === 'dismiss'}">Dismiss</button>${reason}
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="fixed" aria-pressed="${decision === 'fixed'}" title="Fixed by an applied auto-fix, or mark it fixed by hand">Fixed</button>
    </div>`;
  }

  function renderReviewFinding(finding, index) {
    const rule = finding.ruleId ? ` <code>${escapeHtml(finding.ruleId)}</code>` : '';
    const triage = (reviewState.triage || {})[finding.id];
    const triageClass = triage ? ` triage-${triage.decision}` : '';
    return `<li class="review-finding severity-${escapeHtml(finding.severity)}${triageClass}" data-finding-id="${escapeHtml(finding.id)}">
      <div class="review-finding-head"><span class="review-severity">${escapeHtml(finding.severity)}</span><span>${escapeHtml(finding.category)}${rule}</span><span class="review-badge review-badge-${escapeHtml(finding.status)}" title="${finding.status === 'verified' ? 'Evidence passed mechanical checks and a second AI assessment supported it' : 'Not confirmed by the second AI assessment'}">${escapeHtml(finding.status)}</span><span class="review-confidence">confidence ${escapeHtml(finding.confidence)}</span></div>
      <p>${escapeHtml(finding.explanation)}</p>
      <dl><dt>Impact</dt><dd>${escapeHtml(finding.impact)}</dd><dt>Suggested action</dt><dd>${escapeHtml(finding.suggestedAction)}</dd></dl>
      <div class="review-evidence-list">${finding.evidence.map((evidence, evidenceIndex) => reviewEvidenceButton(evidence, index, evidenceIndex)).join('')}</div>
      ${renderTriageControls(finding)}
    </li>`;
  }

  function renderReviewItems(items, findings) {
    if (!items.length) return '<p class="review-none">None.</p>';
    return `<ul class="review-list">${items.map(item => {
      const index = item.findingId ? findings.findIndex(finding => finding.id === item.findingId) : -1;
      return index >= 0
        ? renderReviewFinding(findings[index], index)
        : `<li class="review-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`;
    }).join('')}</ul>`;
  }

  function requestReviewHistory() {
    if (!activeDashboardRepository) return;
    postMessage('listReviewHistory', { repositoryPath: activeDashboardRepository, listId: ++reviewHistoryListId });
  }

  function activeReviewHistory() {
    return reviewHistory.repositoryPath === activeDashboardRepository ? reviewHistory.entries : [];
  }

  // The exact commits a review read: a label like a branch name moves on, these do not.
  function reviewedCommits(scope, baseSha, targetSha) {
    if (!targetSha) return '';
    return scope === 'changes' && baseSha ? `${shortRevision(baseSha)} → ${shortRevision(targetSha)}` : shortRevision(targetSha);
  }

  const READINESS_LABELS = { blocked: 'Blocked', needs_attention: 'Needs attention', no_blocking_findings: 'No blocking findings' };

  // Past reviews of the active repository, newest first; the open one is marked.
  function renderReviewHistory(hasOpenReview) {
    const container = document.getElementById('reviewHistory');
    const list = document.getElementById('reviewHistoryList');
    if (!container || !list) return;
    const entries = activeReviewHistory();
    container.hidden = entries.length === 0;
    if (!entries.length) { list.innerHTML = ''; return; }
    // With nothing open the list is all there is to see, so it starts expanded.
    if (!hasOpenReview && !container.dataset.touched) container.open = true;
    document.getElementById('reviewHistoryCount').textContent = String(entries.length);
    const locked = reviewLocked();
    list.innerHTML = entries.map(entry => {
      const range = entry.scope === 'changes'
        ? `Diff: ${entry.baseLabel || 'parent'} → ${entry.targetLabel}` : `Branch: ${entry.targetLabel}`;
      const counts = [`${entry.findings} finding${entry.findings === 1 ? '' : 's'}`,
        entry.toFix ? `${entry.toFix} to fix` : '', entry.fixed ? `${entry.fixed} fixed` : '', entry.dismissed ? `${entry.dismissed} dismissed` : ''].filter(Boolean).join(' · ');
      const current = reviewState && reviewState.historyId === entry.id;
      const id = escapeHtml(entry.id);
      return `<li class="review-history-item"${current ? ' aria-current="true"' : ''}>
        <button type="button" class="review-history-open" data-action="openStoredReview" data-history-id="${id}"${locked ? ` aria-disabled="true" title="${REVIEW_LOCK_HINT}"` : ` title="Open this review (${escapeHtml(shortRevision(entry.targetSha))})"`}>
          <span class="review-history-date">${escapeHtml(formatHistoryDate(entry.generatedAt))}</span>
          <span class="review-history-range">${entry.kind === 'release' ? '◈ ' : ''}${escapeHtml(range)}</span>
          <code class="review-history-commit" title="Reviewed commit${entry.scope === 'changes' && entry.baseSha ? 's' : ''}">${escapeHtml(reviewedCommits(entry.scope, entry.baseSha, entry.targetSha))}</code>
          <span class="review-history-status readiness-${escapeHtml(entry.status)}">${escapeHtml(READINESS_LABELS[entry.status] || entry.status)}</span>
          <span class="review-history-counts">${escapeHtml(counts)}</span>
        </button>
        <button type="button" class="review-history-delete" data-action="deleteStoredReview" data-history-id="${id}" aria-label="Delete this saved review" title="Delete this saved review">×</button>
      </li>`;
    }).join('');
  }

  function renderReviewPanel() {
    const tabs = document.getElementById('detailTabs');
    const badge = document.getElementById('reviewTabBadge');
    const title = document.getElementById('reviewTitle');
    const meta = document.getElementById('reviewMeta');
    const status = document.getElementById('reviewStatus');
    const body = document.getElementById('reviewBody');
    if (!tabs || !body) return;
    const hasHistory = activeReviewHistory().length > 0;
    tabs.hidden = !reviewState && !hasHistory;
    renderReviewHistory(Boolean(reviewState));
    if (!reviewState) {
      applyReviewLock();
      if (!hasHistory) { showDetailTab('changes'); return; }
      ['cancelReviewButton', 'copyReviewButton', 'saveReviewButton'].forEach(id => { document.getElementById(id).hidden = true; });
      if (badge) badge.textContent = '';
      title.textContent = 'Review';
      meta.textContent = '';
      status.textContent = '';
      body.innerHTML = '<div class="dashboard-empty">No review is open. Open a past review, or start one from Release or a comparison.</div>';
      return;
    }
    const running = reviewState.status === 'running';
    const done = reviewState.status === 'completed';
    applyReviewLock();
    document.getElementById('cancelReviewButton').hidden = !running;
    document.getElementById('copyReviewButton').hidden = !done;
    document.getElementById('saveReviewButton').hidden = !done;
    // A release review's ends are unknown until the extension has resolved them.
    const release = reviewState.kind === 'release';
    const target = reviewState.targetLabel || (release ? 'current branch' : '');
    const label = reviewState.scope === 'changes'
      ? `Diff: ${reviewState.baseLabel || (release ? 'latest release' : 'parent')} → ${target}`
      : `Branch: ${target}`;
    title.textContent = reviewState.kind === 'release' ? 'Current branch review' : 'Review';
    // Name the repository when the dashboard has moved on to another one (or another folder).
    const request = reviewState.result && reviewState.result.request;
    // The exact commits, unless the label already is them (a Base/Target selection of plain commits).
    const shas = request ? reviewedCommits(request.scope, request.baseSha, request.targetSha) : '';
    const commits = shas && !label.includes(shas) ? ` · ${request.baseSha ? '' : 'commit '}${shas}` : '';
    meta.textContent = `${label}${commits}${reviewIsForActiveRepository() ? '' : ` · ${reviewState.repositoryName || reviewState.repositoryPath}`}`;
    if (running) {
      // Visible from the Changes tab too, so progress can be followed while working elsewhere.
      if (badge) badge.textContent = reviewState.detail ? `${reviewProgressPercent()}%` : '…';
      // Before the engine reports (e.g. waiting for consent) the header says what it waits for.
      status.textContent = reviewState.detail ? '' : reviewState.progress || 'Starting…';
      renderReviewProgress(body);
      return;
    }
    stopReviewClock();
    if (!done) {
      if (badge) badge.textContent = '';
      status.textContent = '';
      body.innerHTML = `<div class="${reviewState.cancelled ? 'dashboard-empty' : 'dashboard-error'}">${escapeHtml(reviewState.message || 'Review failed.')}</div>`;
      return;
    }
    const { result, readiness } = reviewState;
    const findings = result.findings || [];
    if (badge) badge.textContent = readiness.blocking.length ? String(readiness.blocking.length) : '';
    status.textContent = result.modelId ? `Model ${result.modelId}` : '';
    // Findings and review gaps are counted apart ("5 items" hid that 2 of them were not findings),
    // in a blocked result too.
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    const findingAndGapCounts = [readiness.attention.length
      ? plural(readiness.attention.length, readiness.status === 'blocked' ? 'other finding' : 'finding') : '',
      (readiness.gaps || []).length ? plural(readiness.gaps.length, 'review gap') : ''].filter(Boolean);
    const banner = {
      blocked: `Blocked: ${[`${readiness.blocking.length} blocking item${readiness.blocking.length === 1 ? '' : 's'}`, ...findingAndGapCounts].join(' · ')}`,
      needs_attention: `Needs attention: ${findingAndGapCounts.join(' · ')}`,
      no_blocking_findings: 'No blocking findings in what was reviewed'
    }[readiness.status];
    const coverage = result.coverage;
    const gaps = coverage.skipped.map(item => ['skipped', item]).concat(coverage.failed.map(item => ['failed', item]));
    const policy = (result.policyResults || []).length
      ? `<section><h4>Policy</h4><table class="review-policy"><thead><tr><th>Rule</th><th>Result</th><th>Reason</th></tr></thead><tbody>${result.policyResults.map(item =>
        `<tr class="policy-${escapeHtml(item.status)}"><td><code>${escapeHtml(item.ruleId)}</code></td><td>${escapeHtml(item.status.replace(/_/g, ' '))}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table></section>`
      : '';
    const triageBar = findings.length
      ? `<div class="review-triage-summary" role="status"><span><strong>${readiness.toFix || 0}</strong> to fix</span><span><strong>${(readiness.fixed || []).length}</strong> fixed</span><span><strong>${(readiness.dismissed || []).length}</strong> dismissed</span><span><strong>${readiness.untriaged || 0}</strong> not triaged</span>${renderFixAction(readiness)}</div>`
      : '';
    body.innerHTML = `<div class="review-readiness readiness-${escapeHtml(readiness.status)}" role="status"><strong>${escapeHtml(banner)}</strong></div>
      ${triageBar}
      ${renderFixPanel()}
      <section class="review-blocking"><h4>Blocking</h4>${renderReviewItems(readiness.blocking, findings)}</section>
      <section class="review-attention"><h4>Needs attention</h4>${renderReviewItems(readiness.attention, findings)}</section>
      ${(readiness.gaps || []).length ? `<section class="review-gaps-section"><h4>Review gaps</h4><p class="review-gaps-note">What this review could not establish. Not findings, but not passes either.</p>${renderReviewItems(readiness.gaps, findings)}</section>` : ''}
      ${(readiness.fixed || []).length ? `<section class="review-fixed"><h4>Fixed</h4>${renderReviewItems(readiness.fixed, findings)}</section>` : ''}
      ${(readiness.dismissed || []).length ? `<section class="review-dismissed"><h4>Dismissed by you</h4>${renderReviewItems(readiness.dismissed, findings)}</section>` : ''}
      ${policy}
      <section><h4>Coverage</h4><p>Analyzed ${coverage.analyzed} of ${coverage.surveyed} files · ${coverage.skipped.length} skipped · ${coverage.failed.length} failed checks · ${coverage.complete ? 'complete' : 'incomplete'}</p>${gaps.length
        ? `<details><summary>Skipped and failed</summary><ul class="review-gaps">${gaps.slice(0, 200).map(([kind, item]) => `<li>${kind}: <code>${escapeHtml(item.path)}</code> — ${escapeHtml(item.reason)}</li>`).join('')}</ul></details>` : ''}</section>
      ${(result.limitations || []).length ? `<section><h4>Limitations</h4><ul class="review-gaps">${result.limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}
      <p class="review-advisory">Advisory: verified findings passed mechanical evidence checks and a second AI assessment. No findings does not mean no vulnerabilities.</p>`;
    tickFixClock();
  }

  // Show the cited line in the dashboard diff when the review compared two commits of the
  // active repository; otherwise open the file at the reviewed revision in an editor.
  function jumpToReviewEvidence(findingIndex, evidenceIndex) {
    if (!reviewState || !reviewState.result) return;
    const finding = reviewState.result.findings[findingIndex];
    const evidence = finding && finding.evidence[evidenceIndex];
    if (!evidence) return;
    const request = reviewState.result.request;
    if (request.scope === 'changes' && request.baseSha && reviewIsForActiveRepository()) {
      pendingEvidenceJump = { path: evidence.path, side: evidence.side, line: evidence.startLine };
      showDetailTab('changes');
      commitCompareSelection = [];
      updateCommitCompareUI();
      loadComparison(request.baseSha, request.targetSha, 'review');
      return;
    }
    postMessage('openReviewEvidence', { requestId: reviewState.requestId, repositoryPath: reviewState.repositoryPath, revision: evidence.revision, path: evidence.path, line: evidence.startLine });
  }

  function highlightEvidenceLine() {
    if (!pendingEvidenceJump) return;
    const column = pendingEvidenceJump.side === 'base' ? 0 : 1;
    const row = Array.from(document.querySelectorAll('#dashboardDiff .diff-line')).find(line => {
      const number = line.querySelectorAll('.diff-ln')[column];
      return number && number.textContent === String(pendingEvidenceJump.line);
    });
    pendingEvidenceJump = null;
    if (!row) return;
    document.querySelectorAll('#dashboardDiff .diff-line-highlight').forEach(line => line.classList.remove('diff-line-highlight'));
    row.classList.add('diff-line-highlight');
    row.scrollIntoView({ block: 'center' });
  }

  // Dialog behaviour for every .modal-overlay: move focus in when it opens, keep Tab inside,
  // close on Escape through the dialog's own close button, and return focus when it closes.
  const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const dialogReturnFocus = new Map();

  function focusableIn(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE))
      .filter(element => !element.disabled && element.getClientRects().length > 0);
  }

  function topOpenDialog() {
    const open = Array.from(document.querySelectorAll('.modal-overlay.active'));
    return open.length ? open[open.length - 1] : null;
  }

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    new MutationObserver(() => {
      const isOpen = overlay.classList.contains('active');
      if (isOpen && !dialogReturnFocus.has(overlay)) {
        dialogReturnFocus.set(overlay, document.activeElement);
        // Wait a frame so fields shown while opening (e.g. by prefix rules) are focusable.
        requestAnimationFrame(() => {
          if (!overlay.classList.contains('active') || overlay.contains(document.activeElement)) return;
          const preferred = overlay.querySelector('[data-initial-focus]');
          const target = preferred && preferred.getClientRects().length
            ? preferred
            : focusableIn(overlay).find(element => !element.classList.contains('modal-close'));
          if (target) target.focus();
        });
      } else if (!isOpen && dialogReturnFocus.has(overlay)) {
        const opener = dialogReturnFocus.get(overlay);
        dialogReturnFocus.delete(overlay);
        if (opener && opener.isConnected && typeof opener.focus === 'function' && !topOpenDialog()) opener.focus();
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('keydown', function (event) {
    const dialog = topOpenDialog();
    if (!dialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // An open dropdown inside the dialog closes first.
      const dropdown = dialog.querySelector('.branch-dropdown.open');
      if (dropdown) {
        dropdown.classList.remove('open');
        return;
      }
      const close = dialog.querySelector('.modal-close');
      if (close) close.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableIn(dialog);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Initialize UI on load
  setupHistoryColumnResizers();
  setupDashboardSplitters();
  if (repositoryData.length > 0) {
    if (!getRepository(activeDashboardRepository)) activeDashboardRepository = repositoryData[0].path;
    activateDashboardRepository(activeDashboardRepository);
  }
  renderRepositorySwitcher();
})();
