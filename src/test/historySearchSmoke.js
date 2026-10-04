const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryService } = require('../../out/services/historyService.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'history-search-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    // 2600 commits through fast-import: the oldest ones lie beyond the 2000 a search used to read.
    let stream = '';
    for (let i = 0; i < 2600; i++) {
      const message = i === 3 ? 'feat: Needle in an old commit' : `fix: change ${i}`;
      stream += `commit refs/heads/main\nauthor ${i === 7 ? 'Old Author' : 'Dev'} <dev${i}@example.org> ${1600000000 + i * 60} +0000\n` +
        `committer Dev <dev@example.org> ${1600000000 + i * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n` +
        `M 644 inline file.txt\ndata ${String(i).length + 1}\n${i}\n\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, env, input: stream });
    git('checkout', '-q', 'main');
    git('tag', 'release-old', 'HEAD~2590');
    const history = new HistoryService(new GitCommandService(repo));
    const search = (text, extra = {}) => history.getHistory({ repositoryPath: '.', limit: 100, search: text, ...extra });

    // Old commits are found: by subject (any case), by author, by a ref name and by hash.
    assert.deepEqual((await search('needle')).commits.map(commit => commit.subject), ['feat: Needle in an old commit']);
    assert.equal((await search('old author')).commits.length, 1);
    const tagged = git('rev-parse', 'release-old');
    assert.deepEqual((await search('release-old')).commits.map(commit => commit.hash), [tagged]);
    assert.deepEqual((await search(tagged.slice(0, 10))).commits.map(commit => commit.hash), [tagged]);
    assert.deepEqual((await search('no such text')).commits, []);
    // Pages: 'change 1' matches far more than a page; the next page continues where the first ended.
    const first = await search('change 1');
    assert.equal(first.commits.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = await search('change 1', { offset: 100 });
    assert.equal(second.commits.length, 100);
    assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.hash)).size, 200, 'the pages overlap');
    // Without a search, history still pages in topological order.
    const plain = await history.getHistory({ repositoryPath: '.', limit: 50 });
    assert.equal(plain.commits.length, 50);
    assert.equal(plain.commits[0].subject, 'fix: change 2599');
    console.log('History search smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
