---
id: ci-supply-chain
name: CI/CD and supply chain
category: security
appliesTo: [".github/workflows/**", "**/action.yml", "**/action.yaml", ".gitlab-ci.yml", "**/Jenkinsfile", "azure-pipelines.yml", "**/.circleci/**", "**/package.json", "**/requirements*.txt", "**/pyproject.toml", "**/setup.py", "**/Dockerfile", "**/*.dockerfile", "**/go.mod", "**/Cargo.toml", "**/pom.xml", "**/build.gradle*"]
references: OpenSSF Scorecard (Dangerous-Workflow, Token-Permissions, Pinned-Dependencies, Branch-Protection); SLSA build track; CWE-829, CWE-494
---
Workflows:
- Untrusted code in a privileged context: pull_request_target or workflow_run that checks out or runs the pull request's code, or uses its artifacts, with secrets or a write token (Scorecard Dangerous-Workflow).
- Script injection: ${{ github.event.* }} values (titles, branch names, comments) placed directly in run: steps instead of passed through an environment variable.
- Token permissions: no top-level permissions block, or write-all; each job should ask only for what it needs (Scorecard Token-Permissions).
- Third-party actions referenced by a moving tag or branch instead of a full commit SHA (Scorecard Pinned-Dependencies, CWE-829).
- Secrets passed to steps that run untrusted code, echoed, or exposed through set-output or artifacts; self-hosted runners used for pull requests from forks.

Dependencies and builds:
- Packages fetched without pinning or integrity checks: curl | sh, unpinned pip/npm installs in CI, Docker images by latest tag (CWE-494).
- An internal package index that can fall back to the public one for the same names (dependency confusion).
- Build steps that publish artifacts without recorded provenance (SLSA).

Cite the workflow file and job. When a risk depends on repository or runner settings you cannot see, say so under limitations instead of reporting it.
