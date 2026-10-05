const assert = require('node:assert/strict');
const { consolidateLimitations } = require('../../out/services/reviewLimitations.js');

// Limitations returned per component by a real review of a repository without a policy.
const observed = [
  'Only .github/plugin/marketplace.json was reviewed. No policy rules were provided.',
  'No repository-specific policy rules were configured.',
  'No compliance rules were provided; compliance could not be assessed.',
  'Review was limited to AGENTS.md.',
  'No policy rules were configured. Review limited to CONTRIBUTING.md.',
  'No compliance rules were provided. The requested files do not establish whether callers can supply untrusted paths to Inventory.load, so path authorization risks cannot be assessed.',
  'No policy rules were supplied, so team-policy compliance could not be assessed.',
  'No compliance rules were supplied; policy status is not configured.',
  'No concrete vulnerability is evident in the supplied files. The workflow does not declare token permissions, but its effective GITHUB_TOKEN permissions depend on repository settings, which are not available here.',
  'No compliance rules were configured.',
  'Reviewed only fixtures/EXPECTED.md and fixtures/README.md, the files provided in scope. Their contents do not establish a concrete security flaw in those files.',
  'No compliance rules were provided; policy compliance could not be evaluated.',
  'No policy rules were configured, so compliance could not be assessed.',
  'Only plugins/code-review/skills/setup-review-rules/SKILL.md was in scope. No concrete security flaw was established in that file.',
  'No team policy rules were provided; policy compliance could not be evaluated.',
  'Only README.md was in scope; the available content is documentation and does not establish a concrete security flaw.',
  'No policy rules were provided.',
  'No compliance rules were configured, so policy compliance could not be evaluated.',
  'Review was limited to shared/references/framework-detection.md and shared/references/review-standard.md; these are documentation files, and no concrete security flaw was identified.',
  'No team policy rules were provided, so policy compliance could not be assessed.',
  'No compliance rules were provided.',
  'No compliance rules were provided; policy status is not configured.',
  'Review was limited to the requested layered-repo contract files and the service, store, and config files inspected.',
  'Review was limited to the supplied files; callers and other repository code were not assessed.',
  'No team policy rules were configured.',
  'No compliance rules were supplied; compliance could not be evaluated.',
  'Review was limited to the requested tools files.',
  'The supplied contents are truncated for several in-scope files, and the search result is truncated; conclusions are limited to the visible evidence.',
  'No compliance rules were provided; policy compliance could not be assessed.',
  'No compliance rules were supplied; repository policy is not configured.',
  'The requested scope contains test files, several of which were truncated in the supplied snapshot.'
];

const result = consolidateLimitations(observed, { policyConfigured: false });
// Only the notes specific to the code survive, once each; truncation is reported once by the engine.
assert.deepEqual(result, { truncated: true, toVerify: [
  'The requested files do not establish whether callers can supply untrusted paths to Inventory.load, so path authorization risks cannot be assessed.',
  'The workflow does not declare token permissions, but its effective GITHUB_TOKEN permissions depend on repository settings, which are not available here.'
] });

// Notes from a real review of a Python repository: restatements go, things to check stay whole.
const python = consolidateLimitations([
  'The calling workflows (.github/workflows/ci.yml, cd.yml) that invoke this composite action and define its triggers and permissions were not in scope, so whether secrets are exposed to untrusted pull_request code cannot be determined.',
  'Whether fork PRs or untrusted contributors can trigger these workflows depends on the GitHub Enterprise repository/runner settings, which are not visible here. The severity of the gh-pages deploy exposure depends on that configuration.',
  'Uv.lock was not inspected.',
  'The only changed file in scope (.vscode/settings.json) configures editor formatting and pytest test discovery. It contains no input-to-sink paths, secrets, command execution, or authorization logic to evaluate.',
  'Changed files are documentation artifacts only (drawio/SVG diagrams and reStructuredText). No input-to-sink, authorization, secret, command-execution, or CI-permission behavior is present in these files.',
  'The changed files in scope are all reStructuredText documentation under docs/source/. None contain executable code, input-to-sink paths, secrets, command execution, or authorization logic.',
  'Block_injector.py, patch_operations.py, address_resolver.py, and tokenizer.py are referenced sinks but were not read. Input-to-sink behavior there is unverified.',
  'uv.lock was not inspected; the tzdata 2026.1 pin could not be confirmed from it.'
], { policyConfigured: false }).toVerify;
assert.ok(python[0].startsWith('The calling workflows'), 'a note to check was dropped');
// The second sentence stays with the first one it depends on.
assert.ok(python.some(item => item.endsWith('The severity of the gh-pages deploy exposure depends on that configuration.') && item.startsWith('Whether fork PRs')));
assert.ok(python.some(item => item.startsWith('Block_injector.py') && item.endsWith('Input-to-sink behavior there is unverified.')));
assert.ok(!python.some(item => /^Uv\.lock was not inspected/.test(item)), 'a bare "not inspected" note was kept');
assert.ok(!python.some(item => /documentation|contains no|None contain/.test(item)), 'a scope restatement was kept');
// A file name at the start keeps its case.
assert.ok(python.includes('uv.lock was not inspected; the tzdata 2026.1 pin could not be confirmed from it.'));
assert.equal(python.length, 4);

// With a policy configured, a model note about the rules may matter, so it is kept.
assert.deepEqual(consolidateLimitations(['No rules applied to the generated files, so they were not checked for compliance.'], { policyConfigured: true }).toVerify,
  ['No rules applied to the generated files, so they were not checked for compliance.']);
// Reworded repeats collapse; case and punctuation do not make a note new.
assert.deepEqual(consolidateLimitations(['Behavior depends on the CALLER config', 'behavior depends on the caller config.'], { policyConfigured: false }).toVerify,
  ['Behavior depends on the CALLER config']);
// Nothing to say: no notes at all, rather than an empty or placeholder line.
assert.deepEqual(consolidateLimitations(['Review was limited to README.md.', 'No policy rules were provided.'], { policyConfigured: false }),
  { truncated: false, toVerify: [] });
console.log('Review limitations smoke passed');
