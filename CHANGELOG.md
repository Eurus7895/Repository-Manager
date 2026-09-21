# Changelog

All notable changes to Repository Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-21

### Added

- Parent repository support in the dashboard and coordinated branch workflows.
- Parent repository selection for branch creation and deletion quick actions.
- One-click **Sync Versions** action for all linked repositories.
- Multi-root workspace selection and repository refresh when switching folders.
- Searchable branch lists with local and remote indicators.
- Branch filtering by repository name, path, and branch name.
- Checkout, pull, push, branch deletion, and pull-request actions from the repository view.
- Commit checkout and comparison with the commit recorded by the parent repository.
- Rebase-state tracking to reduce accidental synchronization during rebase work.
- Repository history with paginated commit loading, branch filtering, remote inclusion, and search.
- Commit inspection with changed-file navigation and per-file patches.
- Sidebar reference browsing for branches, tags, remotes, and stashes.

### Changed

- Repositioned the extension as **Repository Manager**, with repository and branch workflow management as its primary purpose.
- Reduced submodule-specific terminology in the main product description and documentation. Git submodules remain the supported linked-repository mechanism.
- Extended branch hierarchy rules:
  - `dev` can create `feature/` and `release/` branches.
  - `feature` can create `feature/` and `task/` branches.
  - `task` can create `task/` branches.
  - Unknown branch types can use any supported prefix.
- Improved repository row and branch-list layouts for stable sizing and clearer current-branch highlighting.
- Redesigned the webview as a desktop Git dashboard with a command bar, repository sidebar, history table, commit summary, changed-file list, and diff viewer.
- Updated the dashboard to treat the parent and linked repositories as one repository collection, including repository-wide statistics, search, selection, and branch workflows.
- Kept submodule terminology only for Git operations that specifically initialize, update, or stage submodule pointers.
- Restored branch delete actions after an optimistic checkout changes the current branch.
- Split the extension into command, handler, service, and webview modules for easier maintenance.
- Added dedicated read services for paginated history, commit details, file diffs, branches, tags, remotes, and stashes.
- Added typed dashboard request/response contracts so the redesigned UI can lazy-load repository data.
- Replaced shell-based Git execution with argument-safe process execution and workspace path validation.
- Renamed the extension package and publisher identifiers to `repository-manager`.
- Renamed commands and settings from `submoduleManager.*` to `repositoryManager.*`.
- Renamed the Activity Bar container and contributed view IDs to the Repository Manager namespace.
- Changed the packaged artifact name to `repository-manager-1.1.0.vsix`.

### Breaking

- VS Code treats Repository Manager as a new extension identity rather than an automatic update from Submodule Manager.
- Existing settings under `submoduleManager.*` must be migrated to `repositoryManager.*`.
- Keybindings or automation invoking `submoduleManager.*` commands must use `repositoryManager.*`.

### Fixed

- Branch lists not updating after asynchronous loading.
- Base-branch delivery failures by awaiting webview messages and retrying incomplete loads.
- Inconsistent branch tags and row sizing during filtering and checkout.
- Webview interaction failures caused by inline handlers and Content Security Policy constraints.
- TypeScript rebuilds accidentally reading generated declaration files from `out/`.
- Added backend parser, path-boundary, and live Git integration tests.

## [1.0.2] - 2026-02-24

### Added

- Branch-name filtering in the repository search field.

### Changed

- Reworked repository rows with a consistent CSS grid layout.
- Kept branch tags focused on local and remote state while using highlighting for the current branch.
- Excluded the generated `out/` directory from TypeScript compilation inputs.

### Fixed

- Repository cards changing size while branch filters were active.
- Merge-conflict remnants in the webview stylesheet.

## [1.0.1] - 2025-01-29

### Added
- **Branch Naming Tool**: New intelligent branch creation with auto-formatting
  - Input task title (e.g., "Design and Implement XML Parser Abstraction Class")
  - Auto-converts to kebab-case branch names
  - Optional ticket ID prefix (e.g., ECPT-15474)
  - Live preview of generated branch name

- **Branch Hierarchy Rules**: Enforced branch naming conventions based on base branch
  - From `main`/`master`: Can create `bugfix/`, `release/`, `dev/` branches
  - From `dev`: Can create `feature/` branches
  - From `feature`: Can create `task/` branches
  - Dynamic prefix options update based on selected base branch

- **Base Branch Selection**: Dropdown with available branches
  - Shows all local branches from the repository
  - Current branch selected by default
  - Displays branch type hints

- **Review Step After Branch Creation**: New confirmation modal
  - Shows success/failure status for each submodule
  - Displays the generated branch name
  - Option to push to remote after confirmation

- **Push to Remote**: Integrated push functionality
  - Push newly created branches directly from the review modal
  - Also available in the quick action command palette flow

### Changed
- Release branch prefix changed from `Release/` to lowercase `release/`
  - Example: `release/HexOGen_10.54.0`
- Base branch input changed from text field to dropdown selector
- Quick action "Create Branch" command now follows the same workflow:
  - Step-by-step guided flow with prefix selection
  - Branch hierarchy enforcement
  - Push option after creation

### Branch Naming Conventions
- **bugfix/feature/task**: `{prefix}/{ticket-id}-{kebab-case-title}`
  - Example: `feature/ECPT-15474-design-and-implement-xml-parser`
- **release**: `release/{ProductName}_{version}`
  - Example: `release/HexOGen_10.54.0`
- **dev**: `dev/{kebab-case-name}`
  - Example: `dev/sprint-42`

---

## [1.0.0] - 2024-01-26

### Added
- Modern webview dashboard with real-time submodule status
- Visual status cards for each submodule showing:
  - Current branch and commit
  - Status (clean, modified, uninitialized, detached, conflict)
  - Ahead/behind remote counts
- Branch creation across multiple submodules simultaneously
- Quick actions for individual submodules:
  - Checkout branch
  - Pull changes
  - Push changes
  - Create pull request (opens GitHub)
  - Open in Explorer
  - Stage submodule changes
- Tree view sidebar with:
  - Collapsible submodule list
  - Quick actions panel
- Version synchronization to configured branches
- Search and filter submodules
- Bulk selection for batch operations
- GitHub PR integration
- Configurable settings:
  - Default branch name
  - Auto-fetch on panel open
  - Notification preferences
  - GitHub token for API access
- Keyboard shortcuts:
  - `Ctrl+Shift+G M` - Open manager panel
  - `Ctrl+Shift+G R` - Refresh submodules
- File system watcher for auto-refresh when .gitmodules changes

### Technical
- TypeScript implementation
- Webview with VS Code theme integration
- CSP-compliant security
- Efficient git operations with proper error handling
