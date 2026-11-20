const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const versionDir = path.join(__dirname, '..', 'X助手-0.2.55');
const previousDir = path.join(__dirname, '..', 'X助手-0.2.51');
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function makeHarness(initial = {}) {
  const store = structuredClone(initial);
  const listeners = { startup: [], installed: [], alarm: [] };
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
    fetch: async () => ({ status: 200, body: null }),
    chrome: {
      storage: {
        local: {
          async get(defaults) {
            if (Array.isArray(defaults)) return Object.fromEntries(defaults.map((key) => [key, store[key]]).filter(([, value]) => value !== undefined));
            if (typeof defaults === 'string') return { [defaults]: store[defaults] };
            return { ...defaults, ...store };
          },
          async set(values) { Object.assign(store, structuredClone(values)); }
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        onMessage: { addListener() {} },
        onStartup: { addListener(fn) { listeners.startup.push(fn); } },
        onInstalled: { addListener(fn) { listeners.installed.push(fn); } }
      },
      alarms: {
        create(name, info) { store.createdAlarm = { name, ...info }; },
        onAlarm: { addListener(fn) { listeners.alarm.push(fn); } }
      },
      tabs: { onRemoved: { addListener() {} } }
    }
  });
  context.importScripts = () => {};
  vm.runInContext(fs.readFileSync(path.join(versionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return { context, store, listeners };
}

test('0.2.55 加载 0.2.51 列表任务与恢复实现', () => {
  for (const filename of ['follower-target-task.js', 'follower-target-recovery.js']) {
    assert.equal(
      fs.readFileSync(path.join(versionDir, filename), 'utf8'),
      fs.readFileSync(path.join(previousDir, filename), 'utf8'),
      `${filename} should match v0.2.51`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(versionDir, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts[0].js;
  assert.equal(manifest.version, '0.2.55');
  assert.ok(scripts.includes('follower-target-task.js'));
  assert.ok(!scripts.includes('follower-target-policy.js'));
  assert.ok(!scripts.includes('follower-target-runner.js'));
  const background = fs.readFileSync(path.join(versionDir, 'background.js'), 'utf8');
  assert.match(background, /importScripts\("follower-target-recovery\.js"\)/);
  assert.doesNotMatch(background, /follower-target-(?:policy|model)\.js/);
});

test('跨日时清零各任务当日统计并保留失败与任务历史', async () => {
  const yesterday = '2000-01-01';
  const { context, store } = makeHarness({
    dailyStatsDate: yesterday,
    followerTargetStats: { date: yesterday, follows: 10, comments: 7 },
    rankingDailyStats: { date: yesterday, count: 12, keys: ['old'] },
    specifiedDailyStats: { date: yesterday, count: 8, authorCount: 4, authors: ['old'], keys: ['old'] },
    homeReplyDailyStats: { date: yesterday, count: 3 },
    specifiedFailures: [{ username: 'keep-me' }],
    replyMemory: [{ text: 'keep-me' }],
    followerTargetJob: { stage: 'comment', candidateUsername: 'keep-me' }
  });

  await vm.runInContext('resetDailyStatsIfNeeded()', context);
  const today = vm.runInContext('dailyStatsDateKey()', context);
  assert.equal(store.dailyStatsDate, today);
  assert.deepEqual(store.followerTargetStats, { date: today, follows: 0, comments: 0 });
  assert.deepEqual(store.rankingDailyStats, { date: today, count: 0, keys: [] });
  assert.deepEqual(store.specifiedDailyStats, { date: today, count: 0, authorCount: 0, authors: [], keys: [] });
  assert.deepEqual(store.homeReplyDailyStats, { date: today, count: 0 });
  assert.deepEqual(store.specifiedFailures, [{ username: 'keep-me' }]);
  assert.deepEqual(store.replyMemory, [{ text: 'keep-me' }]);
  assert.deepEqual(store.followerTargetJob, { stage: 'comment', candidateUsername: 'keep-me' });
  assert.deepEqual(store.createdAlarm, { name: 'xassistant-daily-stats-rollover', periodInMinutes: 1 });
});

test('当天升级时保留当天已累计数字，仅初始化日期标记', async () => {
  const today = todayKey();
  const { context, store } = makeHarness({
    dailyStatsDate: today,
    followerTargetStats: { date: today, follows: 2, comments: 1 },
    rankingDailyStats: { date: today, count: 11, keys: ['today'] },
    specifiedDailyStats: { date: today, count: 9, authorCount: 5, authors: ['a'], keys: ['today'] },
    homeReplyDailyStats: { date: today, count: 4 }
  });

  await vm.runInContext('resetDailyStatsIfNeeded()', context);
  assert.equal(store.dailyStatsDate, today);
  assert.deepEqual(store.followerTargetStats, { date: today, follows: 2, comments: 1 });
  assert.deepEqual(store.rankingDailyStats, { date: today, count: 11, keys: ['today'] });
  assert.deepEqual(store.specifiedDailyStats, { date: today, count: 9, authorCount: 5, authors: ['a'], keys: ['today'] });
  assert.deepEqual(store.homeReplyDailyStats, { date: today, count: 4 });
});
