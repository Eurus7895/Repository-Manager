const assert = require('node:assert/strict');
const { LiveChanges, affectsStatus } = require('../../out/liveChanges.js');

async function main() {
  // Which paths can change git status: files, and Git's index, HEAD and refs; not its internals.
  for (const file of ['/w/src/a.ts', '/w/.gitignore', '/w/.git/index', '/w/.git/HEAD', '/w/.git/refs/heads/main',
    '/w/.git/modules/lib/index', 'C:\\w\\.git\\index', '/w/lib/.git']) {
    assert.equal(affectsStatus(file), file !== '/w/lib/.git', file);
  }
  for (const file of ['/w/.git/objects/ab/cdef', '/w/.git/index.lock', '/w/.git/logs/HEAD', '/w/.git/FETCH_HEAD',
    '/w/.git/modules/lib/objects/12/34', '/w/.git/refs/heads/main.lock']) {
    assert.equal(affectsStatus(file), false, file);
  }

  // A fake clock: timers run when the test says so.
  let now = 0;
  const timers = new Map();
  let next = 1;
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  let refreshes = 0;
  let canRefresh = true;
  let release;
  let slow = false;
  const live = new LiveChanges({
    refresh: () => { refreshes++; return slow ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); },
    canRefresh: () => canRefresh,
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id)
  }, 800);

  // A burst of saves: one refresh, once they have been quiet for the delay.
  live.notify('/w/a.ts');
  await advance(500);
  live.notify('/w/b.ts');
  await advance(500);
  assert.equal(refreshes, 0, 'refreshed before the events settled');
  await advance(300);
  assert.equal(refreshes, 1);
  // Git's internal churn alone never refreshes.
  live.notify('/w/.git/objects/aa/bb');
  live.notify('/w/.git/index.lock');
  await advance(2000);
  assert.equal(refreshes, 1);

  // Hidden dashboard, or an action running: the refresh waits, then runs once on resume.
  canRefresh = false;
  live.notify('/w/a.ts');
  live.notify('/w/.git/index');
  await advance(1000);
  assert.equal(refreshes, 1);
  live.resume();
  await advance(0);
  assert.equal(refreshes, 1, 'refreshed while it could not');
  canRefresh = true;
  live.resume();
  await advance(0);
  assert.equal(refreshes, 2);
  live.resume();
  await advance(0);
  assert.equal(refreshes, 2, 'resume without new events refreshed again');

  // Events during a refresh ask for exactly one more, after it ends.
  slow = true;
  live.notify('/w/a.ts');
  await advance(800);
  assert.equal(refreshes, 3);
  live.notify('/w/b.ts');
  await advance(800);
  assert.equal(refreshes, 3, 'two refreshes ran at once');
  slow = false;
  release();
  await advance(0);
  await advance(0);
  assert.equal(refreshes, 4);

  // Disposed: nothing more.
  live.notify('/w/a.ts');
  live.dispose();
  await advance(5000);
  assert.equal(refreshes, 4);
  console.log('Live changes smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
