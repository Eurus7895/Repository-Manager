# Repository Manager

A VS Code extension for Git workflows across a parent repository and its linked repositories (Git submodules), from one dashboard.

## Features

- **Overview:** every repository in one dashboard, with drift from the target branch, a commit graph, changed files and diffs. Compare any two commits or branches, and filter or search history.
- **Branches across repositories:** create, switch and delete branches in the repositories you pick, with naming rules for `main`, `dev`, `feature`, `task` and `release`.
- **Everyday Git:** checkout, fetch, pull, push, open a pull request, rebase, reset or drop commits (with a backup branch), and align linked repositories to their recorded commits.
- **AI review with Copilot:**
  - **Review commit**, **Review branch** (changes since the default branch) or **Review all** (every file);
  - findings cite exact lines and can be triaged and fixed with Copilot;
  - stopped reviews continue where they left off, and past reviews are saved;
  - review skills (security checklists by file type) turn on automatically, and **Clean code** adds maintainability notes that never block.

  Results are advisory. See [docs/security-compliance-review-engine.md](docs/security-compliance-review-engine.md) for how a review works.

## Install

Download the `.vsix` from [GitHub Releases](https://github.com/Eurus7895/Repository-Manager/releases). In VS Code, open Extensions, choose **… › Install from VSIX…**, and select the file.

## Use

Open it from the Activity Bar icon, the command **Repository Manager: Open Repository Manager**, or `Ctrl+Shift+G M` (`Cmd+Shift+G M` on macOS). `Ctrl+Shift+G R` refreshes the repository list.

## Settings

| Setting | Default | Description |
|---|---|---|
| `repositoryManager.defaultBranch` | `main` | Default branch for branch workflows |
| `repositoryManager.autoFetch` | `true` | Fetch in the background while the dashboard is visible; never prunes and never prompts for credentials |
| `repositoryManager.autoFetchInterval` | `5` | Minutes between background fetches |
| `repositoryManager.review.confirmBeforeSending` | `false` | Ask before every review sends code to Copilot |
| `repositoryManager.showNotifications` | `true` | Show notifications for Git operations |
| `repositoryManager.githubToken` | `""` | Optional GitHub token for pull request operations |

## Requirements

- VS Code 1.74 or newer and Git 2.20 or newer.
- AI summaries, reviews and fixes need VS Code 1.91 or newer and GitHub Copilot.

## Development

```bash
npm ci
npm test          # compile, lint and test suites
npm run test:ui   # Playwright screenshots into ui-snapshots/
npm run package   # builds the .vsix
```

Press `F5` to launch an Extension Development Host. Pull requests run the same checks in CI. Add a `CHANGELOG.md` entry with each change.

## License

[MIT](LICENSE)
