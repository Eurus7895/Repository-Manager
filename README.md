# Repository Manager

Repository Manager is a VS Code extension for coordinating Git workflows across a parent repository and its linked repositories from one place.

Its primary focus is repository and branch workflow management: inspect repository state, create consistent branches, switch branches, synchronize versions, and move changes toward review. Git submodules remain supported as the current linked-repository mechanism, but they are not the product's main purpose.

## What it helps with

### Unified repository overview

- See the parent repository and linked repositories in one dashboard.
- Check workspace alignment at a glance and identify repositories that have drifted from the active target branch.
- Browse the active repository's commit graph, Git Graph style: the checked-out branch stays in the first column, and each branch keeps its own column and colour, with tag, remote, and stash context. The sidebar lists branches as a folder tree (`feature/…`, `release/…`).
- Inspect commit metadata, changed files, and syntax-colored patches without leaving the panel.
- Resize the history, changed-files, and diff panes to suit the current review task.
- Select up to two circular graph nodes, marked Base and Target, to compare distant commits; local and remote branches can also be compared directly.
- Filter history by branch, include remote refs, or search by author, hash, message, and ref; these filters are remembered per repository.
- Review the active branch, current commit, working-tree state, and ahead/behind counts.
- Search repositories and branches in larger workspaces.
- Filter history from the dashboard branch list or selector; both controls stay synchronized and highlight the selected branch.
- Expand tags, remotes, and stashes to inspect hashes, timestamps, subjects, and remote URLs; tags and stashes can open their history directly.
- Switch between workspace folders in multi-root VS Code workspaces.

### Coordinated branch workflows

- Create a branch across selected repositories with one guided workflow.
- Apply branch hierarchy rules for `main`, `dev`, `feature`, `task`, and `release` workflows.
- Generate consistent branch names from an optional ticket ID and task title.
- Select a base branch with search, local/remote indicators, and current-branch highlighting.
- Delete branches locally or from both local and remote repositories with confirmation.

### Everyday Git operations

- Checkout, fetch, pull, and push without leaving the dashboard.
- Open a repository in Explorer.
- Open GitHub's pull-request creation flow.
- Restore a linked repository to the commit recorded by the parent repository.
- Inspect merge and release commits against their first parent, including their changed files and per-file patches.
- Right-click a history commit to rebase the current local branch onto it, reset to it (soft, mixed, or hard), or drop a commit from the current branch. Confirm the affected commits before running; hard reset and drop create a local backup branch.
- Resolve a paused rebase in Source Control, then choose **Continue rebase** or **Abort rebase** from the history context menu; these items appear only while a rebase is paused. Rebase and drop currently require a linear range; dropping a commit reachable from a remote branch is blocked.

### Security and compliance review

- Every entry point has two buttons: **Review changes** (the diff) and **Review branch** (every file). They sit next to a Base/Target selection or branch comparison, in the history right-click menu (one commit against its parent, or the branch at that commit), and **◈ Release › Review branch** (every file on the current branch).
- **◈ Release › Summarize changes** loads the changes since the latest release tag (`1.5.0` or `v1.5.0`) on the current branch into the dashboard and summarizes them with Copilot. To review that diff for security, choose **Review changes** next to the loaded range.
- One click starts the review, checking security and team policy with the model chosen for AI summaries. The first review in a repository asks before sending code to Copilot; **Always allow for this repository** skips the question from then on. **Repository Manager: Forget Review Permissions** in the Command Palette undoes that for the repositories you choose, and `repositoryManager.review.confirmBeforeSending` asks every time.
- A progress view shows the component being reviewed, files done and elapsed time. The review runs in the background: switch repository, folder or tab while it continues, and follow its percentage on the Review tab.
- Results are classified as blocked, needs attention, or no blocking findings. Mark each finding **Needs fix** or **Dismiss** with a reason; dismissed findings no longer count toward readiness but stay in the report.
- **Fix with Copilot** proposes edits for the findings marked Needs fix. You see the diff first; **Apply to working tree** writes it, and nothing is staged or committed. It needs the reviewed commit checked out and the cited files unchanged.
- Findings cite exact lines; click one to open it in the diff. Team rules come from `.repository-manager/review-policy.json` in the reviewed commit.
- Completed reviews are saved under **Past reviews** in the Review tab, newest first: the last 20 per repository, with your triage. Open one later (also after restarting VS Code) to check its findings, export it, or fix it; delete the ones you no longer need. They are kept in VS Code's workspace state on this machine, never in the repository.
- Copy or save the report as Markdown for a release or pull request. Results are advisory: verified means checked evidence plus a second AI assessment, not proof.

### Linked-repository synchronization

- Initialize and update Git submodules when the workspace uses them.
- Synchronize all linked repositories to their recorded commits, or reset one repository from its row in the Repositories list.
- Stage updated repository pointers in the parent repository.

## Repository model

Repository Manager works with:

- the workspace's parent Git repository; and
- linked repositories declared through `.gitmodules`.

The parent repository participates in branch creation, deletion, checkout, pull, and push workflows. Submodule-specific actions such as initialization and pointer staging are available when applicable.

Version 1.1.0 completes the rename to Repository Manager. Its extension ID, commands, settings, view IDs, and package artifact now use the `repository-manager` or `repositoryManager.*` namespaces.

This is an intentional breaking identity change. VS Code treats it as a separate extension instead of an in-place update from the former Submodule Manager package.

## Installation

### From a VSIX package

1. Download the latest `.vsix` package from the project release artifacts.
2. Open Extensions in VS Code (`Ctrl+Shift+X`).
3. Select the `...` menu and choose **Install from VSIX...**.
4. Select the downloaded package.

### From source

```bash
npm ci
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Usage

### Open Repository Manager

- Command Palette: **Repository Manager: Open Repository Manager**
- Keyboard: `Ctrl+Shift+G M` (`Cmd+Shift+G M` on macOS)
- Activity Bar: select the Repository Manager icon to launch the editor dashboard

### Create a branch across repositories

1. Open Repository Manager.
2. Select **Create Branch**.
3. Choose the parent and linked repositories that should receive the branch.
4. Select a base branch.
5. Select an allowed branch prefix.
6. Enter the ticket and branch details.
7. Review the result and optionally push successful branches.

### Synchronize recorded versions

Select **Sync Versions** to restore linked repositories to the commits recorded by the parent repository. To reset one repository, use **Reset to recorded** on its row in the Repositories list.

## Configuration

Open VS Code settings and search for **Repository Manager**.

| Setting | Description | Default |
|---|---|---|
| `repositoryManager.defaultBranch` | Default branch used by branch workflows | `main` |
| `repositoryManager.autoFetch` | Fetch updates when opening the panel | `true` |
| `repositoryManager.showNotifications` | Show notifications for Git operations | `true` |
| `repositoryManager.githubToken` | Optional GitHub token for PR operations | `""` |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+G M` | Open Repository Manager |
| `Ctrl+Shift+G R` | Refresh repositories |

Use `Cmd` instead of `Ctrl` on macOS.

## Requirements

- VS Code 1.74.0 or newer
- Git 2.20.0 or newer
- Node.js for development only
- For security and compliance reviews: VS Code 1.91 or newer and GitHub Copilot

## Development

```bash
npm ci
npm run compile
npm run lint
npm run package
```

The package command creates a `.vsix` file in the repository root.

## Contributing

1. Create a focused branch.
2. Make and document the change.
3. Run compile and lint checks.
4. Package the extension when the change affects the shipped artifact.
5. Open a pull request with the validation results.

## License

Repository Manager is available under the [MIT License](LICENSE).
