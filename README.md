# Repository Manager

Repository Manager is a VS Code extension for coordinating Git workflows across a parent repository and its linked repositories from one place.

Its primary focus is repository and branch workflow management: inspect repository state, create consistent branches, switch branches, synchronize versions, and move changes toward review. Git submodules remain supported as the current linked-repository mechanism, but they are not the product's main purpose.

## What it helps with

### Unified repository overview

- See the parent repository and linked repositories in one dashboard.
- Browse the active repository's commit graph with branch, tag, remote, and stash context.
- Inspect commit metadata, changed files, and syntax-colored patches without leaving the panel.
- Filter history by branch, include remote refs, or search by author, hash, message, and ref.
- Review the active branch, current commit, working-tree state, and ahead/behind counts.
- Search repositories and branches in larger workspaces.
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
- Mark rebase activity to reduce accidental synchronization during an active rebase.

### Linked-repository synchronization

- Initialize and update Git submodules when the workspace uses them.
- Synchronize selected or all linked repositories to their recorded commits.
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

Select **Sync Versions** to restore linked repositories to the commits recorded by the parent repository. You can synchronize all repositories or operate on an individual repository from its card.

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
