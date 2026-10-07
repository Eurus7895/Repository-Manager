const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubmoduleService } = require('../../out/services/submoduleService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-list-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-qm', `edit ${file}`); };

async function main() {
  try {
    // Three libraries with a remote each, and a parent with its own remote.
    for (const name of ['lib-a', 'lib-b', 'lib-c', 'lib-d', 'parent']) {
      git(base, 'init', '-q', '--bare', '-b', 'main', `${name}.git`);
      git(base, 'clone', '-q', `${name}.git`, `seed-${name}`);
      commit(path.join(base, `seed-${name}`), 'README.md', `${name}\n`);
      git(path.join(base, `seed-${name}`), 'push', '-q', 'origin', 'main');
    }
    const parent = path.join(base, 'seed-parent');
    for (const name of ['lib-a', 'lib-b', 'lib-c', 'lib-d']) git(parent, 'submodule', 'add', '-q', path.join(base, `${name}.git`), `libs/${name}`);
    git(parent, 'config', '-f', '.gitmodules', 'submodule.libs/lib-a.branch', 'develop');
    git(parent, 'commit', '-qm', 'add libraries');
    git(parent, 'push', '-q', 'origin', 'main');
    // Parent: one commit ahead of its upstream, one behind (a commit pushed elsewhere).
    const other = path.join(base, 'other-parent');
    git(base, 'clone', '-q', path.join(base, 'parent.git'), other);
    commit(other, 'remote.txt', 'r\n');
    git(other, 'push', '-q', 'origin', 'main');
    git(parent, 'fetch', '-q');
    commit(parent, 'local.txt', 'l\n');
    // lib-a: on main tracking origin/main, two commits ahead.
    const libA = path.join(parent, 'libs/lib-a');
    commit(libA, 'a1.txt', '1\n');
    commit(libA, 'a2.txt', '2\n');
    // lib-b: detached at its own new commit (not the recorded one), with an unstaged edit.
    const libB = path.join(parent, 'libs/lib-b');
    commit(libB, 'b.txt', 'b\n');
    git(libB, 'checkout', '-q', '--detach');
    fs.appendFileSync(path.join(libB, 'README.md'), 'edit\n');
    // lib-c: a branch without upstream; origin/<branch> exists and is one commit ahead.
    const libC = path.join(parent, 'libs/lib-c');
    git(libC, 'checkout', '-q', '-b', 'topic');
    git(libC, 'push', '-q', 'origin', 'topic');
    commit(libC, 'c.txt', 'c\n');
    git(libC, 'push', '-q', 'origin', 'topic');
    git(libC, 'reset', '-q', '--hard', 'HEAD~1');
    // lib-d: listed in .gitmodules but not initialized.
    git(parent, 'submodule', 'deinit', '-q', '-f', 'libs/lib-d');

    const service = new SubmoduleService(new GitCommandService(parent));
    const strip = info => { const copy = { ...info }; delete copy.lastUpdated; return copy; };
    const short = (cwd, rev = 'HEAD') => git(cwd, 'rev-parse', rev).slice(0, 8);
    const recorded = name => git(parent, 'ls-tree', 'HEAD', `libs/${name}`).split(/\s+/)[2].slice(0, 8);

    assert.deepEqual(strip(await service.getParentRepoInfo()), { name: 'parent', path: '.', url: '', branch: 'main', currentCommit: short(parent),
      currentBranch: 'main', status: 'modified', hasChanges: true,
      // lib-a, lib-b and lib-c are at other commits than recorded: changes the parent can commit.
      changeCounts: { staged: 0, modified: 3, untracked: 0, conflicted: 0 }, ahead: 1, behind: 1, isParentRepo: true });
    const list = (await service.getSubmodules()).map(strip);
    const url = name => path.join(base, `${name}.git`);
    assert.deepEqual(list, [
      { name: 'libs/lib-a', path: 'libs/lib-a', url: url('lib-a'), branch: 'develop', currentCommit: short(libA), currentBranch: 'main',
        status: 'clean', hasChanges: false, changeCounts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, ahead: 2, behind: 0, recordedCommit: recorded('lib-a'), atRecordedCommit: false },
      { name: 'libs/lib-b', path: 'libs/lib-b', url: url('lib-b'), branch: 'main', currentCommit: short(libB), currentBranch: '',
        status: 'modified', hasChanges: true, changeCounts: { staged: 0, modified: 1, untracked: 0, conflicted: 0 }, ahead: 0, behind: 0, recordedCommit: recorded('lib-b'), atRecordedCommit: false },
      { name: 'libs/lib-c', path: 'libs/lib-c', url: url('lib-c'), branch: 'main', currentCommit: short(libC), currentBranch: 'topic',
        status: 'clean', hasChanges: false, changeCounts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, ahead: 0, behind: 1, recordedCommit: recorded('lib-c'), atRecordedCommit: true },
      { name: 'libs/lib-d', path: 'libs/lib-d', url: url('lib-d'), branch: 'main', currentCommit: '', currentBranch: '',
        status: 'uninitialized', hasChanges: false, changeCounts: undefined, ahead: 0, behind: 0, recordedCommit: recorded('lib-d'), atRecordedCommit: undefined }
    ]);
    // The same answer for one submodule on its own (used by pull requests).
    assert.deepEqual(strip(await service.getSubmoduleInfo('libs/lib-a', 'libs/lib-a')), list[0]);
    // A slow or failing status (here: a corrupt index) keeps the parent listed, with its state unknown.
    const index = path.join(parent, '.git', 'index');
    const saved = fs.readFileSync(index);
    fs.writeFileSync(index, 'not an index');
    const degraded = await service.getParentRepoInfo();
    assert.deepEqual([degraded && degraded.path, degraded && degraded.status], ['.', 'unknown']);
    fs.writeFileSync(index, saved);
    // A submodule path Git would quote (non-ASCII) still finds its recorded commit.
    git(parent, 'submodule', 'add', '-q', path.join(base, 'lib-a.git'), 'libs/módulo');
    git(parent, 'commit', '-qm', 'add a library with an accented path');
    const accented = (await service.getSubmodules()).find(item => item.path === 'libs/módulo');
    assert.equal(accented.recordedCommit, git(parent, 'rev-parse', 'HEAD:libs/módulo').slice(0, 8));
    assert.equal(accented.atRecordedCommit, true);
    // Not a repository at all: no parent, no submodules.
    const plain = fs.mkdtempSync(path.join(base, 'plain-'));
    const none = new SubmoduleService(new GitCommandService(plain));
    assert.equal(await none.getParentRepoInfo(), null);
    assert.deepEqual(await none.getSubmodules(), []);
    console.log('Repository list smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
