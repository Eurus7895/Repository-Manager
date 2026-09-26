const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fetch Test', GIT_AUTHOR_EMAIL: 'fetch@example.com',
  GIT_COMMITTER_NAME: 'Fetch Test', GIT_COMMITTER_EMAIL: 'fetch@example.com'
});
const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-autofetch-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Minimal vscode surface used by RepositoryManagerPanel.
const posted = [];
let panelVisible = true;
let viewStateListener = () => {};
const settings = { autoFetch: true, autoFetchInterval: 5 };
const noopEvent = () => ({ dispose() {} });
const fakeVscode = {
  ViewColumn: { One: 1 },
  Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }) },
  window: {
    activeTextEditor: undefined,
    showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
    createWebviewPanel: () => ({
      get visible() { return panelVisible; },
      webview: {
        html: '', cspSource: 'test',
        asWebviewUri: uri => ({ scheme: 'test', toString: () => uri.fsPath }),
        postMessage: async message => { posted.push(message); return true; },
        onDidReceiveMessage: noopEvent
      },
      onDidDispose: noopEvent,
      onDidChangeViewState: listener => { viewStateListener = listener; return { dispose() {} }; },
      reveal() {}, dispose() {}
    })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
    onDidChangeConfiguration: noopEvent
  },
  lm: { selectChatModels: async () => [] },
  LanguageModelChatMessage: { User: text => text },
  CancellationTokenSource: class { constructor() { this.token = {}; } cancel() {} dispose() {} }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RepositoryManagerPanel } = require('../../out/repositoryManagerPanel.js');
Module._load = originalLoad;

async function waitFor(predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for background fetch');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main() {
  try {
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const upstream = path.join(base, 'upstream');
    git(base, 'clone', '-q', remote, upstream);
    git(upstream, 'checkout', '-q', '-b', 'main');
    writeFileSync(path.join(upstream, 'f.txt'), '1\n');
    git(upstream, 'add', 'f.txt');
    git(upstream, 'commit', '-qm', 'base');
    git(upstream, 'push', '-q', 'origin', 'main');
    const local = path.join(base, 'local');
    git(base, 'clone', '-q', remote, local);
    writeFileSync(path.join(upstream, 'f.txt'), '2\n');
    git(upstream, 'commit', '-qam', 'upstream change');
    git(upstream, 'push', '-q');

    // Hidden panel: no background fetch.
    panelVisible = false;
    RepositoryManagerPanel.createOrShow({ fsPath: base }, local);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(git(local, 'rev-parse', 'origin/main'), git(local, 'rev-parse', 'main'), 'fetched while hidden');

    // Becoming visible fetches, then pushes fresh ahead/behind counts to the webview.
    panelVisible = true;
    viewStateListener();
    await waitFor(() => posted.some(message => message.type === 'updateSubmodules'
      && message.payload.submodules.some(repository => repository.isParentRepo && repository.behind === 1)));
    assert.equal(git(local, 'rev-parse', 'origin/main'), git(upstream, 'rev-parse', 'HEAD'));

    RepositoryManagerPanel.currentPanel.dispose();
    console.log('Auto fetch panel smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
