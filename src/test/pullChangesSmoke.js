const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { BranchService } = require('../../out/services/branchService.js');

// Ignore the developer's global pull.rebase/pull.ff settings, for this process and the git it spawns.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Pull Test', GIT_AUTHOR_EMAIL: 'pull@example.com',
  GIT_COMMITTER_NAME: 'Pull Test', GIT_COMMITTER_EMAIL: 'pull@example.com'
});
const bases = [];
const env = process.env;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// upstream: pushes to a bare remote; local: a second clone that pulls.
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-pull-'));
  bases.push(base);
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
  git(local, 'config', 'pull.rebase', 'false');
  return { upstream, local };
}
function commit(repo, file, content, message) {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', message);
}
const pull = repo => new BranchService(new GitCommandService(repo)).pullChanges('.');

async function main() {
  try {
    let repos = setup();
    commit(repos.upstream, 'f.txt', '2\n', 'upstream');
    git(repos.upstream, 'push', '-q');
    let result = await pull(repos.local);
    assert.equal(result.success, true, result.message);
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), git(repos.upstream, 'rev-parse', 'HEAD'));

    // Detached HEAD is refused instead of merging the remote default branch into it.
    repos = setup();
    commit(repos.upstream, 'f.txt', '2\n', 'upstream');
    git(repos.upstream, 'push', '-q');
    git(repos.local, 'checkout', '-q', '--detach');
    const detachedAt = git(repos.local, 'rev-parse', 'HEAD');
    result = await pull(repos.local);
    assert.equal(result.success, false);
    assert.match(result.message, /HEAD is detached/);
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), detachedAt);

    // A conflicting pull says a merge is in progress, not just the fetch output.
    repos = setup();
    commit(repos.upstream, 'f.txt', '2\n', 'upstream');
    git(repos.upstream, 'push', '-q');
    commit(repos.local, 'f.txt', '3\n', 'local');
    result = await pull(repos.local);
    assert.equal(result.success, false);
    assert.match(result.message, /conflicts; a merge is in progress in main/);
    assert.equal(existsSync(path.join(repos.local, '.git', 'MERGE_HEAD')), true);

    // Divergence without a configured strategy (or with pull.ff=only) explains what to do.
    for (const ffOnly of [false, true]) {
      repos = setup();
      git(repos.local, 'config', '--unset', 'pull.rebase');
      if (ffOnly) git(repos.local, 'config', 'pull.ff', 'only');
      commit(repos.upstream, 'f.txt', '2\n', 'upstream');
      git(repos.upstream, 'push', '-q');
      commit(repos.local, 'g.txt', 'x\n', 'local');
      result = await pull(repos.local);
      assert.equal(result.success, false);
      assert.match(result.message, /main and origin\/main have diverged/);
    }

    // A branch tracking a differently named upstream pulls from that upstream.
    repos = setup();
    git(repos.upstream, 'checkout', '-q', '-b', 'feature/x');
    git(repos.upstream, 'push', '-q', '-u', 'origin', 'feature/x');
    git(repos.local, 'fetch', '-q');
    git(repos.local, 'checkout', '-q', '-b', 'x', '--track', 'origin/feature/x');
    commit(repos.upstream, 'f.txt', '2\n', 'upstream on feature/x');
    git(repos.upstream, 'push', '-q');
    result = await pull(repos.local);
    assert.equal(result.success, true, result.message);
    assert.match(result.message, /origin\/feature\/x into x/);
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), git(repos.upstream, 'rev-parse', 'HEAD'));

    // A branch with no remote counterpart reports git's reason without fetch noise.
    repos = setup();
    git(repos.local, 'checkout', '-q', '-b', 'local-only');
    result = await pull(repos.local);
    assert.equal(result.success, false);
    assert.match(result.message, /couldn't find remote ref local-only/);
    assert.doesNotMatch(result.message, /^Failed to pull: fatal:/);

    console.log('Pull changes smoke passed');
  } finally {
    bases.forEach(base => rmSync(base, { recursive: true, force: true }));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
