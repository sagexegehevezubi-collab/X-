const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VERSION = path.join(__dirname, '..', 'X助手-0.2.51');

function harness({ job = {}, state = {}, fetcher, draft, send } = {}) {
  let now = 1000000, timerId = 0;
  const timers = new Map(), storageListeners = [], messages = [], navigation = [], alarmMap = new Map(), writes = [];
  const data = { automationRunning: true, automationTask: 'followerTarget', automationTargetTabId: 7,
    followerTargetSessionId: 'session', followerTargetRecoveryEpoch: 0, followerTargetLeaseAt: now,
    followerTargetJob: { owner: 'owner', sessionId: 'session', stage: 'comment', sourceAuthor: 'source',
      candidateUsername: 'candidate', candidatePosts: [{ id: '123', text: '测试帖子' }, { id: '456', text: '备用帖子' }],
      postIndex: 0, commentAttempt: 0, candidateIndex: 0, candidateBatch: ['candidate', 'next'],
      sourceFollowCount: 1, sessionFollowCount: 1, commentDeadlineAt: now + 90000, ...job },
    endpoint: 'https://api.example.test/v1/chat/completions', ...state };
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const settings = { automationTask: 'followerTarget', automationRunning: true };
  const schedule = (fn, ms, interval = false) => {
    const id = ++timerId;
    timers.set(id, { at: now + Math.max(0, ms), fn, period: interval ? ms : 0 });
    return id;
  };
  const chrome = {
    storage: { local: {
      async get(keys) {
        if (typeof keys === 'string') keys = [keys];
        if (Array.isArray(keys)) return clone(Object.fromEntries(keys.map(key => [key, data[key]])));
        return clone(Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, data[key] === undefined ? value : data[key]])));
      },
      async set(values) {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) =>
          [key, { oldValue: clone(data[key]), newValue: clone(value) }]));
        Object.assign(data, clone(values)); writes.push(clone(values));
        if ('automationRunning' in values) settings.automationRunning = values.automationRunning;
        for (const listener of storageListeners) listener(changes, 'local');
      }
    }, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    runtime: { onMessage: { addListener(fn) { messages.push(fn); } }, onStartup: { addListener() {} },
      async sendMessage(message) {
        if (message.type === 'generateDraft') return draft ? draft(message) : { draft: '先看看实际效果' };
        return new Promise(resolve => {
          let handled = false;
          for (const listener of messages) if (listener(message, { tab: { id: 7 } }, resolve) === true) handled = true;
          if (!handled) resolve({ ok: true, epoch: data.followerTargetRecoveryEpoch });
        });
      }
    },
    alarms: { async create(name, options) { alarmMap.set(name, options); }, async clear(name) { alarmMap.delete(name); },
      onAlarm: { addListener() {} } },
    tabs: { async get(id) { return { id, url: h.tabUrl }; },
      async update(id, options) { navigation.push({ id, ...options }); } }
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const article = { isConnected: true };
  const context = vm.createContext({ console, Date: ClockDate, URL, AbortController, TypeError, chrome, settings,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    fetch: async (...args) => fetcher ? fetcher(...args) : { status: 200 },
    location: { origin: 'https://x.com', pathname: '/candidate/status/123', href: 'https://x.com/candidate/status/123',
      assign(url) { navigation.push({ url }); }, reload() { navigation.push({ reload: true }); } },
    isTaskActive: () => data.automationRunning && data.automationTask === 'followerTarget',
    getCurrentUsername: () => 'owner', getPostContainers: () => [article], getPostId: () => '/candidate/status/123',
    getAuthor: () => 'candidate', findPostText: () => '测试帖子',
    waitForElement: async fn => fn(),
    sendReplyToPost: async (...args) => { h.sends++; return send ? send(...args) : true; },
    bumpFollowerTargetStat: async () => {}, taskGeneration: 1
  });
  const h = { data, settings, context, chrome, navigation, alarmMap, timers, writes, sends: 0,
    tabUrl: 'https://x.com/candidate/status/123',
    load(file) { vm.runInContext(fs.readFileSync(path.join(VERSION, file), 'utf8'), context, { filename: file }); },
    call(code) { return vm.runInContext(code, context); },
    setNow(value) { now = value; },
    async flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); },
    async drain(promise) {
      let done = false, result, error;
      promise.then(value => { done = true; result = value; }, reason => { done = true; error = reason; });
      for (let i = 0; i < 1000 && !done; i++) {
        await h.flush();
        if (done) break;
        const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) { await h.flush(); if (done) break; }
        assert.ok(first, 'Task is pending without a timer');
        const [id, timer] = first; now = timer.at;
        if (timer.period) timer.at += timer.period; else timers.delete(id);
        timer.fn();
      }
      assert.ok(done, 'Task did not settle');
      if (error) throw error;
      return result;
    }
  };
  return h;
}

test('actual .51 runner: thrown send error reaches catch and persists first retry without ReferenceError', async () => {
  const h = harness({ send: async () => { throw new Error('回复框超时'); } });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.commentAttempt, 1);
  assert.equal(h.data.followerTargetJob.postIndex, 1);
  assert.equal(h.data.followerTargetCommentFailures[0].phase, 'exception');
  assert.match(h.navigation[0].url, /status\/456$/);
  assert.equal(h.call('followerTargetBusy'), false);
  assert.equal(h.timers.size, 0);
});

test('second failure abandons author and advances exactly once', async () => {
  const h = harness({ job: { commentAttempt: 1 }, send: async () => { throw new Error('发送未确认'); } });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.stage, 'followers');
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
  assert.equal(h.data.followerTargetJob.candidateUsername, null);
  assert.equal(h.data.followerTargetCommentFailures[0].attempt, 2);
  assert.match(h.navigation[0].url, /source\/verified_followers$/);
});

test('90 second deadline: never-returning model abandons author; late model result never sends', async () => {
  let resolveDraft;
  const h = harness({ draft: () => new Promise(resolve => { resolveDraft = resolve; }) });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.stage, 'followers');
  assert.equal(h.data.followerTargetCommentFailures[0].phase, 'comment_timeout');
  assert.equal(h.sends, 0);
  resolveDraft({ draft: '迟到的回复' }); await h.flush();
  assert.equal(h.sends, 0);
});

test('reload uses persisted deadline instead of granting a fresh 90 seconds', async () => {
  const h = harness({ job: { commentDeadlineAt: 999999 } });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.sends, 0);
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
});

test('offline freezes checkpoint and attempts; service-worker restart resumes same post on browser error page', async () => {
  const h = harness({ fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  h.load('follower-target-recovery.js');
  const before = structuredClone(h.data.followerTargetJob);
  assert.equal((await h.call('ftQueueRecovery()')).waiting, true);
  assert.deepEqual(h.data.followerTargetJob, before);
  h.setNow(1300000);
  await h.call('ftQueueRecovery()');
  assert.deepEqual(h.data.followerTargetJob, before);
  assert.equal(h.navigation.length, 0);
  assert.match(h.data.followerTargetStatus, /等待X 网络恢复/);
  const restarted = harness({ state: structuredClone(h.data) });
  restarted.setNow(1400000); restarted.tabUrl = 'chrome-error://chromewebdata/';
  restarted.load('follower-target-recovery.js');
  assert.equal((await restarted.call('ftQueueRecovery()')).resumed, true);
  assert.equal(restarted.data.followerTargetJob.candidateUsername, 'candidate');
  assert.equal(restarted.data.followerTargetJob.commentAttempt, 0);
  assert.equal(restarted.data.followerTargetJob.commentDeadlineAt, 1490000);
  assert.equal(restarted.navigation[0].id, 7);
  assert.match(restarted.navigation[0].url, /candidate\/status\/123$/);
});

test('content plus background: offline stops actual runner without burning author, no model generation', async () => {
  let calls = 0;
  const h = harness({ fetcher: async () => { throw new TypeError('offline'); }, draft: () => { calls++; } });
  h.load('follower-target-recovery.js'); h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(calls, 0); assert.equal(h.sends, 0);
  assert.equal(h.data.followerTargetJob.commentAttempt, 0);
  assert.equal(h.data.followerTargetJob.candidateUsername, 'candidate');
  assert.equal(h.data.followerTargetRecovery.waiting, true);
});

test('stop during network check prevents auto-resume and clears alarm', async () => {
  let resolveProbe;
  const h = harness({ fetcher: () => new Promise(resolve => { resolveProbe = resolve; }), state: {
    followerTargetRecovery: { sessionId: 'session', waiting: true, waitingSince: 900000, scope: 'x', deadlineRemainingMs: 50000 }
  } });
  h.load('follower-target-recovery.js');
  const check = h.call('ftQueueRecovery()'); await h.flush();
  await h.chrome.storage.local.set({ automationRunning: false });
  resolveProbe({ status: 200 }); await check; await h.flush();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.alarmMap.size, 0);
  assert.equal(h.data.automationRunning, false);
});

test('changed session cancels old network callback', async () => {
  let resolveProbe;
  const h = harness({ fetcher: () => new Promise(resolve => { resolveProbe = resolve; }) });
  h.load('follower-target-recovery.js');
  const check = h.call('ftQueueRecovery()'); await h.flush();
  await h.chrome.storage.local.set({ followerTargetSessionId: 'new-session' });
  resolveProbe({ status: 200 });
  assert.equal((await check).cancelled, true);
  assert.equal(h.navigation.length, 0);
});

test('background expiry advances saved author even when content script is absent', async () => {
  const h = harness({ job: { commentDeadlineAt: 999999 } });
  h.load('follower-target-recovery.js');
  assert.equal((await h.call('ftQueueRecovery()')).recovered, true);
  assert.equal(h.data.followerTargetJob.stage, 'followers');
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
  assert.equal(h.data.followerTargetCommentFailures[0].candidate, 'candidate');
  assert.match(h.navigation[0].url, /verified_followers$/);
});

test('healthy active lease is not mistaken for a stalled task', async () => {
  const h = harness(); h.load('follower-target-recovery.js');
  assert.equal((await h.call('ftQueueRecovery()')).ok, true);
  assert.equal(h.navigation.length, 0);
});

test('API-only outage pauses even with X online; probes send no auth or billable POST', async () => {
  const requests = [];
  const h = harness({ fetcher: async (url, options) => {
    requests.push({ url, options });
    if (String(url).includes('api.example')) throw new TypeError('proxy route failed');
    return { status: 200 };
  } });
  h.load('follower-target-recovery.js');
  assert.equal((await h.call('ftQueueRecovery({scope:"api"})')).waiting, true);
  assert.equal(h.data.followerTargetRecovery.scope, 'api');
  assert.equal(h.data.followerTargetJob.commentAttempt, 0);
  for (const { options } of requests) { assert.equal(options.method, 'GET'); assert.equal(options.headers, undefined); }
});

test('API auth/method errors mean reachable, not a global network outage', async () => {
  for (const status of [400, 401, 403, 404, 405]) {
    const h = harness({ fetcher: async () => ({ status }) }); h.load('follower-target-recovery.js');
    assert.equal((await h.call('ftQueueRecovery({scope:"api",heartbeat:true})')).ok, true);
    assert.equal(h.data.followerTargetRecovery, undefined);
  }
});

test('deadline during composer wait invalidates late send through assertActive callback', async () => {
  let continueComposer, passedGuard = false;
  const h = harness({ send: async (_article, _draft, _generation, options) => {
    await new Promise(resolve => { continueComposer = resolve; });
    await options.assertActive(); passedGuard = true;
  } });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  continueComposer(); await h.flush();
  assert.equal(passedGuard, false);
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
});

test('existing pending send is not removed by offline recovery', async () => {
  const attempt = 'replyAttempt:owner:123';
  const h = harness({ state: { [attempt]: { attemptedAt: 800000 }, 'followerTargetReply:owner:candidate:123': { state: 'pending' },
    followerTargetRecovery: { sessionId: 'session', waiting: true, waitingSince: 900000, scope: 'x', deadlineRemainingMs: 50000 } } });
  h.load('follower-target-recovery.js'); await h.call('ftQueueRecovery()');
  assert.equal(h.data[attempt].attemptedAt, 800000);
  assert.equal(h.data['followerTargetReply:owner:candidate:123'].state, 'pending');
});

test('actual shared send function blocks pending send before opening or writing any editor', async () => {
  const h = harness({ state: { 'replyAttempt:owner:123': { attemptedAt: 800000 } } });
  const source = fs.readFileSync(path.join(VERSION, 'content.js'), 'utf8');
  h.context.isSafeReplyCandidate = () => true;
  vm.runInContext(source.slice(source.indexOf('async function sendReplyToPost('), source.indexOf('\nfunction normalizeReplyText(')), h.context);
  assert.equal(await h.call('sendReplyToPost({isConnected:true}, "测试回复", 1)'), false);
  assert.match(h.data.lastAutomationStatus, /避免重复评论/);
});

test('late draft from a superseded recovery epoch cannot send', async () => {
  let resolveDraft;
  const h = harness({ draft: () => new Promise(resolve => { resolveDraft = resolve; }) });
  h.load('follower-target-task.js');
  const run = h.call('runFollowerTargetTask(1)'); await h.flush();
  await h.chrome.storage.local.set({ followerTargetRecoveryEpoch: 1 });
  resolveDraft({ draft: '旧流程迟到结果' }); await run;
  assert.equal(h.sends, 0);
});

test('missing identity after reload preserves saved checkpoint', async () => {
  const h = harness(); h.context.getCurrentUsername = () => '';
  const before = structuredClone(h.data.followerTargetJob);
  h.load('follower-target-task.js'); await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.deepEqual(h.data.followerTargetJob, before);
  assert.equal(h.sends, 0);
});

test('switching logged-in account stops rather than following on the wrong account', async () => {
  const h = harness(); h.context.getCurrentUsername = () => 'different';
  h.load('follower-target-task.js'); await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.automationRunning, false);
  assert.equal(h.data.followerTargetJob.owner, 'owner');
  assert.equal(h.sends, 0);
});

test('API 429/5xx response backs off instead of burning candidate even if unauthenticated GET is reachable', async () => {
  const h = harness({ draft: async () => ({ error: 'API 返回 429', code: 'API_SERVICE_UNAVAILABLE', status: 429 }) });
  h.load('follower-target-recovery.js'); h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetRecovery.waiting, true);
  assert.equal(h.data.followerTargetRecovery.scope, 'api');
  assert.equal(h.data.followerTargetJob.commentAttempt, 0);
  assert.equal(h.sends, 0);
});

test('hung network probe aborts after eight seconds instead of hanging recovery worker', async () => {
  const h = harness({ fetcher: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  h.load('follower-target-recovery.js');
  assert.equal((await h.drain(h.call('ftQueueRecovery()'))).waiting, true);
  assert.equal(h.navigation.length, 0);
});

test('new task ignores old session network wait and creates its own checkpoint', async () => {
  const h = harness({ state: { followerTargetSessionId: 'new-session',
    followerTargetRecovery: { sessionId: 'session', waiting: true, scope: 'x' } } });
  h.load('follower-target-task.js');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.sessionId, 'new-session');
  assert.equal(h.data.followerTargetJob.stage, 'home');
  assert.match(h.navigation[0].url, /\/home\?/);
});

test('rapid stop/start leaves recovery alarm enabled for the new active task', async () => {
  const h = harness(); h.load('follower-target-recovery.js');
  await h.chrome.storage.local.set({ automationRunning: false });
  await h.chrome.storage.local.set({ automationRunning: true });
  await h.flush();
  assert.equal(h.alarmMap.size, 1);
});
