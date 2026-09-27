const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewSnapshot, ReviewSnapshotService } = require('../../out/services/reviewSnapshotService.js');
const { ReviewPolicyService, parseReviewPolicy, REVIEW_POLICY_PATH } = require('../../out/services/reviewPolicyService.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-snapshot-'));
function git(...args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }
function write(name, content) {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
}
function commit(message) { git('add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); }

async function main() {
  try {
    git('init', '-q');
    write('src/app.js', 'const secret = "one";\nconsole.log(secret);\n');
    const first = commit('first');
    const example = { version: 1, rules: [{
      id: 'TEAM-01', description: 'No secrets in code', scope: { include: ['src/**'] },
      severity: 'high', verification: 'ai', requiredEvidence: 'Identify the literal and its use'
    }] };
    write('src/app.js', 'const secret = "two";\nconsole.log(secret);\n');
    write(REVIEW_POLICY_PATH, JSON.stringify(example, null, 2));
    const second = commit('update');
    // HEAD and the working tree intentionally diverge from the target revision.
    git('checkout', '-q', first);
    write('src/app.js', 'UNCOMMITTED CONTENT\n');
    const gitService = new GitCommandService(repo);
    const service = new ReviewSnapshotService(gitService);
    const snapshot = await service.open('.', second);
    assert.equal(snapshot.targetSha, second);
    assert.equal(snapshot.fileExists('src/app.js'), true);
    assert.equal(snapshot.fileExists('src/missing.js'), false);
    assert.equal(snapshot.listTree('src').totalEntries, 1);
    const file = await snapshot.readFile('src/app.js', 1, 1);
    assert.equal(file.content, 'const secret = "two";');
    assert.equal(file.revision, second);
    assert.equal(file.truncated, true);
    assert.deepEqual((await snapshot.searchCode('"two"')).matches.map(match => match.path), ['src/app.js']);
    const diff = await snapshot.readDiff(first, 'src/app.js');
    assert.match(diff.patch, /\+const secret = "two"/);
    const policyService = new ReviewPolicyService();
    const policy = await policyService.load(snapshot);
    assert.equal(policy.status, 'configured');
    assert.equal(policy.policy.rules[0].id, 'TEAM-01');
    assert.match(policy.hash, /^[0-9a-f]{64}$/);
    assert.equal((await policyService.load(await service.open('.', first))).status, 'not_configured');
    const partial = new ReviewSnapshot(gitService, repo, first, { entries: [], totalEntries: 50001, truncated: true });
    await assert.rejects(policyService.load(partial), /cannot determine policy presence/);
    await assert.rejects(snapshot.readFile('../outside'));
    await assert.rejects(snapshot.readFile('src/app.js', 0));
    await assert.rejects(snapshot.readDiff('HEAD'));
    assert.throws(() => parseReviewPolicy(JSON.stringify({ ...example, rules: [example.rules[0], example.rules[0]] })), /duplicates id/);
    assert.throws(() => parseReviewPolicy('{'), /invalid JSON/);
    console.log('Review snapshot and policy smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
