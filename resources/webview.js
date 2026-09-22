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
  let historyPanelHeight = Number(previousState.historyPanelHeight) || 0;
  let filesPanelWidth = Number(previousState.filesPanelWidth) || 0;
  const runningToolbarOperations = new Set();

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
      filesPanelWidth
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
    refresh: () => runToolbarOperation('refresh', 'refresh'),
    initAll: () => postMessage('initSubmodules'),
    updateAll: () => postMessage('updateSubmodules'),

    selectDashboardRepository: (el) => {
      const repository = el.dataset.repository;
      if (repository) activateDashboardRepository(repository);
    },

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
      const branchFilter = document.getElementById('dashboardBranchFilter');
      if (branchFilter) {
        if (!Array.from(branchFilter.options).some(option => option.value === revision)) {
          branchFilter.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(revision)}">${escapeHtml(revision)}</option>`);
        }
        branchFilter.value = revision;
      }
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
    },

    selectDashboardBranch: (el) => {
      const revision = el.dataset.revision;
      if (revision == null) return;
      const branchFilter = document.getElementById('dashboardBranchFilter');
      if (branchFilter) branchFilter.value = revision;
      updateSelectedBranchUI(revision);
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
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
      const branch = el.dataset.branch;
      if (branch) postMessage('checkoutBranch', { submodule: activeDashboardRepository, branch });
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

    openCreateBranchModal: () => {
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
      // Request branches from the first available repository.
      postMessage('getBaseBranchesForCreate', {});
      document.getElementById('createBranchModal').classList.add('active');
      // Retry if branches haven't loaded after 2s
      retryLoadBaseBranches(3);
    },

    closeModal: (el) => {
      const modalId = el.dataset.modal;
      document.getElementById(modalId).classList.remove('active');
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

  function updateCommitCompareUI() {
    document.querySelectorAll('.history-row').forEach(row => {
      const marker = commitCompareSelection[0] === row.dataset.commit
        ? 'B'
        : commitCompareSelection[1] === row.dataset.commit
          ? 'T'
          : '';
      row.classList.toggle('compare-base', marker === 'B');
      row.classList.toggle('compare-target', marker === 'T');
      const node = row.querySelector('.graph-node-button');
      if (node) {
        node.dataset.marker = marker;
        node.setAttribute('aria-pressed', marker ? 'true' : 'false');
        const accessibleLabel = marker
          ? `${marker === 'B' ? 'Base' : 'Target'} commit ${shortRevision(row.dataset.commit)}. Press to remove from comparison.`
          : `Select commit ${shortRevision(row.dataset.commit)} for comparison.`;
        node.setAttribute('aria-label', accessibleLabel);
        node.title = accessibleLabel;
      }
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
    } else if (transition.action === 'parent' && selectedDashboardCommit) {
      loadParentCommitDetail(selectedDashboardCommit);
    }
  }

  function loadComparison(baseRevision, targetRevision, source) {
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

  function captureDashboardFilters() {
    if (!activeDashboardRepository) return;
    const branch = document.getElementById('dashboardBranchFilter');
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    dashboardHistoryState[activeDashboardRepository] = {
      branch: branch ? branch.value : '',
      includeRemotes: Boolean(includeRemotes && includeRemotes.checked),
      search: search ? search.value : ''
    };
  }

  function applyDashboardFilters(repositoryPath) {
    const filters = getDashboardFilters(repositoryPath);
    const branch = document.getElementById('dashboardBranchFilter');
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    if (branch) {
      if (filters.branch && !Array.from(branch.options).some(option => option.value === filters.branch)) {
        branch.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(filters.branch)}">${escapeHtml(filters.branch)}</option>`);
      }
      branch.value = filters.branch;
    }
    if (includeRemotes) includeRemotes.checked = filters.includeRemotes;
    if (search) search.value = filters.search;
  }

  function activateDashboardRepository(repositoryPath) {
    const repository = getRepository(repositoryPath);
    if (!repository) return;

    if (dashboardActivated) captureDashboardFilters();
    activeDashboardRepository = repositoryPath;
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
    document.querySelectorAll('.dashboard-repository-item').forEach(item => {
      item.classList.toggle('active', item.dataset.repository === repositoryPath);
    });

    const context = document.getElementById('dashboardCommandContext');
    if (context) {
      context.innerHTML = `<span class="context-path">${escapeHtml(repository.path === '.' ? repository.name : repository.path)}</span><span class="context-branch">⑂ ${escapeHtml(repository.currentBranch || '(detached)')}</span>`;
    }
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
    renderWorkspaceAlignment();
    saveState();
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath });
  }

  function requestDashboardHistory(offset, append) {
    const search = document.getElementById('dashboardSearch');
    const branch = document.getElementById('dashboardBranchFilter');
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const history = document.getElementById('dashboardHistory');
    if (!append) loadedHistoryCommits = [];
    captureDashboardFilters();
    saveState();
    if (!append && history) history.innerHTML = '<div class="dashboard-loading">Loading history…</div>';
    if (!append) historyRequestId += 1;
    postMessage('getHistory', {
      repositoryPath: activeDashboardRepository,
      limit: 100,
      offset: offset || 0,
      search: search ? search.value.trim() : '',
      branch: branch && branch.value ? branch.value : undefined,
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

  function renderHistoryGraph(commits, graphModel) {
    const paths = [];
    const nodes = [];
    graphModel.rows.forEach((layout, index) => {
      const commit = commits[index];
      const top = layout.rowIndex * graphModel.rowHeight;
      const middle = top + (graphModel.rowHeight / 2);
      const bottom = top + graphModel.rowHeight;
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
    });
    return `<svg class="history-graph-overlay" width="${graphModel.width}" height="${graphModel.height}" viewBox="0 0 ${graphModel.width} ${graphModel.height}" aria-hidden="true">${paths.join('')}${nodes.join('')}</svg>`;
  }

  function renderGraphCell(commit, layout) {
    const currentX = window.RepositoryHistoryGraph.laneX(layout.lane);
    return `<span class="history-graph-cell"><button class="graph-node-button" type="button" data-action="toggleCommitCompareNode" data-commit="${escapeHtml(commit.hash)}" style="--graph-node-x:${currentX}px" title="Select ${escapeHtml(commit.shortHash)} for comparison" aria-label="Select commit ${escapeHtml(commit.shortHash)} for comparison" aria-pressed="false" data-marker=""></button></span>`;
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
    const historyRegion = history.closest('.history-region');
    if (historyRegion) historyRegion.style.setProperty('--graph-width', `${graphModel.width}px`);
    const rows = loadedHistoryCommits.map((commit, index) => {
      const refs = (commit.refs || []).map(ref => `<span class="history-ref ref-${escapeHtml(ref.kind)}">${escapeHtml(ref.name)}</span>`).join('');
      return `<div class="history-row" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}">
        ${renderGraphCell(commit, graphModel.rows[index])}
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
    const branchFilter = document.getElementById('dashboardBranchFilter');

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
        const revision = branch.isRemote ? `origin/${branch.name}` : branch.name;
        return `<button class="sidebar-ref-item" type="button" data-action="selectDashboardBranch" data-revision="${escapeHtml(revision)}" aria-pressed="false"><span>⑂</span><span>${escapeHtml(branch.name)}</span>${branch.isCurrent ? '<small>HEAD</small>' : ''}</button>`;
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
    if (branchFilter) {
      const currentValue = branchFilter.value;
      branchFilter.innerHTML = '<option value="">HEAD</option>' + branches.map(branch => {
        const revision = branch.isRemote ? `origin/${branch.name}` : branch.name;
        return `<option value="${escapeHtml(revision)}">${escapeHtml(branch.name)}${branch.isRemote ? ' (remote)' : ''}</option>`;
      }).join('');
      if (Array.from(branchFilter.options).some(option => option.value === currentValue)) branchFilter.value = currentValue;
      updateSelectedBranchUI(branchFilter.value);
    }
    populateBranchCompareSelects(document.getElementById('compareBaseBranch'), document.getElementById('compareTargetBranch'));
  }

  function updateSelectedBranchUI(revision) {
    const currentBranch = (repositoryRefs.branches || []).find(branch => branch.isCurrent);
    const selectedRevision = revision || (currentBranch ? currentBranch.name : '');
    document.querySelectorAll('#dashboardBranches .sidebar-ref-item').forEach(item => {
      const selected = item.dataset.revision === selectedRevision;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function renderWorkspaceAlignment() {
    const active = getRepository(activeDashboardRepository);
    const summary = document.getElementById('workspaceAlignmentSummary');
    const cards = document.getElementById('workspaceAlignmentCards');
    const action = document.getElementById('workspaceAlignmentAction');
    if (!active || !summary || !cards || !action) return;

    const targetBranch = active.currentBranch || '';
    const aligned = repositoryData.filter(repository => targetBranch && repository.currentBranch === targetBranch);
    const needsAlignment = repositoryData.filter(repository => !targetBranch || repository.currentBranch !== targetBranch);
    summary.textContent = targetBranch
      ? `${aligned.length} of ${repositoryData.length} on target branch`
      : 'Active repository is detached';

    cards.innerHTML = repositoryData.map(repository => {
      const isConflict = repository.status === 'conflict';
      const isDetached = !repository.currentBranch || repository.status === 'detached';
      const isAligned = Boolean(targetBranch) && repository.currentBranch === targetBranch;
      const tone = isConflict ? 'error' : isAligned ? 'good' : 'warning';
      let detail = 'on target';
      if (isConflict) detail = `on ${repository.currentBranch || 'detached'} · conflict`;
      else if (isDetached) detail = `pointer drift · ${repository.currentCommit || 'detached'}`;
      else if (!isAligned) detail = `on ${repository.currentBranch}`;
      else if (repository.hasChanges) detail = 'on target · uncommitted changes';
      return `<button class="alignment-card alignment-${tone}" type="button" data-action="selectDashboardRepository" data-repository="${escapeHtml(repository.path)}"><strong><i></i>${escapeHtml(repository.name)}</strong><span>${escapeHtml(detail)}</span></button>`;
    }).join('');

    action.hidden = needsAlignment.length === 0;
    action.textContent = `Align ${needsAlignment.length} ${needsAlignment.length === 1 ? 'repo' : 'repos'}`;
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
    const lines = String(payload.patch || '').split('\n');
    diff.innerHTML = lines.map(line => {
      let className = 'diff-context';
      if (line.startsWith('+') && !line.startsWith('+++')) className = 'diff-addition';
      else if (line.startsWith('-') && !line.startsWith('---')) className = 'diff-deletion';
      else if (line.startsWith('@@')) className = 'diff-hunk';
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) className = 'diff-meta';
      return `<span class="${className}">${escapeHtml(line) || ' '}</span>`;
    }).join('');
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
      const dashboardItem = Array.from(document.querySelectorAll('.dashboard-repository-item')).find(item => item.dataset.repository === repository.path);
      if (dashboardItem) {
        const dot = dashboardItem.querySelector('.repository-status-dot');
        const branch = dashboardItem.querySelector('.repository-item-copy small');
        const sync = dashboardItem.querySelector('.repository-sync-state');
        if (dot) dot.className = 'repository-status-dot status-' + repository.status;
        if (branch) branch.textContent = repository.currentBranch || `(detached) ${repository.currentCommit || ''}`;
        if (sync) sync.textContent = `${repository.behind > 0 ? `↓${repository.behind}` : ''}${repository.behind > 0 && repository.ahead > 0 ? ' ' : ''}${repository.ahead > 0 ? `↑${repository.ahead}` : ''}`;
        if (repository.path === activeDashboardRepository) {
          const context = document.getElementById('dashboardCommandContext');
          if (context) context.innerHTML = `<span class="context-path">${escapeHtml(repository.path === '.' ? repository.name : repository.path)}</span><span class="context-branch">⑂ ${escapeHtml(repository.currentBranch || '(detached)')}</span>`;
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
    renderWorkspaceAlignment();
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
      prefixes = rules.prefixes;
      // Update hints only for known branch types
      document.getElementById('baseBranchHint').textContent = 'Type: ' + branchType;
      document.getElementById('prefixRuleHint').textContent = rules.hint;
    } else {
      // Unknown branch type - don't show type hint, show all prefix options
      prefixes = ['bugfix', 'feature', 'task', 'release', 'dev'];
      document.getElementById('baseBranchHint').textContent = '';
      document.getElementById('prefixRuleHint').textContent = '';
    }

    // Update options based on rules
    prefixSelect.innerHTML = prefixes.map(p => {
      return `<option value="${p}">${p}/</option>`;
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

      const prefixStr = prefix + '/';
      if (ticketId && kebabTitle) {
        branchName = prefixStr + ticketId + '-' + kebabTitle;
      } else if (ticketId) {
        branchName = prefixStr + ticketId + '-';
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
      // feature, task, bugfix
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

  const dashboardRepositorySearch = document.getElementById('dashboardRepositorySearch');
  if (dashboardRepositorySearch) {
    dashboardRepositorySearch.addEventListener('input', function () {
      const query = dashboardRepositorySearch.value.trim().toLowerCase();
      document.querySelectorAll('.dashboard-repository-item').forEach(function (item) {
        const searchable = `${item.dataset.name || ''} ${item.dataset.repository || ''} ${item.textContent || ''}`.toLowerCase();
        item.hidden = Boolean(query) && !searchable.includes(query);
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && document.activeElement && document.activeElement.tagName !== 'INPUT') {
        event.preventDefault();
        dashboardRepositorySearch.focus();
      }
    });
  }

  const dashboardBranchFilter = document.getElementById('dashboardBranchFilter');
  if (dashboardBranchFilter) {
    dashboardBranchFilter.addEventListener('change', function () {
      updateSelectedBranchUI(dashboardBranchFilter.value);
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
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

  function applyHistoryPanelHeight(height) {
    const main = document.querySelector('.dashboard-main');
    const alignment = document.getElementById('workspaceAlignment');
    const controls = document.querySelector('.history-controls');
    if (!main || !alignment || !controls) return;
    const max = main.clientHeight - alignment.offsetHeight - controls.offsetHeight - 6 - 120;
    historyPanelHeight = clampPanelSize(height, 120, Math.max(120, max));
    main.style.gridTemplateRows = `${alignment.offsetHeight}px ${controls.offsetHeight}px ${historyPanelHeight}px 6px minmax(120px, 1fr)`;
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
  setupDashboardSplitters();
  updateSelectionUI();
  updateRebaseUI();
  closeAllBranchPanels();
  if (repositoryData.length > 0) {
    activateDashboardRepository(activeDashboardRepository);
  }
})();
