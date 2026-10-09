const assert = require('node:assert/strict');
const { ReviewBridge, progressPercent } = require('../../out/reviewBridge.js');

async function main() {
  const handled = [];
  const dashboard = [];
  let opened = 0;
  let revealed = 0;
  const controller = {
    handles: type => ['startReview', 'openStoredReview', 'setFindingTriage', 'cancelReviewFix', 'discardReviewFix', 'listReviewSkills'].includes(type),
    handle: async message => { handled.push(message); }
  };
  const bridge = new ReviewBridge({ controller, postDashboard: message => dashboard.push(message),
    openView: () => { opened++; }, revealDashboard: () => { revealed++; } });
  const view = () => {
    const posted = [];
    return { posted, post: message => { posted.push(message); } };
  };
  const status = () => dashboard.filter(message => message.type === 'reviewStatus').at(-1).payload;

  // 1. The dashboard asks for a review with no tab open: the tab opens, and gets the request once ready.
  assert.equal(bridge.fromDashboard({ type: 'dashboardContext', payload: { repositoryPath: '.', folder: '/w', modelId: 'gpt' } }), true);
  assert.equal(bridge.fromDashboard({ type: 'requestReview', payload: { scope: 'changes', target: 'abc', repositoryPath: '.' } }), true);
  assert.equal(opened, 1);
  assert.equal(bridge.fromDashboard({ type: 'getHistory', payload: {} }), false, 'a dashboard message was taken for a review one');
  const first = view();
  bridge.attach(first);
  // Not ready yet: nothing is posted to a webview whose script has not loaded.
  await bridge.toReview({ type: 'reviewSkillsLoaded', payload: {} });
  assert.deepEqual(first.posted, []);
  await bridge.fromReview({ type: 'reviewReady' });
  assert.deepEqual(first.posted.map(message => message.type), ['dashboardContext', 'beginReview']);
  assert.equal(first.posted[0].payload.modelId, 'gpt');
  assert.equal(first.posted[1].payload.target, 'abc');

  // 2. The tab starts it: the controller gets it, and the dashboard's button says it runs.
  await bridge.fromReview({ type: 'startReview', payload: { requestId: 7, repositoryPath: '.', scope: 'changes', targetRevision: 'abc' } });
  assert.equal(handled.at(-1).type, 'startReview');
  assert.deepEqual(status(), { state: 'running', percent: 0, repositoryPath: '.' });
  await bridge.toReview({ type: 'reviewProgress', payload: { requestId: 7, message: 'Reviewing', detail: { phase: 'analyzing', filesDone: 1, filesTotal: 4 } } });
  assert.equal(status().percent, 25);
  assert.equal(first.posted.at(-1).type, 'reviewProgress');

  // 3. Closed while it runs: it goes on, and the next tab shows it as far as it got.
  bridge.detach();
  assert.ok(handled.some(message => message.type === 'cancelReviewFix'), 'an auto-fix outlived its tab');
  assert.ok(handled.some(message => message.type === 'discardReviewFix' && message.payload.requestId === 7));
  assert.ok(handled.some(message => message.type === 'cancelReviewExplanation'), 'an explanation being written outlived its tab');
  await bridge.toReview({ type: 'reviewCompleted', payload: { requestId: 7, readiness: { blocking: [{}, {}], attention: [] }, result: {} } });
  // A finished explanation comes back with the review; its progress and failures do not.
  await bridge.toReview({ type: 'reviewExplainProgress', payload: { requestId: 7, findingId: 'f1', message: 'Asking Copilot…' } });
  await bridge.toReview({ type: 'reviewExplanation', payload: { requestId: 7, findingId: 'f1', explanation: { cause: 'Why' } } });
  await bridge.toReview({ type: 'reviewExplainFailed', payload: { requestId: 7, findingId: 'f2', message: 'rate limited' } });
  assert.deepEqual(status(), { state: 'completed', blocking: 2, repositoryPath: '.' }, 'the button did not show the finished review');
  // A message for another request (superseded) is neither replayed nor counted.
  await bridge.toReview({ type: 'reviewCompleted', payload: { requestId: 3, readiness: { blocking: [] } } });
  assert.equal(status().blocking, 2);
  assert.equal(bridge.fromDashboard({ type: 'openReviewTab' }), true);
  assert.equal(opened, 2);
  const second = view();
  bridge.attach(second);
  await bridge.fromReview({ type: 'reviewReady' });
  const restore = second.posted.find(message => message.type === 'reviewRestore');
  assert.equal(restore.payload.start.requestId, 7);
  assert.deepEqual(restore.payload.messages.map(message => message.type), ['reviewProgress', 'reviewCompleted', 'reviewExplanation']);
  assert.equal(status().blocking, 2, 'an explanation changed the button\'s count');
  // Triage changes keep the count current.
  await bridge.toReview({ type: 'reviewTriageUpdated', payload: { requestId: 7, readiness: { blocking: [{}] } } });
  assert.equal(status().blocking, 1);

  // 4. The dashboard (a new panel) asks for the status, and evidence goes to the dashboard's diff.
  bridge.fromDashboard({ type: 'getReviewStatus' });
  assert.equal(status().blocking, 1);
  await bridge.fromReview({ type: 'showReviewEvidence', payload: { path: 'a.js', line: 3 } });
  assert.equal(revealed, 1);
  assert.deepEqual(dashboard.at(-1), { type: 'showReviewEvidence', payload: { path: 'a.js', line: 3 } });
  // The context follows the dashboard while the tab is open.
  bridge.fromDashboard({ type: 'dashboardContext', payload: { repositoryPath: 'lib', folder: '/w' } });
  assert.deepEqual(second.posted.at(-1), { type: 'dashboardContext', payload: { repositoryPath: 'lib', folder: '/w' } });

  // 5. A saved review opened in the tab never shows as running on the dashboard's button.
  await bridge.fromReview({ type: 'openStoredReview', payload: { requestId: 8, id: 'h1', repositoryPath: 'lib' } });
  await bridge.toReview({ type: 'reviewProgress', payload: { requestId: 8, message: 'x' } });
  assert.notEqual(status().state, 'running');
  await bridge.toReview({ type: 'reviewCompleted', payload: { requestId: 8, readiness: { blocking: [] } } });
  assert.deepEqual(status(), { state: 'completed', blocking: 0, repositoryPath: 'lib' });

  // The percentage matches the tab's progress bar.
  assert.equal(progressPercent({ phase: 'finishing' }), 100);
  assert.equal(progressPercent({ units: 4, unit: 3 }), 50);
  assert.equal(progressPercent({}), 0);
  console.log('Review bridge smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
