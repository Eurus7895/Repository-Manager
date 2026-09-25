const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
let requests = 0;
let active = 0;
let maxActive = 0;
let failPart = false;
let invalidLaterIntent = false;
const fakeModel = {
  id: 'test-model', version: '1', name: 'Test model', maxInputTokens: 32000,
  async countTokens(value) { return Math.ceil(value.length / 4); },
  async sendRequest(messages) {
    requests++;
    active++;
    maxActive = Math.max(active, maxActive);
    const packet = JSON.parse(messages[1]);
    const path = packet.patches[0].path;
    const number = requests;
    return {
      text: (async function* () {
        try {
          await new Promise(resolve => setTimeout(resolve, 2));
          if (failPart && number === 2) throw new Error('Temporary model error');
          yield JSON.stringify({ schemaVersion: 1, baseSha: packet.baseSha, targetSha: packet.targetSha,
            intent: { text: `Part ${number}`, evidence: [invalidLaterIntent && number === 2 ? 'missing.ts' : path] },
            behaviorChanges: [], affectedAreas: [], dependencyConfigChanges: [],
            possibleBreakingChanges: [], riskHints: [], suggestedTests: [], limitations: [] });
        } finally {
          active--;
        }
      })()
    };
  }
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {
    lm: { async selectChatModels() { return [fakeModel]; } },
    LanguageModelChatMessage: { User(value) { return value; } }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { CopilotSummaryProvider } = require('../../out/services/changeSummaryService.js');
Module._load = originalLoad;

function makePacket() {
  const sha = 'a'.repeat(40);
  return { repositoryPath: '/test', baseSha: 'b'.repeat(40), targetSha: sha,
    root: false, files: [{ path: 'large.ts', status: 'modified' }],
    patches: [{ path: 'large.ts', patch: '+hello world\n'.repeat(3000) }],
    commits: [{ hash: sha, subject: 'test' }],
    coverage: { totalFiles: 1, includedFiles: 1, omitted: [], truncatedCommits: false } };
}

async function main() {
  const provider = new CopilotSummaryProvider();
  const token = { isCancellationRequested: false };
  const statuses = [];
  const first = await provider.summarize(makePacket(), token, status => statuses.push(status));
  assert.ok(requests > 1);
  assert.ok(maxActive <= 2);
  assert.ok(statuses.some(status => status.includes('part 2/')));
  assert.equal(first.summary.coverage.includedFiles, 1);
  assert.ok(first.summary.behaviorChanges.length > 0);
  for (const claim of [first.summary.intent, ...first.summary.behaviorChanges]) {
    assert.deepEqual(claim.evidence, ['large.ts']);
  }
  const previous = requests;
  await provider.summarize(makePacket(), token, () => {});
  assert.equal(requests, previous, 'successful summary should be cached');

  failPart = true;
  const retryProvider = new CopilotSummaryProvider();
  requests = 0;
  const partial = await retryProvider.summarize(makePacket(), token, () => {});
  assert.ok(partial.summary.coverage.omitted.some(reason => reason.includes('analysis of one patch segment failed')));
  assert.ok(partial.summary.limitations.some(reason => reason.includes('Temporary model error')));
  failPart = false;
  const beforeRetry = requests;
  await retryProvider.summarize(makePacket(), token, () => {});
  assert.ok(requests > beforeRetry, 'incomplete result should be retryable');

  invalidLaterIntent = true;
  const invalidProvider = new CopilotSummaryProvider();
  requests = 0;
  const invalid = await invalidProvider.summarize(makePacket(), token, () => {});
  assert.equal(invalid.summary.intent.text, 'Part 1');
  assert.ok(invalid.summary.limitations.some(reason => reason.includes('evidence could not be verified')));
  invalidLaterIntent = false;
  const beforeInvalidRetry = requests;
  await invalidProvider.summarize(makePacket(), token, () => {});
  assert.ok(requests > beforeInvalidRetry, 'invalid later-batch intent should not be cached');
  console.log('AI summary batch provider smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
