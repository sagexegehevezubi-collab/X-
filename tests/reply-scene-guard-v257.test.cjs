const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..', 'X助手-0.2.57');

function harness(initial = {}, drafts = []) {
  let now = new Date(2026, 10, 24, 12).getTime(), nextTimer = 0;
  const timers = new Map(), requests = [], messages = [], navigation = [];
  const state = structuredClone({ apiKey: 'test-key-never-log', model: 'mock', endpoint: 'https://example.test/v1/chat/completions', ...initial });
  const listeners = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ console, URL, AbortController, TypeError, Date: ClockDate, crypto: { randomUUID },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms, period: ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    chrome: {
      storage: { local: {
        async get(keys) {
          if (typeof keys === 'string') keys = [keys];
          if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map(key => [key, state[key]])));
          return structuredClone(Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, state[key] ?? value])));
        },
        async set(values) { Object.assign(state, structuredClone(values)); }
      }, onChanged: { addListener() {} } },
      runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} },
        getManifest() { return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); },
        async sendMessage(message) {
          messages.push(structuredClone(message));
          if (message.type === 'followerTargetHealth') return { ok: true, epoch: 0 };
          if (!['generateDraft', 'commentMemory', 'commentFactBlocked'].includes(message.type)) return { ok: true };
          return new Promise(resolve => {
            let handled = false;
            for (const listener of listeners) {
              if (listener(message, { tab: { id: 7, url: 'https://x.com/author/status/123' } }, resolve) === true) handled = true;
            }
            if (!handled) resolve({ ok: true });
          });
        }
      },
      alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, async remove() {}, async get(id) { return { id, url: 'https://x.com/author/status/123' }; } }
    },
    fetch: async (url, options) => {
      if (options?.method !== 'POST') return { status: 200, body: null };
      requests.push(JSON.parse(options.body));
      const text = drafts.shift() ?? '这配置够折腾一阵了😂';
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
    }
  });
  const load = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  context.importScripts = (...files) => files.forEach(load);
  load('background.js');
  const h = { context, state, requests, messages, navigation, timers, load,
    call: code => vm.runInContext(code, context),
    async generate(post, control = {}, scene = 'timeline_influencer') {
      context.post = post; context.control = { owner: 'owner', target: 'author', postId: '123', task: 'ranking', ...control }; context.scene = scene;
      return h.call('generateDraft(post, scene, control)');
    },
    async flush() { for (let i = 0; i < 200; i++) await Promise.resolve(); },
    async drain(promise) {
      let settled = false, result, error;
      promise.then(value => { result = value; settled = true; }, reason => { error = reason; settled = true; });
      for (let i = 0; i < 1000 && !settled; i++) {
        await h.flush(); if (settled) break;
        const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(first, 'pending task must have a timer');
        const [id, timer] = first; now = timer.at;
        if (timer.period) timer.at += timer.period; else timers.delete(id);
        timer.fn();
      }
      assert.ok(settled, 'task did not finish'); if (error) throw error; return result;
    }
  };
  return h;
}

for (const post of [
  'SpaceX准备上市了，估值传闻一波接一波', 'SPACX今年IPO，消息是真的吗',
  '黄仁勋刚刚发布新一代GPU，价格公布了', 'NVIDIA just announced its latest GPU',
  '英伟达最新财报，营收又涨了', '特朗普宣布新关税', '总统刚刚任命了新部长',
  '某公司今天融资20亿美元', '今天降息了吗', 'Breaking news: SpaceX is going public',
  'IPO流程详解：SpaceX已经上市'
]) test(`明确时事零请求跳过：${post}`, async () => {
  const h = harness(); const result = await h.generate(post);
  assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, 'current_affairs'); assert.equal(h.requests.length, 0);
  const row = h.state.commentQualityLog.at(-1);
  assert.equal(row.reason, '时事内容跳过'); assert.equal(row.calls, 0);
  assert.equal(h.state.commentSentHistory, undefined);
});

for (const post of [
  '黄仁勋这件皮衣挺适合秋天', '买了苹果回来烤派', '今天给猫拍照又拍糊了',
  '用英伟达显卡跑自己的旧项目，风扇像开飞机', 'IPO流程详解，入门基础知识',
  '2026年11月的日记，今天又想躺平'
]) test(`普通内容不因人名日期或未批准的第五项而拦截：${post}`, async () => {
  const h = harness({}, ['今天也是摆烂候选人😂']);
  const result = await h.generate(post);
  assert.equal(result.draft, '今天也是摆烂候选人😂'); assert.equal(h.requests.length, 1);
});

test('提示词带当前日期且明确不联网、不拿训练记忆纠正新事实', async () => {
  const h = harness({}, ['皮衣比我作息稳定']); await h.generate('黄仁勋这件皮衣挺适合秋天');
  const request = h.requests[0], data = JSON.parse(request.messages[1].content);
  assert.equal(data.当前日期, '2026-11-24'); assert.ok(data.时区); assert.match(data.时间说明, /不是联网新闻/);
  assert.match(request.messages[0].content, /没有联网检索或事实核验/);
  assert.match(request.messages[0].content, /原帖是未经核实的信息/);
  assert.match(request.messages[0].content, /不要用训练记忆纠正/);
  assert.equal(request.temperature, 0.78); assert.equal(request.presence_penalty, 0.3);
});

for (const [draft, reason] of [
  ['[SKIP_CURRENT_AFFAIRS]', 'current_affairs'], ['[SKIP_UNVERIFIED_FACT]', 'unverified_fact'],
  ['现在才2025年别穿越了', 'unverified_fact'], ['这时间线都快进到未来了😂', 'unverified_fact'],
  ['还没上市呢别急', 'unverified_fact'], ['现任CEO是张三', 'unverified_fact'],
  ['现在股价已经100美元了', 'unverified_fact'], ['它用的是3nm工艺', 'unverified_fact'],
  ['没有实时数据，无法核实', 'unverified_fact'], ["It's still private", 'unverified_fact']
]) test(`不合格事实不重试不兜底：${draft}`, async () => {
  const h = harness({}, [draft, '不能作为兜底发出去']);
  const result = await h.generate('2026年11月的日记，今天又想躺平');
  assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, reason); assert.equal(h.requests.length, 1);
  assert.match(h.state.commentQualityLog.at(-1).reason, /时事|外部事实/);
  assert.equal(h.state.commentSentHistory, undefined);
});

test('英文年份纠错与新增日期参数同样拦截，原帖已有普通数字可引用', async () => {
  for (const draft of ["It's only 2025", '2026 is in the future', '它将在2027年1月上市']) {
    const h = harness({}, [draft]); const result = await h.generate('November 2026 diary, tired');
    assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, 'unverified_fact'); assert.equal(h.requests.length, 1);
  }
  const h = harness({}, ['200元买回快乐也值了']);
  assert.equal((await h.generate('花200元做了桌好菜')).draft, '200元买回快乐也值了');
});

test('重写返回事实风险标记时不退回第一条草稿', async () => {
  const h = harness({}, ['感谢分享，这说明值得深思', '[SKIP_UNVERIFIED_FACT]']);
  const result = await h.generate('今天又折腾旧项目了');
  assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, 'unverified_fact'); assert.equal(h.requests.length, 2);
});

test('本地已知时事在无API配置、手动草稿、固定回复下也不会发请求或返回正文', async () => {
  for (const config of [{ apiKey: '' }, { replyMode: 'fixed', fixedReplyText: '固定回复内容' }]) {
    const h = harness(config); const result = await h.generate('SpaceX即将上市', {}, 'manual_draft');
    assert.equal(result.draft, '[SKIP]'); assert.equal(h.requests.length, 0);
  }
});

test('30字符硬上限、单表情和普通格式重写仍有效', async () => {
  const h = harness({}, ['长'.repeat(31), '皮衣可以当传家宝了😂']);
  assert.equal((await h.generate('黄仁勋这件皮衣挺适合秋天')).draft, '皮衣可以当传家宝了😂');
  assert.equal(h.requests.length, 2);
  for (const text of ['[SKIP_CURRENT_AFFAIRS]', '正文[SKIP_UNVERIFIED_FACT]', '[SKIP_OTHER]', '😂', '字'.repeat(31)]) {
    h.context.text = text; assert.equal(h.call('isSafeReplyCandidate(text)'), false);
  }
});

test('后台发送预占拦截时事和未知事实，普通同名日常可以预占', async () => {
  const h = harness();
  const reserve = (text, postText) => h.context.chrome.runtime.sendMessage({ type: 'commentMemory', action: 'reserve', token: randomUUID(),
    owner: 'owner', target: 'author', postId: '123', text, postText, requestDeadlineAt: h.call('Date.now()') + 2000 });
  assert.equal((await reserve('钱包又要瘦了', 'SpaceX准备上市')).code, 'current_affairs');
  assert.equal((await reserve('还没上市呢', '今天想躺平')).code, 'unverified_fact');
  assert.equal((await reserve('皮衣比我作息稳定', '黄仁勋这件皮衣挺适合秋天')).ok, true);
  await h.call('commentMemoryQueue');
  assert.equal(h.state.commentSendReservations.length, 1); assert.equal(h.state.commentSentHistory, undefined);
});

function sendHarness(postText = '周末折腾旧项目', draft = '先把这步跑通😂', postContext = {}) {
  const h = harness(), c = h.context, events = [];
  let editorText = '', clicked = false, liveText = postText;
  const editor = { isConnected: true }, scope = {};
  const article = { isConnected: true, querySelector(selector) {
    if (selector.includes('video') && postContext.video) return {};
    if (selector.includes('audio') && postContext.audio) return {};
    if (selector.includes('tweetPhoto') && postContext.image) return {};
    if (selector.includes('poll') && postContext.poll) return {};
    if (selector === '[data-testid="reply"]') return { click() { events.push('open'); } };
    return null;
  }, querySelectorAll() { return []; }, scrollIntoView() {} };
  const submit = { click() { clicked = true; editorText = ''; events.push('click'); } };
  Object.assign(c, { settings: { automationTask: 'ranking' }, isTaskActive: () => true, getCurrentUsername: () => 'owner',
    getPostId: () => '/author/status/123', getPostContainers: () => [article], getAuthor: () => 'author', findPostText: () => liveText,
    location: { pathname: '/author/status/123' }, document: { querySelectorAll: selector => selector.includes('role="status"') && clicked ? [{ innerText: '你的回复已发送' }] : [] },
    getEditorText: () => editorText, normalizeReplyText: value => String(value).trim(), findReplySubmitButton: () => submit,
    insertTextIntoEditor: (_editor, text) => { editorText = text; events.push('write'); }, closeEmptyReplyDialog() {}
  });
  let waits = 0;
  c.waitForElement = async fn => ++waits === 1 ? { editor, scope } : fn();
  h.load('reply-context.js');
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function sendReplyToPost('), source.indexOf('\nfunction normalizeReplyText(')), c);
  c.article = article; c.draft = draft;
  h.send = options => { c.sendOptions = options || {}; return h.call('sendReplyToPost(article, draft, 1, sendOptions)'); };
  h.changePost = value => { liveText = value; }; h.events = events;
  return h;
}

test('实际共享发送函数在打开回复框前拦截遗漏的时事帖子', async () => {
  const h = sendHarness('SpaceX即将上市');
  await assert.rejects(h.send(), error => error.code === 'current_affairs');
  assert.deepEqual(h.events, []); await h.call('commentMemoryQueue');
  assert.equal(h.state.commentQualityLog.at(-1).result, 'send_blocked');
  assert.equal(h.state.commentSentHistory, undefined); assert.equal(h.state['replyAttempt:owner:123'], undefined);
});

test('实际共享发送函数拦截过时日期纠正，但普通评论仍确认并记入历史', async () => {
  const bad = sendHarness('2026年11月的日记', '这时间线都快进到未来了😂');
  await assert.rejects(bad.send(), error => error.code === 'unverified_fact'); assert.deepEqual(bad.events, []);
  const good = sendHarness(); await good.send({ strict: true });
  assert.deepEqual(good.events, ['open', 'write', 'click']); assert.equal(good.state.commentSentHistory.length, 1);
});

test('页面文字在最后一刻变为时事时不能点击，发送预占会释放', async () => {
  const h = sendHarness();
  await assert.rejects(h.send({ beforeSend: () => h.changePost('黄仁勋刚刚发布新模型') }), error => error.code === 'current_affairs');
  assert.ok(!h.events.includes('click')); assert.equal(h.state.commentSendReservations.length, 0);
  assert.equal(h.state.commentSentHistory, undefined);
});

for (const [postContext, reason] of [
  [{ video: true }, 'video_media'], [{ live: true }, 'live_space'],
  [{ audio: true }, 'audio_media'], [{ poll: true }, 'interactive_content']
]) test(`帖子结构命中硬跳过并且不调用模型：${reason}`, async () => {
  const h = harness();
  const result = await h.generate('这场活动看起来不错', { postContext });
  assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, reason); assert.equal(h.requests.length, 0);
  assert.match(h.state.commentQualityLog.at(-1).reason, /跳过/);
});

test('直播链接、抽奖互动和明确拒绝AI评论在调用模型前跳过', async () => {
  for (const [post, reason] of [
    ['大家一起抱团取暖！ https://x.com/i/spaces/1vyyk', 'live_space'],
    ['转发抽奖，评论区抽三位', 'interactive_content'],
    ['别弄AI回复', 'no_ai_requested'],
    ['不欢迎AI评论', 'no_ai_requested']
  ]) {
    const h = harness(); const result = await h.generate(post);
    assert.equal(result.reason, reason, post); assert.equal(result.draft, '[SKIP]'); assert.equal(h.requests.length, 0);
  }
});

test('纯表情、无上下文的套语和空文本不启动模型请求', async () => {
  for (const post of ['', '😂😂', '哈哈哈', '懂得都懂', 'lol']) {
    const h = harness(); const result = await h.generate(post);
    assert.equal(result.draft, '[SKIP]', post); assert.equal(result.reason, 'unclear_context', post);
    assert.equal(h.requests.length, 0, post);
  }
});

test('模型不能完整识别场景时按具体标记跳过且不重试', async () => {
  for (const [marker, reason] of [
    ['[SKIP_IMAGE_CONTEXT]', 'image_context'], ['[SKIP_MISSING_CONTEXT]', 'missing_context'],
    ['[SKIP_UNCLEAR_CONTEXT]', 'unclear_context'], ['[SKIP_INTERACTION]', 'interactive_content'],
    ['[SKIP_NO_AI_REPLY]', 'no_ai_requested']
  ]) {
    const h = harness({}, [marker, '不应兜底发送']);
    const result = await h.generate('看图就懂了', { postContext: { image: true, quoted: true } });
    assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, reason); assert.equal(h.requests.length, 1);
    assert.match(h.state.commentQualityLog.at(-1).reason, /已跳过/);
  }
});

test('图片可见性传给模型但不硬拦独立配文，提示要求画面依赖内容跳过', async () => {
  const h = harness({}, ['今天下班早，终于能晒到太阳了']);
  const result = await h.generate('今天下班早，终于能晒到太阳了', { postContext: { image: true } });
  assert.equal(result.draft, '今天下班早，终于能晒到太阳了'); assert.equal(h.requests.length, 1);
  const data = JSON.parse(h.requests[0].messages[1].content);
  assert.equal(data.帖子结构.包含图片, '模型未看到图片内容');
  assert.match(h.requests[0].messages[0].content, /视频、直播\/Spaces和音频一律跳过/);
  assert.match(h.requests[0].messages[0].content, /配文脱离图片也能完整理解/);
  assert.match(h.requests[0].messages[0].content, /指代不明/);
});

test('固定回复没有AI可判断语境，遇到图片或缺少引用正文时保守跳过', async () => {
  for (const [postContext, reason] of [
    [{ image: true }, 'image_context'], [{ quoted: true, quotedText: '' }, 'missing_context'],
    [{ externalLink: true }, 'missing_context'], [{ replyPost: true }, 'missing_context']
  ]) {
    const h = harness({ replyMode: 'fixed', fixedReplyText: '感谢分享' });
    const result = await h.generate('看起来不错', { postContext });
    assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, reason); assert.equal(h.requests.length, 0);
  }
});

test('引用文本和链接预览只以不完整上下文提示提供，模型标记不清楚时直接跳过', async () => {
  const h = harness({}, ['[SKIP_MISSING_CONTEXT]']);
  const result = await h.generate('这下真有意思', { postContext: { quoted: true, quotedText: '', externalLink: true, linkCardText: '标题预览' } });
  assert.equal(result.reason, 'missing_context'); assert.equal(h.requests.length, 1);
  const data = JSON.parse(h.requests[0].messages[1].content);
  assert.equal(data.帖子结构.包含引用内容, '引用正文未提供');
  assert.equal(data.帖子结构.包含外链, '没有读取外链正文');
  assert.equal(data.帖子结构.链接卡片可见文字, '标题预览');
});

test('媒体页面在打开回复框前再次硬拦，发送预占不会记录', async () => {
  const h = sendHarness('配文看起来很普通', '同感😂', { video: true });
  await assert.rejects(h.send(), error => error.code === 'video_media');
  assert.deepEqual(h.events, []); await h.call('commentMemoryQueue');
  assert.equal(h.state.commentSentHistory, undefined); assert.equal(h.state['replyAttempt:owner:123'], undefined);
});

test('固定回复发送前遇到图片时仍然拦截', async () => {
  const h = sendHarness('配文看起来很普通', '感谢分享', { image: true });
  h.state.replyMode = 'fixed';
  await assert.rejects(h.send(), error => error.code === 'image_context');
  assert.deepEqual(h.events, []); assert.equal(h.state['replyAttempt:owner:123'], undefined);
});

test('页面结构提取能识别视频播放器和 X Spaces 链接', () => {
  const h = harness(); h.load('reply-context.js');
  const space = { parentElement: null, innerText: '', getAttribute(name) { return name === 'href' ? 'https://x.com/i/spaces/1vyyk' : ''; }, matches() { return false; } };
  const article = {
    querySelector(selector) { return selector.includes('videoPlayer') ? {} : null; },
    querySelectorAll(selector) { return selector.includes('a[href') ? [space] : []; }
  };
  space.parentElement = article; h.context.article = article;
  const context = h.call('getReplyPostContext(article)');
  assert.equal(context.live, true); assert.equal(context.video, true); assert.equal(context.audio, false);
});

function taskHarness(task, draft = { draft: '[SKIP]', reason: 'current_affairs' }, sendIssue) {
  const h = harness(), c = h.context;
  const key = 'worker'; let running = true, sends = 0;
  const job = { owner: 'owner', sessionId: 'session', queue: [{ username: 'author' }], index: 0, stage: 'comment',
    selectionVersion: 3, commentPostId: '123', retryAt: 0, interval: 0, authorInterval: 0, retryCounts: {},
    posts: [{ id: '123', date: new Date(h.call('Date.now()') - 1000).toISOString(), text: '原帖' },
      { id: '456', date: new Date(h.call('Date.now()') - 2000).toISOString(), text: '备用' }], postIndex: 0,
    sourceAuthor: 'source', candidateUsername: 'author', candidatePosts: [{ id: '123', text: '原帖' }, { id: '456', text: '备用' }],
    candidateBatch: ['author', 'next'], candidateIndex: 0, commentAttempt: 0, sourceFollowCount: 1, sessionFollowCount: 1,
    commentDeadlineAt: h.call('Date.now()') + 90000 };
  h.state.worker = job;
  Object.assign(h.state, { automationRunning: true, automationTask: task, automationTargetTabId: 7, followerTargetFollowLimit: 100,
    followerTargetSessionId: 'session', followerTargetRecoveryEpoch: 0, followerTargetJob: structuredClone(job) });
  const article = { isConnected: true };
  Object.assign(c, { settings: { automationTask: task, automationRunning: true }, taskGeneration: 1,
    isTaskActive: () => running, getCurrentUsername: () => 'owner', getAuthor: () => 'author', getPostId: () => '/author/status/123',
    getPostContainers: () => [article], findPostText: () => '原帖', waitForElement: async fn => fn(),
    updateTaskState(value) { running = value; }, rankingWorkerJobKey: key, specifiedWorkerJobKey: key,
    location: { origin: 'https://x.com', pathname: '/author/status/123', assign(url) { h.navigation.push(url); }, reload() { h.navigation.push('reload'); } },
    async sendReplyToPost() { sends++; if (sendIssue) { const error = new Error('需要核实外部事实'); error.code = sendIssue; throw error; } return true; }
  });
  const original = c.chrome.runtime.sendMessage;
  c.chrome.runtime.sendMessage = async message => {
    if (message.type === 'generateDraft') { h.messages.push(structuredClone(message)); return draft; }
    return original(message);
  };
  h.load('reply-context.js');
  h.load(`${task === 'followerTarget' ? 'follower-target' : task}-task.js`);
  h.sends = () => sends;
  return h;
}

for (const issue of ['current_affairs', 'unverified_fact']) {
  test(`榜单${issue}不重试当前帖且保留下一帖入口`, async () => {
    const h = taskHarness('ranking', { draft: '[SKIP]', reason: issue });
    await h.drain(h.call('runRankingTask(1)'));
    assert.equal(h.messages.filter(m => m.type === 'generateDraft').length, 1); assert.equal(h.sends(), 0);
    assert.equal(h.state.worker.stage, 'posts'); assert.deepEqual(h.state.worker.attemptedPostIds, ['123']);
    assert.equal(h.state.worker.replyRetryCount, 0); assert.equal(h.state.worker.retryAt, 0);
    assert.equal(h.navigation.at(-1), 'https://x.com/author');
  });
  test(`指定博主${issue}记录原因并转向备用帖`, async () => {
    const h = taskHarness('specified', { draft: '[SKIP]', reason: issue });
    await h.drain(h.call('runSpecifiedTask(1)'));
    assert.equal(h.sends(), 0); assert.equal(h.state.worker.postIndex, 1);
    assert.equal(h.navigation.at(-1), 'https://x.com/author/status/456');
    assert.match(h.state['specifiedReply:owner:author:123'].reason, /时事|外部事实/);
    assert.equal(h.messages.filter(m => m.type === 'specifiedWorkerCommentSuccess').length, 0);
  });
}

test('列表关注时事跳过保留已关注数量，依原20秒节奏换已有备用帖', async () => {
  const h = taskHarness('followerTarget');
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.sends(), 0); assert.equal(h.state.followerTargetJob.sessionFollowCount, 1);
  assert.equal(h.state.followerTargetJob.postIndex, 1); assert.equal(h.state.followerTargetJob.commentAttempt, 1);
  assert.match(h.navigation.at(-1), /\/author\/status\/456$/);
  assert.equal(h.state.followerTargetCommentFailures.at(-1).phase, 'current_affairs');
  assert.equal(h.messages.filter(m => m.type === 'generateDraft').length, 1);
});

test('列表关注没有备用帖时直接结束评论，不回到同帖生成', async () => {
  const h = taskHarness('followerTarget'); h.state.followerTargetJob.candidatePosts.length = 1;
  await h.drain(h.call('runFollowerTargetTask(1)'));
  assert.equal(h.state.followerTargetJob.stage, 'followers'); assert.equal(h.state.followerTargetJob.candidateUsername, null);
  assert.equal(h.state.followerTargetJob.sessionFollowCount, 1);
  assert.match(h.state.followerTargetStatus, /评论处理结束|没有其他/);
  assert.equal(h.messages.filter(m => m.type === 'generateDraft').length, 1);
});

for (const task of ['ranking', 'specified', 'followerTarget']) test(`${task}发送前事实拦截不进入普通同帖错误重试`, async () => {
  const h = taskHarness(task, { draft: '正文可以通过格式' }, 'unverified_fact');
  await h.drain(h.call(`run${task === 'followerTarget' ? 'FollowerTarget' : task === 'ranking' ? 'Ranking' : 'Specified'}Task(1)`));
  assert.equal(h.sends(), 1); assert.equal(h.messages.filter(m => m.type === 'generateDraft').length, 1);
  if (task === 'ranking') { assert.equal(h.state.worker.stage, 'posts'); assert.equal(h.state.worker.retryCounts.author, undefined); }
  else if (task === 'specified') assert.equal(h.state.worker.postIndex, 1);
  else assert.equal(h.state.followerTargetJob.postIndex, 1);
  assert.equal(h.messages.filter(m => /CommentSuccess/.test(m.type)).length, 0);
});

for (const task of ['ranking', 'specified', 'followerTarget']) test(`${task}媒体/语境策略跳过不重试同一帖子`, async () => {
  const h = taskHarness(task, { draft: '[SKIP]', reason: 'unclear_context' });
  await h.drain(h.call(`run${task === 'followerTarget' ? 'FollowerTarget' : task === 'ranking' ? 'Ranking' : 'Specified'}Task(1)`));
  assert.equal(h.sends(), 0); assert.equal(h.messages.filter(m => m.type === 'generateDraft').length, 1);
  if (task === 'ranking') assert.equal(h.state.worker.replyRetryCount, 0);
  else if (task === 'specified') assert.equal(h.state.worker.postIndex, 1);
  else assert.equal(h.state.followerTargetJob.postIndex, 1);
  assert.equal(h.messages.filter(m => /CommentSuccess/.test(m.type)).length, 0);
});

test('清单与加载顺序完整，未引入加速runner，恢复模块保持0.2.55原样', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.57');
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('reply-fact-guard.js') < scripts.indexOf('reply-context.js'));
  assert.ok(scripts.indexOf('reply-context.js') < scripts.indexOf('reply-validation.js'));
  assert.ok(!scripts.includes('follower-target-runner.js'));
  assert.equal(fs.readFileSync(path.join(root, 'follower-target-recovery.js'), 'utf8'),
    fs.readFileSync(path.join(root, '..', 'X助手-0.2.55', 'follower-target-recovery.js'), 'utf8'));
});
