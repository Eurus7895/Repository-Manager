const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const nodes = new Map();
const listeners = {};
const posts = [];
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {}, closest() { return null; } });
  return nodes.get(id);
}
const document = { body: { addEventListener(type, cb) { listeners[`body_${type}`] = cb; }, closest() { return null; } },
  getElementById: node, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} };
const window = { __initialRepositories: [], addEventListener(type, cb) { listeners[`window_${type}`] = cb; },
  setTimeout() {}, requestAnimationFrame() {}, RepositoryHistoryGraph: {} };
const vscode = { getState() { return { selectedDashboardCommit: 'a'.repeat(40), activeDashboardRepository: '.' }; },
  setState() {}, postMessage(message) { posts.push(message); } };
vm.runInNewContext(fs.readFileSync('resources/webview.js', 'utf8'), { document, window, acquireVsCodeApi: () => vscode,
  console, ResizeObserver: class { observe() {} }, setTimeout, clearTimeout, requestAnimationFrame: () => 1 });
function detail(hash, parent) { listeners.window_message({ data: { type: 'commitDetailLoaded', payload: {
  repositoryPath: '.', targetRevision: hash, detail: { hash, shortHash: hash.slice(0,7), parentHashes:[parent],
    comparisonBaseHash: parent, subject: 'Change', authorName: 'Test', authoredAt: new Date().toISOString(), files: [{ path: 'a.txt', status: 'modified' }], refs: [] } } } }); }
function click(action) { listeners.body_click({ target: { dataset: { action }, parentElement: document.body, tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} }); }
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
console.log('UI summary switch smoke passed');
