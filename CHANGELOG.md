# Changelog

All notable changes to Repository Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.1] - Unreleased

### Changed

- Reviews are split by what they cover, so no two buttons share a name:
  - **Review commit** (the toolbar above the changed files, formerly Review changes) reviews the selected commit or the loaded comparison.
  - **Review branch** (new, at the top) reviews what the current branch adds since it left the default branch, as a pull request shows it.
  - **Review all** (at the top, formerly ◈ Release › Review branch) reviews every committed file at the tip of the current branch.
- The toolbar no longer has its own Review branch, which reviewed every file at the selected commit under the same name as the one at the top.
- Tooltips say that reviews read committed files only.

## [1.9.0] - 2026-10-04

### Changed

- The dashboard follows the VS Code colour theme: light, dark and high-contrast themes get their own colours instead of the fixed dark palette.
- Review results separate findings from **Review gaps** (no policy, an unresolved rule, incomplete coverage): the banner counts each ("3 findings · 2 review gaps"), and the advisory note appears once, at the end.
- The Review tab has more room: the commit header and summary toolbar give way to it, and **Expand** hides the history for the whole review.
- Ctrl+click (Cmd+click) or Shift+click a history row to pick it for a comparison, as in Git Graph.
- The Model menu loads its list when you open it, so the Load models button is gone; the list ends with **Reload model list**.
- **Sync** is now **Align**, matching the "aligned" count of linked repositories and no longer reading like VS Code's Sync (pull and push).
- Switching repository or filters keeps the current history dimmed until the new one arrives, instead of flashing a loading message; scrolling to the end loads more history.
- One toolbar for what the dashboard shows: **Summarize changes**, **Review changes** and **Review branch** now sit together above the changed files and act on the selected commit or the loaded comparison. The comparison status next to the search only names the range, so it no longer pushes the search box off screen.
- **◈ Release › Load range** replaces Release › Summarize changes, which had the same name as the toolbar button but did something else. It loads the changes since the latest release tag on the current branch; summarize or review them from the toolbar.

### Added

- **Auto-fix progress**: while Copilot proposes a fix, the Review tab shows each step (checking the cited files, sending the findings and files, receiving the edits with how much has arrived, checking the edits) and the elapsed time.
- **Apply all or Apply selected**: each proposed file lists the findings it fixes and has a checkbox. Apply every file, or untick some and apply the rest; files you leave out stay proposed.
- **Fixed** findings: once its fix is applied, a finding moves to a **Fixed** section and out of "to fix" and readiness. You can also mark a finding Fixed by hand. The report and saved reviews record it.

### Fixed

- Reviews no longer lose whole components to model hiccups. A reply with text around its JSON is read anyway, and an unreadable reply gets one more try. A tool the model may not use (such as reading a diff in a branch review) is reported back to the model instead of failing every file in the component. When the model runs out of tool calls, it is asked for its result from what it has read.
- Long files are no longer listed as skipped after the first 100 lines. Each file now sends up to 400 lines at first, a file the model reads to the end counts as reviewed, and the rest say how much was read (for example "Partly reviewed: the model saw 400 of 2,315 lines").
- History search finds commits anywhere in the history. It used to look only at the newest 2,000 commits and show no result for older matches.
- The dashboard opens faster: on a repository with 20,000 commits and 8 submodules, the history appeared after about 1.5 s and now after about 0.4 s. The repository list needs 13 Git processes instead of 64, they run in parallel, and opening no longer loads the history, branches and commit details twice.
- **Load more** stays fast: each click adds its rows instead of redrawing the whole list, so it no longer gets slower with every page (at 2,000 rows, about 0.4 s instead of 1.7 s).
- A submodule that is not initialized is shown as uninitialized. It used to show the parent repository's branch, commit and changes.
- The parent repository is marked modified when its own files change or a submodule moves to another commit, but no longer when a submodule only has uncommitted edits; that submodule's own row shows them.

## [1.8.0] - 2026-10-02

### Added

- **Past reviews**: every completed review is saved with your triage, so you can check it later, even after restarting VS Code. The Review tab lists each repository's last 20 reviews with date, range, the exact commits reviewed, readiness and counts. Open one to see its findings, export it, or fix it; delete the ones you no longer need. Reviews are kept in VS Code's workspace state on this machine, never in the repository.

### Changed

- **◈ Release › Summarize changes** replaces Release › Review changes. It loads the changes since the latest release tag on the current branch into the dashboard and summarizes them with Copilot. To security-review that diff, choose **Review changes** next to the loaded range. **Review branch** still reviews every file on the current branch.

### Fixed

- The latest release tag is found by version number when tags with and without a `v` prefix are mixed. Before, `v1.9.0` was picked over a newer `1.10.0`.

## [1.7.2] - 2026-10-02

### Fixed

- When your branch is behind its configured upstream (for example `origin/<branch>`), the history graph draws them as one straight line in the first column, as Git Graph does, instead of putting the upstream's newer commits in a separate column that curves into your branch. An upstream that has diverged from your branch still gets its own column.
- The history columns settle at once when the dashboard gets narrower, for example after moving it to a new window. They used to take about a second to shrink step by step.

## [1.7.1] - 2026-10-02

### Fixed

- Review results no longer repeat the same limitation for every component reviewed. Notes that the report already gives once are left out: which files were in scope, that no policy was configured, that content was truncated, or that no flaw was found. The notes that remain are specific to the code, such as behavior that depends on callers that weren't reviewed.

## [1.7.0] - 2026-10-02

### Added

- **Fix with Copilot** after a review: mark findings **Needs fix**, and Copilot proposes edits to the files they cite. The proposed diff appears in the Review tab, and nothing is written until you choose **Apply to working tree**. Applying never stages or commits. Auto-fix needs the reviewed commit checked out and the cited files free of local or unsaved changes, and it checks this again just before writing.
- Triage review findings: mark each one **Needs fix** or **Dismiss** (false positive, accepted risk, or not applicable). Dismissed findings move to their own section and no longer count toward readiness, so a dismissed verified high stops blocking; the exported report lists them with the reason.
- Review progress: a progress bar, the component being reviewed (for example "Component 2 of 3 · Analyzing"), files done, candidate findings, elapsed time, and a checklist of every component.
- The sidebar branch list is a folder tree: `feature/a` and `feature/b` sit under **feature**. Folders collapse; the one holding the checked-out branch stays open.

### Changed

- **Review whole** is now **Review branch**; the Review tab and the report say **Branch: main**.
- A review runs in the background: switch repository, workspace folder or tab, and browse commits, while it continues. The Review tab shows its progress as a percentage, and the header names the reviewed repository when you are looking at another one. Clicking a commit shows its changes. Only starting a second review waits until the first finishes or is cancelled. Switching workspace folders no longer cancels a review.
- History graph, Git Graph style: the checked-out branch stays in the first column with a ring on HEAD, and every branch keeps one column and one colour from its tip until it merges. A branch started from another branch's commit curves into it instead of leaving a dangling line.

## [1.6.0] - 2026-09-29

### Added

- Switch the dashboard between the parent repository and linked repositories from a Repositories list that shows each repository's branch, status, ahead/behind counts, drift from the parent branch, and whether it has moved off the commit the parent records.
- Reset a single linked repository to the commit the parent records from its row in the Repositories list, after a confirmation that explains the resulting detached HEAD. It resets only the commit you confirmed and needs no network when that commit is already local.
- Show old and new file line numbers in commit and working-tree diffs.
- Fetch all repositories in the background every `repositoryManager.autoFetchInterval` minutes (default 5) while the dashboard is visible, so ahead/behind counts stay current. Background fetches never prune; only the Fetch button removes deleted remote branches. The existing `repositoryManager.autoFetch` setting, which previously had no effect, turns this on or off.
- Run a security and compliance review with GitHub Copilot from the dashboard. Every entry point has **Review changes** (the diff) and **Review whole** (every file): a Base/Target selection, a branch comparison, the history menu, and **◈ Release** (since the latest release tag, or the whole current branch). One click starts the review, with no dialog. Results open in a Review tab, headed **Diff: …** or **Whole: …**, with findings, policy results, coverage and limitations; evidence links jump to the cited line in the diff.
- Reviews report readiness: blocked (verified critical or high findings, policy violations), needs attention, or no blocking findings. Copy or save the report as Markdown.
- Consent before sending code to Copilot is asked once per repository with **Always allow for this repository**; **Repository Manager: Forget Review Permissions** undoes it for chosen repositories, and the `repositoryManager.review.confirmBeforeSending` setting asks every time.
- Add `npm run test:ui`, which renders the dashboard in headless Chromium against a fixture workspace and writes screenshots to `ui-snapshots/`.

### Changed

- Hide Git's `diff --git`, `index`, `---`, and `+++` header lines in diffs; the panel title already names the file.
- Dialogs close on Escape (an open dropdown closes first), move focus inside when they open, keep Tab within the dialog, and return focus to the button that opened them. They are announced as modal dialogs to screen readers.
- The history context menu shows Continue rebase and Abort rebase only while a rebase is paused.
- At narrow editor widths the history keeps a readable Message column (Author and Date shrink first), ref labels stay on one line and truncate, the Refresh, Fetch, Pull, Push, and Sync buttons and the Include remotes toggle stay visible, and repository badges move under the repository name in a narrow sidebar.
- Publishing a release whose tag is newer than `package.json` now packages the VSIX with the tag's version and attaches it, instead of failing and attaching nothing (this is what left 1.5.0 without a VSIX). A tag older than `package.json` is still refused.

### Removed

- Remove the unreachable repository selection bar; branch creation already selects repositories in its own dialog.
- Remove the unreachable code left from the old repository cards: the inline branch panels, the checkout-branch and checkout-commit dialogs, the rebase marker, and about 630 lines of unused CSS.

### Fixed

- Choosing another workspace folder now loads its history, branches, and repositories immediately instead of after Refresh.
- The header Sync button now reloads the history of the repositories it moved.
- Re-select all available repositories when opening New branch after creating a branch from a history commit.
- Pull refuses a detached HEAD instead of merging the remote default branch into it.
- Pull uses the branch's configured upstream, so branches tracking a differently named remote branch can be pulled.
- A pull that stops on conflicts now says a merge or rebase is in progress; diverged branches and other failures report the reason instead of fetch output.
- Ahead/behind counts compare against the branch's upstream, matching what Pull and Push use.
- The Pull, Push, and Fetch buttons always leave their busy state and keep their own label in the tooltip.

## [1.5.0] - 2026-09-25

### Added

- Right-click commit history actions to copy commit details, checkout a commit, create a branch or annotated tag, cherry-pick, revert, and merge.
- Rebase the current branch onto a selected commit, reset it (soft, mixed, or hard), or drop an unpublished commit, with confirmation, backup branches for hard reset and drop, and rebase continue/abort actions.
- Analyze large changes in bounded AI Change Summary batches with validated evidence and progress for each part.

### Fixed

- Refresh dashboard history after Git actions change commits or refs, including after resolving conflicts.
- Allow a summary with an invalid batch intent to be retried instead of caching incomplete output.

## [1.4.0] - 2026-09-25

### Added

- Select an available GitHub Copilot model when generating an AI Change Summary.
- Restore the summary for the selected model when switching between models or commits.

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
- Workspace alignment cards that compare every repository with the active target branch and surface drift or conflicts.
- Resizable history/diff and changed-files/diff split panes with persisted panel sizes.
- Accessible graph-node selection for comparing any two history commits, with explicit Base/Target markers and a dedicated branch comparison workflow.
- Expandable tag, remote, and stash details in the dashboard sidebar.

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
- Removed the duplicate Activity Bar `Repositories` and `Quick Actions` views so the editor dashboard is the only UI surface.
- Reintroduced the compact branch list inside the editor dashboard while keeping the removed Activity Bar tree views out of the extension.
- Synchronized the branch list with the history selector and highlighted the active history branch.
- Replaced the decorative single-line history graph with a continuous, topology-aware SVG graph that expands beyond five branch and merge lanes.
- Persisted branch, remote-inclusion, and search filters independently for each repository.
- Restored the active commit's parent diff whenever a comparison is cleared or reduced to one selected node.
- Hardened graph and toolbar layouts at narrow breakpoints and increased graph-node keyboard and pointer hit areas.
- Matched the dashboard command buttons to the approved HTML design with compact outlined icons, counters, spacing, and separators.
- Unified commit, merge, release, and branch comparisons around an explicit base-to-target diff range.
- Reworked the dashboard visual system from the approved design: compact branded header, repository filter, status-aware repository rows, denser history graph, commit inspector, diff styling, and branch workflow modal.
- Restored the Repository Manager Activity Bar icon as a single dashboard launcher without bringing back the removed repository and quick-action trees.
- Replaced the extension artwork with the Repository Manager graph icon and added a monochrome Activity Bar variant.
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
- Empty changed-file lists and patches for merge commits by comparing against the merge commit's first parent.
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
