---
id: ci-supply-chain
name: CI/CD and supply chain
category: security
appliesTo: [".github/workflows/**", "**/action.yml", "**/action.yaml", "**/.gitlab-ci.yml", "**/Jenkinsfile", "**/azure-pipelines*.yml", "**/bitbucket-pipelines.yml", "**/.circleci/**", "**/package.json", "**/.npmrc", "**/requirements*.txt", "**/requirements*.in", "**/Pipfile", "**/pyproject.toml", "**/setup.py", "**/Gemfile", "**/go.mod", "**/Cargo.toml", "**/pom.xml", "**/build.gradle*", "**/*.csproj", "**/Directory.Packages.props", "**/CMakeLists.txt", "**/*.cmake", "**/conanfile.*", "**/vcpkg.json", "**/Dockerfile", "**/*.dockerfile"]
references: OpenSSF Scorecard (Dangerous-Workflow, Token-Permissions, Pinned-Dependencies); GitHub Actions security hardening guide; CWE-829, CWE-494, CWE-77
---
Workflows:
- Untrusted code in a privileged context: pull_request_target or workflow_run that checks out or runs the pull request's code, or uses its artifacts, with secrets or a write token (Scorecard Dangerous-Workflow).
- Script injection: ${{ github.event.* }} values (titles, branch names, comments) placed directly in run: steps, or written to GITHUB_ENV, GITHUB_OUTPUT or GITHUB_PATH, instead of passed through an environment variable (CWE-77).
- Token permissions: no top-level permissions block, or write-all; each job should ask only for what it needs (Scorecard Token-Permissions).
- Third-party actions referenced by a tag or branch instead of a full commit SHA (Scorecard Pinned-Dependencies, CWE-829).
- Secrets passed to steps that run untrusted code, echoed, or uploaded in artifacts; actions/checkout leaving its token in .git (persist-credentials) for later steps that run untrusted code; self-hosted runners used for pull requests from forks.

Dependencies and builds:
- Code fetched without pinning or an integrity check: curl | sh, unpinned installs in CI, Docker images by the latest tag, CMake FetchContent or ExternalProject without a commit hash or URL_HASH (CWE-494).
- An internal package index that can fall back to the public one for the same names (dependency confusion).

Cite the workflow file and job, or the build file and line. When a risk depends on repository or runner settings you cannot see, say so under limitations instead of reporting it.
