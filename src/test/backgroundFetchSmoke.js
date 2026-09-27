const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { BranchService } = require('../../out/services/branchService.js');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fetch Test', GIT_AUTHOR_EMAIL: 'fetch@example.com',
  GIT_COMMITTER_NAME: 'Fetch Test', GIT_COMMITTER_EMAIL: 'fetch@example.com'
});
const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-bgfetch-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function main() {
  // An HTTP remote that always demands credentials.
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const repo = path.join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', repo);
    git(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);

    // Every askpass mechanism Git and SSH consult leaves a marker if it is ever run.
    const marker = path.join(base, 'askpass-called');
    const askpass = path.join(base, 'askpass.sh');
    writeFileSync(askpass, `#!/bin/sh\ntouch "${marker}"\necho secret\n`);
    chmodSync(askpass, 0o755);
    git(repo, 'config', 'core.askPass', askpass);
    const previous = { GIT_ASKPASS: process.env.GIT_ASKPASS, SSH_ASKPASS: process.env.SSH_ASKPASS };
    process.env.GIT_ASKPASS = askpass;
    process.env.SSH_ASKPASS = askpass;
    try {
      await assert.rejects(new BranchService(new GitCommandService(repo)).fetchInBackground('.'));
    } finally {
      Object.assign(process.env, previous);
      for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key];
    }
    assert.equal(existsSync(marker), false, 'background fetch ran an askpass helper');
    console.log('Background fetch smoke passed');
  } finally {
    server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
