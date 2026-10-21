const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const extensionDir = path.join(__dirname, '..', 'X助手-0.2.0');

function harness(initial = {}) {
  const data = structuredClone(initial);
  const elements = new Map();
  const messages = [];
  const navigation = [];
  const sends = [];
  let running = true;
  const context = vm.createContext({
    console, URL, Date, setTimeout, crypto: { randomUUID },
    chrome: {
      storage: { local: {
        async get(keys) {
          if (typeof keys === 'string') return structuredClone({ [keys]: data[keys] });
          if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map(key => [key, data[key]])));
          return structuredClone({ ...keys, ...data });
        },
        async set(values) { Object.assign(data, structuredClone(values)); }
      } },
      runtime: { async sendMessage(message) {
        messages.push(structuredClone(message));
        return message.type === 'generateDraft' ? { draft: '先看看实际效果' } : { ok: true };
      } },
      tabs: { async query() { return []; } }
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', options: [], addEventListener() {}, replaceChildren() {} });
        return elements.get(id);
      }
    },
    location: { pathname: '/author', assign(url) { navigation.push(url); } },
    rankingWorkerJobKey: 'worker', settings: { automationTask: 'ranking' },
    isTaskActive: () => running,
    updateTaskState: value => { running = value; },
    getCurrentUsername: () => 'owner',
    waitForElement: async find => find(),
    getPostContainers: () => [{ id: data.worker.commentPostId }],
    getPostId: article => `/author/status/${article.id}`,
    getAuthor: () => 'author', findPostText: () => '这次工具更新速度快了很多',
    async sendReplyToPost(article, draft, generation, options) {
      await options.beforeSend();
      assert.equal(data[`rankingReply:owner:${article.id}`].state, 'pending');
      sends.push(article.id);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'ranking-task.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'reply-validation.js'), 'utf8'), context);
  context.collectRankingSamples = async () => ['103', '102', '101'].map(id => ({ id }));
  return { context, data, elements, messages, navigation, sends, resume() { running = true; } };
}

function job(overrides = {}) {
  return { id: randomUUID(), owner: 'owner', queue: [{ username: 'author' }],
    index: 0, stage: 'posts', selectionVersion: 3, interval: 0, retryAt: 0, ...overrides };
}

test('a fresh import retains all 200 authors despite completed or uncertain author history', async () => {
  const queue = Array.from({ length: 200 }, (_, i) => ({ username: `author${i}` }));
  const h = harness({ rankingImport: { queue, importedAt: Date.now() }, rankingHistory: {} });
  for (let i = 0; i < 200; i++) {
    h.data[`rankingAccount:owner:author${i}`] = { state: i < 100 ? 'done' : 'pending', postId: String(1000 + i) };
    h.data.rankingHistory[`owner:author${i}`] = { state: 'done', postId: String(1000 + i) };
  }
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'ranking-dashboard.js'), 'utf8'), h.context);
  h.context.document.getElementById('rankingLimit').value = '200';
  h.context.document.getElementById('rankingInterval').value = '12';
  h.elements.get('rankingConcurrency').value = '1';
  await h.context.prepareRankingJob({ username: 'owner' });
  assert.deepEqual(h.data.rankingJob.queue, queue);
  const firstId = h.data.rankingJob.id;
  await h.context.prepareRankingJob({ username: 'owner' });
  assert.equal(h.data.rankingJob.queue.length, 200);
  assert.notEqual(h.data.rankingJob.id, firstId);
});

test('repeat runs select a different post from the same author and preserve every prior post record', async () => {
  const h = harness({ worker: job(), 'rankingAccount:owner:author': { state: 'done', postId: '103' } });
  await h.context.runRankingTask(1);
  assert.equal(h.data.worker.commentPostId, '102');
  h.context.location.pathname = '/author/status/102';
  await h.context.runRankingTask(1);
  assert.deepEqual(h.sends, ['102']);
  assert.equal(h.data['rankingReply:owner:102'].state, 'done');

  h.data.worker = job(); h.resume(); h.context.location.pathname = '/author';
  await h.context.runRankingTask(2);
  assert.equal(h.data.worker.commentPostId, '101');
  h.context.location.pathname = '/author/status/101';
  await h.context.runRankingTask(2);
  assert.deepEqual(h.sends, ['102', '101']);
  assert.equal(h.data['rankingReply:owner:102'].state, 'done');
  assert.equal(h.data['rankingReply:owner:101'].state, 'done');
  assert.equal(h.messages.filter(m => m.type === 'rankingWorkerCommentSuccess').length, 2);

  h.data.worker = job(); h.resume(); h.context.location.pathname = '/author';
  await h.context.runRankingTask(3);
  assert.deepEqual(h.sends, ['102', '101']);
  assert.equal(h.data.worker.index, 1);
});

test('legacy pending/commented records block only their specific post', async () => {
  for (const state of ['pending', 'commented']) {
    const h = harness({ worker: job(), rankingHistory: { 'owner:author': { state, postId: '103' } } });
    await h.context.runRankingTask(1);
    assert.equal(h.data.worker.commentPostId, '102');
  }
});

test('post deduplication combines old records, new records and shared send attempts', async () => {
  const h = harness({
    rankingHistory: { 'owner:author': { state: 'commented', postId: 'https://x.com/author/status/1' } },
    'rankingAccount:owner:author': { state: 'pending', postId: '2' },
    'rankingReply:owner:3': { state: 'done' }, 'rankingReply:owner:4': { state: 'pending' },
    'replyAttempt:owner:5': { attemptedAt: Date.now() },
    repliedPostIds: ['/author/status/6', '7'], uncertainReplyPostIds: ['8', '/author/status/9'],
    'rankingReply:owner:10': { state: 'skipped' }, 'rankingReply:another:11': { state: 'done' }
  });
  const ids = await h.context.getRankingHandledPostIds('owner', 'author', Array.from({length: 11}, (_, i) => String(i + 1)));
  assert.deepEqual([...ids].sort(), ['1','2','3','4','5','6','7','8','9']);
});

test('a migrated follow stage selects another post without following or excluding the author', async () => {
  const h = harness({ worker: job({ selectionVersion: 2, stage: 'follow', commentPostId: '103' }),
    'rankingAccount:owner:author': { state: 'commented', postId: '103' } });
  await h.context.runRankingTask(1);
  assert.equal(h.data.worker.selectionVersion, 3);
  assert.equal(h.data.worker.stage, 'comment');
  assert.equal(h.data.worker.commentPostId, '102');
});

test('a post marked pending after selection is not generated or sent again', async () => {
  const h = harness({ worker: job({ stage: 'comment', commentPostId: '103' }),
    'rankingReply:owner:103': { state: 'pending' } });
  h.context.location.pathname = '/author/status/103';
  await h.context.runRankingTask(1);
  assert.equal(h.messages.some(m => m.type === 'generateDraft'), false);
  assert.deepEqual(h.sends, []);
});

test('resume mode keeps the unfinished job and restores per-worker checkpoints', async () => {
  const previous = job({ id: 'unfinished', concurrency: 2, completed: false });
  const h = harness({ rankingJob: previous, rankingCheckpoint: { jobId: 'unfinished', completedByWorker: [4, 2] } });
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'ranking-dashboard.js'), 'utf8'), h.context);
  await h.context.prepareRankingJob({ username: 'owner' }, 'resume');
  assert.equal(h.data.rankingJob.id, 'unfinished');
  assert.deepEqual(h.data.rankingJob.resumeFrom, [4, 2]);
  assert.match(h.data.rankingStatus, /继续上次榜单任务/);
});
