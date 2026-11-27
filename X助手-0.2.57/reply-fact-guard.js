// 本地风险筛选，不联网、不声称核实事实。人名/公司名本身不是跳过依据。
function normalizeFactGuardText(value) {
  return String(value || "").normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function getCurrentAffairsPostIssue(value) {
  const text = normalizeFactGuardText(value);
  if (!text) return "";
  const fresh = /刚刚|最新|突发|快讯|官宣|重磅|今日|今天|昨天|昨日|近日|本周|本月|目前|现在|即将|传闻|据报道|breaking\s+news|just\s+announced|today|yesterday|latest|currently|reportedly/i.test(text);
  const business = /黄仁勋|老黄|马斯克|英伟达|特斯拉|苹果|微软|谷歌|字节|阿里|腾讯|豆包|深度求索|公司|企业|美联储|央行|(?:space\s*x|spacx|nvidia|jensen\s+huang|elon\s+musk|tesla|openai|deepseek|google|microsoft|apple|meta|anthropic)\b/i.test(text);
  const financeEvent = /上市|退市|招股|估值|融资|收购|并购|财报|营收|市值|股价|股票|股市|涨停|跌停|大涨|大跌|降息|加息|利率|ipo\b|(?:stock|share)\s+price|going\s+public|publicly\s+traded|privately\s+held|(?:is|still)\s+private|earnings|acquisition|valuation|interest\s+rates?/i.test(text);
  const launchEvent = /发布|推出|发售|上市|首发|宣布|官宣|新款|新一代|release[ds]?\b|launch(?:ed|es)?\b|announce[ds]?\b|unveil(?:ed|s)?\b/i.test(text);
  const tech = /模型|芯片|显卡|手机|系统|软件|产品|新工具|model|chip|gpu|iphone/i.test(text);
  const politics = /总统|总理|首相|主席|部长|议会|政府|大选|选举|特朗普|拜登|习近平|普京|泽连斯基|trump|biden|president|prime\s+minister|election|government/i.test(text);
  const politicalEvent = /任命|任免|当选|连任|就任|卸任|辞职|罢免|去世|死亡|遇袭|开战|停火|制裁|关税|签署|新政|法案|发表讲话|宣布|appoint|resign|elected|inaugurat|died|dies|ceasefire|sanction|tariff/i.test(text);
  // 没有时效信号的流程教程/历史科普留给模型按普通内容处理。
  if (!fresh && !business && !politics && /科普|入门|教程|历史回顾|流程详解|基础知识|history\s+of|tutorial/i.test(text)) return "";
  if ((business && financeEvent) || (/(?:IPO|招股|上市|退市|财报|降息|加息|股市|stock\s+market|earnings)/i.test(text) && fresh) ||
      (business && launchEvent) || (tech && launchEvent && fresh) ||
      (politics && (politicalEvent || fresh)) || (fresh && financeEvent)) return "current_affairs";
  return "";
}

function getFactGuardMarkerIssue(value) {
  const text = normalizeFactGuardText(value);
  if (/\[\s*SKIP_CURRENT_AFFAIRS\s*\]/i.test(text)) return "current_affairs";
  if (/\[\s*SKIP_UNVERIFIED_FACT\s*\]/i.test(text)) return "unverified_fact";
  return getReplyContextMarkerIssue(text);
}

function getReplyContextMarkerIssue(value) {
  const text = normalizeFactGuardText(value);
  const markers = [
    [/\[\s*SKIP_VIDEO\s*\]/i, "video_media"],
    [/\[\s*SKIP_LIVE_OR_SPACE\s*\]/i, "live_space"],
    [/\[\s*SKIP_AUDIO\s*\]/i, "audio_media"],
    [/\[\s*SKIP_IMAGE_CONTEXT\s*\]/i, "image_context"],
    [/\[\s*SKIP_MISSING_CONTEXT\s*\]/i, "missing_context"],
    [/\[\s*SKIP_UNCLEAR_CONTEXT\s*\]/i, "unclear_context"],
    [/\[\s*SKIP_INTERACTION\s*\]/i, "interactive_content"],
    [/\[\s*SKIP_NO_AI_REPLY\s*\]/i, "no_ai_requested"]
  ];
  return markers.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function getReplyPostPolicyIssue(value, postContext = {}) {
  const text = normalizeFactGuardText(value);
  const context = postContext && typeof postContext === "object" ? postContext : {};
  if (!text) return "unclear_context";
  if (/不要(?:用|让)?(?:AI|人工智能)(?:来)?(?:回复|评论)|别(?:用|让|弄)?(?:AI|人工智能)(?:来)?(?:回复|评论)|不欢迎.{0,4}(?:AI|人工智能)(?:回复|评论)|禁止(?:AI|人工智能)(?:回复|评论)|no\s+ai\s+(?:repl(?:y|ies)|comments?)/i.test(text)) return "no_ai_requested";
  if (context.live || /\/i\/spaces\//i.test(text)) return "live_space";
  if (context.video) return "video_media";
  if (context.audio) return "audio_media";
  if (context.poll) return "interactive_content";
  if (/转发抽奖|评论抽奖|抽奖(?:活动|转发|评论|抽)?|转发(?:并)?抽|giveaway/i.test(text)) return "interactive_content";
  const contextless = text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  if (!contextless || /^(?:哈哈+|呵呵+|嘻嘻+|笑死|懂得都懂|懂的都懂|这就对了|然后呢|真的吗|真的假的|无语|离谱|绝了|在吗|lol+|lmao+|yep+|yeah+|ok(?:ay)?|same)$/iu.test(contextless)) return "unclear_context";
  return "";
}

function getReplyFixedContextIssue(postContext = {}) {
  const context = postContext && typeof postContext === "object" ? postContext : {};
  if (context.image) return "image_context";
  if ((context.quoted && !normalizeFactGuardText(context.quotedText)) || context.externalLink || context.replyPost) return "missing_context";
  return "";
}

function getReplyPolicyIssue(reply, original = "", postContext = {}) {
  const marker = getReplyContextMarkerIssue(reply);
  if (marker) return marker;
  const postIssue = getReplyPostPolicyIssue(original, postContext);
  if (postIssue) return postIssue;
  return getReplyFactIssue(reply, original);
}

function getReplyFactIssue(reply, original = "") {
  const text = normalizeFactGuardText(reply), source = normalizeFactGuardText(original);
  const marker = getFactGuardMarkerIssue(text);
  if (marker) return marker;
  if (getCurrentAffairsPostIssue(source)) return "current_affairs";
  if (/无法核实|无法确认|没有(?:实时|最新|联网)|知识(?:截止|更新)|截至我的|实时数据|不能联网|无法联网|不掌握.{0,6}(?:最新|消息)|(?:can't|cannot|unable to).{0,15}(?:verify|browse|access)|knowledge\s+cutoff|no\s+real.?time/i.test(text)) return "unverified_fact";
  // 即使原帖没命中关键词，回复也不能断言实时事件或用旧知识纠正日期。
  if (getCurrentAffairsPostIssue(text)) return "unverified_fact";
  const dateContext = /(?:19|20)\d{2}\s*(?:年|[-/.])|\b(?:19|20)\d{2}\b|今年|明年|本月|current\s+year/i.test(source + " " + text);
  const dateCorrection = /(?:现在|目前|今年|今天).{0,6}(?:才|还|不是|已经|明明|其实|是).{0,6}(?:19|20)\d{2}|(?:还没到|尚未到|才到|穿越|快进|未来|时间线.{0,8}错)|(?:还没|不是).{0,4}(?:19|20)\d{2}|(?:it(?:'s| is)|we(?:'re| are))\s+(?:(?:still|only|actually)\s+)?(?:19|20)\d{2}|(?:timeline|year|date).{0,15}(?:wrong|future)|(?:19|20)\d{2}.{0,12}(?:future|hasn't arrived)/i.test(text);
  if (dateContext && dateCorrection) return "unverified_fact";
  if (/(?:还没|尚未|尚未正式|早就|已经|目前|至今|仍未|即将|并未|已于|还未|根本没|不会).{0,10}(?:上市|退市|发布|发售|宣布|收购|融资|当选|就任|卸任|去世)|(?:hasn't|has not|not yet|already|still|currently|will).{0,24}(?:listed|public|released|announced|president|ceo)/i.test(text)) return "unverified_fact";
  if (/\b(?:publicly\s+traded|privately\s+held|(?:is|still|remains)\s+private|not\s+(?:public|listed)|has\s+gone\s+public)\b/i.test(text)) return "unverified_fact";
  if (/上市|退市|招股|估值|股价|市值|财报|融资|降息|加息|\bIPO\b/i.test(text)) return "unverified_fact";
  if (/(?:现任|现在的|目前的).{0,12}(?:总统|总理|首相|主席|部长|CEO|首席执行官)|(?:总统|总理|首相|CEO).{0,6}(?:还是|已经是|其实是|是|叫)|current\s+(?:president|ceo|prime\s+minister)/i.test(text)) return "unverified_fact";
  // 原帖没有提供的日期、价钱、估值、产品参数不允许自行补充。
  const facts = text.match(/(?:19|20)\d{2}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?|(?:19|20)\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d+(?:\.\d+)?\s*(?:万亿|亿|万)?\s*(?:美元|美金|人民币|元|港币|港元)|[$￥¥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:GB|TB|GHz|MHz|nm|纳米|TOPS|TFLOPS)\b/gi) || [];
  if (facts.some(fact => !source.toLowerCase().replace(/\s/g, "").includes(fact.toLowerCase().replace(/\s/g, "")))) return "unverified_fact";
  return "";
}

function isReplyFactSkip(issue) {
  return issue === "current_affairs" || issue === "unverified_fact";
}

function isReplyPolicySkip(issue) {
  return isReplyFactSkip(issue) || ["video_media", "live_space", "audio_media", "image_context", "missing_context",
    "unclear_context", "interactive_content", "no_ai_requested"].includes(issue);
}

function replyFactIssueLabel(issue) {
  return ({ current_affairs: "时事内容跳过", unverified_fact: "需要核实外部事实，已跳过",
    video_media: "含视频内容，已跳过", live_space: "含直播/Spaces内容，已跳过", audio_media: "含音频内容，已跳过",
    image_context: "需要查看图片才能理解，已跳过", missing_context: "缺少引用或对话上下文，已跳过",
    unclear_context: "帖子场景不明确，已跳过", interactive_content: "投票/抽奖等互动内容，已跳过",
    no_ai_requested: "作者不欢迎AI回复，已跳过" })[issue] || "";
}
