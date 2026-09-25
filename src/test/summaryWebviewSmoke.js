const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const nodes = new Map();
const listeners = {};
const posts = [];
const repositoryCheckboxes = [
  { value: '.', disabled: false, checked: true, dataset: {} },
  { value: 'other', disabled: false, checked: true, dataset: {} },
  { value: 'conflicted', disabled: true, checked: false, dataset: {} }
];
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, querySelector() { return id === 'historyContextMenu' ? { focus() {} } : null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {}, closest() { return null; } });
  return nodes.get(id);
}
const document = { documentElement: { clientWidth: 1200, clientHeight: 800 }, body: { addEventListener(type, cb) { listeners[`body_${type}`] = cb; }, closest() { return null; } },
  getElementById: node, querySelectorAll(selector) { return selector === '.branch-repository' ? repositoryCheckboxes : []; },
  querySelector() { return null; }, addEventListener() {} };
const window = { __initialRepositories: [], innerWidth: 1200, innerHeight: 800,
  addEventListener(type, cb) { listeners[`window_${type}`] = cb; }, setTimeout() {}, requestAnimationFrame() {},
  RepositoryHistoryGraph: { laneX() { return 25; }, buildGraphModel(commits) { return {
    width: 76, rowHeight: 32, rows: commits.map(() => ({ lane: 0, before: [], after: [], startsHere: true, parentLanes: [], isMerge: false }))
  }; } } };
const vscode = { getState() { return { selectedDashboardCommit: 'a'.repeat(40), activeDashboardRepository: '.', selectedRepositories: ['other'] }; },
  setState() {}, postMessage(message) { posts.push(message); } };
vm.runInNewContext(fs.readFileSync('resources/webview.js', 'utf8'), { document, window, acquireVsCodeApi: () => vscode,
  console, ResizeObserver: class { observe() {} }, setTimeout, clearTimeout, requestAnimationFrame: () => 1 });
function detail(hash, parent) { listeners.window_message({ data: { type: 'commitDetailLoaded', payload: {
  repositoryPath: '.', targetRevision: hash, detail: { hash, shortHash: hash.slice(0,7), parentHashes:[parent],
    comparisonBaseHash: parent, subject: 'Change', authorName: 'Test', authoredAt: new Date().toISOString(), files: [{ path: 'a.txt', status: 'modified' }], refs: [] } } } }); }
function click(action, data = {}) { listeners.body_click({ target: { dataset: { action, ...data }, parentElement: document.body, tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} }); }
const A='a'.repeat(40), B='b'.repeat(40), P='0'.repeat(40);
detail(A, P);
click('summarizeChanges');
assert.equal(posts.at(-1).type, 'summarizeChanges');
const id = posts.at(-1).payload.requestId;
// Navigate away by requesting a different commit through the dashboard action.
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(B, P);
assert.equal(posts.filter(item => item.type === 'cancelChangeSummary').length, 0);
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: A }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(A, P);
assert.equal(node('summarizeChangesButton').disabled, true);
assert.equal(node('cancelChangeSummaryButton').hidden, false);
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(B, P);
const summary={ repositoryPath:'.', baseSha:P, targetSha:A, root:false, intent:{text:'Changed a.txt',evidence:['a.txt']},
  behaviorChanges:[],affectedAreas:[],dependencyConfigChanges:[],possibleBreakingChanges:[],riskHints:[],suggestedTests:[],
  limitations:[],coverage:{totalFiles:1,includedFiles:1,omitted:[],truncatedCommits:false} };
listeners.window_message({ data: { type:'changeSummaryLoaded', payload: {requestId:id,repositoryPath:'.',summary,model:'test'} } });
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: A }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(A,P);
assert.match(node('changeSummaryResult').innerHTML, /Changed a.txt/);
assert.equal(posts.filter(item=>item.type==='cancelChangeSummary').length,0);
click('loadSummaryModels');
assert.equal(posts.at(-1).type, 'loadSummaryModels');
listeners.window_message({ data: { type: 'summaryModelsLoaded', payload: { models: [
  { id: 'fast', name: 'Fast model' }, { id: 'deep', name: 'Deep model' }
] } } });
const modelSelect = node('summaryModelSelect');
assert.match(modelSelect.innerHTML, /Deep model/);
modelSelect.value = 'deep';
modelSelect.listeners.change();
assert.equal(node('changeSummaryResult').innerHTML, '');
click('summarizeChanges');
assert.equal(posts.at(-1).payload.modelId, 'deep');
const secondId = posts.at(-1).payload.requestId;
listeners.window_message({ data: { type: 'changeSummaryLoaded', payload: {
  requestId: secondId, repositoryPath: '.', summary: { ...summary, intent: { text: 'Deep summary', evidence: ['a.txt'] } }, model: 'deep:1'
} } });
assert.match(node('changeSummaryResult').innerHTML, /Deep summary/);
modelSelect.value = '';
modelSelect.listeners.change();
assert.match(node('changeSummaryResult').innerHTML, /Changed a.txt/);
const historyRequest = posts.filter(post => post.type === 'getHistory').at(-1);
listeners.window_message({ data: { type: 'historyLoaded', payload: {
  repositoryPath: '.', requestId: historyRequest?.payload.requestId || 0, offset: 0, nextOffset: null,
  commits: [{ hash: B, shortHash: B.slice(0, 7), subject: 'Right clicked', authorName: 'Test', authorEmail: '',
    authoredAt: new Date().toISOString(), refs: [], parentHashes: [] }]
} } });
const row = { dataset: { commit: B }, closest(selector) { return selector.includes('.history-row') ? this : null; } };
let prevented = false;
listeners.body_contextmenu({ target: row, clientX: 1180, clientY: 790, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(node('historyContextMenu').hidden, false);
click('contextCopyHash');
assert.equal(posts.at(-1).type, 'copyHistoryCommit');
assert.equal(posts.at(-1).payload.commit, B);
click('contextCopySubject');
assert.equal(posts.at(-1).payload.field, 'subject');
click('contextCheckoutCommit');
assert.equal(posts.at(-1).payload.fromHistory, true);
assert.equal(posts.at(-1).payload.commit, B);
click('contextCreateBranch');
assert.equal(node('baseBranch').value, B);
assert.equal(node('branchFromCommitCheckoutRow').hidden, false);
assert.equal(node('baseBranchInput').disabled, true);
assert.equal(repositoryCheckboxes[1].disabled, true);
click('closeModal', { modal: 'createBranchModal' });
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
assert.equal(repositoryCheckboxes[1].disabled, false);
assert.equal(repositoryCheckboxes[2].disabled, true);
click('contextCreateBranch');
node('branchName').value = 'topic/from-history';
node('branchFromCommitCheckout').checked = false;
click('createBranch');
assert.equal(posts.at(-1).type, 'createBranchFromCommit');
assert.equal(posts.at(-1).payload.commit, B);
assert.equal(posts.at(-1).payload.checkout, false);
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
click('contextCreateBranch');
click('createBranchForSelected');
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('baseBranchDropdown').style.pointerEvents, '');
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
assert.equal(repositoryCheckboxes[0].disabled, false);
assert.equal(repositoryCheckboxes[1].disabled, false);
assert.equal(repositoryCheckboxes[1].checked, true);
assert.equal(repositoryCheckboxes[2].disabled, true);
assert.equal(posts.at(-1).type, 'getBaseBranchesForCreate');
listeners.body_contextmenu({ target: { closest() { return null; } } });
assert.equal(node('historyContextMenu').hidden, true);
console.log('UI summary switch smoke passed');
