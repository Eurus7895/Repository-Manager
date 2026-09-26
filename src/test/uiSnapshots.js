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

const root = path.resolve(__dirname, '../..');
const { GitOperations } = require(path.join(root, 'out/gitOperations'));
const { getHtmlForWebview } = require(path.join(root, 'out/webview/template'));
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
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
  });
}

function commitFile(repo, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
}

function createFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-ui-'));
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
  git(parent, 'checkout', '-q', '-b', 'feature/dashboard');
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
  return { base, parent };
}

function startServer(workspace) {
  const ops = new GitOperations(workspace);
  const resource = uri => ({ scheme: 'http', toString: () => uri });
  // Same list the panel builds: parent repository first, then linked repositories.
  const listRepositories = async () => {
    const parentRepo = await ops.getParentRepoInfo();
    const submodules = await ops.getSubmodules();
    return parentRepo ? [parentRepo, ...submodules] : submodules;
  };
  const handlers = {
    getHistory: async p => ({ type: 'historyLoaded', payload: { ...(await ops.getHistory({ repositoryPath: p.repositoryPath, limit: p.limit, offset: p.offset, search: p.search, branch: p.branch, includeRemotes: p.includeRemotes === true })), requestId: p.requestId || 0 } }),
    getRepositoryRefs: async p => ({ type: 'repositoryRefsLoaded', payload: await ops.getRepositoryRefs(p.repositoryPath) }),
    getCommitDetail: async p => ({ type: 'commitDetailLoaded', payload: { repositoryPath: p.repositoryPath, detail: await ops.getCommitDetail(p.repositoryPath, p.commitHash, p.baseRevision), baseRevision: p.baseRevision, targetRevision: p.commitHash } }),
    getFileDiff: async p => ({ type: 'fileDiffLoaded', payload: await ops.getFileDiff(p.repositoryPath, p.commitHash, p.path, p.baseRevision) }),
    refresh: async () => ({ type: 'updateSubmodules', payload: { submodules: await listRepositories() } })
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        const html = getHtmlForWebview(await listRepositories(), {
          graphScriptUri: resource('/resources/historyGraph.js'),
          scriptUri: resource('/resources/webview.js'),
          styleUri: resource('/resources/webview.css')
        }, [{ name: 'workspace', path: workspace, isCurrent: true }])
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
          .replace('<head>', `<head><style>${themeCss}</style><script>
            window.acquireVsCodeApi = () => ({
              getState() { return null; }, setState() {},
              postMessage(message) {
                fetch('/rpc', { method: 'POST', body: JSON.stringify(message) }).then(r => r.json())
                  .then(reply => { if (reply) window.postMessage(reply, '*'); });
              }
            });</script>`);
        res.setHeader('content-type', 'text/html');
        return res.end(html);
      }
      if (req.url.startsWith('/resources/')) {
        res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
        return res.end(fs.readFileSync(path.join(root, 'resources', path.basename(req.url))));
      }
      if (req.url === '/rpc') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        const handler = handlers[message.type];
        const reply = handler ? await handler(message.payload || {}) : null;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(reply));
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const { base, parent } = createFixture();
  const server = await startServer(parent);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const pageErrors = [];
  fs.mkdirSync(outputDir, { recursive: true });
  const openPage = async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url);
    await page.locator('.history-row').first().waitFor();
    return page;
  };
  const snap = (page, name) => page.screenshot({ path: path.join(outputDir, `${name}.png`) });

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
    await snap(page, '01-dashboard');

    // Diff shows file line numbers and hides git's file headers.
    await page.locator('.history-row', { hasText: 'update app in two places' }).click();
    await page.locator('#dashboardChangedFiles [data-action]').first().click();
    await page.locator('#dashboardDiff .diff-hunk').first().waitFor();
    const diffText = await page.locator('#dashboardDiff').textContent();
    assert.doesNotMatch(diffText, /diff --git|^index /m);
    const firstAddition = page.locator('#dashboardDiff .diff-addition').first();
    assert.equal(await firstAddition.locator('.diff-ln').nth(1).textContent(), '3');
    await snap(page, '02-commit-diff');

    // Switching repositories reloads history for the selected one.
    await libB.click();
    await page.locator('.history-row', { hasText: 'unrecorded lib-b change' }).waitFor();
    assert.equal(await libB.getAttribute('aria-current'), 'true');
    await snap(page, '03-linked-repository');

    await page.close();
    await snap(await openPage(820, 700), '04-narrow');

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
