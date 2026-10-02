const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryService } = require('../../out/services/historyService.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'history-upstream-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function main() {
  try {
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const local = path.join(base, 'local');
    git(base, 'clone', '-q', remote, local);
    fs.writeFileSync(path.join(local, 'a.txt'), '1\n');
    git(local, 'add', 'a.txt');
    git(local, 'commit', '-qm', 'one');
    git(local, 'push', '-q', 'origin', 'HEAD:release', 'HEAD:work');
    // `work` tracks a differently named upstream; a same-named origin/work also exists.
    git(local, 'checkout', '-q', '-b', 'work', '--track', 'origin/release');
    const history = new HistoryService(new GitCommandService(local));

    const page = await history.getHistory({ repositoryPath: '.', includeRemotes: true });
    assert.equal(page.upstream, 'origin/release', 'the configured upstream was not reported');
    assert.ok(page.commits[0].refs.some(ref => ref.name === 'origin/release' && ref.kind === 'remote-branch'),
      'the upstream ref name does not match the decoration the graph looks for');

    // No upstream: a detached HEAD, and a branch without tracking.
    git(local, 'checkout', '-q', '--detach');
    assert.equal((await history.getHistory({ repositoryPath: '.' })).upstream, null);
    git(local, 'checkout', '-q', '-b', 'untracked');
    assert.equal((await history.getHistory({ repositoryPath: '.' })).upstream, null);
    console.log('History upstream smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
