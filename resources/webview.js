// Webview script for Repository Manager
// This file is loaded as an external script by the webview panel.
// Initial repository data is provided via window.__initialRepositories (set by inline script).

(function () {
  const vscode = acquireVsCodeApi();

  // Restore state from previous session
  const previousState = vscode.getState() || {};
  let selectedRepositories = new Set(previousState.selectedRepositories || previousState.selectedSubmodules || []);
  let rebasingRepositories = new Set(previousState.rebasingRepositories || previousState.rebasingSubmodules || []);
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
  let pendingBranchCheckout = null;
  let pendingHistoryViewport = null;
  let historyPanelHeight = Number(previousState.historyPanelHeight) || 0;
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
  let previewedWorkingTreeFile = null;
  let workingTreePreviewMode = 'unstaged';
  let workingTreePreviewRequestId = 0;
  let changeSummaryRequestId = 0;
  let changeSummarySelection = null;
  let selectedSummaryModelId = '';
  const changeSummaries = new Map();
  let activeChangeSummaryKey = null;
  let historyContextTarget = null;
  let branchFromCommitTarget = null;

  function hideHistoryContextMenu() {
    document.getElementById('historyContextMenu').hidden = true;
  }

  function showHistoryContextMenu(element, x, y) {
    const commit = loadedHistoryCommits.find(item => item.hash === element.dataset.commit);
    if (!commit) return false;
    historyContextTarget = { repositoryPath: activeDashboardRepository, hash: commit.hash };
    const menu = document.getElementById('historyContextMenu');
    menu.hidden = false;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(0, Math.min(x, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, height - menu.offsetHeight - 8))}px`;
    menu.querySelector('button').focus();
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
      selectedRepositories: Array.from(selectedRepositories),
      rebasingRepositories: Array.from(rebasingRepositories),
      repositoryData,
      activeDashboardRepository,
      selectedDashboardCommit,
      commitCompareSelection,
      comparisonRepository,
      dashboardHistoryState,
      historyPanelHeight,
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
    if (message) button.title = message;
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
    loadSummaryModels: () => {
      const button = document.getElementById('loadSummaryModelsButton');
      button.disabled = true;
      button.textContent = 'Loading models…';
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
    initAll: () => postMessage('initSubmodules'),
    updateAll: () => postMessage('updateSubmodules'),

    pullActiveRepository: () => runToolbarOperation('pull', 'pullChanges'),
    pushActiveRepository: () => runToolbarOperation('push', 'pushChanges'),
    fetchActiveRepository: () => runToolbarOperation('fetch', 'fetchUpdates'),
    openActiveRepository: () => postMessage('openSubmodule', { submodule: activeDashboardRepository }),

    loadMoreHistory: () => {
      if (historyNextOffset !== null) requestDashboardHistory(historyNextOffset, true);
    },

    selectHistoryCommit: (el) => {
      const commitHash = el.dataset.commit;
      if (!commitHash) return;
      clearCommitComparison(false);
      loadParentCommitDetail(commitHash);
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

    selectDashboardBranch: (el) => {
      requestBranchCheckout(el.dataset.branch);
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
      loadComparison(base.value, target.value, 'branches');
    },

    clearCommitComparison: () => clearCommitComparison(true),

    toggleCommitCompareNode: (el) => toggleCommitCompareNode(el.dataset.commit),

    checkoutDashboardBranch: (el) => {
      requestBranchCheckout(el.dataset.branch, el);
    },

    selectAll: () => {
      document.querySelectorAll('.repository-card').forEach(row => {
        selectedRepositories.add(row.dataset.path);
        const cb = row.querySelector('.row-checkbox');
        if (cb) cb.checked = true;
        row.classList.add('selected');
      });
      saveState();
      updateSelectionUI();
    },

    deselectAll: () => {
      selectedRepositories.clear();
      document.querySelectorAll('.repository-card').forEach(row => {
        const cb = row.querySelector('.row-checkbox');
        if (cb) cb.checked = false;
        row.classList.remove('selected');
      });
      saveState();
      updateSelectionUI();
    },

    toggleSelection: (el) => {
      const path = el.dataset.repository;
      if (!path) return;

      // Toggle selection state
      if (selectedRepositories.has(path)) {
        selectedRepositories.delete(path);
      } else {
        selectedRepositories.add(path);
      }

      // Update checkbox state directly
      const checkbox = el.tagName === 'INPUT' ? el : el.querySelector('.row-checkbox');
      if (checkbox) {
        checkbox.checked = selectedRepositories.has(path);
      }

      // Update the row's selected class
      const row = el.closest('.repository-card');
      if (row) {
        row.classList.toggle('selected', selectedRepositories.has(path));
      }

      saveState();
      updateSelectionUI();
    },

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
      if (message) message.value = '';
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
        if (fromCommit) cb.checked = cb.value === fromCommit.repositoryPath;
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

    createBranchForSelected: () => {
      if (selectedRepositories.size === 0) return;
      restoreBranchModalControls();
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
      }
      const baseBranchList = document.getElementById('baseBranchList');
      if (baseBranchList) {
        baseBranchList.innerHTML = '';
      }
      const baseBranchDropdown = document.getElementById('baseBranchDropdown');
      if (baseBranchDropdown) {
        baseBranchDropdown.classList.remove('open');
      }
      // Request branches
      postMessage('getBaseBranchesForCreate', {});
      // Apply the repository selection to the branch workflow.
      document.querySelectorAll('.branch-repository').forEach(cb => {
        cb.checked = selectedRepositories.has(cb.value);
      });
      document.getElementById('createBranchModal').classList.add('active');
      // Retry if branches haven't loaded after 2s
      retryLoadBaseBranches(3);
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

    openCheckoutModal: (el) => {
      const repository = el.dataset.repository;
      document.getElementById('checkoutRepository').value = repository;
      document.getElementById('branchSelect').innerHTML = '<option value="">Loading branches...</option>';
      document.getElementById('checkoutModal').classList.add('active');
      postMessage('getBranches', { submodule: repository });
    },

    checkoutBranch: () => {
      const repository = document.getElementById('checkoutRepository').value;
      const branch = document.getElementById('branchSelect').value;
      if (!branch) return;
      postMessage('checkoutBranch', { submodule: repository, branch });
      document.getElementById('checkoutModal').classList.remove('active');
    },

    openCommitModal: (el) => {
      const repository = el.dataset.repository;
      document.getElementById('commitRepository').value = repository;
      document.getElementById('commitSelect').innerHTML = '<option value="">Loading commits...</option>';
      document.getElementById('commitInput').value = '';
      document.getElementById('commitModal').classList.add('active');
      postMessage('getCommits', { submodule: repository });
      postMessage('getRecordedCommit', { submodule: repository });
    },

    checkoutCommit: () => {
      const repository = document.getElementById('commitRepository').value;
      const commitInput = document.getElementById('commitInput').value.trim();
      const commitSelect = document.getElementById('commitSelect').value;
      const commit = commitInput || commitSelect;
      if (!commit) return;
      postMessage('checkoutCommit', { submodule: repository, commit });
      document.getElementById('commitModal').classList.remove('active');
    },

    useRecorded: () => {
      const repository = document.getElementById('commitRepository').value;
      postMessage('updateToRecorded', { submodule: repository });
      document.getElementById('commitModal').classList.remove('active');
    },

    toggleRebaseStatus: (el) => {
      const repository = el.dataset.repository;
      const isCurrentlyRebasing = rebasingRepositories.has(repository);
      if (isCurrentlyRebasing) {
        rebasingRepositories.delete(repository);
      } else {
        rebasingRepositories.add(repository);
      }
      saveState();
      postMessage('setRebaseStatus', { submodule: repository, isRebasing: !isCurrentlyRebasing });
      updateRebaseUI();
    },

    pullChanges: (el) => postMessage('pullChanges', { submodule: el.dataset.repository }),
    pushChanges: (el) => postMessage('pushChanges', { submodule: el.dataset.repository }),
    createPR: (el) => postMessage('createPR', { submodule: el.dataset.repository }),
    openRepository: (el) => postMessage('openSubmodule', { submodule: el.dataset.repository }),
    stageSubmodule: (el) => postMessage('stageSubmodule', { submodule: el.dataset.repository }),
    syncSelected: () => postMessage('syncVersions', { submodules: Array.from(selectedRepositories) }),
    syncAll: () => postMessage('syncVersions', { submodules: [] }),

    toggleBranches: (el) => {
      const repository = el.dataset.repository;
      const panelId = 'branches-' + repository.replace(/[\\/.]/g, '-');
      const panel = document.getElementById(panelId);
      if (!panel) return;

      const card = panel.closest('.repository-card');
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        panel.innerHTML = '<div class="branches-loading">Loading branches...</div>';
        if (card) card.classList.add('branches-open');
        postMessage('getBranches', { submodule: repository });
      } else {
        panel.style.display = 'none';
        if (card) card.classList.remove('branches-open');
      }
    },

    checkoutBranchInline: (el) => {
      const repository = el.dataset.repository;
      const branch = el.dataset.branch;
      if (repository && branch) {
        // Optimistic UI: immediately highlight the selected branch
        const panelId = 'branches-' + repository.replace(/[\\/.]/g, '-');
        const panel = document.getElementById(panelId);
        if (panel) {
          panel.querySelectorAll('.branch-item').forEach(function (item) {
            const itemBranch = item.getAttribute('data-branch');
            if (itemBranch === branch) {
              item.classList.add('current');
              var icon = item.querySelector('.branch-icon');
              if (icon) icon.textContent = '\u2713';
              // Remove delete button from the now-current branch
              var del = item.querySelector('.branch-delete');
              if (del) del.remove();
            } else {
              item.classList.remove('current');
              var icon2 = item.querySelector('.branch-icon');
              if (icon2 && icon2.textContent === '\u2713') {
                icon2.textContent = item.classList.contains('remote') ? '\u2601' : '\u238B';
              }
              // Restore delete button for branches that were previously current
              if (!item.querySelector('.branch-delete')) {
                var delBtn = document.createElement('span');
                delBtn.className = 'branch-delete';
                delBtn.setAttribute('data-action', 'deleteBranchInline');
                delBtn.setAttribute('data-repository', item.getAttribute('data-repository') || repository);
                delBtn.setAttribute('data-branch', itemBranch || '');
                delBtn.title = 'Delete ' + (itemBranch || '');
                delBtn.textContent = '\u2715';
                item.appendChild(delBtn);
              }
            }
          });
        }
        postMessage('checkoutBranch', { submodule: repository, branch });
      }
    },

    deleteBranchInline: (el) => {
      const repository = el.dataset.repository;
      const branch = el.dataset.branch;
      if (!repository || !branch) return;

      const deleteRemote = confirm('Also delete the remote branch?');
      // Server-side handler will show a VS Code modal confirmation before actually deleting
      postMessage('deleteBranch', { submodule: repository, branch, deleteRemote });
    }
  };

  function updateCommitSelectionCount() {
    const selected = document.querySelectorAll('.commit-change-checkbox:checked').length;
    const count = document.getElementById('commitSelectionCount');
    if (count) count.textContent = selected + ' selected';
  }

  function renderPatchLines(patch) {
    return String(patch || '').split('\n').map(line => {
      let className = 'diff-context';
      if (line.startsWith('+') && !line.startsWith('+++')) className = 'diff-addition';
      else if (line.startsWith('-') && !line.startsWith('---')) className = 'diff-deletion';
      else if (line.startsWith('@@')) className = 'diff-hunk';
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) className = 'diff-meta';
      return `<span class="${className}">${escapeHtml(line) || ' '}</span>`;
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
      ? `<span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} · select a second graph node <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`
      : `<span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} → <span class="compare-role compare-role-target">T</span> ${escapeHtml(shortRevision(commitCompareSelection[1]))} <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
  }

  function loadParentCommitDetail(commitHash) {
    if (!commitHash) return;
    resetChangeSummary();
    selectedDashboardCommit = commitHash;
    activeComparisonTarget = commitHash;
    comparisonBaseHash = null;
    comparisonSource = null;
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

  function loadComparison(baseRevision, targetRevision, source) {
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
      status.innerHTML = `${source === 'branches' ? 'Branches' : 'Commits'}: ${escapeHtml(shortRevision(baseRevision))} → ${escapeHtml(shortRevision(targetRevision))} <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
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
    repositoryRefs = { branches: [], tags: [], remotes: [], stashes: [] };
    applyDashboardFilters(repositoryPath);
    dashboardActivated = true;
    updateCommitCompareUI();
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
    if (history) history.innerHTML = '<div class="dashboard-loading">Loading history…</div>';
    clearCommitDetail();
    saveState();
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath });
    postMessage('refresh', { repositoryPath });
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
    if (!append && !preserveViewport && history) history.innerHTML = '<div class="dashboard-loading">Loading history…</div>';
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

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    const ageMs = Date.now() - date.getTime();
    if (ageMs >= 0 && ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.floor(ageMs / 60000))} min ago`;
    if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)} h ago`;
    if (ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 86400000)} d ago`;
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: '2-digit', year: 'numeric'
    }).format(date);
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
      const continuingLaneCount = Math.max(layout.before.length, layout.after.length);
      for (let lane = 0; lane < continuingLaneCount; lane += 1) {
        if (lane === layout.lane) continue;
        if (layout.before[lane] && layout.after[lane] && layout.before[lane] === layout.after[lane]) {
          const x = window.RepositoryHistoryGraph.laneX(lane);
          paths.push(`<path class="graph-edge graph-lane-${lane % 8}" d="M ${x} ${top} V ${bottom}"/>`);
        }
      }

      if (!layout.startsHere) {
        paths.push(`<path class="graph-edge graph-lane-${layout.lane % 8}" d="M ${currentX} ${top} V ${middle}"/>`);
      }
      layout.parentLanes.forEach((parentLane, parentIndex) => {
        const parentX = window.RepositoryHistoryGraph.laneX(parentLane);
        const colorLane = parentIndex === 0 ? layout.lane : parentLane;
        paths.push(`<path class="graph-edge graph-lane-${colorLane % 8}" d="M ${currentX} ${middle} C ${currentX} ${middle + 9}, ${parentX} ${bottom - 9}, ${parentX} ${bottom}"/>`);
      });

      const decorated = (commit.refs || []).length > 0 || layout.isMerge;
      nodes.push(decorated
        ? `<circle class="graph-node graph-lane-${layout.lane % 8}" cx="${currentX}" cy="${middle}" r="5.5"/><circle class="graph-node-core graph-lane-${layout.lane % 8}" cx="${currentX}" cy="${middle}" r="2.3"/>`
        : `<circle class="graph-node-core graph-lane-${layout.lane % 8}" cx="${currentX}" cy="${middle}" r="4"/>`);
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

    if (payload.offset > 0) {
      const knownHashes = new Set(loadedHistoryCommits.map(commit => commit.hash));
      loadedHistoryCommits = loadedHistoryCommits.concat((payload.commits || []).filter(commit => !knownHashes.has(commit.hash)));
    } else {
      loadedHistoryCommits = payload.commits || [];
    }
    const graphModel = window.RepositoryHistoryGraph.buildGraphModel(loadedHistoryCommits);
    loadedHistoryGraphModel = graphModel;
    historyGraphGeometrySignature = '';
    const historyRegion = history.closest('.history-region');
    historyGraphWidth = graphModel.width;
    if (historyRegion) historyRegion.style.setProperty('--graph-width', `${graphModel.width}px`);
    const rows = loadedHistoryCommits.map((commit, index) => {
      const refs = renderHistoryRefs(commit.refs, true);
      return `<div class="history-row" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}" tabindex="0">
        ${renderGraphCell()}
        <span class="history-message">${refs ? `<span class="history-refs">${refs}</span>` : ''}<button class="history-subject" type="button" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}">${escapeHtml(commit.subject)}</button></span>
        <span class="history-author" title="${escapeHtml(commit.authorEmail)}">${escapeHtml(commit.authorName)}</span>
        <span class="history-date">${escapeHtml(formatHistoryDate(commit.authoredAt))}</span>
        <code class="history-hash">${escapeHtml(commit.shortHash)}</code>
      </div>`;
    }).join('');

    const append = payload.offset > 0;
    history.innerHTML = rows
      ? `<div class="history-table-content">${renderHistoryGraph(loadedHistoryCommits, graphModel)}${rows}</div>`
      : '<div class="dashboard-empty">No commits match this view.</div>';
    applyHistoryColumnWidths(historyColumnWidths);
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
      branchList.innerHTML = branches.map(branch => {
        const useOrigin = branch.hasRemote
          ? `<button class="sidebar-ref-origin-action" type="button" data-action="replaceLocalBranchFromRemote" data-branch="${escapeHtml(branch.name)}" title="Reset local branch to origin/${escapeHtml(branch.name)}">Reset to origin</button>`
          : '';
        const deleteBranch = !branch.isCurrent && !branch.isRemote
          ? `<button class="sidebar-ref-delete-action" type="button" data-action="deleteDashboardBranch" data-branch="${escapeHtml(branch.name)}" data-has-remote="${branch.hasRemote ? 'true' : 'false'}" title="Delete local branch ${escapeHtml(branch.name)}" aria-label="Delete local branch ${escapeHtml(branch.name)}">×</button>`
          : '';
        const branchActions = useOrigin || deleteBranch
          ? `<span class="sidebar-ref-actions">${useOrigin}${deleteBranch}</span>`
          : '';
        return `<div class="sidebar-ref-row"><button class="sidebar-ref-item${branch.isCurrent ? ' current' : ''}" type="button" data-action="selectDashboardBranch" data-branch="${escapeHtml(branch.name)}" title="${escapeHtml(branch.name)}" aria-pressed="${branch.isCurrent ? 'true' : 'false'}"><span>⑂</span><span>${escapeHtml(branch.name)}</span>${branch.isCurrent ? '<small>HEAD</small>' : ''}</button>${branchActions}</div>`;
      }).join('') || '<span class="sidebar-placeholder">No branches</span>';
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
      const firstFile = files.querySelector('.changed-file-item');
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
  }

  function renderDashboardError(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    const history = document.getElementById('dashboardHistory');
    if (payload.request === 'getHistory' && history) {
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

    // Special handling for checkboxes - don't prevent default, just track state
    if (el.tagName === 'INPUT' && el.type === 'checkbox' && el.dataset.action === 'toggleSelection') {
      const path = el.dataset.repository;
      if (path) {
        // Sync our state with checkbox state (checkbox already toggled)
        if (el.checked) {
          selectedRepositories.add(path);
        } else {
          selectedRepositories.delete(path);
        }
        const row = el.closest('.repository-card');
        if (row) {
          row.classList.toggle('selected', el.checked);
        }
        saveState();
        updateSelectionUI();
      }
      return;
    }

    // Walk up the DOM tree to find element with data-action
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        const action = el.dataset.action;
        if (actions[action]) {
          e.preventDefault();
          actions[action](el);
        }
        return;
      }
      el = el.parentElement;
    }

    // If no action was found, check if the click was on a repository row to toggle branches.
    const row = e.target.closest('.repository-row');
    if (row) {
      const card = row.closest('.repository-card');
      if (card && card.dataset.path) {
        // Don't toggle if clicked on a button, input, or link
        if (e.target.closest('.row-actions') || e.target.closest('.row-checkbox')) return;
        actions.toggleBranches({ dataset: { repository: card.dataset.path } });
      }
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

  // Handle search input
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', function (e) {
      const query = (e.target.value || '').toLowerCase();
      document.querySelectorAll('.repository-card').forEach(function (row) {
        const name = (row.dataset.name || '').toLowerCase();
        const path = (row.dataset.path || '').toLowerCase();
        const branchEl = row.querySelector('.branch');
        const branch = branchEl ? (branchEl.textContent || '').toLowerCase() : '';
        const visible = name.includes(query) || path.includes(query) || branch.includes(query);
        row.style.display = visible ? 'block' : 'none';
      });
    });
  }

  function updateSelectionUI() {
    const bar = document.getElementById('selectionBar');
    const count = document.getElementById('selectedCount');

    if (selectedRepositories.size > 0) {
      bar.classList.add('active');
      count.textContent = selectedRepositories.size;
    } else {
      bar.classList.remove('active');
    }

    document.querySelectorAll('.repository-card').forEach(row => {
      const checkbox = row.querySelector('.row-checkbox');
      if (checkbox) {
        checkbox.checked = selectedRepositories.has(row.dataset.path);
        row.classList.toggle('selected', selectedRepositories.has(row.dataset.path));
      }
    });
  }

  function updateRebaseUI() {
    document.querySelectorAll('.repository-card').forEach(row => {
      const path = row.dataset.path;
      const rebaseIndicator = row.querySelector('.rebase-indicator');

      if (rebasingRepositories.has(path)) {
        if (rebaseIndicator) rebaseIndicator.style.display = 'inline-block';
      } else {
        if (rebaseIndicator) rebaseIndicator.style.display = 'none';
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
          select.value = selectedSummaryModelId;
          const button = document.getElementById('loadSummaryModelsButton');
          button.disabled = false;
          button.textContent = 'Reload models';
          restoreChangeSummary();
          break;
        }
        case 'summaryModelsError': {
          const button = document.getElementById('loadSummaryModelsButton');
          button.disabled = false;
          button.textContent = 'Load models';
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
            document.getElementById('commitChangesModal').classList.remove('active');
          }
          break;
        }

        case 'branches': {
          const branchSelect = document.getElementById('branchSelect');
          const branches = (message.payload && message.payload.branches) || [];
          const branchRepository = message.payload && message.payload.submodule;

          // Update checkout modal if open - just list all branches
          if (branchSelect) {
            if (branches.length === 0) {
              branchSelect.innerHTML = '<option value="">No branches found</option>';
            } else {
              branchSelect.innerHTML = branches.map(b =>
                `<option value="${b.name}">${b.name}${b.isCurrent ? ' (current)' : ''}${b.isRemote ? ' (remote)' : ''}</option>`
              ).join('');
            }
          }

          // Update inline branches panel if exists
          if (branchRepository) {
            const panelId = 'branches-' + branchRepository.replace(/[\\/.]/g, '-');
            const panel = document.getElementById(panelId);
            if (panel) {
              if (branches.length === 0) {
                panel.innerHTML = '<div class="branches-loading">No branches found</div>';
              } else {
                const filterId = 'branch-filter-' + branchRepository.replace(/[\\/.]/g, '-');
                const listId = 'branch-list-' + branchRepository.replace(/[\\/.]/g, '-');
                const countId = 'branch-count-' + branchRepository.replace(/[\\/.]/g, '-');
                panel.innerHTML =
                  '<div class="branches-filter">' +
                    '<input type="text" class="branches-filter-input" id="' + filterId + '" placeholder="Filter branches..." />' +
                    '<span class="branches-filter-count" id="' + countId + '">' + branches.length + ' branches</span>' +
                  '</div>' +
                  '<div class="branches-list" id="' + listId + '">' + branches.map(b => {
                  let tags = '';
                  if (b.isRemote) {
                    tags = '<span class="branch-tag tag-remote">remote</span>';
                    if (b.hasLocal) {
                      tags += '<span class="branch-tag tag-local">local</span>';
                    }
                  } else {
                    tags = '<span class="branch-tag tag-local">local</span>';
                    if (b.hasRemote) {
                      tags += '<span class="branch-tag tag-remote">remote</span>';
                    }
                  }
                  return `<div class="branch-item ${b.isCurrent ? 'current' : ''}" data-branch-name="${b.name.toLowerCase()}" data-repository="${branchRepository}" data-branch="${b.name}">
                    <span class="branch-icon" data-action="checkoutBranchInline" data-repository="${branchRepository}" data-branch="${b.name}" title="Checkout ${b.name}">${b.isCurrent ? '\u2713' : (b.isRemote ? '\u2601' : '\u238B')}</span>
                    <span class="branch-name" data-action="checkoutBranchInline" data-repository="${branchRepository}" data-branch="${b.name}" title="Checkout ${b.name}">${b.name}</span>
                    <span class="branch-tags">${tags}</span>
                    ${!b.isCurrent ? `<span class="branch-delete" data-action="deleteBranchInline" data-repository="${branchRepository}" data-branch="${b.name}" title="Delete ${b.name}">\u2715</span>` : ''}
                  </div>`;
                }).join('') + '</div>';

                // Attach filter event
                const filterInput = document.getElementById(filterId);
                const branchListEl = document.getElementById(listId);
                const countEl = document.getElementById(countId);
                if (filterInput && branchListEl) {
                  filterInput.addEventListener('input', function () {
                    const query = filterInput.value.toLowerCase();
                    let visibleCount = 0;
                    branchListEl.querySelectorAll('.branch-item').forEach(function (item) {
                      const name = item.getAttribute('data-branch-name') || '';
                      const visible = name.includes(query);
                      item.style.display = visible ? 'flex' : 'none';
                      if (visible) visibleCount++;
                    });
                    if (countEl) {
                      countEl.textContent = visibleCount + ' of ' + branches.length + ' branches';
                    }
                  });
                }
              }
            }
          }
          break;
        }

        case 'commits': {
          const commitSelect = document.getElementById('commitSelect');
          const commits = (message.payload && message.payload.commits) || [];
          if (commitSelect) {
            commitSelect.innerHTML = '<option value="">Select a commit...</option>' +
              commits.map(c =>
                `<option value="${c.hash}">${c.shortHash} - ${c.message.substring(0, 50)}</option>`
              ).join('');
          }
          break;
        }

        case 'recordedCommit': {
          const recordedInfo = document.getElementById('recordedCommitInfo');
          if (recordedInfo && message.payload) {
            const { recordedCommit, currentCommit, isMatching } = message.payload;
            const statusClass = isMatching ? 'success' : 'warning';
            const statusIcon = isMatching ? '\u2713' : '\u26A0';
            recordedInfo.innerHTML = `
              <div class="recorded-commit-status ${statusClass}">
                <span>${statusIcon} Parent expects: <code>${recordedCommit ? recordedCommit.substring(0, 8) : 'N/A'}</code></span>
                <span>Current: <code>${currentCommit ? currentCommit.substring(0, 8) : 'N/A'}</code></span>
                ${!isMatching ? '<span class="mismatch-warning">Commits do not match!</span>' : ''}
              </div>
            `;
          }
          break;
        }

        case 'updateSubmodules': {
          repositoryData = message.payload.submodules;
          saveState();
          updateRepositoryRows(repositoryData);
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

        case 'rebaseStatusUpdated': {
          updateRebaseUI();
          break;
        }

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
      const row = document.querySelector(`.repository-card[data-path="${repository.path}"]`);
      if (row) {
        const statusEl = row.querySelector('.row-status');
        if (statusEl) {
          statusEl.className = 'row-status status-' + repository.status;
          statusEl.innerHTML = getStatusIcon(repository.status) + ' ' + repository.status.toUpperCase();
        }

        const branchEl = row.querySelector('.branch');
        if (branchEl) branchEl.textContent = repository.currentBranch || '(detached)';

        const commitEl = row.querySelector('.commit');
        if (commitEl) commitEl.textContent = repository.currentCommit || 'N/A';

        const syncEl = row.querySelector('.row-sync');
        if (syncEl) {
          let syncHtml = '';
          if (repository.ahead > 0) syncHtml += `<span class="ahead">\u2191${repository.ahead}</span>`;
          if (repository.behind > 0) syncHtml += `<span class="behind">\u2193${repository.behind}</span>`;
          syncEl.innerHTML = syncHtml;
        }
      }
    });
  }

  function getStatusIcon(status) {
    const icons = {
      'clean': '\u2713',
      'modified': '\u25CF',
      'uninitialized': '\u25CB',
      'detached': '\u25CE',
      'conflict': '\u26A0',
      'unknown': '?'
    };
    return icons[status] || '?';
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

  // Ensure all branch panels are closed on load
  function closeAllBranchPanels() {
    document.querySelectorAll('.branches-panel').forEach(panel => {
      panel.style.display = 'none';
    });
  }

  const dashboardSearch = document.getElementById('dashboardSearch');
  const summaryModelSelect = document.getElementById('summaryModelSelect');
  if (summaryModelSelect) {
    summaryModelSelect.addEventListener('change', function () {
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
      for (const index of [1, 2, 3, 4, 0]) {
        const reduction = Math.min(-remaining, next[index] - historyColumnMinimums[index]);
        next[index] -= reduction;
        remaining += reduction;
        if (remaining >= 0) break;
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

  // Initialize UI on load
  setupHistoryColumnResizers();
  setupDashboardSplitters();
  updateSelectionUI();
  updateRebaseUI();
  closeAllBranchPanels();
  if (repositoryData.length > 0) {
    activateDashboardRepository(activeDashboardRepository);
  }
})();
