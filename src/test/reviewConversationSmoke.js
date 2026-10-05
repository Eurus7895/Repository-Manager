const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'vscode') return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { SecurityReviewProvider, parseModelJson, INITIAL_UNIT_CHARS } = require('../../out/services/securityReviewProvider.js');
const { SecurityReviewService } = require('../../out/services/securityReviewService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
Module._load = originalLoad;

// How a model reply is read: the JSON object, even when the model wraps it in prose or a fence.
assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
assert.deepEqual(parseModelJson('```json\n{"a":2}\n```'), { a: 2 });
assert.deepEqual(parseModelJson('Here is the result:\n{"a":"x}y\\"z","b":{"c":3}}\nHope this helps.'), { a: 'x}y"z', b: { c: 3 } });
assert.deepEqual(parseModelJson('{not json} then {"ok":true}'), { ok: true });
assert.equal(parseModelJson('I cannot review this file.'), undefined);
assert.equal(parseModelJson('[1, 2]'), undefined, 'an array is not the object the review needs');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-conversation-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/app.py'), 'print("hi")\n');
    fs.writeFileSync(path.join(repo, 'src/big.py'), Array.from({ length: 1000 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const target = git('rev-parse', 'HEAD');

    // Each scenario scripts the model's replies; `seen` records what the model was sent.
    let script;
    let seen;
    const model = { id: 'mock', version: '1', name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        seen.push(messages.slice());
        const reply = script(messages, seen.length);
        return { text: (async function* () { yield typeof reply === 'string' ? reply : JSON.stringify(reply); })() };
      } };
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const service = new SecurityReviewService(new GitCommandService(repo), provider);
    const done = { schemaVersion: 1, targetSha: target, findings: [], policyResults: [], limitations: [] };
    const review = () => service.review({ repositoryPath: '.', targetSha: target, scope: 'branch', categories: ['security'] },
      { isCancellationRequested: false }, () => {});
    const failures = result => [...new Set(result.coverage.failed.map(item => item.reason))];

    // A branch review has no base: read_diff is not offered, and calling it anyway is an error the
    // model is told about, not a failed component. Prose around the JSON is fine.
    seen = [];
    script = (messages, call) => call === 1 ? 'Let me look at the diff first.\n{"toolCall":{"name":"read_diff","args":{}}}' : `Done.\n${JSON.stringify(done)}`;
    let result = await review();
    assert.deepEqual(failures(result), []);
    assert.ok(!seen[0][0].includes('read_diff'), 'read_diff was offered without a base revision');
    assert.match(seen[1].at(-1), /"error":"No base revision for diff"/);
    assert.equal(result.coverage.analyzed, 2);

    // A reply that is not JSON gets one request to answer in the format; then it is accepted.
    seen = [];
    script = (messages, call) => call === 1 ? 'I reviewed the file and found nothing.' : done;
    result = await review();
    assert.deepEqual(failures(result), []);
    assert.match(seen[1].at(-1), /not a valid JSON object/);
    // Twice in a row, and the component fails as before.
    seen = [];
    script = () => 'Still prose.';
    result = await review();
    assert.deepEqual(failures(result), ['AI review returned invalid JSON']);
    assert.equal(seen.length, 2);

    // Out of tool calls: the model is asked for its result from what it read, instead of failing.
    seen = [];
    script = messages => (/tool budget is used up/.test(messages.at(-1)) ? done
      : { toolCall: { name: 'read_file', args: { path: 'src/app.py' } } });
    result = await review();
    assert.deepEqual(failures(result), []);
    assert.equal(seen.length, 6 + 2, 'six reads, then the request for a final answer');
    // A model that keeps asking for tools after that still fails the component.
    seen = [];
    script = () => ({ toolCall: { name: 'read_file', args: { path: 'src/app.py' } } });
    result = await review();
    assert.deepEqual(failures(result), ['AI review exceeded tool call budget']);
    // Searches beyond two are refused to the model as a result, not as a failure.
    seen = [];
    script = (messages, call) => call <= 3 ? { toolCall: { name: 'search_code', args: { query: 'print' } } } : done;
    result = await review();
    assert.deepEqual(failures(result), []);
    assert.match(seen[3].at(-1), /Search budget used up/);
    // A long file: the first 400 lines are sent; it is reported as partly reviewed with how much was
    // seen, unless the model reads the rest itself.
    seen = [];
    script = () => done;
    result = await review();
    assert.deepEqual(result.coverage.skipped, [{ path: 'src/big.py', partial: true, reason: 'Partly reviewed: the model saw 400 of 1,000 lines' }]);
    const sent = JSON.parse(seen[0][1]).files.find(file => file.path === 'src/big.py');
    assert.deepEqual([sent.endLine, sent.totalLines, sent.truncated], [400, 1000, true]);
    seen = [];
    script = (messages, call) => call === 1 ? { toolCall: { name: 'read_file', args: { path: 'src/big.py', startLine: 401, lineCount: 500 } } }
      : call === 2 ? { toolCall: { name: 'read_file', args: { path: 'src/big.py', startLine: 850, lineCount: 200 } } } : done;
    result = await review();
    assert.deepEqual(result.coverage.skipped, [], 'a file read to the end is not partly reviewed');
    assert.equal(result.coverage.complete, true);

    // A second commit: eight large files in one component, and a minified one-line file.
    fs.mkdirSync(path.join(repo, 'lib'));
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(repo, 'lib', `big${i}.py`), Array.from({ length: 300 }, (_, line) => `value_${i}_${line} = '${'x'.repeat(60)}'`).join('\n') + '\n');
    }
    fs.writeFileSync(path.join(repo, 'lib', 'bundle.min.js'), `var a=${'1+'.repeat(30000)}1;\n`);
    git('add', '.');
    git('commit', '-qm', 'two');
    const second = git('rev-parse', 'HEAD');
    const reviewSecond = () => service.review({ repositoryPath: '.', targetSha: second, scope: 'branch', categories: ['security'] },
      { isCancellationRequested: false }, () => {});
    const doneSecond = { ...done, targetSha: second };
    seen = [];
    script = (messages, call) => call === 1 && JSON.parse(messages[1]).component === 'lib'
      ? { toolCall: { name: 'read_file', args: { path: 'lib/bundle.min.js' } } } : doneSecond;
    result = await reviewSecond();
    const libPacket = seen.map(sent => JSON.parse(sent[1])).find(packet => packet.component === 'lib');
    // The component's files together stay within its budget, and each still gets a share.
    const sentChars = libPacket.files.reduce((sum, file) => sum + file.content.length, 0);
    assert.ok(sentChars <= INITIAL_UNIT_CHARS, `the first look sent ${sentChars} characters`);
    assert.ok(libPacket.files.every(file => file.content.length > 0), 'a file was sent empty');
    // A single line longer than the limit is cut inside the line, not dropped; reads are bounded too.
    // (Eight files per component: the planner puts the ninth into a second 'lib' component.)
    const bundle = seen.map(sent => JSON.parse(sent[1])).flatMap(packet => packet.files || []).find(file => file.path === 'lib/bundle.min.js');
    assert.ok(bundle.content.startsWith('var a=1+1+') && bundle.endLine === 0 && bundle.truncated);
    const readReply = JSON.parse(seen.find(sent => JSON.parse(sent[1]).component === 'lib' && sent.length > 2).at(-1)).result;
    assert.ok(readReply.content.length <= 16000 && /only its start is shown/.test(readReply.note));
    assert.match(result.coverage.skipped.find(item => item.path === 'lib/bundle.min.js').reason,
      /^Partly reviewed: the model saw the first [\d,]+ characters of line 1 \(of 1\)$/);
    console.log('Review conversation smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
