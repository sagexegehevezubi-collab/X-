// ===== 列表关注加评论任务（followerTarget）=====
// 首页互关关键词帖 → 来源博主认证关注者列表 → 收集最多 5 个候选 → 严格逐个进入主页、关注并评论。
// 每个来源最多关注5人；关注优先，只选一条24小时原创帖，不重试评论。

let followerTargetBusy = false;
let followerTargetNetworkPaused = false;
let followerTargetObservedEpoch = null;
let followerTargetObservedSession = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.followerTargetRecovery) followerTargetNetworkPaused = changes.followerTargetRecovery.newValue?.waiting === true &&
    changes.followerTargetRecovery.newValue?.sessionId === followerTargetObservedSession;
  if (changes.followerTargetRecoveryEpoch) followerTargetObservedEpoch = changes.followerTargetRecoveryEpoch.newValue || 0;
});
const FOLLOWER_TARGET_PER_ROUND = 4;          // 每轮执行 4 次“挑号→关注”
const FOLLOWER_TARGET_INTERVAL_MS = 20_000;   // 关注间隔 20 秒
const FOLLOWER_TARGET_MIN_FOLLOWERS = 600;    // followers 下界（含）
const FOLLOWER_TARGET_MAX_FOLLOWERS = 10000;  // followers 上界（含）
const FOLLOWER_TARGET_SCAN_LIMIT = 30;        // 关注者列表里最多检查前 30 个（滚动加载）
const FOLLOWER_TARGET_PROFILE_TIMEOUT_MS = 15000;

// 每个阶段期望的 pathname 判断
function followerTargetStageOf() {
  const path = location.pathname.toLowerCase();
  if (path === "/home") return "home";
  if (/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(path)) return "comment";
  if (/^\/[A-Za-z0-9_]{1,15}\/verified_followers\/?$/.test(path)) return "followers";
  if (/^\/[A-Za-z0-9_]{1,15}\/followers\/?$/.test(path)) return "followers";
  if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(path)) return "profile";
  return "other";
}

// v0.2.45 流程：至少连续扫描多个列表视口，合并并排序候选后再逐个处理。
const FOLLOWER_TARGET_V241_MAX_PER_SOURCE = 5;
const FOLLOWER_TARGET_V241_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS = 1;
// 单条帖子等待模型返回的硬上限；超时后当前帖子不再重复生成或发送。
const FOLLOWER_TARGET_RUNTIME_MESSAGE_TIMEOUT_MS = 40_000;
const FOLLOWER_TARGET_V241_KEYWORDS = ["蓝v", "蓝 v", "认证", "验证", "互关", "互", "互fo", "互粉", "关注", "关", "回关", "回", "求关注", "交友", "交", "友", "朋友", "粉丝", "粉", "follow", "mutual", "f4f", "fo"];
const FOLLOWER_TARGET_V243_MIN_SCAN_ROUNDS = 3;
const FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS = 16;
const FOLLOWER_TARGET_V243_MAX_SCAN_ROWS = 200;
const FOLLOWER_TARGET_V243_NO_PROGRESS_ROUNDS = 5;
const FOLLOWER_TARGET_V243_SCROLL_WAIT_MS = 1800;
const FOLLOWER_TARGET_SCAN_BUDGET_MS = 20000;

function followerTargetHomeUrl() {
  // X 有时会复用 /home 的 SPA 状态；查询参数强制产生一次新的导航，
  // 避免返回主页后继续读取上一轮的旧时间线节点。
  return `${location.origin}/home?followerTargetRefresh=${Date.now()}`;
}

function followerTargetV241SourcePost(job = {}) {
  const seen = new Set(Array.isArray(job.sourceAuthorsSeen) ? job.sourceAuthorsSeen : []);
  let source = null;
  let bestScore = -1;
  for (const post of getPostContainers()) {
    const text = findPostText(post);
    const author = sanitizeUsername(getAuthor(post));
    if (!author || seen.has(author) || !text || author === getCurrentUsername() || !matchedTerms(text).length) continue;
    const score = followerTargetEngagementScore(post);
    if (score > bestScore) { bestScore = score; source = author; }
  }
  return source;
}

function followerTargetRuntimeMessage(message, timeoutMs = FOLLOWER_TARGET_RUNTIME_MESSAGE_TIMEOUT_MS) {
  let timer = null;
  const request = Promise.resolve().then(() => chrome.runtime.sendMessage(message));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`等待扩展后台响应超过 ${Math.ceil(timeoutMs / 1000)} 秒，已跳过当前帖子`);
      error.code = "FOLLOWER_TARGET_RUNTIME_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function followerTargetCommentDeadline(operation, deadline, cancel) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancel();
      const error = new Error("评论全流程超过40秒，放弃评论并继续关注");
      error.code = "FT_EXPIRED";
      reject(error);
    }, Math.max(0, deadline - Date.now()));
  });
  try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
  finally { clearTimeout(timer); }
}

function followerTargetV241RowMatches(row) {
  const text = String(row?.innerText || "").replace(/\s+/g, " ").toLowerCase();
  const verified = Boolean(row?.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"], svg[aria-label*="认证"]'));
  return verified || FOLLOWER_TARGET_V241_KEYWORDS.some((keyword) => text.includes(keyword));
}

function followerTargetV243RowText(row) {
  if (!row) return "";
  const clone = row.cloneNode(true);
  clone.querySelectorAll("button,[role=\"button\"],svg,[aria-hidden=\"true\"]").forEach((node) => node.remove());
  return String(clone.innerText || clone.textContent || "")
    .replace(/Follow|Following|Follows you|关注了你/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function followerTargetV243ChineseProfile(row) {
  const text = followerTargetV243RowText(row);
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  // 用至少两个中文字符作为硬门槛，兼容“AI中文研究员”等中英混合账号，排除纯英文/其他语言账号。
  return { text, chinese, isChinese: chinese >= 2 };
}

function followerTargetV243CandidateScore(row) {
  const profile = followerTargetV243ChineseProfile(row);
  if (!profile.isChinese) return { score: -Infinity, ...profile };
  const lower = profile.text.toLowerCase();
  const keywordHits = FOLLOWER_TARGET_V241_KEYWORDS.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
  const verified = Boolean(row.querySelector('[data-testid="icon-verified"], [data-testid*="verified" i], [data-testid="UserVerifiedBadge"], [aria-label*="Verified" i], [aria-label*="认证"], [aria-label*="验证"], [aria-label*="蓝V"]'));
  const score = profile.chinese * 4 + keywordHits * 10 + (verified ? 25 : 0) + Math.min(12, Math.floor(profile.text.length / 20));
  return { score, keywordHits, verified, ...profile };
}

function followerTargetV244FollowState(row) {
  const controls = [...row.querySelectorAll('button,[role="button"]')].filter((button) => button.getClientRects().length > 0);
  const labels = controls.map((button) => `${button.getAttribute("data-testid") || ""} ${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim());
  if (labels.some((label) => /(?:^|\s)(?:follow|关注)(?:\s|$)/i.test(label) && !/(?:following|已关注|正在关注|取消关注|unfollow)/i.test(label))) return "unfollowed";
  if (labels.some((label) => /(?:following|已关注|正在关注|取消关注|unfollow)/i.test(label))) return "followed";
  return "unknown";
}

function followerTargetV243AddVisibleCandidates(job) {
  if (!Array.isArray(job.candidatesSeen)) job.candidatesSeen = [];
  if (!Array.isArray(job.candidatesScanned)) job.candidatesScanned = [];
  if (!Array.isArray(job.candidateBatch)) job.candidateBatch = [];
  if (!job.candidateScores || typeof job.candidateScores !== "object") job.candidateScores = {};
  let visible = 0;
  let added = 0;
  for (const row of followerTargetListRows()) {
    const username = sanitizeUsername(getRelationshipUsername(row));
    if (!username || job.candidatesSeen.includes(username)) continue;
    visible += 1;
    if (username === job.owner || username === job.sourceAuthor) {
      job.candidatesSeen.push(username);
      continue;
    }
    const followState = followerTargetV244FollowState(row);
    // X 虚拟列表刚滚入时，资料和按钮可能还没渲染；这时不要写入 candidatesSeen，下一轮继续复查。
    if (followState === "unknown") continue;
    const scored = followerTargetV243CandidateScore(row);
    if (scored.text.length < 4) continue;
    job.candidatesSeen.push(username);
    if (followState !== "unfollowed" || !scored.isChinese) continue;
    job.candidateScores[username] = scored.score;
    job.candidateBatch.push(username);
    job.candidatesScanned.push(username);
    added += 1;
  }
  job.candidateBatch = [...new Set(job.candidateBatch)].sort((a, b) => (job.candidateScores[b] || 0) - (job.candidateScores[a] || 0));
  return { visible, added };
}

async function followerTargetV243CollectCandidates(job, active, pause, status) {
  const started = Date.now();
  let scannedRows = 0;
  let noProgressRounds = 0;
  let totalAdded = 0;
  for (let round = 0; round < FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS && active() && Date.now() - started < FOLLOWER_TARGET_SCAN_BUDGET_MS; round += 1) {
    const result = followerTargetV243AddVisibleCandidates(job);
    scannedRows += result.visible;
    totalAdded += result.added;
    if (result.added) noProgressRounds = 0;
    else noProgressRounds += 1;
    await status(`正在快速浏览关注者列表：第 ${round + 1}/${FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS} 轮，已读取约 ${scannedRows} 个账号，筛出 ${job.candidateBatch.length} 个中文候选`);
    const minimumScanComplete = round + 1 >= FOLLOWER_TARGET_V243_MIN_SCAN_ROUNDS;
    // 主候选之外保留两个备选；不再机械扫描满5～16轮。
    if (minimumScanComplete && (job.candidateBatch.length >= FOLLOWER_TARGET_V241_MAX_PER_SOURCE + 2 || scannedRows >= FOLLOWER_TARGET_V243_MAX_SCAN_ROWS || noProgressRounds >= FOLLOWER_TARGET_V243_NO_PROGRESS_ROUNDS)) break;
    if (round + 1 >= FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS || Date.now() - started >= FOLLOWER_TARGET_SCAN_BUDGET_MS) break;
    const visibleBefore = followerTargetListRows().map(row => `${getRelationshipUsername(row)}:${followerTargetV244FollowState(row)}:${followerTargetV243RowText(row)}`).join("|");
    scrollRelationshipList();
    const until = Math.min(Date.now() + FOLLOWER_TARGET_V243_SCROLL_WAIT_MS, started + FOLLOWER_TARGET_SCAN_BUDGET_MS);
    // 先给虚拟列表一个渲染窗口，再按真实新增资料提前结束等待。
    if (!await pause(Math.min(600, Math.max(0, until - Date.now())))) break;
    while (active() && Date.now() < until) {
      const visibleNow = followerTargetListRows().map(row => `${getRelationshipUsername(row)}:${followerTargetV244FollowState(row)}:${followerTargetV243RowText(row)}`).join("|");
      if (visibleNow !== visibleBefore) break;
      if (!await pause(Math.min(200, until - Date.now()))) break;
    }
  }
  // 最后一轮滚动加载出的账号也要读取，避免刚出现的合适候选被丢弃。
  if (active()) totalAdded += followerTargetV243AddVisibleCandidates(job).added;
  return { scannedRows, totalAdded, candidates: job.candidateBatch.length };
}

function followerTargetV241OriginalPost(article) {
  const full = String(article?.innerText || "").replace(/\s+/g, " ");
  return !/(?:回复了|回复给|回复于|转发|转推|被转发|replied to|replying to|reposted|retweeted)/i.test(full);
}

function followerTargetV241PostDate(article) {
  const time = getOuterPostTime(article);
  const value = Date.parse(time?.getAttribute("datetime") || "");
  return Number.isFinite(value) ? value : null;
}

async function followerTargetV241CollectPosts(username, active, owner = getCurrentUsername()) {
  const started = Date.now();
  const posts = new Map();
  while (active() && Date.now() - started < 5000) {
    const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
    for (const article of getPostContainers()) {
      if (!primary.contains(article) || sanitizeUsername(getAuthor(article)) !== username || !followerTargetV241OriginalPost(article)) continue;
      const timestamp = followerTargetV241PostDate(article);
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      const text = findPostText(article);
      const reply = article.querySelector('[data-testid="reply"]');
      if (!id || !timestamp || timestamp > Date.now() || Date.now() - timestamp > FOLLOWER_TARGET_V241_RECENT_WINDOW_MS || !text || !reply) continue;
      const keys = [`followerTargetReply:${owner}:${username}:${id}`, `replyAttempt:${owner}:${id}`, "uncertainReplyPostIds"];
      const state = await chrome.storage.local.get(keys);
      if (state[keys[0]] || state[keys[1]] || state.uncertainReplyPostIds?.includes(id)) continue;
      posts.set(id, { id, author: username, date: new Date(timestamp).toISOString(), text: text.slice(0, 1800) });
      break;
    }
    if (posts.size >= FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return [...posts.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS);
}

// X 用户名合法形态：仅字母/数字/下划线，1–15 位。用于统一清洗，杜绝
// "/home"、"//foo/"、"i/web" 等特殊路径被误判为 username（曾导致污染）。
function sanitizeUsername(value) {
  const raw = String(value || "").trim().replace(/^@/, "");
  const match = raw.match(/^[A-Za-z0-9_]{1,15}$/);
  return match ? match[0].toLowerCase() : null;
}

function followerTargetUsernameFromPath() {
  const path = location.pathname;
  // 排除 X 的特殊路径，只识别真实用户主页
  if (/^\/(?:home|i|search|notifications|messages|explore|settings|compose|login|signup|tos|privacy|account)(?:\/|$)/i.test(path)) return null;
  const match = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
  return sanitizeUsername(match?.[1]);
}

// 解析 X 粉丝数文本：支持 "3,245"、"3.2K"、"1.5万"、"10K"、"1万"，以及带后缀的
// "12,000 Followers"、"4,567 关注者" 等。
function parseFollowerCount(text) {
  const raw = String(text || "").replace(/[\s,，]/g, "");
  if (!raw) return null;
  const wan = raw.match(/([0-9]+(?:\.[0-9]+)?)万/);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  const k = raw.match(/([0-9]+(?:\.[0-9]+)?)[kK]/);
  if (k) return Math.round(Number(k[1]) * 1000);
  const plain = raw.match(/([0-9]+)/);
  if (plain) return Number(plain[1]);
  return null;
}

// 从主页读取 followers 数量。X 的 followers 计数链接在不同版本/语言下 selector 会变化，
// 这里做多重兜底：
//   1) a[href$="/verified_followers"]（新版：认证关注者标签，数字在嵌套 span span 里）
//   2) a[href$="/followers"]（旧版）
//   3) [data-testid="Followers"]
// 数字文本可能带后缀（"12,000 Followers"、"1.2万 关注者"），由 parseFollowerCount 统一解析。
function readProfileFollowers(username) {
  const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
  // 候选节点：优先 verified_followers（新版主页用这个），其次 followers，再次 data-testid。
  const nodes = [
    scope.querySelector('a[href$="/verified_followers"]'),
    scope.querySelector('a[href$="/followers"]'),
    scope.querySelector('[data-testid="Followers"]')
  ].filter(Boolean);
  for (const node of nodes) {
    // 数字通常在嵌套 span span 里，其次才在节点自身文本里。
    const deepSpan = node.querySelector('span span') || node.querySelector('span');
    const text = (deepSpan?.textContent || node.getAttribute("aria-label") || node.innerText || node.textContent || "").replace(/\s+/g, "");
    const count = parseFollowerCount(text);
    if (count !== null) return count;
  }
  // 兜底：遍历所有指向 followers / verified_followers 的链接
  for (const link of scope.querySelectorAll('a[href$="/verified_followers"], a[href$="/followers"]')) {
    const deepSpan = link.querySelector('span span') || link.querySelector('span');
    const text = (deepSpan?.textContent || link.getAttribute("aria-label") || link.innerText || link.textContent || "").replace(/\s+/g, "");
    const count = parseFollowerCount(text);
    if (count !== null) return count;
  }
  return null;
}

function followerTargetFollowsYou(row) {
  const markerPattern = /^(?:follows you|关注了你)$/i;
  return [...row.querySelectorAll("[aria-label],span")].some((element) =>
    markerPattern.test((element.getAttribute("aria-label") || element.innerText || "").replace(/\s+/g, " ").trim())) ||
    /(?:^|\s)(?:follows you|关注了你)(?:\s|$)/i.test((row.innerText || "").replace(/\s+/g, " ").trim());
}

// 判断某 UserCell 是否“未关注”（仍可点击“关注”）。
function followerTargetIsUnfollowed(row) {
  return [...row.querySelectorAll('button,[role="button"]')].some((button) =>
    button.getAttribute("data-testid") === "follow" ||
    /^(?:关注|follow)(?:\s|$)/i.test(`${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim()));
}

// 顶层人工延迟：随机等待 1–5 秒，期间若任务停止则提前返回 false。
async function humanWaitActive(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isTaskActive(taskGeneration)) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
  }
  return true;
}
const randomHumanDelay = () => 1000 + Math.floor(Math.random() * 4000);

// 资料头部就绪不代表帖子已就绪；在完整等待窗口内持续检查，避免空列表误判。
async function followerTargetWaitForProfilePost(candidate, active) {
  const started = Date.now();
  let snapshot = { target: null, postCount: 0, ownPostCount: 0, samples: [] };
  while (active() && Date.now() - started < FOLLOWER_TARGET_PROFILE_TIMEOUT_MS) {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    const posts = getPostContainers().filter((post) => primary && primary.contains(post));
    const own = posts.filter((post) => sanitizeUsername(getAuthor(post)) === candidate);
    const target = own.map((post) => ({
      id: getPostId(post)?.match(/\/status\/(\d+)/)?.[1],
      text: findPostText(post)
    })).find((post) => post.id && matchedTerms(post.text).length) || null;
    snapshot = {
      target, postCount: posts.length, ownPostCount: own.length,
      samples: posts.slice(0, 5).map((post) => ({ author: getAuthor(post), text: findPostText(post).slice(0, 100) }))
    };
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ...snapshot, elapsedMs: Date.now() - started };
}

// 今日统计：累加关注数或评论数（按本地日期归档）。
function followerTargetDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
// 帖子的互动量粗估（点赞 + 转发×2 + 回复），用于在多个互关帖里优先挑体量更大的作者。
function followerTargetEngagementScore(post) {
  const parse = (el) => {
    if (!el) return 0;
    const raw = String(el.getAttribute("aria-label") || el.innerText || "").replace(/,/g, "");
    const match = raw.match(/([\d.]+)\s*(万|w|k|千)?/i);
    if (!match) return 0;
    let value = parseFloat(match[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = (match[2] || "").toLowerCase();
    if (unit === "万" || unit === "w") value *= 10000;
    else if (unit === "k" || unit === "千") value *= 1000;
    return value;
  };
  return parse(post.querySelector('[data-testid="like"]')) +
    parse(post.querySelector('[data-testid="retweet"]')) * 2 +
    parse(post.querySelector('[data-testid="reply"]'));
}

// 取「真正的关注者列表」行，剔除 X 插在列表顶部的「推荐关注」模块（aside / 横向卡片）。
// 之前只按 primaryColumn 过滤，导致推荐位的小号被优先选中——候选池全是几十粉的账号，
// 表现为"挑了一堆人却一个都不满足 600–10000"。
function followerTargetListRows() {
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return [];
  const primaryWidth = primary.getBoundingClientRect().width || 0;
  const base = [...primary.querySelectorAll('[data-testid="UserCell"]')]
    .filter((row) => row.getClientRects().length > 0)
    .filter((row) => !row.closest('[data-testid="sidebarColumn"]'))
    // 推荐关注模块渲染成 aside，不是真正的列表项
    .filter((row) => !row.closest('aside'))
    .filter((row) => {
      const label = row.closest('[aria-label]')?.getAttribute('aria-label') || "";
      return !/推荐|Recommend|Similar/i.test(label);
    })
    // 横向卡片（推荐位）宽度明显窄于列表行，用宽度兜底再排一次
    .filter((row) => (primaryWidth > 300 ? row.getBoundingClientRect().width >= primaryWidth * 0.45 : true));
  // 优先只保留「时间线/列表 region」内的行；若一个都没有则退回 base，避免过滤过严挑不到号
  const inRegion = base.filter((row) => row.closest('section[role="region"]'));
  return inRegion.length ? inRegion : base;
}

async function bumpFollowerTargetStat(field) {
  const date = followerTargetDateKey();
  const { followerTargetStats = {} } = await chrome.storage.local.get({ followerTargetStats: {} });
  const current = followerTargetStats.date === date ? followerTargetStats : { date, follows: 0, comments: 0 };
  current[field] = Math.max(0, Number(current[field]) || 0) + 1;
  await chrome.storage.local.set({ followerTargetStats: current });
}

// 记录本轮每个候选的校验结果（followers + 判定），用于诊断"为何一直无关注/评论"。
// 保留最近 20 条，自检时一次性展示分布。
async function recordCandidateVerdict(candidate, followers, verdict) {
  try {
    const { followerTargetVerdicts = [] } = await chrome.storage.local.get({ followerTargetVerdicts: [] });
    const next = [...followerTargetVerdicts, { candidate, followers, verdict, at: new Date().toLocaleTimeString() }].slice(-20);
    await chrome.storage.local.set({ followerTargetVerdicts: next });
  } catch {}
}

// 评论失败明细单独保存，便于定位“为什么在某个博主处停很久”。只保留最近 100 条，
// 不影响现有榜单失败记录和候选判定记录。
async function recordFollowerTargetCommentFailure({ candidate, postId, attempt, phase, reason, followed }) {
  try {
    const { followerTargetCommentFailures = [] } = await chrome.storage.local.get({ followerTargetCommentFailures: [] });
    const item = {
      candidate: String(candidate || ""),
      postId: postId ? String(postId) : "",
      attempt: Math.max(1, Number(attempt) || 1),
      phase: String(phase || "comment"),
      reason: String(reason || "评论失败").slice(0, 240),
      followed: Boolean(followed),
      at: new Date().toISOString()
    };
    await chrome.storage.local.set({ followerTargetCommentFailures: [...followerTargetCommentFailures, item].slice(-100) });
  } catch {}
}

// 在当前候选主页上直接点击“关注”，并确认状态。
async function followOnProfile(username, assertActive) {
  const expected = username.toLowerCase();
  let clickedFollow = false;
  // 保留短暂停顿，且发送前检查阶段期限和执行代次。
  if (!await humanWaitActive(ftRandomMs(FT_POLICY.followMinMs, FT_POLICY.followMaxMs))) return { error: "任务已停止" };
  const startedAt = Date.now(); // 随机停顿不挤占关注结果确认窗口。
  while (Date.now() - startedAt < 8000) {
    if (assertActive) await assertActive();
    if (!isTaskActive(taskGeneration)) return { error: "任务已停止" };
    if (followerTargetStageOf() !== "profile" || followerTargetUsernameFromPath() !== expected || document.readyState === "loading")
      return { error: "目标主页已改变或尚未就绪，取消关注操作" };
    if (hasXFollowRateLimit()) return { rateLimited: true };
    const profileScope = document.querySelector('[data-testid="primaryColumn"]') || document;
    const buttons = [...profileScope.querySelectorAll('button,[role="button"]')]
      .filter((button) => button.getClientRects().length && !button.closest('article,[data-testid="UserCell"]'));
    const labels = buttons.map((button) => ({
      button,
      label: `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim().toLowerCase()
    }));
    const followed = labels.some(({ label }) => /(^|\s)(已关注|正在关注|following|unfollow)(\s|$)/i.test(label));
    if (followed) return { followed: clickedFollow, alreadyFollowing: !clickedFollow };
    const follow = labels.find(({ label }) => /(^|\s)(关注|follow)(\s|$)/i.test(label));
    if (follow && !clickedFollow) {
      if (assertActive) await assertActive();
      follow.button.click();
      clickedFollow = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (clickedFollow) return { error: "点击关注后未能确认关注状态" };
  return { error: "主页未找到可确认的关注按钮" };
}

// ===== 自检模块 =====
// 在任务旁点击「自检」时触发：收集当前 X 页面的诊断数据，返回结构化文本供复制给我。
async function runFollowerTargetSelfCheck() {
  const lines = [];
  const push = (label, value) => lines.push(`${label}: ${value}`);

  try {
    push("自检时间", new Date().toLocaleString());
    push("当前URL", location.href);
    push("任务控制版本", "0.2.54-follow-priority");
    const recoveryState = await chrome.storage.local.get({ followerTargetRecovery: null, followerTargetRecoveryEpoch: 0, followerTargetJob: null });
    push("网络恢复状态", recoveryState.followerTargetRecovery?.waiting ?
      `等待恢复，范围=${recoveryState.followerTargetRecovery.scope}，开始于${new Date(recoveryState.followerTargetRecovery.waitingSince).toLocaleString()}` : "未处于断网等待");
    push("当前评论截止时间", recoveryState.followerTargetJob?.commentDeadlineAt ? new Date(recoveryState.followerTargetJob.commentDeadlineAt).toLocaleString() : "未进入评论计时");
    push("任务恢复代次", recoveryState.followerTargetRecoveryEpoch);
    push("阶段判断", followerTargetStageOf());
    push("识别到的页面账号", followerTargetUsernameFromPath() || "(无)");

    // ===== 1. 认证关注者列表挑号诊断 =====
    const allCells = [...document.querySelectorAll('[data-testid="UserCell"]')];
    const primaryScope = document.querySelector('[data-testid="primaryColumn"]');
    const sidebarScope = document.querySelector('[data-testid="sidebarColumn"]');
    const primaryCells = primaryScope ? [...primaryScope.querySelectorAll('[data-testid="UserCell"]')] : [];
    const sidebarCells = sidebarScope ? [...sidebarScope.querySelectorAll('[data-testid="UserCell"]')] : [];
    push("UserCell总数(全页)", allCells.length);
    push("主栏primaryColumn内UserCell数", primaryCells.length);
    push("侧边栏sidebarColumn内UserCell数", sidebarCells.length);

    // 侧边栏里的账号（污染源排查）
    if (sidebarCells.length) {
      const sidebarNames = sidebarCells.map((row) => getRelationshipUsername(row)).filter(Boolean);
      push("侧边栏残留账号(应排除)", sidebarNames.join("；"));
    }

    // 修复后的挑号范围：与任务主循环完全一致（followerTargetListRows 已排除侧边栏/推荐位/aside）
    const validRows = followerTargetListRows();
    push("任务实际可用列表行数", validRows.length);
    const validList = validRows.map((row) => ({
      username: getRelationshipUsername(row),
      isUnfollowed: followerTargetIsUnfollowed(row)
    })).filter((item) => item.username);
    push("修复后候选范围(主栏内账号)", validList.map((item) =>
      `${item.username}${item.isUnfollowed ? "(未关注)" : "(已关注/无法判断)"}`).join("；") || "(空)");

    const owner = getCurrentUsername();
    const sourceAuthor = followerTargetUsernameFromPath();
    let firstCandidate = null;
    for (const row of validRows) {
      const username = getRelationshipUsername(row);
      if (!username || username === owner || username === sourceAuthor) continue;
      if (!followerTargetIsUnfollowed(row)) continue;
      firstCandidate = username;
      break;
    }
    push("修复后第一个候选", firstCandidate || "(无可用未关注账号)");

    // ===== 2. 评论链路诊断 =====
    const posts = getPostContainers();
    push("当前页帖子容器数", posts.length);
    const postsInfo = posts.slice(0, 5).map((post) => {
      const id = getPostId(post)?.match(/\/status\/(\d+)/)?.[1];
      const author = getAuthor(post);
      const hasReplyBtn = Boolean(post.querySelector('[data-testid="reply"]'));
      const text = (findPostText(post) || "").slice(0, 20);
      return `[id=${id || "无"} 作者=${author || "无"} 回复按钮=${hasReplyBtn ? "有" : "无"} 文本=${text}]`;
    });
    push("前5条帖子详情", postsInfo.join("\n    ") || "(无帖子)");

    const mutualPosts = posts.filter((post) => matchedTerms(findPostText(post)).length > 0);
    push("含互关关键词的帖子数", mutualPosts.length);

    // ===== 3. 实测「生成评论草稿」（定位"始终没评论"的关键环节）=====
    if (mutualPosts.length) {
      const sample = findPostText(mutualPosts[0]);
      push("→ 正在实测 generateDraft（取第1条互关帖文本前50字）", (sample || "").slice(0, 50));
      try {
        const draftResult = await chrome.runtime.sendMessage({
          type: "generateDraft",
          postText: sample,
          replyContext: "timeline_influencer"
        });
        if (draftResult?.error) {
          const isConfigIssue = /api\s*key|配置|密钥|固定回复|保存/i.test(draftResult.error);
          push("generateDraft 结果", `报错: ${draftResult.error}${isConfigIssue ? " ← 【配置问题：这是评论失败根因】" : ""}`);
        } else if (!draftResult?.draft) {
          push("generateDraft 结果", "未返回草稿内容（可能未配置 AI/固定回复）");
        } else if (draftResult.draft === "[SKIP]") {
          push("generateDraft 结果", "[SKIP]（模型判断不适合评论）");
        } else {
          push("generateDraft 结果", `成功，草稿(${draftResult.draft.length}字): ${draftResult.draft.slice(0, 40)}`);
        }
      } catch (error) {
        push("generateDraft 结果", `调用异常: ${String(error?.message || error)}`);
      }
    } else {
      push("generateDraft 实测", "跳过（当前页无互关关键词帖）");
    }

    // ===== 4. 认证标识检测 =====
    const verifiedMarkers = document.querySelectorAll('[data-testid="icon-verified"], svg[aria-label*="认证"], svg[aria-label*="Verified"], [data-testid="UserVerifiedBadge"]');
    push("页面认证标识节点数", verifiedMarkers.length);

    // ===== 4.5 主页 followers 读取专项诊断（定位"打开主页就回列表"）=====
    if (followerTargetStageOf() === "profile") {
      const pageUser = followerTargetUsernameFromPath();
      push("readProfileFollowers 返回值", String(readProfileFollowers(pageUser)));
      const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
      const fNode = scope.querySelector('a[href$="/verified_followers"]') || scope.querySelector('[data-testid="Followers"]') || scope.querySelector('a[href$="/followers"]');
      if (fNode) {
        push("followers节点 aria-label", `"${fNode.getAttribute("aria-label") || ""}"`);
        push("followers节点 innerText", `"${(fNode.innerText || "").replace(/\s+/g, "")}"`);
        push("followers节点 textContent", `"${(fNode.textContent || "").replace(/\s+/g, "")}"`);
        push("followers节点 href", fNode.getAttribute("href") || "(无)");
        const deepSpan = fNode.querySelector('span span') || fNode.querySelector('span');
        push("followers节点 嵌套span文本", `"${(deepSpan?.textContent || "").replace(/\s+/g, "")}"`);
      } else {
        push("followers节点", "未找到 [data-testid=Followers] 或 a[href$=/followers] / a[href$=/verified_followers]");
      }
      // 枚举所有指向 followers 的链接
      const allFollowerLinks = [...scope.querySelectorAll('a[href$="/followers"], a[href$="/verified_followers"]')];
      push("主页指向followers的链接数", allFollowerLinks.length);
      allFollowerLinks.slice(0, 5).forEach((link, i) => {
        push(`  followers链接[${i}]`, `aria="${link.getAttribute("aria-label") || ""}" innerText="${(link.innerText || "").replace(/\s+/g, "")}"`);
      });

      // 枚举主页资料头部区域所有带数字的链接/元素（定位 followers 真实 DOM）
      const headerHints = [];
      const allLinks = [...scope.querySelectorAll('a[href]')];
      for (const link of allLinks) {
        const href = link.getAttribute("href") || "";
        if (!/(followers|following|verified_followers)/i.test(href)) continue;
        const txt = (link.innerText || link.textContent || "").replace(/\s+/g, "").slice(0, 40);
        headerHints.push(`href="${href}" text="${txt}" aria="${(link.getAttribute("aria-label") || "").slice(0, 40)}"`);
      }
      push("资料区含followers/following关键词的链接", headerHints.join("；") || "(无)");

      // 枚举 UserProfileHeader_Items 及附近带数字的 span 文本
      const headerScope = scope.querySelector('[data-testid="UserProfileHeader_Items"], [data-testid="UserName"]')?.parentElement || scope;
      const numericSpans = [...headerScope.querySelectorAll('span')]
        .map((s) => (s.innerText || "").replace(/\s+/g, ""))
        .filter((t) => t && /\d/.test(t) && t.length <= 30)
        .slice(0, 20);
      push("资料头部带数字的span文本", numericSpans.join(" | ") || "(无)");
    }

    // ===== 5. 评论链路实测（点开一条互关帖的回复按钮，检测回复框能否出现，不发送）=====
    if (mutualPosts.length) {
      push("→ 正在实测「点回复按钮→回复框出现」", "");
      const probePost = mutualPosts[0];
      const replyBtn = probePost.querySelector('[data-testid="reply"]');
      push("目标帖回复按钮", replyBtn ? "存在" : "不存在");
      if (replyBtn) {
        replyBtn.click();
        // 等待回复弹窗或回复框出现（最多 4 秒）
        const probeStart = Date.now();
        let dialogFound = false;
        let editorFound = false;
        let editorCount = 0;
        while (Date.now() - probeStart < 4000) {
          const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
            .filter((d) => d.getClientRects().length > 0);
          if (dialogs.length) dialogFound = true;
          const editorSelector = '[contenteditable="true"][role="textbox"], [contenteditable="plaintext-only"][role="textbox"], [contenteditable="true"][data-testid^="tweetTextarea_"], [data-testid^="tweetTextarea_"] [contenteditable="true"], .DraftEditor-root [contenteditable="true"]';
          const editors = [...document.querySelectorAll(editorSelector)].filter((e) => e.getClientRects().length > 0);
          editorCount = editors.length;
          if (editors.length) { editorFound = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        push("回复弹窗(dialog)出现", dialogFound ? "是" : "否");
        push("回复编辑器出现", editorFound ? "是" : "否");
        push("可见编辑器数量", editorCount);

        // 枚举弹窗内所有候选输入元素及其属性（定位真实编辑器结构）
        const visibleDialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
          .filter((d) => d.getClientRects().length > 0);
        const probeScope = visibleDialogs[0] || document;
        const inputCandidates = [...probeScope.querySelectorAll(
          'textarea, [contenteditable], [role="textbox"], [data-testid^="tweetTextarea"], .DraftEditor-root, .public-DraftEditor-content, .notranslate')]
          .filter((node) => node.getClientRects().length > 0)
          .slice(0, 15)
          .map((node) => {
            const tag = node.tagName.toLowerCase();
            const testid = node.getAttribute("data-testid") || "";
            const role = node.getAttribute("role") || "";
            const ce = node.getAttribute("contenteditable") || "";
            const aria = (node.getAttribute("aria-label") || "").slice(0, 30);
            const cls = (node.className && typeof node.className === "string" ? node.className : "").slice(0, 50);
            return `[tag=${tag} testid=${testid} role=${role} contenteditable=${ce} class=${cls} aria=${aria}]`;
          });
        push("弹窗内输入类元素(前15个)", inputCandidates.join("\n    ") || "(无任何 textarea/contenteditable/textbox 元素)");

        // 关闭探针弹窗（按 Esc / 点击关闭按钮，避免影响页面）
        const closeBtn = [...document.querySelectorAll('[role="dialog"] button[aria-label*="关闭"],[role="dialog"] button[aria-label*="Close"],button[data-testid="app-bar-close"]')]
          .filter((b) => b.getClientRects().length > 0)[0];
        if (closeBtn) closeBtn.click();
        else {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }
      }
    } else {
      push("评论链路实测", "跳过（当前页无互关关键词帖）");
    }

    // ===== 6. 上次评论失败的具体错误（持久化）=====
    try {
      const { followerTargetLastCommentError = "" } = await chrome.storage.local.get({ followerTargetLastCommentError: "" });
      push("上次评论失败错误", followerTargetLastCommentError || "(无，最近一次评论未失败或未运行过)");
      const { followerTargetCommentFailures = [] } = await chrome.storage.local.get({ followerTargetCommentFailures: [] });
      const recent = Array.isArray(followerTargetCommentFailures) ? followerTargetCommentFailures.slice(-5) : [];
      push("最近评论失败明细", recent.length
        ? recent.map((item) => `@${item.candidate || "?"} 第${item.attempt || "?"}次 ${item.phase || "comment"} 帖${item.postId || "?"}：${item.reason || "未知"}`).join("\n")
        : "(无记录)");
    } catch {
      push("上次评论失败错误", "(读取失败)");
    }

    // ===== 7. 上次"回列表跳过"的具体原因（定位"打开主页就回列表"）=====
    try {
      const { followerTargetLastSkipReason = "" } = await chrome.storage.local.get({ followerTargetLastSkipReason: "" });
      push("上次跳过原因", followerTargetLastSkipReason || "(无记录)");
    } catch {
      push("上次跳过原因", "(读取失败)");
    }

    // ===== 8. 当前持久化任务状态（定位"不回首页/畸形账号"）=====
    try {
      const { followerTargetFollowLimit = 10 } = await chrome.storage.local.get({ followerTargetFollowLimit: 10 });
      push("本轮关注上限", String(followerTargetFollowLimit));
      const { followerTargetJob = null } = await chrome.storage.local.get({ followerTargetJob: null });
      if (followerTargetJob) {
        push("当前任务 stage", String(followerTargetJob.stage || "(无)"));
        push("当前任务 sourceAuthor", String(followerTargetJob.sourceAuthor || "(空)"));
        push("本轮已处理来源博主", Array.isArray(followerTargetJob.sourceAuthorsSeen) ? followerTargetJob.sourceAuthorsSeen.join("，") || "(空)" : "(未记录)");
        push("当前任务 candidateUsername", String(followerTargetJob.candidateUsername || "(空)"));
        push("当前任务 step2Count", String(followerTargetJob.step2Count ?? "(未记录)"));
        push("当前任务 followCountInRound", String(followerTargetJob.followCountInRound ?? "(未记录)"));
        push("本次任务 sessionFollowCount", String(followerTargetJob.sessionFollowCount ?? "(未记录)"));
        push("当前任务 roundId", String(followerTargetJob.roundId || "(无)"));
        push("当前任务 pickedInRound", Array.isArray(followerTargetJob.pickedInRound) ? followerTargetJob.pickedInRound.join("，") || "(空)" : "(非数组)");
      } else {
        push("当前任务状态", "(无持久化 job)");
      }
    } catch {
      push("当前任务状态", "(读取失败)");
    }

    // ===== 9. 任务主循环心跳（定位"任务是否在跑/跳没跳转"）=====
    try {
      const { followerTargetHeartbeat = "", followerTargetHeartbeatAt = 0 } = await chrome.storage.local.get({ followerTargetHeartbeat: "", followerTargetHeartbeatAt: 0 });
      push("任务主循环心跳", followerTargetHeartbeat || "(无心跳记录，说明任务主循环根本没在运行)");
      push("最近心跳时间", followerTargetHeartbeatAt ? new Date(followerTargetHeartbeatAt).toLocaleString() : "(无)");
    } catch {
      push("任务主循环心跳", "(读取失败)");
    }

    try {
      const { followerTargetLastProfileScan = null } = await chrome.storage.local.get({ followerTargetLastProfileScan: null });
      push("主页帖子检查版本", "20261112-wait-posts-v1");
      push("最近主页帖子检查(含文本摘要)", followerTargetLastProfileScan ? JSON.stringify(followerTargetLastProfileScan) : "(暂无，等待达标候选)");
    } catch {
      push("最近主页帖子检查", "读取失败");
    }

    // ===== 10. 最近候选校验记录（看清 followers 分布，判断"是否真没有合格账号"）=====
    try {
      const { followerTargetVerdicts = [] } = await chrome.storage.local.get({ followerTargetVerdicts: [] });
      if (Array.isArray(followerTargetVerdicts) && followerTargetVerdicts.length) {
        const brief = followerTargetVerdicts.slice(-12).map((v) => `[${v.at}] ${v.candidate}${v.followers === null || v.followers === undefined ? "" : `(${v.followers})`} → ${v.verdict}`);
        push("最近候选校验记录", brief.join("；"));
      } else {
        push("最近候选校验记录", "(暂无)");
      }
      const rowsNow = followerTargetListRows();
      push("当前列表行数(已排除推荐位)", String(rowsNow.length));
    } catch {
      push("最近候选校验记录", "(读取失败)");
    }

    return { ok: true, text: lines.join("\n") };
  } catch (error) {
    return { ok: false, text: `自检出错：${String(error?.message || error)}` };
  }
}
