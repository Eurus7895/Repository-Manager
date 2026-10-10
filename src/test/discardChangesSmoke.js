const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-discard-'));
const identity = { GIT_AUTHOR_NAME: 'Discard Test', GIT_AUTHOR_EMAIL: 'discard@example.com',
  GIT_COMMITTER_NAME: 'Discard Test', GIT_COMMITTER_EMAIL: 'discard@example.com' };
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, identity);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The VS Code API the handler uses: modals answered by `answer`, and a Trash that can refuse.
const shown = [];
const modals = [];
let answer = () => undefined;
let trashRefuses = false;
const trashed = [];
const trash = path.join(base, 'trash');
mkdirSync(trash);
const fakeVscode = {
  window: {
    showInformationMessage(message) { shown.push(['info', message]); return Promise.resolve(undefined); },
    showErrorMessage(message) { shown.push(['error', message]); return Promise.resolve(undefined); },
    showWarningMessage(message, options, ...items) {
      if (!options || !options.modal) { shown.push(['warning', message]); return Promise.resolve(undefined); }
      modals.push({ message, detail: options.detail, items });
      return Promise.resolve(answer(message, items));
    }
  },
  workspace: { fs: { delete: async (uri, options) => {
    if (options.useTrash) {
      if (trashRefuses) throw new Error('Unable to delete file via trash because provider does not support it.');
      trashed.push(uri.fsPath);
      renameSync(uri.fsPath, path.join(trash, `${trashed.length}-${path.basename(uri.fsPath)}`));
    } else {
      rmSync(uri.fsPath);
    }
  } } },
  Uri: { file: fsPath => ({ fsPath }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { messageHandlers } = require('../../out/handlers/webviewMessageHandler.js');
const { GitOperations } = require('../../out/gitOperations.js');
Module._load = originalLoad;

function repository(name) {
  const repo = path.join(base, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  return repo;
}

/** Runs one discard request; `reply` answers each modal (by its message and buttons). */
async function discard(repo, payload, reply = () => undefined) {
  shown.length = 0;
  modals.length = 0;
  answer = reply;
  const posted = [];
  const reloads = [];
  const ctx = {
    panel: { webview: { postMessage: async message => { posted.push(message); return true; } } },
    gitOps: new GitOperations(repo), prManager: {}, workspaceRoot: repo,
    refresh: async () => { reloads.push('refresh'); }, reloadDashboardHistory: async paths => { reloads.push(paths); }
  };
  await messageHandlers.discardChanges(ctx, { repositoryPath: '.', ...payload });
  const results = posted.filter(message => message.type === 'discardChangesResult');
  assert.equal(results.length, 1, 'the dashboard was not told the discard ended');
  return { result: results[0].payload, modals: modals.slice(), shown: shown.slice(), reloads };
}

const status = repo => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
  .split('\n').filter(Boolean).sort();
const stashes = repo => git(repo, 'stash', 'list', '--format=%gs').split('\n').filter(Boolean);
const stashed = (repo, ref = 'stash@{0}') => git(repo, 'diff', '--name-status', '--no-renames', `${ref}^1`, ref).split('\n').filter(Boolean).sort();
const read = (repo, file) => readFileSync(path.join(repo, file), 'utf8');
const confirmWith = label => (_message, items) => items.includes(label) ? label : undefined;

async function testOneFile() {
  const repo = repository('one');
  for (const file of ['a.txt', 'b.txt', 'keep.txt', 'partly.txt']) writeFileSync(path.join(repo, file), `${file} base\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  // A modified file goes back to HEAD; the other changes, staged or not, stay as they were.
  writeFileSync(path.join(repo, 'a.txt'), 'a.txt edited\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b.txt edited\n');
  writeFileSync(path.join(repo, 'keep.txt'), 'keep.txt staged\n');
  git(repo, 'add', 'keep.txt');
  let run = await discard(repo, { paths: ['a.txt'] }, confirmWith('Discard Changes'));
  assert.equal(run.modals.length, 1);
  assert.equal(run.modals[0].message, 'Discard changes to a.txt?');
  assert.match(run.modals[0].detail, /a\.txt in one goes back to the last commit: its staged and unstaged changes are discarded/);
  assert.match(run.modals[0].detail, /backup is kept as a stash/);
  assert.equal(read(repo, 'a.txt'), 'a.txt base\n');
  assert.deepEqual(status(repo), ['M  keep.txt', ' M b.txt'].sort());
  assert.deepEqual(run.result, { repositoryPath: '.', changed: true });
  assert.deepEqual(run.reloads, [['.'], 'refresh']);
  assert.deepEqual(run.shown, [['info', 'Discarded changes to 1 file. Backup: stash@{0} (Git: Apply Stash brings it back).']]);
  // The backup holds that file only, and applying it brings the change back next to the others.
  assert.deepEqual(stashes(repo), ['On main: Repository Manager: discarded a.txt']);
  assert.deepEqual(stashed(repo), ['M\ta.txt']);
  git(repo, 'stash', 'pop', '-q');
  assert.equal(read(repo, 'a.txt'), 'a.txt edited\n');
  assert.deepEqual(status(repo), ['M  keep.txt', ' M a.txt', ' M b.txt'].sort());

  // Partly staged: both parts go, and `stash apply --index` gives back each part where it was.
  git(repo, 'reset', '-q', '--hard');
  writeFileSync(path.join(repo, 'partly.txt'), 'partly.txt staged\n');
  git(repo, 'add', 'partly.txt');
  writeFileSync(path.join(repo, 'partly.txt'), 'partly.txt staged\nthen edited\n');
  run = await discard(repo, { paths: ['partly.txt'] }, confirmWith('Discard Changes'));
  assert.equal(read(repo, 'partly.txt'), 'partly.txt base\n');
  assert.deepEqual(status(repo), []);
  git(repo, 'stash', 'apply', '-q', '--index');
  assert.deepEqual(status(repo), ['MM partly.txt']);
  assert.equal(git(repo, 'show', ':partly.txt'), 'partly.txt staged');
  assert.equal(read(repo, 'partly.txt'), 'partly.txt staged\nthen edited\n');

  // Cancelled: nothing changes and no backup is made, but the buttons are released.
  const before = stashes(repo).length;
  run = await discard(repo, { paths: ['partly.txt'] });
  assert.deepEqual(status(repo), ['MM partly.txt']);
  assert.equal(stashes(repo).length, before);
  assert.deepEqual([run.result.changed, run.reloads, run.shown], [false, [], []]);

  // A file that changed state while the modal was open (staged meanwhile) is left alone.
  git(repo, 'reset', '-q', '--hard');
  writeFileSync(path.join(repo, 'b.txt'), 'b.txt edited again\n');
  run = await discard(repo, { paths: ['b.txt'] }, (_message, items) => { git(repo, 'add', 'b.txt'); return items[0]; });
  assert.deepEqual(status(repo), ['M  b.txt']);
  assert.equal(stashes(repo).length, before);
  assert.equal(run.result.changed, false);
  assert.match(run.shown[0][1], /changed while you were confirming\. Nothing was discarded/);

  // A file that is no longer changed is not asked about.
  run = await discard(repo, { paths: ['a.txt'] }, confirmWith('Discard Changes'));
  assert.deepEqual([run.modals.length, run.shown], [0, [['error', 'a.txt is no longer changed. Nothing was discarded.']]]);
  run = await discard(repo, { paths: [] });
  assert.deepEqual(run.shown, [['error', 'Choose a changed file to discard.']]);

  // Staged as new: the file is not in HEAD, so it goes from the index and the disk (and the modal says so).
  git(repo, 'reset', '-q', '--hard');
  writeFileSync(path.join(repo, 'fresh.txt'), 'fresh\n');
  git(repo, 'add', 'fresh.txt');
  run = await discard(repo, { paths: ['fresh.txt'] }, confirmWith('Discard Changes'));
  assert.match(run.modals[0].detail, /^fresh\.txt in one is staged as a new file, not in the last commit: it is removed from the index and from the disk\./);
  assert.equal(existsSync(path.join(repo, 'fresh.txt')), false);
  assert.deepEqual(status(repo), []);
  assert.deepEqual(stashed(repo), ['A\tfresh.txt']);
  git(repo, 'stash', 'pop', '-q', '--index');
  assert.deepEqual(status(repo), ['A  fresh.txt']);
}

async function testEverything() {
  const repo = repository('all');
  const files = { 'mod.txt': 'mod', 'staged.txt': 'staged', 'del-staged.txt': 'del staged', 'del.txt': 'del',
    'old-name.txt': 'renamed file', '[x] *.txt': 'glob name', 'run.sh': 'run', 'uncached.txt': 'uncached', '.gitignore': 'ignored.log' };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(repo, file), `${content}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  writeFileSync(path.join(repo, 'mod.txt'), 'mod edited\n');
  writeFileSync(path.join(repo, 'staged.txt'), 'staged edited\n');
  git(repo, 'add', 'staged.txt');
  git(repo, 'rm', '-q', 'del-staged.txt');
  rmSync(path.join(repo, 'del.txt'));
  git(repo, 'mv', 'old-name.txt', 'new-name.txt');
  writeFileSync(path.join(repo, '[x] *.txt'), 'glob name edited\n');
  chmodSync(path.join(repo, 'run.sh'), 0o755);
  writeFileSync(path.join(repo, 'added.txt'), 'added\n');
  git(repo, 'add', 'added.txt');
  writeFileSync(path.join(repo, 'added.txt'), 'added\nand edited\n');
  // Staged as deleted but still on disk: Git lists it twice (deleted, and untracked). It is tracked.
  writeFileSync(path.join(repo, 'uncached.txt'), 'uncached edited\n');
  git(repo, 'rm', '-q', '--cached', 'uncached.txt');
  mkdirSync(path.join(repo, 'newdir/deep'), { recursive: true });
  writeFileSync(path.join(repo, 'newdir/deep/new.txt'), 'new\n');
  writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');
  writeFileSync(path.join(repo, 'ignored.log'), 'ignored\n');
  // A nested repository is never deleted, and a linked one (a gitlink) is discarded inside it.
  const nested = repository('all/nested');
  writeFileSync(path.join(nested, 'n.txt'), 'n\n');
  const linked = repository('all/linked');
  writeFileSync(path.join(linked, 'l.txt'), 'l\n');
  git(linked, 'add', 'l.txt');
  git(linked, 'commit', '-qm', 'linked');
  execFileSync('git', ['add', 'linked'], { cwd: repo, stdio: 'ignore' });

  // Skipped files alone: nothing to discard, and no modal.
  let run = await discard(repo, { paths: ['linked'] });
  assert.equal(run.modals.length, 0);
  assert.deepEqual(run.shown, [['error', 'Nothing to discard: linked (linked repository: discard inside it).']]);
  run = await discard(repo, { paths: ['nested/'] });
  assert.deepEqual(run.shown, [['error', 'Nothing to discard: nested/ (nested Git repository: never deleted).']]);

  run = await discard(repo, { all: true }, confirmWith('Discard All'));
  assert.equal(run.modals.length, 1);
  assert.equal(run.modals[0].message, 'Discard all uncommitted changes in all?');
  assert.match(run.modals[0].detail, /^9 changed files go back to the last commit: staged and unstaged changes are discarded\. A backup/);
  assert.match(run.modals[0].detail, /2 new files are moved to the Trash\./);
  assert.match(run.modals[0].detail, /Left as they are:\nlinked \(linked repository: discard inside it\)\nnested\/ \(nested Git repository: never deleted\)/);
  assert.match(run.modals[0].detail, /Files Git ignores are not touched\.$/);
  assert.equal(run.shown[0][1], 'Discarded changes to 9 files and moved 2 new files to the Trash. Backup: stash@{0} (Git: Apply Stash brings it back).');

  // Only the skipped changes are left; every tracked file is as committed.
  assert.deepEqual(status(repo), ['A  linked', '?? nested/n.txt'].sort().map(line => line.replace('nested/n.txt', 'nested/')));
  for (const [file, content] of Object.entries(files)) assert.equal(read(repo, file), `${content}\n`, file);
  assert.equal(existsSync(path.join(repo, 'new-name.txt')), false);
  assert.equal(existsSync(path.join(repo, 'added.txt')), false);
  assert.equal(statSync(path.join(repo, 'run.sh')).mode & 0o111, 0);
  // New files went to the Trash, with the folders they leave empty; ignored files stay.
  assert.deepEqual(trashed.map(file => path.relative(repo, file)).sort(), ['loose.txt', path.join('newdir', 'deep', 'new.txt')]);
  assert.equal(existsSync(path.join(repo, 'newdir')), false);
  assert.equal(read(repo, 'ignored.log'), 'ignored\n');
  assert.equal(read(path.join(repo, 'nested'), 'n.txt'), 'n\n');

  // The backup holds the discarded files only, and applying it brings them back.
  assert.deepEqual(stashed(repo), ['A\tadded.txt', 'A\tnew-name.txt', 'D\tdel-staged.txt', 'D\tdel.txt', 'D\told-name.txt',
    'M\t[x] *.txt', 'M\tmod.txt', 'M\trun.sh', 'M\tstaged.txt', 'M\tuncached.txt'].sort());
  git(repo, 'stash', 'apply', '-q');
  assert.equal(read(repo, '[x] *.txt'), 'glob name edited\n');
  assert.equal(read(repo, 'added.txt'), 'added\nand edited\n');
  assert.equal(read(repo, 'uncached.txt'), 'uncached edited\n');
  assert.equal(read(repo, 'new-name.txt'), 'renamed file\n');
  assert.equal(existsSync(path.join(repo, 'del.txt')), false);
  assert.notEqual(statSync(path.join(repo, 'run.sh')).mode & 0o111, 0);
}

async function testRefusals() {
  // A merge in progress: tracked files cannot go back to HEAD, but a new file can still go.
  const repo = repository('merge');
  for (const file of ['a.txt', 'c.txt']) writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'other');
  writeFileSync(path.join(repo, 'a.txt'), 'other\n');
  writeFileSync(path.join(repo, 'c.txt'), 'c.txt from other\n');
  git(repo, 'commit', '-qam', 'other');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'main');
  assert.throws(() => git(repo, 'merge', 'other'));
  writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  let run = await discard(repo, { all: true }, confirmWith('Discard All'));
  assert.equal(run.modals.length, 0);
  assert.deepEqual(run.shown, [['error', 'A merge is in progress: finish or abort it (Source Control) before discarding changes. Nothing was discarded.']]);
  run = await discard(repo, { paths: ['a.txt'] });
  assert.deepEqual(run.shown, [['error', 'Nothing to discard: a.txt (in conflict: resolve it in Source Control).']]);
  run = await discard(repo, { paths: ['new.txt'] }, confirmWith('Move to Trash'));
  assert.equal(run.modals[0].message, 'Move new.txt to the Trash?');
  assert.deepEqual(run.shown, [['info', 'Moved 1 new file to the Trash.']]);
  assert.equal(existsSync(path.join(repo, 'new.txt')), false);
  assert.deepEqual(stashes(repo), []);

  // No commit yet: there is no version to go back to.
  const unborn = repository('unborn');
  writeFileSync(path.join(unborn, 'staged.txt'), 'staged\n');
  git(unborn, 'add', 'staged.txt');
  run = await discard(unborn, { paths: ['staged.txt'] });
  assert.deepEqual(run.shown, [['error', 'This repository has no commit yet, so there is no version to go back to. Nothing was discarded.']]);
  run = await discard(unborn, { all: true });
  assert.match(run.shown[0][1], /no commit yet/);
  run = await discard(repository('clean'), { all: true });
  assert.deepEqual(run.shown, [['error', 'There are no uncommitted changes in clean.']]);
}

async function testTrashRefused() {
  // A file system without a Trash: deleting for good needs its own yes.
  const repo = repository('no-trash');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'base');
  writeFileSync(path.join(repo, 'a.txt'), 'a edited\n');
  writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  trashRefuses = true;
  try {
    let run = await discard(repo, { all: true }, confirmWith('Discard All'));
    assert.equal(run.modals.length, 2);
    assert.equal(run.modals[1].message, '1 new file could not be moved to the Trash. Delete it permanently?');
    assert.match(run.modals[1].detail, /^new\.txt\n\nUnable to delete file via trash/);
    assert.equal(run.shown[0][0], 'warning');
    assert.match(run.shown[0][1], /^Discarded changes to 1 file\. Backup: stash@\{0\} .* Could not remove new\.txt: Unable to delete/);
    assert.equal(read(repo, 'a.txt'), 'a\n');
    assert.equal(read(repo, 'new.txt'), 'new\n', 'declining the second question deleted the file');
    assert.equal(run.result.changed, true);

    run = await discard(repo, { paths: ['new.txt'] }, (_message, items) => items[0]);
    assert.deepEqual(run.modals.map(modal => modal.items), [['Move to Trash'], ['Delete Permanently']]);
    assert.deepEqual(run.shown.map(item => item[0]), ['error', 'info']);
    assert.equal(run.shown[1][1], 'Deleted 1 new file permanently.');
    assert.equal(existsSync(path.join(repo, 'new.txt')), false);
    assert.equal(run.result.changed, true);
  } finally {
    trashRefuses = false;
  }
}

async function testWithoutIdentity() {
  // Like `git stash`, the backup does not need a configured identity.
  const repo = repository('anonymous');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'config', 'user.useConfigOnly', 'true');
  writeFileSync(path.join(repo, 'a.txt'), 'a edited\n');
  for (const name of Object.keys(identity)) delete process.env[name];
  try {
    const run = await discard(repo, { paths: ['a.txt'] }, confirmWith('Discard Changes'));
    assert.equal(run.shown[0][0], 'info', run.shown[0][1]);
    assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>', 'stash@{0}'), 'git stash <git@stash>');
    assert.equal(read(repo, 'a.txt'), 'a\n');
  } finally {
    Object.assign(process.env, identity);
  }
}

async function main() {
  try {
    await testOneFile();
    await testEverything();
    await testRefusals();
    await testTrashRefused();
    await testWithoutIdentity();
    console.log('Discard changes smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
