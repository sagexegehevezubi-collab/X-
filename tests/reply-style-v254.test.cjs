const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..', 'X助手-0.2.54');

function harness(initial = {}, drafts = []) {
  const data = structuredClone({ apiKey: 'dummy', model: 'mock', endpoint: 'https://example.test/v1/chat/completions', ...initial });
  const listeners = [], requests = [];
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout, Date,
    importScripts() {}, chrome: {
      storage: { local: {
        async get(keys) {
          if (typeof keys === 'string') keys = [keys];
          if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map(k => [k, data[k]])));
          return structuredClone(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, data[k] ?? v])));
        },
        async set(values) { Object.assign(data, structuredClone(values)); }
      }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
      tabs: { onRemoved: { addListener() {} } }
    }, fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      const draft = drafts.shift();
      if (draft instanceof Error) throw draft;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: draft ?? '冰箱会自己补货的😂' } }] }) };
    }
  });
  const h = { context, data, requests, listeners, load(file) { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }); },
    call(code) { return vm.runInContext(code, context); },
    async generate(control = {}, scene = 'timeline_influencer', post = '冰箱吃空才开始减肥') {
      context.control = { owner: 'owner', target: 'author', postId: '123', task: 'ranking', ...control };
      context.scene = scene; context.post = post;
      return h.call('generateDraft(post, scene, control)');
    },
    memory(action, overrides = {}) {
      context.message = { action, token: 'token', owner: 'owner', target: 'author', postId: '123', text: '冰箱会自己补货的😂', requestDeadlineAt: Date.now() + 2000, ...overrides };
      return h.call('updateCommentMemory(message, 7)');
    }
  };
  h.load('reply-validation.js'); h.load('reply-style.js'); h.load('reply-memory.js'); h.load('background.js');
  return h;
}

test('emoji is optional, one emoji sequence allowed, no minimum text length, raw upper limit remains strict', () => {
  const h = harness();
  for (const text of ['行', '6', '确实', '哈哈还能这么接', '冰箱会自己补货的😂', '开工🧑🏽‍💻', '加油🇨🇳', '就这一步1️⃣', '字'.repeat(28)+'😂']) {
    h.context.text = text; assert.equal(h.call('getReplyCandidateIssue(text)'), '', text);
  }
  for (const [text, reason] of [['😂', 'punctuation'], ['😂👍', 'too_many_emoji'], ['接住😂😂', 'too_many_emoji'],
    ['字'.repeat(29)+'😂', 'too_long'], ['字'.repeat(31), 'too_long'], ['ｶﾞ'.repeat(16), 'too_long']]) {
    h.context.text = text; assert.equal(h.call('getReplyCandidateIssue(text)'), reason, text);
  }
});

test('safety and leakage hard checks remain in shared send validation', () => {
  const h = harness();
  for (const text of ['这是思考过程', '抱歉，我无法协助传播谣言', '[SKIP]', '甲，乙，丙', '正文。', '看https://x.com', '问@someone', '#互关']) {
    h.context.text = text; assert.notEqual(h.call('getReplyCandidateIssue(text)'), '', text);
  }
});

test('main tasks share half-familiar humorous voice, scene only in system, image limits and no minimum', async () => {
  const h = harness({}, ['冰箱会自己补货的😂', '可以', '行']);
  for (const scene of ['ranking', 'specified', 'timeline_influencer']) await h.generate({}, scene);
  for (const body of h.requests) {
    const system = body.messages[0].content, user = body.messages[1].content;
    assert.match(system, /半熟人/); assert.match(system, /尽可能幽默/); assert.match(system, /允许平淡/);
    assert.match(system, /没有最低字数/); assert.match(system, /一个贴合语境的emoji/); assert.match(system, /没有看到图片/);
    assert.doesNotMatch(system, /高情商的创作者|更温暖|8–24|互关贴/);
    assert.doesNotMatch(user, /当前场景|半熟人/);
    assert.equal(body.temperature, 0.78); assert.equal(body.presence_penalty, 0.3);
  }
});

test('normal keywords, pronoun opening, one comma and four-character overlap no longer reduce score', () => {
  const h = harness();
  for (const [text, post] of [['你这个配色我也想要', '这个配色'], ['期待下一期', '下一期'], ['价格低了，兼容呢', '价格低了'], ['值得再看一眼', '看一眼']]) {
    h.context.text = text; h.context.post = post; assert.equal(h.call('analyzeCommentStyle(text, post).score'), 100, text);
  }
});

test('targeted retry includes previous output and concrete reason without forcing twelve characters', async () => {
  const h = harness({}, ['感谢分享，这说明值得深思', '需求都换三遍皮了😂']);
  const result = await h.generate();
  assert.equal(result.draft, '需求都换三遍皮了😂'); assert.equal(h.requests.length, 2);
  const retry = JSON.parse(h.requests[1].messages[1].content);
  assert.equal(retry.上次输出, '感谢分享，这说明值得深思'); assert.match(retry.需要修正, /套话|升华/);
  assert.doesNotMatch(h.requests[1].messages[0].content, /不超过 12|更温暖/);
});

test('singleAttempt only performs local checks and logs soft style without a second request', async () => {
  const h = harness({}, ['感谢分享，这说明值得深思']);
  const result = await h.generate({ singleAttempt: true });
  assert.equal(h.requests.length, 1); assert.equal(result.draft, '感谢分享，这说明值得深思');
  assert.equal(h.data.commentQualityLog[0].calls, 1); assert.ok(result.styleScore < 65);
});

test('two poor outputs never fall back to result with score below fifty', async () => {
  const h = harness({}, ['作者，感谢分享这说明值得深思', '博主，感谢支持由此可见值得深思']);
  const result = await h.generate(); assert.equal(result.draft, '[SKIP]'); assert.equal(result.reason, 'low_style');
  assert.equal(h.requests.length, 2);
});

test('safety skip or refusal does not retry and cannot become posted refusal text', async () => {
  for (const text of ['[SKIP]', '抱歉，我无法帮助传播谣言']) {
    const h = harness({}, [text]); const result = await h.generate();
    assert.equal(h.requests.length, 1); assert.equal(result.draft, '[SKIP]');
  }
});

test('style rewrite returning skip does not fall back to earlier comment', async () => {
  const h = harness({}, ['感谢分享，这说明值得深思', '[SKIP]']);
  assert.equal((await h.generate()).draft, '[SKIP]'); assert.equal(h.requests.length, 2);
});

test('too-long or emoji-only result gets precise retry and never truncates to fit', async () => {
  for (const text of ['长'.repeat(31), '😂']) {
    const h = harness({}, [text, '冰箱会自己补货的😂']);
    assert.equal((await h.generate()).draft, '冰箱会自己补货的😂');
    assert.equal(JSON.parse(h.requests[1].messages[1].content).上次输出, text);
    assert.ok(JSON.parse(h.requests[1].messages[1].content).需要修正);
  }
});

test('cleaning preserves natural openings and emoji rather than stripping a short reply', () => {
  const h = harness();
  for (const text of ['绝了😂', '哈哈还有这招', '确实', '牛逼还能这么接']) {
    h.context.text = text; assert.equal(h.call('stripReplyDecorations(text)'), text);
  }
  assert.equal(h.call('stripReplyDecorations("回复：冰箱会自己补货的😂记得回访喔")'), '冰箱会自己补货的😂');
});

test('same author same body blocks, short responses across different authors allowed', () => {
  const h = harness();
  h.context.rows = [{ target: 'author', text: '求链接😂' }];
  assert.equal(h.call('getCommentDuplicateIssue("求链接", "author", rows)'), 'same_author_duplicate');
  assert.equal(h.call('getCommentDuplicateIssue("求链接", "other", rows)'), '');
  h.context.rows = [{ target: 'other', text: '钱包正在骂骂咧咧退出群聊😂' }];
  assert.equal(h.call('getCommentDuplicateIssue("钱包正在骂骂咧咧退出群聊", "author", rows)'), 'recent_duplicate');
});

test('recent frequent opening and emoji use influence prompt without sending prior full comments', async () => {
  const history = Array.from({length: 5}, (_, i) => ({ owner: 'owner', target: 'p'+i, text: '这个功能还有几步😂' }));
  const h = harness({ commentSentHistory: history }, ['先看兼容性']); await h.generate();
  assert.match(h.requests[0].messages[0].content, /近期常用开头：这个/);
  assert.match(h.requests[0].messages[0].content, /这次不用表情/);
  assert.doesNotMatch(h.requests[0].messages[0].content, /这个功能还有几步/);
  assert.equal(h.data.commentSentHistory.length, 5, 'generation must not enter sent memory');
});

test('history isolated by posting owner and no duplicates cause second call in singleAttempt', async () => {
  const text = '钱包正在骂骂咧咧退出群聊😂';
  const h = harness({ commentSentHistory: [{owner: 'owner', target: 'other', text}] }, [text]);
  const result = await h.generate({ singleAttempt: true });
  assert.equal(result.reason, 'recent_duplicate'); assert.equal(h.requests.length, 1);
  const other = harness({ commentSentHistory: [{owner: 'another', target: 'author', text}] }, [text]);
  assert.equal((await other.generate({ singleAttempt: true })).draft, text);
});

test('parallel send reservations serialize and only one duplicate succeeds', async () => {
  const h = harness();
  const text = '钱包正在骂骂咧咧退出群聊😂';
  const results = await Promise.all([h.memory('reserve', {text, token:'one'}), h.memory('reserve', {text, token:'two', target: 'other'})]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(h.data.commentSentHistory, undefined);
  assert.equal(h.data.commentSendReservations.length, 1);
});

test('only confirmed send enters memory, duplicate confirmations are idempotent and failed send releases', async () => {
  const h = harness();
  await h.memory('reserve'); assert.equal(h.data.commentSentHistory, undefined);
  await h.memory('confirm'); await h.memory('confirm');
  assert.equal(h.data.commentSentHistory.length, 1); assert.equal(h.data.commentSendReservations.length, 0);
  await h.memory('reserve', { token: 'second', text: '另一条有意义的回复', postId: '456' });
  await h.memory('release', { token: 'second', postId: '456' });
  assert.equal(h.data.commentSentHistory.length, 1); assert.equal(h.data.commentSendReservations.length, 0);
});

test('memory persists through background restart and retains at most two hundred successes', async () => {
  const rows = Array.from({length:200}, (_, i) => ({owner:'owner', target:'p'+i, text:'历史'+i, token:String(i)}));
  const h = harness({commentSentHistory:rows}); await h.memory('reserve');
  const restarted = harness(h.data); await restarted.memory('confirm');
  assert.equal(restarted.data.commentSentHistory.length, 200);
  assert.equal(restarted.data.commentSentHistory.at(-1).text, '冰箱会自己补货的😂');
});

test('expired reservation request and invalid confirmation cannot fabricate sent history', async () => {
  const h = harness();
  assert.equal((await h.memory('reserve', {requestDeadlineAt: Date.now()-1})).ok, false);
  assert.equal((await h.memory('confirm')).ok, false);
  assert.equal(h.data.commentSentHistory, undefined);
});

test('quality log contains no API secrets, bounded and records real generation attempts', async () => {
  const h = harness({commentQualityLog: Array.from({length:200}, () => ({}))});
  await h.generate({ singleAttempt: true });
  assert.equal(h.data.commentQualityLog.length, 200);
  const row = h.data.commentQualityLog.at(-1);
  assert.equal(row.calls, 1); assert.equal(row.version, '0.2.54'); assert.equal(row.result, 'generated');
  assert.doesNotMatch(JSON.stringify(row), /dummy|apiKey|endpoint|原帖/);
});

// 执行共享发送函数本身，模拟X编辑器和发送确认，不打开浏览器或发表真实评论。
function sendHarness({ reservation = true, confirmation = true, existing = false, alterEditor = false } = {}) {
  const h = harness(); const context = h.context;
  const events = []; let editorText = '', clicked = false;
  const editor = { isConnected: true };
  const scope = { isConnected:true, getClientRects:()=>[1] };
  const article = { isConnected:true, querySelector:()=>({click(){}}), scrollIntoView(){} };
  const submit = { click(){events.push('click'); clicked=true; editorText='';} };
  const notices = () => clicked && confirmation ? [{innerText:'你的回复已发送'}] : [];
  Object.assign(context, { crypto:{randomUUID}, settings:{automationTask:'ranking'}, generation:1,
    isTaskActive:()=>true, getCurrentUsername:()=> 'owner', getPostId:()=>'/author/status/123',
    getPostContainers:()=>[article], getAuthor:()=> 'author', findPostText:()=> '原帖文字',
    location:{pathname:'/author/status/123'},
    document:{querySelectorAll: selector => selector.includes('role="status"') ? notices() : []},
    getEditorText:()=>editorText, normalizeReplyText: text=>String(text).trim(),
    findReplySubmitButton:()=>submit, insertTextIntoEditor:(_e,text)=>{editorText=text;},
    closeEmptyReplyDialog(){},
    waitForElement:async fn=> {
      const value=fn();
      if (alterEditor && value===editor) editorText='长'.repeat(31);
      return value;
    }
  });
  context.chrome.runtime.sendMessage = async message => {
    events.push(message.action);
    return {ok: message.action==='reserve' ? reservation : true, reason:'重复正文'};
  };
  if(existing) h.data['replyAttempt:owner:123']={attemptedAt:1};
  let code=fs.readFileSync(path.join(root,'content.js'),'utf8');
  code=code.slice(code.indexOf('async function sendReplyToPost('),code.indexOf('\nfunction normalizeReplyText('));
  vm.runInContext(code,context);
  // composer定位由页面适配层返回；其余等待仍运行实际函数的判定。
  const originalWait=context.waitForElement; let waits=0;
  context.waitForElement=async fn=> ++waits===1 ? {editor,scope} : originalWait(fn);
  context.article=article;
  h.events=events;
  h.send=()=>h.call('sendReplyToPost(article,"冰箱会自己补货的😂",1,{strict:true})');
  return h;
}

test('actual shared send reserves before click and confirms memory only after X success', async () => {
  const h=sendHarness(); await h.send();
  assert.deepEqual(h.events,['reserve','click','confirm']);
});

test('actual shared send cannot click when final duplicate reservation fails', async () => {
  const h=sendHarness({reservation:false});
  await assert.rejects(h.send(), /重复正文/);
  assert.ok(!h.events.includes('click')); assert.ok(!h.events.includes('confirm'));
});

test('actual shared send never adds uncertain result to confirmed history', async () => {
  const h=sendHarness({confirmation:false});
  await assert.rejects(h.send(), /未确认 X 已发送/);
  assert.deepEqual(h.events,['reserve','click']);
});

test('actual shared send respects original post dedup before reserving text', async () => {
  const h=sendHarness({existing:true}); assert.equal(await h.send(),false); assert.deepEqual(h.events,[]);
});

test('actual shared send hard checks mutated editor before reservation and click', async () => {
  const h=sendHarness({alterEditor:true}); await assert.rejects(h.send(), /正文已改变|内容与预期不一致/);
  assert.deepEqual(h.events,[]);
});


test('stop during send reservation prevents clicking and releases reservation', async () => {
  const h=sendHarness(); let running=true;
  h.context.isTaskActive=()=>running;
  h.context.chrome.runtime.sendMessage=async message=> {
    h.events.push(message.action); if(message.action==='reserve') running=false; return {ok:true};
  };
  await assert.rejects(h.send(), /任务已停止/);
  assert.deepEqual(h.events,['reserve','release']);
});

test('parallel different confirmed replies never lose one history entry', async () => {
  const h=harness();
  await Promise.all([h.memory('reserve',{token:'one',text:'这一点说到心里了'}),h.memory('reserve',{token:'two',target:'other',text:'冰箱哪天才能清空'})]);
  await Promise.all([h.memory('confirm',{token:'one'}),h.memory('confirm',{token:'two',target:'other'})]);
  assert.equal(h.data.commentSentHistory.length,2);
  assert.equal(new Set(h.data.commentSentHistory.map(r=>r.token)).size,2);
});

test('send memory listener rejects non-X senders and records block reasons without raw API data', async () => {
  const h=harness(); const listener=h.listeners[0];
  let denied; listener({type:'commentMemory'}, {tab:{id:7,url:'https://example.test/'}}, value=>denied=value);
  assert.equal(denied.ok,false);
  const result=await new Promise(resolve=>listener({type:'commentMemory', action:'reserve',owner:'owner',target:'author',token:'test',postId:'123',
    text:'长'.repeat(31),requestDeadlineAt:Date.now()+2000}, {tab:{id:7,url:'https://x.com/author/status/123'}}, resolve));
  assert.equal(result.ok,false);
  await h.call('commentMemoryQueue');
  assert.equal(h.data.commentQualityLog.at(-1).result,'send_blocked');
});


test('deadline with too little remaining time does not add a rewrite request', async () => {
  const h=harness({},['感谢分享，这说明值得深思']);
  const result=await h.generate({deadlineAt:Date.now()+5000});
  assert.equal(h.requests.length,1); assert.equal(result.styleScore,50);
});

test('fixed reply keeps its configured body and performs no model request', async () => {
  const h=harness({replyMode:'fixed',fixedReplyText:'稍后看😂'});
  assert.equal((await h.generate()).draft,'稍后看😂'); assert.equal(h.requests.length,0);
});

test('aborted model control prevents any new request', async () => {
  const h=harness(); const controller=new AbortController(); controller.abort();
  await assert.rejects(h.generate({signal:controller.signal}), error=>error.code==='API_CANCELLED');
  assert.equal(h.requests.length,0);
});

test('send listener records only X-confirmed event after confirmation', async () => {
  const h=harness(); const listener=h.listeners[0];
  const call=action=>new Promise(resolve=>listener({type:'commentMemory',action,owner:'owner',target:'author',token:'confirm-event',postId:'123',
    text:'冰箱会自己补货的😂',requestDeadlineAt:Date.now()+2000},{tab:{id:7,url:'https://x.com/author/status/123'}},resolve));
  await call('reserve'); assert.equal(h.data.commentQualityLog,undefined);
  await call('confirm'); await h.call('commentMemoryQueue');
  assert.equal(h.data.commentQualityLog.at(-1).result,'send_confirmed');
});
