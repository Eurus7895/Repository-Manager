# AGENTS.md — Instructions for AI Agents and Harnesses

This file defines how to work in this repository. Keep it under 120 lines.
Keep product requirements and architecture in task-specific documents, not here.
Write repository documentation in English; converse in the user's language.

## Response Style

- Answer the current question directly; lead with the main conclusion.
- Scale depth to the question, complexity, and risk. Do not turn a simple answer into a post-mortem.
- Explain mechanisms and causal reasoning in plain language; define jargon when it helps.
- State assumptions and distinguish verified facts, inferences, and proposals.
- Support implementation claims with relevant code locations, logs, or test evidence. State what remains unverified.
- Quantify when measurements exist; never invent numbers or imply precision without evidence.
- Offer judgments and recommendations with reasons, rather than merely listing information.
- Ask for a decision only when a material unresolved trade-off requires the user's judgment.
- Respect reasoning ownership without forcing a lecture or a Socratic question sequence into every exchange.
- Be detailed enough to assess the conclusion and concise enough to keep the important point visible.

## Start Each Task

1. Read this file and any instructions scoped to the files you will touch.
2. Identify the requested outcome and any decisions already approved in the
   conversation. Do not restart discovery for settled decisions.
3. Discover the specification, design, and plan relevant to the current task.
   Start with user-provided references and the repository's documentation
   index, then search by feature, component, or affected code.
   Check scope, approval status, and superseding decisions before applying a
   document. Do not select it solely because it has the newest date.
   If no applicable document exists, state that and plan at the task's scale.
4. Inspect the actual files, interfaces, dependencies, tests, and working-tree
   changes relevant to the task before proposing edits.
5. Distinguish implemented behavior, approved requirements, and proposals.
   A document describing a command or component does not prove it exists.

## Interpret References Correctly

- Documents may reference other repositories or proposed interfaces. Verify repository ownership and actual availability before using those references.
- Do not assume an external runtime, command, or configuration exists here.
- Before implementing an integration, verify its interface and resolve where the new code belongs. Do not silently copy or modify another repository.
- When working in another repository, read its applicable instructions.
- Surface material conflicts between code, documents, and current user decisions. Do not silently convert an assumption into a requirement.

## Preserve the User's Reasoning Ownership

Use Problem → Design → Predict → Build → Validate → Learn.

- Let the user own problem framing, initial design, trade-offs, and technical decisions. Critique their reasoning after they have expressed it.
- Ask targeted questions only for unresolved decisions that affect the work. Reuse answers already given; do not turn each small step into a questionnaire.
- Before a meaningful implementation, elicit failure predictions if they have not already been stated, then add overlooked risks.
- Implement authorized work, including routine code, tests, and documentation.
- Report validation evidence; leave final product acceptance to the user.
- After a meaningful experiment, compare predictions with observed outcomes and record the lesson without forcing reflection after every small edit.

## Apply Feature-Centered Rings (FCR)

- Establish whether the task is Build or Study using the request and context. These are independent goals; do not require both to succeed simultaneously.
- Identify the central feature and its minimum value before expanding scope.
- Work on the nearest component blocking that feature. Set a sufficient stopping point before exploring its dependencies.
- Open another ring only for an actual blocker. Explain which blocker a prerequisite or improvement removes.
- When work is too difficult, split it, reduce scope, change the approach, or strengthen an earlier component as appropriate to the selected goal.
- Build: verify the complete feature after integration.
- Study: check explanation, independent reasoning, and transfer to a changed problem. Finishing an artifact alone does not establish understanding.

## Plan and Implement

- Scale the plan to the task. Use the existing approved plan when applicable; a small edit needs a short stated approach, not a new architecture document.
- Do not treat the product's runtime approval rules as instructions requiring user approval for every edit you make to this repository.
- Preserve unrelated local changes. Avoid destructive replacements without explicit authorization; prefer isolated, reviewable changes.
- Reuse verified capabilities before adding new abstractions or dependencies.
- Keep responsibilities and interfaces clear. If delegating authorized work, provide the goal, inputs, output contract, allowed scope, and acceptance checks; review returned artifacts rather than trusting completion summaries.
- Keep requirements, assumptions, decisions, and observed results distinct in persistent notes. Do not rely on conversation memory as the only record.

## Validate and Report

- Use tests appropriate to the change. For features and bug fixes, include failure cases and relevant integration behavior, not only happy paths.
- Run the affected user flow when feasible. Unit tests alone do not establish that the integrated application works.
- Do not claim commands, tests, or live runs succeeded without observing them. State what was checked, what failed, and what remains unverified.
- Keep credentials out of code, documents, logs, and test fixtures. Use test doubles for unit tests that would otherwise call external model providers.
- Record reproducible commands and evidence where useful. Separate technical readiness from user acceptance and subjective quality judgments.
- Update affected documentation when behavior or a decision changes.
- Do not commit or publish merely because a plan lists a future Git step.

## Branches and Commits — Read Before Every Git Command

- Use `Eurus <56497078+Eurus7895@users.noreply.github.com>` (the GitHub account's no-reply address) for both author and committer.
- Never persist `user.name` or `user.email` with `git config`.
- Use command-scoped identity flags for commits, rebases, cherry-picks, and amends: `git -c user.name='Eurus' -c user.email='56497078+Eurus7895@users.noreply.github.com' commit ...`
- Never add AI/tool attribution, co-author/session trailers, generated-by footers, or AI session links to commits, PRs, comments, or documents.
- Never push to `claude/*`; never put `codex` or `claude` in branch names or PR titles.
- Name branches `<type>/<area>-<outcome>` in lowercase kebab-case, using a Conventional Commits type; no session suffixes or tool prefixes.
- Start work from the latest `origin/main` (this repository has no `dev` branch): fetch, then create the branch from it. If `main` advances, fetch and rebase before pushing; never push a stale base.
- Release by tagging `main` (for example `1.7.0`) and publishing a GitHub release; the Build VSIX workflow packages that tag and attaches the VSIX. Do not cut a branch for a normal release.
- Only when a published version needs a patch and `main` has moved on, cut `release/<major>.<minor>` from that version's tag (the one exception to the naming rule above). Land only `fix:` commits on it, through PRs so CI runs (pushes to `release/*` do not trigger it), tag the patch (for example `1.7.1`) on it, and bring each fix back to `main` by merge or cherry-pick.
- Never amend a published commit; create a new commit instead.
- Follow Conventional Commits 1.0.0: lowercase type/scope, imperative subject, at most 72 characters, no trailing period; wrap body at 72 columns and explain why.
- Breaking changes require both `!` and a `BREAKING CHANGE:` footer.
- Update `CHANGELOG.md` (Keep a Changelog, under the upcoming version) before every PR; keep entries user-facing and summary-only.
- Set the version with `npm version <x.y.z> --no-git-tag-version`; the release tag is the version of record.

## This Repository

- VS Code extension: TypeScript host in `src/`, webview in `resources/` (`webview.js`, `webview.css`, `historyGraph.js`), HTML in `src/webview/template.ts`.
- Validate with `npm run lint`, `npm test` (compiles, then runs every suite), and `npm run test:ui` (Playwright screenshots of the real webview into `ui-snapshots/`; needs Chromium).
- Copilot (`vscode.lm`) calls are not available outside VS Code: tests use scripted runners and models. Live model paths remain unverified until run in VS Code; say so.
- There is no `docs/roadmap.md` or commit guard script here. Verify `origin/main` and any referenced file exist before relying on them; report gaps instead of inventing them.
