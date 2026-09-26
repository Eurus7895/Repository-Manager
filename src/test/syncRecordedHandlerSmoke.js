const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-sync-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'Sync Test', GIT_AUTHOR_EMAIL: 'sync@example.com', GIT_COMMITTER_NAME: 'Sync Test', GIT_COMMITTER_EMAIL: 'sync@example.com' }
}).trim();

const prompts = [];
let answer;
const fakeVscode = { window: {
  async showWarningMessage(message, options, ...items) {
    prompts.push({ message, options, items });
    return answer;
  },
  showInformationMessage() {}, showErrorMessage() {}
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleSyncRepositoryToRecorded } = require('../../out/handlers/webviewMessageHandler.js');
const { GitOperations } = require('../../out/gitOperations.js');
Module._load = originalLoad;

async function main() {
  try {
    const origin = path.join(base, 'lib');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(origin, 'a.txt'), 'a\n');
    git(origin, 'add', 'a.txt');
    git(origin, 'commit', '-qm', 'lib base');
    const parent = path.join(base, 'parent');
    mkdirSync(parent);
    git(parent, 'init', '-q', '-b', 'main');
    git(parent, 'submodule', 'add', '-q', origin, 'lib');
    git(parent, 'commit', '-qm', 'add lib');
    const lib = path.join(parent, 'lib');
    const recorded = git(lib, 'rev-parse', 'HEAD');
    writeFileSync(path.join(lib, 'b.txt'), 'b\n');
    git(lib, 'add', 'b.txt');
    git(lib, 'commit', '-qm', 'unrecorded');
    const moved = git(lib, 'rev-parse', 'HEAD');

    let refreshed = 0;
    const ctx = { workspaceRoot: parent, gitOps: new GitOperations(parent), async refresh() { refreshed++; } };

    // Dismissing the modal leaves the repository untouched.
    answer = undefined;
    await handleSyncRepositoryToRecorded(ctx, { repositoryPath: 'lib' });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].options.modal, true);
    assert.match(prompts[0].message, new RegExp(`recorded commit ${recorded.slice(0, 8)}`));
    assert.match(prompts[0].options.detail, /Branch 'main' keeps its commits/);
    assert.deepEqual(prompts[0].items, ['Reset to recorded']);
    assert.equal(git(lib, 'rev-parse', 'HEAD'), moved);
    assert.equal(refreshed, 0);

    // Confirming checks out the recorded commit and refreshes the dashboard.
    answer = 'Reset to recorded';
    await handleSyncRepositoryToRecorded(ctx, { repositoryPath: 'lib' });
    assert.equal(git(lib, 'rev-parse', 'HEAD'), recorded);
    assert.equal(git(lib, 'rev-parse', 'main'), moved);
    assert.equal(refreshed, 1);
    console.log('Sync to recorded handler smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
