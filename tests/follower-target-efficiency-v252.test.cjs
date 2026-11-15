const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VERSION = path.join(__dirname, '..', 'X助手-0.2.52');

function harness({ job = {}, state = {}, fetcher, draft, send } = {}) {
  let now = 1000000, timerId = 0;
  const timers = new Map(), storageListeners = [], messages = [], navigation = [], alarmMap = new Map(), writes = [];
  const data = { automationRunning: true, automationTask: 'followerTarget', automationTargetTabId: 7,
    followerTargetSessionId: 'session', followerTargetRecoveryEpoch: 0, followerTargetLeaseAt: now,
    followerTargetJob: { owner: 'owner', sessionId: 'session', stage: 'comment', sourceAuthor: 'source',
      candidateUsername: 'candidate', candidatePosts: [{ id: '123', text: '测试帖子' }, { id: '456', text: '备用帖子' }],
      postIndex: 0, commentAttempt: 0, candidateIndex: 0, candidateBatch: ['candidate', 'next'],
      sourceFollowCount: 1, sessionFollowCount: 1, commentDeadlineAt: now + 40000, ...job },
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
        if (message.type === 'followerTargetGenerateDraft') return draft ? draft(message) : { draft: '先看看实际效果' };
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
    bumpFollowerTargetStat: async () => {}, taskGeneration: 1, document: {querySelector: () => null}, FOLLOW_RATE_LIMIT_COOLDOWN_MS: 1800000
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

function loadRunner(h, recovery = false) {
  h.load('follower-target-policy.js');
  if (recovery) h.load('follower-target-recovery.js');
  h.load('follower-target-task.js'); h.load('follower-target-runner.js');
}

test('single failed model call advances directly to next profile with no alternate post', async () => {
  let calls = 0;
  const h = harness({ draft: async () => { calls++; return { draft: '[SKIP]' }; } });
  loadRunner(h);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(calls, 1); assert.equal(h.sends, 0);
  assert.equal(h.data.followerTargetJob.stage, 'profile');
  assert.equal(h.data.followerTargetJob.candidateUsername, 'next');
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
  assert.match(h.navigation[0].url, /\/next$/);
  assert.equal(h.data.followerTargetCommentFailures[0].attempt, 1);
});

test('successful comment preserves follow total and goes directly to next queued account', async () => {
  const h = harness(); loadRunner(h);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.sends, 1);
  assert.equal(h.data.followerTargetJob.sessionFollowCount, 1);
  assert.equal(h.data.followerTargetJob.metrics.comments, 1);
  assert.match(h.navigation[0].url, /\/next$/);
  assert.equal(h.data['followerTargetReply:owner:candidate:123'].state, 'done');
});

test('hung model: 40 second deadline advances once and never sends late result', async () => {
  let resolveDraft;
  const h = harness({ draft: () => new Promise(resolve => { resolveDraft = resolve; }) });
  loadRunner(h, true);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
  assert.equal(h.data.followerTargetJob.metrics.commentTimeouts, 1);
  assert.equal(h.data.followerTargetCommentFailures[0].phase, 'comment_timeout');
  assert.match(h.navigation[0].url, /\/next$/);
  resolveDraft({ draft: '迟到结果' }); await h.flush();
  assert.equal(h.sends, 0);
});

test('composer overrun cannot click send after 40 seconds', async () => {
  let release, guarded = false;
  const h = harness({ send: async (_a, _b, _c, options) => {
    await new Promise(resolve => { release = resolve; });
    await options.assertActive(); guarded = true;
  } });
  loadRunner(h, true);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  release(); await h.flush();
  assert.equal(guarded, false);
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
});

test('reloaded stage deadline expires even with fresh lease/heartbeat', async () => {
  const h = harness({ job: { stage: 'profile', stageKey: 'profile:source:candidate',
    stageDeadlineAt: 999999, stageStartedAt: 939999, commentDeadlineAt: 0 } });
  h.context.location.pathname = '/candidate'; loadRunner(h, true);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.candidateUsername, 'next');
  assert.equal(h.data.followerTargetJob.metrics.stageTimeouts, 1);
  assert.equal(h.sends, 0);
});

test('source quota five switches home even with backup candidates remaining', async () => {
  const h = harness({ job: { sourceFollowCount: 5 } }); loadRunner(h);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.stage, 'home');
  assert.equal(h.data.followerTargetJob.candidateUsername, null);
  assert.match(h.navigation[0].url, /\/home\?/);
});

test('existing send attempt is skipped before generating another reply', async () => {
  let calls = 0;
  const h = harness({ state: { 'replyAttempt:owner:123': { attemptedAt: 800000 } }, draft: () => { calls++; } });
  loadRunner(h); await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(calls, 0); assert.equal(h.sends, 0);
  assert.equal(h.data.followerTargetJob.candidateUsername, 'next');
});

test('reload after model started never generates that post again', async () => {
  let calls = 0;
  const h = harness({ job: { commentStartedPostId: '123' }, draft: () => { calls++; } });
  loadRunner(h); await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(calls, 0); assert.equal(h.sends, 0);
  assert.equal(h.data.followerTargetJob.candidateIndex, 1);
});

test('X offline retains checkpoint; restart on browser error page resumes', async () => {
  const h = harness({ fetcher: async () => { throw new TypeError('offline'); } });
  h.load('follower-target-policy.js'); h.load('follower-target-recovery.js');
  const before = structuredClone(h.data.followerTargetJob);
  assert.equal((await h.call('ftQueueRecovery()')).waiting, true);
  assert.deepEqual(h.data.followerTargetJob, before);
  h.setNow(1400000); await h.call('ftQueueRecovery()');
  assert.deepEqual(h.data.followerTargetJob, before);
  const resumed = harness({ state: structuredClone(h.data) });
  resumed.setNow(1500000); resumed.tabUrl = 'edge-error://edgewebdata/';
  resumed.load('follower-target-policy.js'); resumed.load('follower-target-recovery.js');
  assert.equal((await resumed.call('ftQueueRecovery()')).resumed, true);
  assert.equal(resumed.data.followerTargetJob.candidateUsername, 'candidate');
  assert.equal(resumed.data.followerTargetJob.commentDeadlineAt, 1540000);
  assert.match(resumed.navigation[0].url, /status\/123$/);
});

test('homepage and source-list deadlines move on rather than repeating the source', async () => {
  for (const stage of ['home', 'followers']) {
    const h = harness({ job: { stage, candidateUsername: null, stageKey: `${stage}:source:`,
      stageDeadlineAt: 999999, stageStartedAt: 939999, commentDeadlineAt: 0 } });
    h.load('follower-target-policy.js'); h.load('follower-target-recovery.js');
    assert.equal((await h.call('ftQueueRecovery()')).recovered, true);
    assert.equal(h.data.followerTargetJob.stage, 'home');
    assert.equal(h.data.followerTargetJob.sourceAuthor, null);
    assert.match(h.navigation[0].url, /\/home\?/);
  }
});

test('intentional follow cooldown is not treated as a 60 second stall', async () => {
  const h = harness({ job: { stage: 'profile', cooldownUntil: 900000, stageDeadlineAt: 800000 } });
  h.load('follower-target-policy.js'); h.load('follower-target-recovery.js');
  assert.equal((await h.call('ftQueueRecovery()')).ok, true);
  assert.equal(h.navigation.length, 0);
});

test('first valid post returns immediately without waiting for a second post', async () => {
  const h = harness(); h.load('follower-target-task.js');
  h.context.document = { querySelector: () => ({ contains: () => true }) };
  h.context.getOuterPostTime = () => ({ getAttribute: () => new Date(990000).toISOString() });
  h.context.getPostContainers = () => [{ innerText: '中文内容', querySelector: () => ({}) }];
  const posts = await h.call('followerTargetV241CollectPosts("candidate", () => true, "owner")');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, '123'); assert.equal(h.timers.size, 0);
});

test('stopped or superseded task cannot recover or navigate', async () => {
  let release;
  const h = harness({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  h.load('follower-target-policy.js'); h.load('follower-target-recovery.js');
  const result = h.call('ftQueueRecovery()'); await h.flush();
  await h.chrome.storage.local.set({ automationRunning: false });
  release({ status: 200 }); await result; await h.flush();
  assert.equal(h.navigation.length, 0); assert.equal(h.alarmMap.size, 0);
});

test('changed logged-in owner stops all actions', async () => {
  const h = harness(); h.context.getCurrentUsername = () => 'other'; loadRunner(h);
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.automationRunning, false); assert.equal(h.sends, 0);
});

function loadModel(h) {
  h.context.importScripts = () => {};
  h.chrome.tabs.onRemoved = { addListener() {} };
  h.load('follower-target-policy.js'); h.load('follower-target-recovery.js');
  h.load('background.js'); h.load('follower-target-model.js');
  h.context.normalizeReplyScene = () => 'timeline_influencer';
  h.context.buildReplySystemPrompt = () => '短回复'; h.context.buildReplyUserPrompt = () => '帖子';
  h.context.stripReplyDecorations = value => value;
  h.context.getReplyCandidateIssue = value => value.length > 30 ? 'too_long' : '';
  h.context.extractModelText = value => value.text;
  h.context.scoreReplyNaturalness = () => 0;
}

test('single-attempt model uses one fetch even for poor style or invalid output; normal mode retains retry', async () => {
  for (const text of ['可以看看实际效果', '长'.repeat(35), '']) {
    let calls = 0;
    const h = harness({ state: { apiKey: 'dummy', model: 'mock' }, fetcher: async () => {
      calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ text }) };
    } }); loadModel(h);
    await h.call('generateDraft("测试", "post", {singleAttempt:true})'); assert.equal(calls, 1);
    calls = 0; await h.call('generateDraft("测试", "post")'); assert.equal(calls, 2);
  }
});

test('model fetch really aborts at 25 seconds', async () => {
  let aborted = false;
  const h = harness({ state: { apiKey: 'dummy' }, fetcher: (_u, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }) }); loadModel(h);
  await assert.rejects(h.drain(h.call('generateDraft("测试", "post", {singleAttempt:true, timeoutMs:25000})')), error => error.code === 'API_TIMEOUT');
  assert.equal(aborted, true);
});

test('three API failures suspend only comments and keep follow task running', async () => {
  const h = harness(); loadModel(h);
  for (let i = 0; i < 3; i++) await h.call('ftNoteModelResult("session", new Error("API失败"))');
  assert.equal(h.data.automationRunning, true);
  assert.equal(h.data.followerTargetRecovery, undefined);
  assert.equal(h.data.followerTargetApiCooldown.failures, 3);
  assert.equal(h.data.followerTargetApiCooldown.until, 1300000);
});

test('profile follows once then selects one post and starts 40 second comment budget', async () => {
  const h = harness({ job: { stage: 'profile', commentDeadlineAt: 0 } });
  h.context.location.pathname = '/candidate'; loadRunner(h);
  let follows = 0;
  h.context.readProfileFollowers = () => 800;
  h.context.followOnProfile = async (_name, guard) => { await guard(); follows++; return { followed: true }; };
  h.context.followerTargetV241CollectPosts = async () => [{ id: '123', text: '测试' }];
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(follows, 1); assert.equal(h.data.followerTargetJob.sessionFollowCount, 2);
  assert.equal(h.data.followerTargetJob.sourceFollowCount, 2);
  assert.equal(h.data.followerTargetJob.stage, 'comment');
  assert.equal(h.data.followerTargetJob.candidatePosts.length, 1);
  assert.equal(h.data.followerTargetJob.commentDeadlineAt, 1040000);
  assert.match(h.navigation[0].url, /candidate\/status\/123$/);
});

test('already followed candidate consumes no model or follow attempt', async () => {
  const h = harness({ job: { stage: 'profile' } });
  h.context.location.pathname = '/candidate'; loadRunner(h);
  h.context.readProfileFollowers = () => 800;
  h.context.followerTargetProfileAlreadyFollowing = () => true;
  h.context.followOnProfile = async () => { throw new Error('must not follow'); };
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.sends, 0); assert.equal(h.data.followerTargetJob.sessionFollowCount, 1);
  assert.match(h.navigation[0].url, /\/next$/);
});

test('API cooldown continues confirming new follows without collecting comment posts', async () => {
  const h = harness({ job: { stage: 'profile' }, state: { followerTargetApiCooldown: { sessionId: 'session', until: 1300000 } } });
  h.context.location.pathname = '/candidate'; loadRunner(h);
  h.context.readProfileFollowers = () => 800;
  h.context.followOnProfile = async () => ({ followed: true });
  h.context.followerTargetV241CollectPosts = async () => { throw new Error('must not collect posts'); };
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.sessionFollowCount, 2);
  assert.equal(h.data.followerTargetJob.metrics.abandoned, 1);
  assert.match(h.navigation[0].url, /\/next$/);
});

test('candidate queue bypasses the source list even if the current page is a post', async () => {
  const h = harness({ job: { stage: 'followers', candidateUsername: null, candidateIndex: 1 } });
  loadRunner(h); await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.data.followerTargetJob.stage, 'profile');
  assert.match(h.navigation[0].url, /\/next$/);
});

test('multiview scan retains backup candidates and stops early when ready', async () => {
  const h = harness(); h.load('follower-target-task.js');
  let rounds = 0, scrolls = 0, now = 1000000;
  h.context.followerTargetV243AddVisibleCandidates = job => {
    rounds++; const name = `p${rounds}`; job.candidateBatch.push(name);
    return { visible: 3, added: 1 };
  };
  h.context.followerTargetListRows = () => [];
  h.context.scrollRelationshipList = () => { scrolls++; };
  h.context.scanJob = { candidateBatch: [] };
  h.context.scanPause = async ms => { now += ms; h.setNow(now); return true; };
  await h.call('followerTargetV243CollectCandidates(scanJob, () => true, scanPause, async () => {})');
  assert.ok(scrolls >= 2); assert.ok(rounds < 16);
  assert.ok(h.context.scanJob.candidateBatch.length >= 7);
});

test('stop aborts an actual model fetch and does not return a draft', async () => {
  let aborted = false;
  const h = harness({ job: { commentStartedPostId: '123' }, state: { apiKey: 'dummy' },
    fetcher: (url, options) => String(url).includes('robots.txt') ? Promise.resolve({ status: 200 }) : new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }) }); loadModel(h);
  const run = h.call('ftGenerateOneDraft({sessionId:"session", epoch:0, candidate:"candidate", postId:"123", deadlineAt:1040000, requestId:"req", postText:"测试"}, 7)');
  await h.flush(); await h.chrome.storage.local.set({ automationRunning: false });
  const result = await run;
  assert.equal(aborted, true); assert.equal(result.code, 'API_CANCELLED');
  assert.equal(result.draft, undefined);
});

test('simultaneous requests for the same post reserve one generation even with different IDs', async () => {
  let calls = 0, release;
  const h = harness({ job: { commentStartedPostId: '123' }, state: { apiKey: 'dummy' },
    fetcher: async () => { calls++; return new Promise(resolve => { release = () => resolve({ ok: true, status: 200,
      text: async () => JSON.stringify({ text: '看看实际效果' }) }); }); }
  }); loadModel(h);
  const first = h.call('ftGenerateOneDraft({sessionId:"session", epoch:0, candidate:"candidate", postId:"123", deadlineAt:1040000, requestId:"first", postText:"测试"}, 7)');
  const second = h.call('ftGenerateOneDraft({sessionId:"session", epoch:0, candidate:"candidate", postId:"123", deadlineAt:1040000, requestId:"second", postText:"测试"}, 7)');
  await h.flush();
  assert.equal(calls, 1);
  assert.equal((await second).code, 'API_CANCELLED');
  release();
  assert.equal((await first).draft, '看看实际效果');
});

test('single-attempt mode does not retry schema or protocol errors', async () => {
  for (const message of ['unknown field "max_tokens"', 'unknown field "messages"']) {
    let calls = 0;
    const h = harness({ state: { apiKey: 'dummy' }, fetcher: async () => {
      calls++; return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message } }) };
    } }); loadModel(h);
    await assert.rejects(h.call('generateDraft("测试", "post", {singleAttempt:true})'), error => error.code === 'API_CONFIG_ERROR');
    assert.equal(calls, 1);
  }
});
