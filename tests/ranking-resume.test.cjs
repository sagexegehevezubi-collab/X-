const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const job = { id: 'run1', owner: 'owner', concurrency: 2, interval: 20, completed: false,
    queue: Array.from({ length: 200 }, (_, index) => ({ username: `author${index}` })), resumeFrom: [] };
  const data = { rankingJob: job, automationRunning: true, automationTask: 'ranking', automationTargetTabId: 1 };
  const writes = [], navigation = [], removed = [], changes = [], tabRemoved = [];
  let listener, tabId = 10;
  const context = vm.createContext({ console, Date, chrome: {
    storage: { local: {
      async get(keys) {
        if (typeof keys === 'string') keys = [keys];
        return structuredClone(Object.fromEntries(keys.map(key => [key, data[key]])));
      },
      async set(values) {
        const diff = Object.fromEntries(Object.entries(values).map(([key, value]) =>
          [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
        Object.assign(data, structuredClone(values));
        writes.push(structuredClone(values));
        for (const fn of changes) fn(diff, 'local');
      }
    }, onChanged: { addListener(fn) { changes.push(fn); } } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      async create() { return { id: tabId++ }; },
      async update(id, options) { navigation.push({ id, ...options }); },
      async remove(id) { removed.push(id); for (const fn of tabRemoved) fn(id); },
      onRemoved: { addListener(fn) { tabRemoved.push(fn); } }
    }
  } });
  for (const file of ['ranking-checkpoint.js', 'ranking-pool.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'X助手-0.2.0', file), 'utf8'), context);
  }
  const workerKey = index => `rankingWorkerJob:${job.id}:${index}`;
  const seedWorker = (index, completed) => {
    data[workerKey(index)] = { ...structuredClone(job), queue: job.queue.filter((_, position) => position % 2 === index), index: completed };
  };
  const seedPool = (completed = [0, 0]) => {
    data.rankingPool = { id: job.id, coordinatorTabId: 1, workers: completed.map((value, index) =>
      ({ jobKey: workerKey(index), tabId: 5 + index, total: 100, completed: value, done: false })) };
  };
  const message = (value, sender = {}) => new Promise(resolve => listener(value, sender, resolve));
  const flush = () => vm.runInContext('rankingPoolOperations', context);
  return { context, data, job, writes, navigation, removed, workerKey, seedWorker, seedPool, message, flush };
}

test('stop then resume restores 120/200 from durable worker positions even without a summary', async () => {
  const h = harness();
  h.seedWorker(0, 60); h.seedWorker(1, 60); h.seedPool();
  assert.equal((await h.message({ type: 'stopRankingPool' })).ok, true);
  await h.flush();
  assert.deepEqual(h.data.rankingCheckpoint.completedByWorker, [60, 60]);
  assert.equal(h.data.rankingPool, null);
  h.data.automationRunning = true;
  await h.message({ type: 'startRankingPool' }, { tab: { id: 1 } });
  assert.deepEqual(h.data.rankingPool.workers.map(worker => worker.completed), [60, 60]);
  assert.deepEqual(h.navigation.map(item => item.url), ['https://x.com/author120', 'https://x.com/author121']);
  assert.match(h.data.rankingStatus, /120\/200/);
  assert.equal(h.data[h.workerKey(0)].index, 60);
  // No partial initialization may publish a misleading total or reset a lane.
  for (const write of h.writes.filter(write => write.rankingPool)) {
    assert.equal(write.rankingPool.workers.reduce((sum, worker) => sum + worker.total, 0), 200);
    assert.deepEqual(write.rankingCheckpoint.completedByWorker, [60, 60]);
  }
});

test('resume merges uneven progress and ignores late messages from the previous tabs', async () => {
  const h = harness();
  h.seedWorker(0, 70); h.seedWorker(1, 50); h.seedPool([69, 48]);
  h.data.rankingCheckpoint = { jobId: h.job.id, completedByWorker: [68, 49] };
  await h.message({ type: 'stopRankingPool' }); await h.flush();
  h.data.automationRunning = true;
  await h.message({ type: 'startRankingPool' }, { tab: { id: 1 } });
  assert.deepEqual(h.navigation.map(item => item.url), ['https://x.com/author140', 'https://x.com/author101']);
  await h.message({ type: 'rankingWorkerStatus', jobKey: h.workerKey(0), completed: 0, total: 100 }, { tab: { id: 5 } });
  const worker = h.data.rankingPool.workers[0];
  await h.message({ type: 'rankingWorkerStatus', jobKey: worker.jobKey, completed: 0, total: 100 }, { tab: { id: worker.tabId } });
  assert.deepEqual(h.data.rankingCheckpoint.completedByWorker, [70, 50]);
});

test('a completed lane stays complete while the unfinished lane resumes', async () => {
  const h = harness();
  h.data.rankingCheckpoint = { jobId: h.job.id, completedByWorker: [100, 20] };
  await h.message({ type: 'startRankingPool' }, { tab: { id: 1 } });
  assert.equal(h.navigation.length, 1);
  assert.equal(h.navigation[0].url, 'https://x.com/author41');
  assert.equal(h.data.rankingPool.workers[0].done, true);
  assert.match(h.data.rankingStatus, /120\/200/);
});

test('switching tasks also snapshots worker positions before closing tabs', async () => {
  const h = harness();
  h.seedWorker(0, 60); h.seedWorker(1, 60); h.seedPool();
  await h.context.chrome.storage.local.set({ automationTask: 'engagement' });
  await h.flush();
  assert.deepEqual(h.data.rankingCheckpoint.completedByWorker, [60, 60]);
  assert.equal(h.data.rankingPool, null);
});

test('fresh job ids never inherit another round or a different worker queue', async () => {
  const h = harness();
  h.seedWorker(0, 60);
  h.data[h.workerKey(0)].queue.reverse();
  h.data.rankingCheckpoint = { jobId: 'previous-round', completedByWorker: [100, 100] };
  await h.message({ type: 'startRankingPool' }, { tab: { id: 1 } });
  assert.deepEqual(h.data.rankingCheckpoint.completedByWorker, [0, 0]);
  assert.deepEqual(h.navigation.map(item => item.url), ['https://x.com/author0', 'https://x.com/author1']);
});
