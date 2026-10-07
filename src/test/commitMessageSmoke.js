const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CommitMessageController } = require('../../out/commitMessageController.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-message-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'app.js'), 'one\n');
    git('add', 'app.js');
    git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'app.js'), 'one\ntwo\n');

    const posts = [];
    const questions = [];
    const prompts = [];
    let answer = 'Write message';
    let alwaysConfirm = false;
    const remembered = new Set();
    let reply = async () => ({ text: '```\nfeat(app): add the second line\n\nThe app needs both lines.\nCo-authored-by: Bot <bot@example.org>\n```', model: 'scripted:1' });
    const controller = new CommitMessageController({
      workspaceRoot: () => repo,
      post: async message => { posts.push(message); },
      ask: async (message, detail, actions) => { questions.push({ message, detail, actions }); return typeof answer === 'function' ? answer() : answer; },
      alwaysConfirm: () => alwaysConfirm,
      isConsentRemembered: root => remembered.has(root),
      rememberConsent: async root => { remembered.add(root); },
      complete: async (prompt, modelId, token) => { prompts.push({ prompt, modelId }); return reply(token); },
      createCancellation: () => {
        const token = { isCancellationRequested: false };
        return { token, cancel() { token.isCancellationRequested = true; }, dispose() {} };
      }
    });
    const last = type => posts.filter(message => message.type === type).at(-1);
    const generate = (requestId, extra = {}) => controller.handle({ type: 'generateCommitMessage',
      payload: { requestId, repositoryPath: '.', files: ['app.js'], modelId: 'deep', ...extra } });

    assert.equal(controller.handles('generateCommitMessage'), true);
    assert.equal(controller.handles('commitFiles'), false);

    // Nothing selected, or nothing to describe: no question, no model.
    await generate(1, { files: [] });
    assert.match(last('commitMessageFailed').payload.message, /Select the files to commit first/);
    await generate(2, { files: ['missing.js'] });
    assert.match(last('commitMessageFailed').payload.message, /None of the selected files has a diff/);
    assert.equal(questions.length + prompts.length, 0);

    // Declining sends nothing.
    answer = undefined;
    await generate(3);
    assert.equal(last('commitMessageFailed').payload.cancelled, true);
    assert.equal(prompts.length, 0);
    assert.deepEqual(questions.at(-1).actions, ['Write message', 'Always allow for this repository']);
    assert.match(questions.at(-1).detail, /none found: Conventional Commits/);

    // Accepted: the model gets the diff and the default convention; the reply comes back cleaned.
    answer = 'Write message';
    await generate(4);
    assert.equal(prompts.at(-1).modelId, 'deep');
    assert.match(prompts.at(-1).prompt, /Conventional Commits 1\.0\.0/);
    assert.match(prompts.at(-1).prompt, /\+two/);
    const written = last('commitMessageGenerated').payload;
    assert.deepEqual([written.requestId, written.message, written.model, written.convention],
      [4, 'feat(app): add the second line\n\nThe app needs both lines.', 'scripted:1', []]);

    // The repository's own convention is used, and named in the question.
    fs.writeFileSync(path.join(repo, 'CONTRIBUTING.md'), '# Contributing\n\n## Commit messages\n\nStart every commit subject with the ticket key, like ABC-12.\n');
    answer = 'Always allow for this repository';
    await generate(5);
    assert.match(questions.at(-1).detail, /\(CONTRIBUTING\.md\)/);
    assert.match(prompts.at(-1).prompt, /taken from CONTRIBUTING\.md[\s\S]*Start every commit subject with the ticket key/);
    assert.deepEqual(last('commitMessageGenerated').payload.convention, ['CONTRIBUTING.md']);
    // "Always allow" (shared with reviews) skips the question next time; the setting asks again.
    const asked = questions.length;
    await generate(6);
    assert.equal(questions.length, asked);
    alwaysConfirm = true;
    answer = 'Write message';
    await generate(7);
    assert.deepEqual(questions.at(-1).actions, ['Write message']);
    alwaysConfirm = false;

    // An empty or failing reply says so.
    reply = async () => ({ text: '  ', model: 'scripted:1' });
    await generate(8);
    assert.match(last('commitMessageFailed').payload.message, /returned no message/);
    reply = async () => { throw new Error('The selected files\' diff does not fit this model.'); };
    await generate(9);
    assert.match(last('commitMessageFailed').payload.message, /does not fit/);

    // Cancel while the model writes: the reply is dropped, nothing is posted for it.
    let release;
    reply = token => new Promise(resolve => { release = () => resolve({ text: token.isCancellationRequested ? 'late' : 'late', model: 'm' }); });
    const pending = generate(10);
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await controller.handle({ type: 'cancelCommitMessage' });
    release();
    await pending;
    assert.equal(posts.some(message => message.type === 'commitMessageGenerated' && message.payload.requestId === 10), false, 'a cancelled message arrived');

    // A newer request replaces an older one still running.
    let first;
    reply = () => new Promise(resolve => { first = resolve; });
    const older = generate(11);
    for (let i = 0; i < 100 && !first; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const firstResolve = first;
    reply = async () => ({ text: 'fix: newer', model: 'm' });
    await generate(12);
    firstResolve({ text: 'fix: older', model: 'm' });
    await older;
    assert.deepEqual(posts.filter(message => message.type === 'commitMessageGenerated').slice(-1).map(message => message.payload.message), ['fix: newer']);
    console.log('Commit message smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
