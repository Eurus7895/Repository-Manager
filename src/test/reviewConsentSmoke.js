const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// reviewCommands imports vscode only for registration; the command logic takes an injected UI.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { forgetReviewPermissions } = require('../../out/commands/reviewCommands.js');
Module._load = originalLoad;
const { ReviewConsentStore } = require('../../out/reviewConsent.js');
const { ReviewController } = require('../../out/reviewController.js');
const { ReviewHistoryStore } = require('../../out/reviewHistory.js');

class Memento {
  constructor() { this.values = new Map(); }
  get(key) { return this.values.get(key); }
  async update(key, value) { this.values.set(key, value); }
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-consent-'));
  try {
    // Store: allow is idempotent, forget removes only what was chosen, junk state is ignored.
    const memento = new Memento();
    const store = new ReviewConsentStore(memento);
    const libA = path.join(workspace, 'libs', 'lib-a');
    await store.allow(workspace);
    await store.allow(libA);
    await store.allow(libA);
    assert.deepEqual(store.list(), [workspace, libA]);
    await store.forget([libA]);
    assert.deepEqual(store.list(), [workspace]);
    memento.values.set('repositoryManager.reviewConsent', 'not a list');
    assert.deepEqual(new ReviewConsentStore(memento).list(), []);
    assert.equal(new ReviewConsentStore(undefined).has(workspace), false);
    await new ReviewConsentStore(undefined).allow(workspace); // no workspace state: nothing to remember, no throw

    // Command: nothing to forget, dismissed pick, and a partial choice.
    const notices = [];
    let picks = [];
    let offered;
    const ui = { pick: async items => { offered = items; return picks.shift(); }, notify: message => notices.push(message) };
    const fresh = new ReviewConsentStore(new Memento());
    await forgetReviewPermissions(fresh, workspace, ui);
    assert.match(notices.at(-1), /No repository skips the review question/);
    assert.equal(offered, undefined, 'offered a pick with nothing to forget');
    await fresh.allow(workspace);
    await fresh.allow(libA);
    picks = [undefined];
    await forgetReviewPermissions(fresh, workspace, ui);
    assert.deepEqual(fresh.list(), [workspace, libA], 'dismissing the pick forgot something');
    assert.deepEqual(offered.map(item => [item.label, item.description]), [[path.basename(workspace), '.'], ['lib-a', path.join('libs', 'lib-a')]]);
    picks = [[libA]];
    await forgetReviewPermissions(fresh, workspace, ui);
    assert.deepEqual(fresh.list(), [workspace]);
    assert.equal(notices.at(-1), 'Reviews in lib-a will ask before sending code to Copilot again.');

    // Round trip through the controller: "Always allow", then forget, then asked again.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
    const repo = path.join(workspace, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'one');
    const consent = new ReviewConsentStore(new Memento());
    const questions = [];
    let answer = 'Always allow for this repository';
    const controller = new ReviewController({
      workspaceRoot: () => repo,
      post: async () => {},
      ask: async (message, detail) => { questions.push(detail); return answer; },
      alwaysConfirm: () => false,
      isConsentRemembered: root => consent.has(root),
      rememberConsent: root => consent.allow(root),
      createRunner: () => ({ review: async request => ({ request, findings: [], policyResults: [], policyStatus: 'not_configured',
        limitations: [], coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } }) }),
      createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() {}, dispose() {} }),
      copyText: async () => {}, saveText: async () => true, openText: async () => {}, notify: () => {},
      history: new ReviewHistoryStore(new Memento())
    });
    const review = requestId => controller.handle({ type: 'startReview', payload: {
      requestId, repositoryPath: '.', scope: 'branch', targetRevision: 'main' } });
    await review(1);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Forget Review Permissions/, 'the question does not say how to undo "Always allow"');
    assert.deepEqual(consent.list(), [repo]);
    await review(2);
    assert.equal(questions.length, 1, 'asked again while allowed');
    picks = [[repo]];
    await forgetReviewPermissions(consent, workspace, ui);
    answer = undefined;
    await review(3);
    assert.equal(questions.length, 2, 'not asked again after Forget Review Permissions');
    console.log('Review consent smoke passed');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
