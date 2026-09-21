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

  // Save state helper
  function saveState() {
    vscode.setState({
      selectedRepositories: Array.from(selectedRepositories),
      rebasingRepositories: Array.from(rebasingRepositories),
      repositoryData
    });
  }

  function postMessage(type, payload) {
    vscode.postMessage({ type, payload });
  }

  // Action handlers
  const actions = {
    refresh: () => postMessage('refresh'),
    initAll: () => postMessage('initSubmodules'),
    updateAll: () => postMessage('updateSubmodules'),

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

  // Initialize UI on load
  updateSelectionUI();
  updateRebaseUI();
  closeAllBranchPanels();
})();
