// Renders the real dashboard webview in headless Chromium against a fixture
// workspace (parent repository + two submodules) and the compiled GitOperations
// backend, checks a few UX invariants, and writes screenshots to ui-snapshots/.
//
// Run with `npm run test:ui` (compiles first). Needs a Chromium that matches
// playwright-core: `npx playwright-core install chromium`, or set
// PLAYWRIGHT_CHROMIUM_PATH to an existing executable.
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const Module = require('module');

const root = path.resolve(__dirname, '../..');
// The extension's real message handlers run against a minimal fake `vscode` module.
const fakeVscode = {
  window: { showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {} },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
  Uri: { file: fsPath => ({ fsPath }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { GitOperations } = require(path.join(root, 'out/gitOperations'));
const { messageHandlers } = require(path.join(root, 'out/handlers/webviewMessageHandler'));
const { ReviewController } = require(path.join(root, 'out/reviewController'));
const { getHtmlForWebview } = require(path.join(root, 'out/webview/template'));
Module._load = originalLoad;
const outputDir = path.join(root, 'ui-snapshots');

// A trimmed VS Code "Dark Modern" palette so theme variables resolve.
const themeCss = `:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#ccc;--vscode-sideBar-background:#181818;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;
--vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#6e7681;--vscode-button-background:#0078d4;--vscode-button-hoverBackground:#026ec1;--vscode-button-foreground:#fff;--vscode-panel-border:#2b2b2b;
--vscode-testing-iconPassed:#73c991;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f85149;--vscode-editorInfo-foreground:#3794ff;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-focusBorder:#0078d4;--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#ccc;--vscode-dropdown-border:#3c3c3c;--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#ccc;--vscode-menu-border:#454545}`;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Fixed identity and dates give identical hashes and date labels on every run, so screenshots can be compared.
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: '2025-01-15T10:00:00Z', GIT_COMMITTER_DATE: '2025-01-15T10:00:00Z', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  });
}

function commitFile(repo, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
}

function createFixture() {
  // A fixed path keeps submodule URLs, and therefore every commit hash, identical between runs.
  const base = path.join(os.tmpdir(), 'repository-manager-ui-fixture');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  for (const name of ['lib-a', 'lib-b']) {
    const repo = path.join(base, 'origins', name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitFile(repo, 'README.md', `# ${name}\n`, `chore: initialize ${name}`);
  }
  const parent = path.join(base, 'workspace');
  fs.mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  commitFile(parent, 'src/app.txt', lines.join('\n') + '\n', 'feat: add app');
  for (const name of ['lib-a', 'lib-b']) git(parent, 'submodule', 'add', '-q', path.join(base, 'origins', name), name);
  git(parent, 'commit', '-q', '-m', 'chore: add linked repositories');
  git(parent, 'tag', '1.0.0'); // the release a release review starts from
  git(parent, 'checkout', '-q', '-b', 'feature/dashboard');
  // Long ref names like real-world ones exercise ref-pill wrapping in narrow layouts.
  git(parent, 'branch', 'claude/review-dashboard-layout-at-narrow-widths');
  lines[2] = 'line 3 changed';
  lines[35] = 'line 36 changed';
  lines.splice(20, 0, 'inserted line');
  commitFile(parent, 'src/app.txt', lines.join('\n') + '\n', 'feat: update app in two places');
  // lib-a follows the parent branch at the recorded commit; lib-b stays on main,
  // moves past the recorded commit, and has local edits.
  git(path.join(parent, 'lib-a'), 'checkout', '-q', '-b', 'feature/dashboard');
  git(path.join(parent, 'lib-b'), 'checkout', '-q', 'main');
  commitFile(path.join(parent, 'lib-b'), 'CHANGES.md', 'unrecorded\n', 'feat: unrecorded lib-b change');
  fs.appendFileSync(path.join(parent, 'lib-b', 'README.md'), 'local edit\n');
  // A second workspace folder, for switching folders in a multi-root workspace.
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  commitFile(other, 'notes.md', 'notes\n', 'docs: other folder notes');
  return { base, parent, other };
}

function startServer(workspace, otherFolder) {
  let ops = new GitOperations(workspace);
  let hostBusy = 0; // host messages still being handled
  let currentRoot = workspace;
  // The review runs through the real ReviewController with a scripted runner instead of Copilot.
  // ask: answers the consent question (a function, so a test can hold it open); remembered: "Always allow".
  const reviewProbe = { runner: null, copied: null, opened: null, questions: [], ask: actions => actions[0], remembered: new Set(),
    fixResponse: null, fixRequests: 0, workingTreeChanged: 0 };
  const resource = uri => ({ scheme: 'http', toString: () => uri });
  // Same list the panel builds: parent repository first, then linked repositories.
  const listRepositories = async (gitOps = ops) => {
    const parentRepo = await gitOps.getParentRepoInfo();
    const submodules = await gitOps.getSubmodules();
    return parentRepo ? [parentRepo, ...submodules] : submodules;
  };
  // Mirrors RepositoryManagerPanel: messages go to the real handler map, `refresh` is
  // handled by the panel itself, and replies are posted back into the page.
  const connect = async page => {
    const post = message => page.evaluate(data => window.postMessage(data, '*'), message).catch(() => undefined);
    // Like RepositoryManagerPanel._update: drop a result that a folder switch made stale.
    const refresh = async () => {
      const gitOps = ops;
      const submodules = await listRepositories(gitOps);
      if (gitOps === ops) await post({ type: 'updateSubmodules', payload: { submodules } });
    };
    const ctx = {
      panel: { webview: { postMessage: async message => { await post(message); return true; } } },
      get gitOps() { return ops; }, prManager: {}, workspaceRoot: workspace, refresh,
      reloadDashboardHistory: async repositoryPaths => post({ type: 'reloadDashboardHistory', payload: { repositoryPaths } })
    };
    const reviews = new ReviewController({
      workspaceRoot: () => currentRoot,
      post,
      ask: async (message, detail, actions) => { reviewProbe.questions.push({ message, actions }); return reviewProbe.ask(actions); },
      alwaysConfirm: () => false,
      isConsentRemembered: root => reviewProbe.remembered.has(root),
      rememberConsent: async root => { reviewProbe.remembered.add(root); },
      createRunner: () => ({ review: (request, token, progress) => reviewProbe.runner(request, token, progress) }),
      createCancellation: () => {
        const token = { isCancellationRequested: false };
        return { token, cancel() { token.isCancellationRequested = true; }, dispose() {} };
      },
      copyText: async text => { reviewProbe.copied = text; },
      saveText: async () => true,
      openText: async (content, revision, filePath, line) => { reviewProbe.opened = { revision, filePath, line }; },
      notify: () => {},
      createFixModel: () => ({ request: async () => { reviewProbe.fixRequests++; return { modelId: 'scripted-fix:1', response: reviewProbe.fixResponse }; } }),
      isDirtyInEditor: () => false,
      workingTreeChanged: () => { reviewProbe.workingTreeChanged++; }
    });
    await page.exposeFunction('__postToHost', async message => {
      hostBusy++;
      try {
      if (reviews.handles(message.type)) {
        await reviews.handle(message);
      } else if (message.type === 'switchWorkspaceFolder') {
        // Same as RepositoryManagerPanel._switchWorkspaceFolder.
        reviews.cancel();
        currentRoot = message.payload.folderPath;
        ops = new GitOperations(message.payload.folderPath);
        await post({ type: 'workspaceFolderChanged', payload: { repositories: await listRepositories() } });
      } else if (message.type === 'refresh') {
        await refresh();
        await post({ type: 'repositoryOperationResult', payload: { operation: 'refresh', success: true, message: 'Dashboard refreshed' } });
      } else if (messageHandlers[message.type]) {
        await messageHandlers[message.type](ctx, message.payload);
      }
      } finally {
        hostBusy--;
      }
    });
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        ops = new GitOperations(workspace); // every page starts in the main workspace folder
        currentRoot = workspace;
        const html = getHtmlForWebview(await listRepositories(), {
          graphScriptUri: resource('/resources/historyGraph.js'),
          scriptUri: resource('/resources/webview.js'),
          styleUri: resource('/resources/webview.css')
        }, [{ name: 'workspace', path: workspace, isCurrent: true }, { name: 'other', path: otherFolder, isCurrent: false }])
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
          .replace('<head>', `<head><style>${themeCss}</style><script>
            window.acquireVsCodeApi = () => ({
              getState() { return null; }, setState() {},
              postMessage(message) { window.__postToHost(message); }
            });</script>`);
        res.setHeader('content-type', 'text/html');
        return res.end(html);
      }
      if (req.url.startsWith('/resources/')) {
        res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
        return res.end(fs.readFileSync(path.join(root, 'resources', path.basename(req.url))));
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, connect, isHostIdle: () => hostBusy === 0, reviewProbe })));
}

async function main() {
  const { base, parent, other } = createFixture();
  const { server, connect, isHostIdle, reviewProbe } = await startServer(parent, other);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const pageErrors = [];
  fs.mkdirSync(outputDir, { recursive: true });
  const openPage = async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await connect(page);
    await page.goto(url);
    await page.locator('.history-row').first().waitFor();
    return page;
  };
  // Screenshots wait until nothing is loading and no toolbar button is busy or flashing a result,
  // so the same state renders to the same pixels on every run.
  const settled = page => page.waitForFunction(() => !Array.from(document.querySelectorAll('.dashboard-loading, .is-busy, .is-success, .is-error'))
    .some(element => element.getClientRects().length > 0));
  const snap = async (page, name) => {
    // Settled means: the host has answered everything, and the page shows no loading or result flash.
    for (let stable = 0; stable < 2;) {
      while (!isHostIdle()) await page.waitForTimeout(20);
      await settled(page);
      await page.waitForTimeout(150);
      stable = isHostIdle() && await page.evaluate(() => !document.querySelector('.is-busy, .is-success, .is-error')) ? stable + 1 : 0;
    }
    await page.screenshot({ path: path.join(outputDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  };

  try {
    const page = await openPage(1440, 900);

    // Repository switcher lists every repository and flags drift from the parent branch.
    const repositories = page.locator('.sidebar-repository-item');
    assert.equal(await repositories.count(), 3);
    assert.equal(await page.locator('#repositoryAlignment').textContent(), '1/2 aligned');
    const libB = page.locator('.sidebar-repository-item[data-path="lib-b"]');
    assert.match(await libB.textContent(), /drift/);
    assert.match(await libB.textContent(), /≠ recorded/);
    assert.equal(await page.locator('.sidebar-repository-item[data-path="lib-a"] .repo-badge-drift').count(), 0);
    // Only repositories off their recorded commit offer the reset action.
    assert.equal(await page.locator('.sidebar-repository-action[data-path="lib-b"]').count(), 1);
    assert.equal(await page.locator('.sidebar-repository-action[data-path="lib-a"]').count(), 0);
    await snap(page, '01-dashboard');
    await libB.hover();
    await snap(page, '01b-reset-to-recorded');

    // Branches are a folder tree: feature/dashboard sits under "feature", shown as "dashboard".
    const folders = await page.locator('#dashboardBranches .sidebar-branch-folder').evaluateAll(items =>
      items.map(item => [item.dataset.folder, item.getAttribute('aria-expanded')]));
    assert.deepEqual(folders, [['claude', 'true'], ['feature', 'true']]);
    const current = page.locator('#dashboardBranches .sidebar-ref-item.current');
    assert.equal(await current.getAttribute('data-branch'), 'feature/dashboard');
    assert.match(await current.textContent(), /^⑂dashboardHEAD$/);
    assert.equal(await page.locator('#dashboardBranches .sidebar-ref-row.branch-depth-1').count(), 2);
    const claudeLeaf = '#dashboardBranches .sidebar-ref-item[data-branch="claude/review-dashboard-layout-at-narrow-widths"]';
    await page.click('[data-action="toggleBranchFolder"][data-folder="claude"]');
    await page.locator(claudeLeaf).waitFor({ state: 'detached' });
    assert.equal(await page.getAttribute('[data-folder="claude"]', 'aria-expanded'), 'false');
    // The folder holding the checked-out branch cannot be collapsed out of sight.
    await page.click('[data-action="toggleBranchFolder"][data-folder="feature"]');
    assert.equal(await page.getAttribute('[data-folder="feature"]', 'aria-expanded'), 'true');
    await page.click('[data-action="toggleBranchFolder"][data-folder="claude"]');
    await page.locator(claudeLeaf).waitFor();

    // Diff shows file line numbers and hides git's file headers.
    await page.locator('.history-row', { hasText: 'update app in two places' }).click();
    await page.locator('#dashboardChangedFiles [data-action]').first().click();
    await page.locator('#dashboardDiff .diff-hunk').first().waitFor();
    const diffText = await page.locator('#dashboardDiff').textContent();
    assert.doesNotMatch(diffText, /diff --git|^index /m);
    const firstAddition = page.locator('#dashboardDiff .diff-addition').first();
    assert.equal(await firstAddition.locator('.diff-ln').nth(1).textContent(), '3');
    await snap(page, '02-commit-diff');

    // History context menu.
    await page.locator('.history-row', { hasText: 'add linked repositories' }).click({ button: 'right' });
    await page.locator('#historyContextMenu').waitFor();
    await snap(page, '05-context-menu');
    await page.mouse.click(5, 5);
    await page.locator('#historyContextMenu').waitFor({ state: 'hidden' });

    // Dialogs: focus moves in, Tab stays inside, Escape closes (an open dropdown first), focus returns.
    const activeInside = selector => page.evaluate(sel => document.querySelector(sel).contains(document.activeElement), selector);
    const newBranchButton = page.locator('[data-action="openCreateBranchModal"]');
    await newBranchButton.focus();
    await page.keyboard.press('Enter');
    await page.locator('#createBranchModal.active').waitFor();
    await page.waitForFunction(() => document.querySelector('#createBranchModal').contains(document.activeElement));
    assert.equal(await page.getAttribute('#createBranchModal .modal', 'role'), 'dialog');
    await snap(page, '06-create-branch-modal');
    const firstFocused = await page.evaluate(() => document.activeElement.outerHTML);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await activeInside('#createBranchModal'), true, 'Shift+Tab left the dialog');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.outerHTML), firstFocused, 'Tab did not wrap to the first control');
    await page.click('#baseBranchInput');
    await page.locator('#baseBranchDropdown.open').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#baseBranchDropdown.open').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#createBranchModal.active').count(), 1, 'Escape closed the dialog instead of the dropdown');
    await page.keyboard.press('Escape');
    await page.locator('#createBranchModal.active').waitFor({ state: 'detached' });
    assert.equal(await newBranchButton.evaluate(button => button === document.activeElement), true, 'focus did not return to New branch');

    await page.click('[data-action="openCommitChangesModal"]');
    await page.locator('#commitChangesModal.active').waitFor();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'commitMessage');
    await snap(page, '07-commit-modal');
    await page.keyboard.type('wip: draft message');
    await page.keyboard.press('Escape');
    await page.locator('#commitChangesModal.active').waitFor({ state: 'detached' });
    // Escape keeps the unsent message for the next time the dialog opens.
    await page.click('[data-action="openCommitChangesModal"]');
    await page.locator('#commitChangesModal.active').waitFor();
    assert.equal(await page.inputValue('#commitMessage'), 'wip: draft message');
    await page.keyboard.press('Escape');
    await page.locator('#commitChangesModal.active').waitFor({ state: 'detached' });

    // W6–W7: release review from the latest release tag, results, evidence jump and export.
    let releaseRunner;
    const runnerGate = new Promise(resolve => { releaseRunner = resolve; });
    reviewProbe.runner = async (request, token, progress) => {
      const components = [{ component: 'src', files: 1 }, { component: 'lib', files: 2 }, { component: 'docs', files: 1 }];
      const step = { phase: 'analyzing', unit: 2, units: 3, component: 'lib', filesDone: 1, filesTotal: 4, candidates: 2 };
      progress('Planned 3 component(s), 4 file(s)', { ...step, phase: 'planning', unit: 0, filesDone: 0, candidates: 0, components });
      progress('Reading related code (1/6)…', step);
      await runnerGate;
      const evidence = [{ revision: request.targetSha, path: 'src/app.txt', side: 'target', startLine: 3, endLine: 3 }];
      const finding = (id, severity, status, explanation) => ({ id, category: 'security', severity, confidence: 'high', status,
        explanation, impact: 'Untrusted input reaches a sensitive sink', suggestedAction: 'Validate the input first', evidence });
      return { request, policyResults: [], policyStatus: 'not_configured', modelId: 'scripted:1',
        findings: [finding('high-verified', 'high', 'verified', 'Changed line passes input to eval'),
          finding('critical-hypothesis', 'critical', 'hypothesis', 'Possible command injection through the same input')],
        limitations: ['Scripted review used by the UI test.'],
        coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } };
    };
    // Every entry point offers "Review changes" and "Review branch"; one click starts, no dialog.
    assert.equal(await page.locator('.review-release-group button').count(), 2);
    assert.equal(await page.locator('#reviewModal').count(), 0, 'the review dialog is gone');
    // The consent question is held open so the header can be checked while it waits.
    let answerConsent;
    reviewProbe.ask = () => new Promise(resolve => { answerConsent = resolve; });
    await page.click('.review-release-group [data-action="reviewRelease"][data-scope="changes"]');
    assert.equal(await page.getAttribute('#detailTabReview', 'aria-selected'), 'true');
    // The extension resolved the release range and reported it back.
    await page.waitForFunction(() => document.getElementById('reviewMeta').textContent === 'Diff: 1.0.0 → feature/dashboard');
    assert.equal(await page.textContent('#reviewStatus'), 'Waiting for confirmation…');
    assert.deepEqual(reviewProbe.questions.at(-1).actions, ['Start review', 'Always allow for this repository']);
    // Not snap(): the host is busy on purpose, waiting for the answer.
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outputDir, '09-review-waiting-for-consent.png'), animations: 'disabled', caret: 'hide' });
    // While it waits and runs, the dashboard stays on the review: no switching.
    const libBItem = page.locator('.sidebar-repository-item[data-path="lib-b"]');
    assert.equal(await libBItem.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.isDisabled('#workspaceFolderSelect'), true);
    assert.equal(await page.getAttribute('#detailTabChanges', 'aria-disabled'), 'true');
    assert.equal(await page.getAttribute('.review-release-group [data-scope="branch"]', 'aria-disabled'), 'true');
    // Forced: Playwright itself refuses aria-disabled targets; the handlers must ignore the click too.
    await libBItem.click({ force: true });
    await page.click('#detailTabChanges', { force: true });
    assert.equal(await libBItem.getAttribute('aria-current'), null, 'switched repository during a review');
    assert.equal(await page.getAttribute('#detailTabReview', 'aria-selected'), 'true', 'left the Review tab during a review');
    answerConsent('Always allow for this repository');
    // Progress: overall bar, where it is, and each component's state.
    await page.locator('.review-steps .review-step-current').waitFor();
    assert.equal(await page.getAttribute('.review-progress', 'aria-valuenow'), '25');
    assert.match(await page.textContent('.review-progress-where'), /Component 2 of 3: lib · Analyzing/);
    assert.match(await page.textContent('.review-progress-counts'), /1 of 4 files · 2 candidate findings · \d+s elapsed/);
    assert.deepEqual(await page.locator('.review-step').evaluateAll(items => items.map(item => item.className.replace('review-step ', ''))),
      ['review-step-done', 'review-step-current', 'review-step-pending']);
    assert.match(await page.textContent('.review-progress-message'), /Reading related code/);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outputDir, '09b-review-progress.png'), animations: 'disabled', caret: 'hide' });
    releaseRunner();
    await page.locator('.review-readiness.readiness-blocked').waitFor();
    // Finished: switching works again.
    assert.equal(await libBItem.getAttribute('aria-disabled'), null);
    assert.equal(await page.isDisabled('#workspaceFolderSelect'), false);
    const blocking = await page.locator('.review-body .review-blocking').textContent();
    const attention = await page.locator('.review-body .review-attention').locator('.review-finding').first().textContent();
    assert.match(blocking, /Changed line passes input to eval/);
    assert.match(attention, /critical/i, 'the critical hypothesis should lead the attention list');
    assert.match(attention, /hypothesis/);
    await snap(page, '10-review-results');

    // Triage: Needs fix keeps a finding in place; Dismiss moves it out of readiness, with a reason.
    assert.match(await page.textContent('.review-triage-summary'), /0 to fix.*0 dismissed.*2 not triaged/);
    assert.equal(await page.isDisabled('[data-action="proposeReviewFix"]'), true, 'Fix is enabled with nothing marked');
    const triage = (id, decision) => page.click(`.review-finding[data-finding-id="${id}"] [data-action="triageFinding"][data-decision="${decision}"]`);
    await triage('high-verified', 'fix');
    await page.waitForFunction(() => /1 to fix/.test(document.querySelector('.review-triage-summary').textContent));
    await triage('critical-hypothesis', 'dismiss');
    await page.locator('.review-dismissed .review-finding[data-finding-id="critical-hypothesis"]').waitFor();
    assert.match(await page.textContent('.review-triage-summary'), /1 to fix.*1 dismissed.*0 not triaged/);
    await page.selectOption('.review-dismiss-reason[data-finding-id="critical-hypothesis"]', 'accepted_risk');
    await page.waitForFunction(() => document.querySelector('.review-dismiss-reason').value === 'accepted_risk');
    // Pressing the active choice again clears it.
    await triage('critical-hypothesis', 'dismiss');
    await page.waitForFunction(() => !document.querySelector('.review-dismissed'));
    await triage('critical-hypothesis', 'dismiss');
    await page.selectOption('.review-dismiss-reason[data-finding-id="critical-hypothesis"]', 'accepted_risk');
    await page.waitForFunction(() => document.querySelector('.review-dismiss-reason') && document.querySelector('.review-dismiss-reason').value === 'accepted_risk');
    await page.click('[data-action="exportReview"][data-format="copy"]');
    for (let i = 0; i < 100 && !reviewProbe.copied; i++) await page.waitForTimeout(20);
    assert.match(reviewProbe.copied || '', /^# Release review — Diff: 1\.0\.0 → feature\/dashboard/);
    assert.match(reviewProbe.copied, /Triage: 1 marked to fix, 1 dismissed, 0 not triaged\./);
    assert.match(reviewProbe.copied, /## Dismissed by reviewer\n\n- \*\*CRITICAL security\*\*.*dismissed: accepted risk/);

    // Auto-fix: preview first; nothing is written until Apply, and nothing is committed.
    const appFile = path.join(parent, 'src/app.txt');
    const original = fs.readFileSync(appFile, 'utf8');
    reviewProbe.fixResponse = { edits: [{ path: 'src/app.txt', findingId: 'high-verified', find: 'line 3 changed', replace: 'line 3 fixed' }],
      notes: ['Add a test for the fixed input path.'] };
    await page.click('[data-action="proposeReviewFix"]');
    await page.locator('.review-fix-file').waitFor();
    assert.equal(reviewProbe.fixRequests, 1);
    assert.equal(fs.readFileSync(appFile, 'utf8'), original, 'the preview wrote the file');
    assert.match(await page.textContent('.review-fix'), /Proposed fix · 1 file/);
    assert.match(await page.textContent('.review-fix'), /Add a test for the fixed input path/);
    assert.equal(await page.locator('.review-fix .diff-addition').first().textContent(), '3+line 3 fixed');
    await snap(page, '10b-review-fix-preview');
    await page.click('[data-action="applyReviewFix"]');
    await page.locator('.review-fix-applied').waitFor();
    assert.match(fs.readFileSync(appFile, 'utf8'), /line 3 fixed/);
    assert.equal(reviewProbe.workingTreeChanged, 1);
    assert.equal(git(parent, 'diff', '--cached', '--name-only').trim(), '', 'auto-fix staged the file');
    assert.equal(git(parent, 'diff', '--name-only', '--', 'src').trim(), 'src/app.txt');
    // A second proposal is refused now that the file has local changes.
    await page.click('[data-action="proposeReviewFix"]');
    await page.waitForFunction(() => /local changes/.test(document.querySelector('.review-fix').textContent));
    assert.equal(reviewProbe.fixRequests, 1, 'asked the model despite local changes');
    git(parent, 'checkout', '--', 'src/app.txt');
    // Evidence opens the cited line in the dashboard diff.
    await page.locator('.review-body .review-blocking').locator('[data-action="reviewEvidence"]').first().click();
    await page.locator('#dashboardDiff .diff-line-highlight').waitFor();
    assert.equal(await page.getAttribute('#detailTabChanges', 'aria-selected'), 'true');
    assert.equal(await page.locator('#dashboardDiff .diff-line-highlight .diff-ln').nth(1).textContent(), '3');
    await snap(page, '11-review-evidence');

    // From here on the repository is allowed: a question would fail the test.
    const questionsAsked = reviewProbe.questions.length;
    reviewProbe.ask = () => undefined;
    const runs = [];
    const record = request => { runs.push(request); return { request, findings: [], policyResults: [], policyStatus: 'not_configured',
      limitations: [], coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } }; };
    reviewProbe.runner = async request => record(request);
    // Base/Target selection: both buttons sit in the comparison status.
    const nodes = page.locator('.graph-node-control');
    const [baseHash, targetHash] = [await nodes.nth(1).getAttribute('data-commit'), await nodes.nth(0).getAttribute('data-commit')];
    await nodes.nth(1).click();
    await nodes.nth(0).click();
    const compareButtons = page.locator('#commitCompareStatus .review-entry button');
    await compareButtons.first().waitFor();
    assert.deepEqual(await compareButtons.allTextContents(), ['Review changes', 'Review branch']);
    await snap(page, '12-compare-review-buttons');
    await compareButtons.nth(0).click();
    await page.waitForFunction(() => /^Diff: /.test(document.getElementById('reviewMeta').textContent) && document.querySelector('.review-readiness'));
    assert.deepEqual([runs.at(-1).scope, runs.at(-1).baseSha, runs.at(-1).targetSha], ['changes', baseHash, targetHash]);
    assert.equal(await page.textContent('#reviewMeta'), `Diff: ${baseHash.slice(0, 8)} → ${targetHash.slice(0, 8)}`);
    await page.click('#detailTabChanges');
    await page.locator('#commitCompareStatus .review-entry button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('reviewMeta').textContent.startsWith('Branch: '));
    for (let i = 0; i < 100 && runs.length < 2; i++) await page.waitForTimeout(20);
    assert.deepEqual([runs.at(-1).scope, runs.at(-1).baseSha, runs.at(-1).targetSha], ['branch', undefined, targetHash]);
    assert.deepEqual(runs.at(-1).categories, ['security', 'compliance']);

    // History menu: "changes" reviews the commit against its parent; "branch" every file at it.
    await page.locator('.history-row').first().click({ button: 'right' });
    assert.match(await page.textContent('#historyContextMenu [data-action="contextReviewCommit"]'), /Review changes/);
    await page.click('#historyContextMenu [data-action="contextReviewCommit"]');
    for (let i = 0; i < 100 && runs.length < 3; i++) await page.waitForTimeout(20);
    assert.deepEqual([runs.at(-1).scope, runs.at(-1).baseSha], ['changes', undefined]);
    await page.waitForFunction(() => document.getElementById('reviewMeta').textContent.startsWith('Diff: parent → '));
    // Cancelling a running branch review.
    reviewProbe.runner = (request, token) => new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (token.isCancellationRequested) { clearInterval(timer); reject(new Error('Cancelled')); } }, 20);
    });
    await page.locator('.history-row').first().click({ button: 'right' });
    await page.click('#historyContextMenu [data-action="contextReviewSnapshot"]');
    await page.locator('#cancelReviewButton').waitFor({ state: 'visible' });
    assert.match(await page.textContent('#reviewMeta'), /^Branch: /);
    await page.click('#cancelReviewButton');
    await page.waitForFunction(() => /Review cancelled/.test(document.getElementById('reviewBody').textContent));
    assert.equal(reviewProbe.questions.length, questionsAsked, 'asked for consent after "Always allow"');

    // One click switches the dashboard to the selected repository; no Refresh needed.
    await libB.click();
    await page.locator('.history-row', { hasText: 'unrecorded lib-b change' }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.history-row', { hasText: 'update app in two places' }).count(), 0);
    assert.equal(await libB.getAttribute('aria-current'), 'true');
    await snap(page, '03-linked-repository');

    // Messages are dispatched synchronously so the switcher is read before any real refresh lands.
    // A repository with no recorded commit is flagged and never counted as aligned.
    const alignment = await page.evaluate(() => {
      const list = window.__initialRepositories.map(repository => repository.path === 'lib-a'
        ? Object.assign({}, repository, { atRecordedCommit: undefined, recordedCommit: '' }) : repository);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateSubmodules', payload: { submodules: list } } }));
      return {
        summary: document.getElementById('repositoryAlignment').textContent,
        libA: document.querySelector('.sidebar-repository-item[data-path="lib-a"]').textContent
      };
    });
    assert.equal(alignment.summary, '0/2 aligned');
    assert.match(alignment.libA, /unrecorded/);

    // If the active repository disappears from the list, the dashboard falls back to the parent.
    const fallback = await page.evaluate(() => {
      const list = window.__initialRepositories.filter(repository => repository.path !== 'lib-b');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateSubmodules', payload: { submodules: list } } }));
      const active = document.querySelector('.sidebar-repository-item.active');
      return active && active.dataset.path;
    });
    assert.equal(fallback, '.');
    await page.locator('.history-row', { hasText: 'update app in two places' }).waitFor({ timeout: 5000 });

    // Choosing another workspace folder loads its history and repositories without Refresh.
    await page.selectOption('#workspaceFolderSelect', other);
    await page.locator('.history-row', { hasText: 'other folder notes' }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.history-row', { hasText: 'unrecorded lib-b change' }).count(), 0);
    assert.equal(await page.locator('.sidebar-repository-item').count(), 1);
    await snap(page, '03b-other-workspace-folder');

    // Continue/Abort rebase are offered only while a rebase is paused.
    const rebaseItems = page.locator('#historyContextMenu [data-requires-operation="rebase"]');
    await page.locator('.history-row').first().click({ button: 'right' });
    await page.locator('#historyContextMenu').waitFor();
    assert.equal(await rebaseItems.evaluateAll(items => items.filter(item => item.offsetParent).length), 0);
    await page.mouse.click(5, 5);
    git(other, 'checkout', '-q', '-b', 'topic');
    commitFile(other, 'notes.md', 'topic\n', 'docs: topic notes');
    git(other, 'checkout', '-q', 'main');
    commitFile(other, 'notes.md', 'main\n', 'docs: main notes');
    git(other, 'checkout', '-q', 'topic');
    assert.throws(() => git(other, 'rebase', 'main'), 'expected the fixture rebase to stop on a conflict');
    await page.locator('.history-row').first().click({ button: 'right' });
    await page.locator('#historyContextMenu [data-action="contextContinueRebase"]').waitFor({ state: 'visible' });
    await page.locator('#historyContextMenu [data-action="contextAbortRebase"]').waitFor({ state: 'visible' });
    await snap(page, '08-rebase-menu');
    await page.mouse.click(5, 5);

    await page.close();
    // Narrow editor splits: rows keep one-line ref pills, and the subject keeps a readable width.
    for (const [width, name] of [[820, '04-narrow'], [680, '04b-narrower']]) {
      const narrow = await openPage(width, 700);
      const layout = await narrow.evaluate(() => ({
        tallestRow: Math.max(...Array.from(document.querySelectorAll('.history-row')).map(row => row.getBoundingClientRect().height)),
        messageWidth: document.querySelector('.history-row .history-message').getBoundingClientRect().width,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // The review buttons must be fully on screen (the controls row clips, it does not scroll).
        releaseRight: document.querySelector('.review-release-group').getBoundingClientRect().right,
        controlsRight: document.querySelector('.history-controls').getBoundingClientRect().right,
        releaseText: document.querySelector('.review-release-group').innerText.replace(/\s+/g, ' ').trim()
      }));
      assert.ok(layout.releaseRight <= layout.controlsRight, `${width}px: the release review buttons are cut off`);
      assert.equal(layout.releaseText.toLowerCase(), '◈ changes branch');
      // With a Base/Target selection, the comparison pill keeps both review buttons on screen too.
      if (width > 760) {
        await narrow.locator('.graph-node-control').nth(1).click();
        await narrow.locator('.graph-node-control').nth(0).click();
        await narrow.locator('#commitCompareStatus .review-entry').waitFor();
        const pill = await narrow.evaluate(() => ({
          right: document.querySelector('#commitCompareStatus [data-action="clearCommitComparison"]').getBoundingClientRect().right,
          statusRight: document.getElementById('commitCompareStatus').getBoundingClientRect().right,
          controlsRight: document.querySelector('.history-controls').getBoundingClientRect().right
        }));
        assert.ok(pill.right <= pill.statusRight && pill.statusRight <= pill.controlsRight, `${width}px: the comparison review buttons are cut off`);
        assert.equal(await narrow.locator('.review-release-group').isVisible(), false, `${width}px: two sets of review buttons`);
        await snap(narrow, `${name}-compare`);
        await narrow.click('[data-action="clearCommitComparison"]');
        await narrow.locator('.review-release-group').waitFor();
      }
      assert.ok(layout.tallestRow <= 80, `${width}px: a history row is ${layout.tallestRow}px tall`);
      assert.ok(layout.messageWidth >= 150, `${width}px: the message column is only ${layout.messageWidth}px`);
      assert.equal(layout.pageOverflow, 0, `${width}px: the page scrolls horizontally`);
      await snap(narrow, name);
      await narrow.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log(`UI snapshots written to ${path.relative(process.cwd(), outputDir)}`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
