const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewFixService, FixError, MAX_FIX_FILES } = require('../../out/services/reviewFixService.js');
const { ReviewController } = require('../../out/reviewController.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
const write = (file, content) => fs.writeFileSync(path.join(repo, file), content);
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const never = { isCancellationRequested: false };

async function rejects(promise, pattern) {
  await assert.rejects(promise, error => error instanceof FixError && pattern.test(error.message));
}

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    write('app.js', 'const input = read();\neval(input);\nmodule.exports = input;\n');
    write('util.js', 'exports.x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const head = git('rev-parse', 'HEAD');
    const finding = (id, file, line) => ({ id, category: 'security', severity: 'high', confidence: 'high', status: 'verified',
      explanation: 'Input reaches eval', impact: 'Code execution', suggestedAction: 'Parse instead of eval',
      evidence: [{ revision: head, path: file, side: 'target', startLine: line, endLine: line }] });
    const result = { request: { repositoryPath: '.', targetSha: head, scope: 'branch', categories: ['security'] },
      findings: [finding('f1', 'app.js', 2), finding('f2', 'util.js', 1), finding('other', 'missing-at-target.js', 1)],
      policyResults: [], policyStatus: 'not_configured', limitations: [],
      coverage: { surveyed: 2, analyzed: 2, skipped: [], failed: [], complete: true } };
    const service = new ReviewFixService(new GitCommandService(repo));
    let response;
    let sent;
    const model = { request: async (instructions, input) => { sent = input; return { modelId: 'fixer:1', response }; } };
    const propose = (overrides = {}) => service.propose({ repositoryPath: '.', result, findingIds: ['f1'], model, token: never,
      isDirtyInEditor: () => false, ...overrides });

    // Refusals the user can act on, before anything is sent.
    await rejects(propose({ findingIds: [] }), /Mark at least one finding/);
    // Only base-side evidence: nothing to edit. An unrelated untracked file must not turn this
    // into a "local changes" refusal (git status with no paths describes the whole repository).
    write('scratch.tmp', 'unrelated\n');
    const baseOnly = { ...result, findings: [{ ...finding('b1', 'app.js', 2),
      evidence: [{ revision: head, path: 'app.js', side: 'base', startLine: 2, endLine: 2 }] }] };
    await rejects(propose({ result: baseOnly, findingIds: ['b1'] }), /None of the marked findings cites a file/);
    fs.rmSync(path.join(repo, 'scratch.tmp'));
    sent = undefined;
    write('app.js', read('app.js') + '// local\n');
    await rejects(propose(), /app\.js has local changes/);
    git('checkout', '--', 'app.js');
    await rejects(propose({ isDirtyInEditor: absolute => absolute.endsWith('app.js') }), /unsaved changes in an editor/);
    const many = { ...result, findings: Array.from({ length: MAX_FIX_FILES + 1 }, (_, index) => finding(`m${index}`, `f${index}.js`, 1)) };
    await rejects(propose({ result: many, findingIds: many.findings.map(item => item.id) }), /up to 8 at a time/);
    assert.equal(sent, undefined, 'files were sent to the model before the working tree was checked');

    // A proposal applies only edits that match exactly once, in cited files.
    response = { edits: [
      { path: 'app.js', findingId: 'f1', find: 'eval(input);', replace: 'JSON.parse(input);' },
      { path: 'app.js', find: 'input', replace: 'x' },
      { path: 'app.js', find: 'not in the file', replace: 'y' },
      { path: '../outside.js', find: 'a', replace: 'b' },
      { path: 'app.js', find: '', replace: 'z' }
    ], notes: ['Validate the parsed value too.'] };
    const proposal = await propose();
    assert.deepEqual(sent.files.map(file => file.path), ['app.js']);
    assert.deepEqual(sent.findings.map(item => item.id), ['f1']);
    assert.deepEqual(proposal.files.map(file => file.path), ['app.js']);
    assert.equal(proposal.files[0].after, 'const input = read();\nJSON.parse(input);\nmodule.exports = input;\n');
    assert.match(proposal.files[0].patch, /^--- a\/app\.js$/m);
    assert.match(proposal.files[0].patch, /^-eval\(input\);$/m);
    assert.match(proposal.files[0].patch, /^\+JSON\.parse\(input\);$/m);
    assert.equal(proposal.rejected.length, 4);
    assert.ok(proposal.rejected.some(item => /found more than once/.test(item)));
    assert.ok(proposal.rejected.some(item => /not found/.test(item)));
    assert.ok(proposal.rejected.some(item => /not one of the cited files/.test(item)));
    assert.deepEqual(proposal.notes, ['Validate the parsed value too.']);
    assert.equal(read('app.js').includes('eval(input)'), true, 'propose wrote the file');

    // Nothing applicable: explain instead of an empty preview.
    response = { edits: [{ path: 'app.js', find: 'nope', replace: 'x' }], notes: [] };
    await rejects(propose(), /no change that could be applied/);

    // Apply re-checks the file, writes it, and never stages or commits.
    write('app.js', read('app.js').replace('read()', 'readInput()'));
    git('commit', '-qam', 'moved on');
    await rejects(service.apply(proposal, () => false), /must be checked out/);
    git('reset', '-q', '--hard', head);
    write('app.js', read('app.js') + '// edited after the proposal\n');
    await rejects(service.apply(proposal, () => false), /local changes/);
    git('checkout', '--', 'app.js');
    assert.deepEqual(await service.apply(proposal, () => false), ['app.js']);
    assert.match(read('app.js'), /JSON\.parse\(input\)/);
    assert.equal(git('rev-parse', 'HEAD'), head, 'apply committed');
    assert.equal(git('diff', '--cached', '--name-only'), '', 'apply staged');
    assert.equal(git('diff', '--name-only'), 'app.js');
    git('checkout', '--', 'app.js');

    // Through the controller: consent, preview, apply, refresh.
    const posts = [];
    const questions = [];
    let refreshed = 0;
    let copied = '';
    let opened = null;
    // The dashboard can switch workspace folders while a review runs or after it finishes.
    let currentRoot = repo;
    const otherFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-other-'));
    const remembered = new Set();
    const controller = new ReviewController({
      workspaceRoot: () => currentRoot,
      post: async message => { posts.push(message); },
      ask: async (message, detail, actions) => { questions.push(message); return actions[0]; },
      alwaysConfirm: () => false,
      isConsentRemembered: root => remembered.has(root),
      rememberConsent: async root => { remembered.add(root); },
      createRunner: () => ({ review: async () => result }),
      createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() { this.token.isCancellationRequested = true; }, dispose() {} }),
      copyText: async text => { copied = text; }, saveText: async () => true,
      openText: async (content, revision, filePath) => { opened = { content, revision, filePath }; }, notify: () => {},
      createFixModel: () => model,
      isDirtyInEditor: () => false,
      workingTreeChanged: () => { refreshed++; }
    });
    const of = type => posts.filter(message => message.type === type);
    remembered.add(repo);
    await controller.handle({ type: 'startReview', payload: { requestId: 1, repositoryPath: '.', scope: 'branch', targetRevision: 'main' } });
    assert.equal(of('reviewCompleted').length, 1);
    // Switch the dashboard to another folder: the review stays pinned to the folder it ran in.
    currentRoot = otherFolder;
    await controller.handle({ type: 'openReviewEvidence', payload: { requestId: 1, repositoryPath: '.', revision: head, path: 'app.js', line: 2 } });
    assert.ok(opened && opened.content.includes('eval(input)'), 'evidence was looked up in the new folder');
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.match(of('reviewFixFailed').at(-1).payload.message, /Mark at least one finding/);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fix' } });
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f2', decision: 'dismiss', reason: 'accepted_risk' } });
    const triaged = of('reviewTriageUpdated').at(-1).payload;
    assert.deepEqual(triaged.triage, { f1: { decision: 'fix' }, f2: { decision: 'dismiss', reason: 'accepted_risk' } });
    assert.equal(triaged.readiness.dismissed.length, 1);
    assert.equal(triaged.readiness.toFix, 1);
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }], notes: [] };
    remembered.clear();
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.match(questions.at(-1), /fix 1 finding in/);
    const proposed = of('reviewFixProposed').at(-1).payload;
    assert.deepEqual(proposed.files.map(file => file.path), ['app.js']);
    assert.deepEqual(proposed.findingIds, ['f1']);
    assert.equal(read('app.js').includes('eval(input)'), true);
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.deepEqual(of('reviewFixApplied').at(-1).payload.paths, ['app.js']);
    assert.equal(refreshed, 1);
    assert.match(read('app.js'), /JSON\.parse/);
    // A second Apply has no proposal left, and changes nothing.
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.equal(of('reviewFixApplied').length, 1);
    // The exported report records the triage.
    await controller.handle({ type: 'exportReviewReport', payload: { requestId: 1, format: 'copy' } });
    assert.match(copied, /Triage: 1 marked to fix, 1 dismissed, 1 not triaged\./);
    assert.match(copied, /## Dismissed by reviewer\n\n- \*\*HIGH security\*\* · verified · confidence high · dismissed: accepted risk/);
    fs.rmSync(otherFolder, { recursive: true, force: true });
    console.log('Review fix smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
