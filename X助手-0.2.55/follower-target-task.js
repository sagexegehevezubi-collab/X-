// ===== 列表关注加评论任务（followerTarget）=====
// 首页互关关键词帖 → 来源博主认证关注者列表 → 收集最多 5 个候选 → 严格逐个进入主页、关注并评论。
// 每个来源博主最多成功关注 5 人；关注后只处理最近 24 小时原创帖，评论失败会等待 20 秒更换第二条帖子。
// 评论链路的任何失败（包括页面/控件超时和异常）都计入同一个博主级两次上限。

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
const FOLLOWER_TARGET_V241_COMMENT_RETRY_MS = 20_000;
const FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS = 2;
// 单条帖子等待模型返回的硬上限；超时后当前帖子不再重复生成或发送。
const FOLLOWER_TARGET_RUNTIME_MESSAGE_TIMEOUT_MS = 90_000;
const FOLLOWER_TARGET_STALL_WATCHDOG_INTERVAL_MS = 15_000;
const FOLLOWER_TARGET_STALL_WATCHDOG_LIMIT_MS = 100_000;
const FOLLOWER_TARGET_V241_KEYWORDS = ["蓝v", "蓝 v", "认证", "验证", "互关", "互", "互fo", "互粉", "关注", "关", "回关", "回", "求关注", "交友", "交", "友", "朋友", "粉丝", "粉", "follow", "mutual", "f4f", "fo"];
const FOLLOWER_TARGET_V242_NAV_MIN_MS = 3500;
const FOLLOWER_TARGET_V242_NAV_MAX_MS = 7500;
const FOLLOWER_TARGET_V242_SOURCE_REFRESH_MIN_MS = 8000;
const FOLLOWER_TARGET_V242_SOURCE_REFRESH_MAX_MS = 15000;
const FOLLOWER_TARGET_V243_MIN_SCAN_ROUNDS = 5;
const FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS = 16;
const FOLLOWER_TARGET_V243_MAX_SCAN_ROWS = 200;
const FOLLOWER_TARGET_V243_NO_PROGRESS_ROUNDS = 5;
const FOLLOWER_TARGET_V243_SCROLL_WAIT_MS = 2200;

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
      const error = new Error("评论累计超过90秒，强制跳过当前博主");
      error.code = "FOLLOWER_TARGET_COMMENT_TIMEOUT";
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
  let scannedRows = 0;
  let noProgressRounds = 0;
  let totalAdded = 0;
  for (let round = 0; round < FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS && active(); round += 1) {
    const result = followerTargetV243AddVisibleCandidates(job);
    scannedRows += result.visible;
    totalAdded += result.added;
    if (result.added) noProgressRounds = 0;
    else noProgressRounds += 1;
    await status(`正在快速浏览关注者列表：第 ${round + 1}/${FOLLOWER_TARGET_V243_MAX_SCAN_ROUNDS} 轮，已读取约 ${scannedRows} 个账号，筛出 ${job.candidateBatch.length} 个中文候选`);
    const minimumScanComplete = round + 1 >= FOLLOWER_TARGET_V243_MIN_SCAN_ROUNDS;
    if (minimumScanComplete && (job.candidateBatch.length >= FOLLOWER_TARGET_V241_MAX_PER_SOURCE || scannedRows >= FOLLOWER_TARGET_V243_MAX_SCAN_ROWS || noProgressRounds >= FOLLOWER_TARGET_V243_NO_PROGRESS_ROUNDS)) break;
    scrollRelationshipList();
    if (!await pause(FOLLOWER_TARGET_V243_SCROLL_WAIT_MS)) break;
  }
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

async function followerTargetV241CollectPosts(username, active) {
  const started = Date.now();
  const posts = new Map();
  while (active() && Date.now() - started < FOLLOWER_TARGET_PROFILE_TIMEOUT_MS) {
    const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
    for (const article of getPostContainers()) {
      if (!primary.contains(article) || sanitizeUsername(getAuthor(article)) !== username || !followerTargetV241OriginalPost(article)) continue;
      const timestamp = followerTargetV241PostDate(article);
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      const text = findPostText(article);
      const reply = article.querySelector('[data-testid="reply"]');
      if (!id || !timestamp || timestamp > Date.now() || Date.now() - timestamp > FOLLOWER_TARGET_V241_RECENT_WINDOW_MS || !text || !reply) continue;
      posts.set(id, { id, author: username, date: new Date(timestamp).toISOString(), text: text.slice(0, 1800) });
    }
    if (posts.size >= FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return [...posts.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS);
}

async function runFollowerTargetTask(generation) {
  if (followerTargetBusy) return;
  followerTargetBusy = true;
  let recoveryEpoch = null;
  let interrupted = false;
  const active = () => !interrupted && !followerTargetNetworkPaused &&
    (recoveryEpoch === null || followerTargetObservedEpoch === null || recoveryEpoch === followerTargetObservedEpoch) &&
    isTaskActive(generation) && settings.automationTask === "followerTarget";
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!active()) return false;
      lastLoopProgressAt = Date.now(); // 有意等待（重试/冷却）不是循环卡死。
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    }
    return active();
  };
  const status = async (text) => {
    if (!active()) return;
    await chrome.storage.local.set({ lastAutomationStatus: text, lastAutomationError: "", followerTargetStatus: text, followerTargetLeaseAt: Date.now() });
  };
  const transition = async (target, action, minMs = FOLLOWER_TARGET_V242_NAV_MIN_MS, maxMs = FOLLOWER_TARGET_V242_NAV_MAX_MS) => {
    if (!active()) return false;
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    await status(`${action}，等待 ${Math.ceil(delay / 1000)} 秒`);
    if (!await pause(delay) || !active()) return false;
    location.assign(target);
    return true;
  };
  const save = async () => {
    const state = await chrome.storage.local.get(["automationRunning", "followerTargetSessionId", "followerTargetRecoveryEpoch"]);
    if (!active() || !state.automationRunning || state.followerTargetSessionId !== job.sessionId ||
        (recoveryEpoch !== null && (state.followerTargetRecoveryEpoch || 0) !== recoveryEpoch)) throw new Error("任务已停止或旧执行流程已失效");
    await chrome.storage.local.set({ followerTargetJob: job, followerTargetLeaseAt: Date.now() });
  };
  let job;
  // 失败处理器必须位于 catch 可访问的作用域，不能在 try 块里声明 const。
  let finishCandidate;
  let handleCommentFailure;
  let lastHealthAt = 0;
  const health = async (scope = "x", serviceUnavailable = false) => {
    const result = await followerTargetRuntimeMessage({ type: "followerTargetHealth", sessionId: job?.sessionId, scope, serviceUnavailable }, 25000);
    if (!active() || !result?.ok) { interrupted = true; return false; }
    lastHealthAt = Date.now();
    return true;
  };
  const budget = () => {
    if (job?.commentDeadlineAt && Date.now() >= job.commentDeadlineAt) {
      const error = new Error("评论累计超过90秒，强制跳过当前博主");
      error.code = "FOLLOWER_TARGET_COMMENT_TIMEOUT";
      throw error;
    }
  };
  let lastLoopProgressAt = Date.now();
  let stallWatchdogTriggered = false;
  const stallWatchdog = setInterval(async () => {
    if (stallWatchdogTriggered || !active()) return;
    if (Date.now() - lastLoopProgressAt < FOLLOWER_TARGET_STALL_WATCHDOG_LIMIT_MS) return;
    stallWatchdogTriggered = true;
    // 由独立后台先检查网络再恢复；不能反复刷新同一断网页面。
    interrupted = true;
    await chrome.storage.local.set({ followerTargetLeaseAt: 0,
      followerTargetStatus: "检测到任务无进度，等待后台检查网络并恢复断点",
      lastAutomationStatus: "检测到任务无进度，等待后台检查网络并恢复断点" }).catch(() => {});
  }, FOLLOWER_TARGET_STALL_WATCHDOG_INTERVAL_MS);
  try {
    const config = await chrome.storage.local.get({ followerTargetFollowLimit: 10, followerTargetSessionId: null,
      followerTargetRecoveryEpoch: 0, followerTargetRecovery: null });
    recoveryEpoch = config.followerTargetRecoveryEpoch;
    followerTargetObservedEpoch = recoveryEpoch;
    followerTargetObservedSession = config.followerTargetSessionId;
    followerTargetNetworkPaused = config.followerTargetRecovery?.waiting === true &&
      config.followerTargetRecovery.sessionId === config.followerTargetSessionId;
    if (!active()) return;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(config.followerTargetFollowLimit) || 10)));
    const sessionId = config.followerTargetSessionId || String(Date.now());
    // 断网后重载时 X 资料导航可能尚未渲染，不能把空账号当成新用户清空断点。
    const owner = await waitForElement(() => getCurrentUsername() || null, FOLLOWER_TARGET_PROFILE_TIMEOUT_MS);
    if (!active()) return;
    if (!owner) { await status("等待 X 页面加载并识别登录账号，断点保留；后台会继续检查网络和恢复"); return; }
    job = (await chrome.storage.local.get({ followerTargetJob: null })).followerTargetJob;
    if (job?.sessionId === sessionId && job.owner !== owner) {
      const text = "当前登录账号与任务账号不一致，已停止；请确认账号后重新开始";
      await chrome.storage.local.set({ automationRunning: false, followerTargetStatus: text, lastAutomationStatus: text });
      return;
    }
    if (!job || job.sessionId !== sessionId) {
      job = {
        owner, sessionId, stage: "home", sourceAuthor: null,
        sourceFollowCount: 0, sessionFollowCount: 0, lastFollowAt: 0,
        candidatesScanned: [], candidatesSeen: [], candidateScores: {}, candidateBatch: [], candidateIndex: 0,
        sourceAuthorsSeen: [], candidateUsername: null, candidatePosts: [], postIndex: 0, commentAttempt: 0,
        retryAt: 0, retryCounts: {}
      };
      await save();
    }
    if (!Array.isArray(job.candidatesScanned)) job.candidatesScanned = [];
    if (!Array.isArray(job.candidatesSeen)) job.candidatesSeen = [];
    if (!job.candidateScores || typeof job.candidateScores !== "object") job.candidateScores = {};
    if (!Array.isArray(job.sourceAuthorsSeen)) job.sourceAuthorsSeen = [];
    finishCandidate = async (reason) => {
      if (!active()) return;
      if (job.candidateUsername) await recordCandidateVerdict(job.candidateUsername, null, reason || "已完成本账号处理");
      job.candidateIndex = Math.max(0, Number(job.candidateIndex) || 0) + 1;
      job.candidateUsername = null; job.candidatePosts = []; job.postIndex = 0; job.commentAttempt = 0; job.retryAt = 0;
      job.stage = "followers"; job.commentDeadlineAt = 0; job.recoveryAttempts = 0;
      await save();
      await status(reason || "当前账号处理完成，返回关注者列表");
    };
    // 统一处理评论失败。此前只有“正常返回失败”会走这里，页面加载、回复框
    // 或发送确认超时会掉到外层 catch，导致同一个博主被无限恢复。现在任何失败
    // 都消耗一次博主级尝试；第一次换下一条帖子（没有下一条时再次检查当前帖），
    // 第二次立即记录并跳过当前博主。
    handleCommentFailure = async (error, phase = "comment", options = {}) => {
      if (!active()) return false;
      const candidate = job.candidateUsername;
      if (!candidate) return false;
      const currentAttempt = Math.max(0, Number(job.commentAttempt) || 0);
      const attempt = Math.min(FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS, currentAttempt + 1);
      const post = job.candidatePosts?.[job.postIndex] || null;
      const reason = String(error?.message || error || "评论失败").replace(/\s+/g, " ").slice(0, 240);
      await recordFollowerTargetCommentFailure({
        candidate,
        postId: post?.id || null,
        attempt,
        phase,
        reason,
        followed: true
      });
      await chrome.storage.local.set({
        followerTargetLastCommentError: `@${candidate}（第${attempt}次，${phase}）：${reason}`
      });
      job.commentAttempt = attempt;
      if (options.abandonCandidate) {
        await finishCandidate(`已关注，但评论超过90秒，已强制跳过当前博主：${reason}`);
        return transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, `@${candidate} 已超时，跳过并返回列表`);
      }
      const nextIndex = Number(job.postIndex) + 1;
      const hasNextPost = nextIndex < job.candidatePosts.length;
      if (attempt < FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS && hasNextPost) {
        job.postIndex = nextIndex;
      }
      // 模型超时的帖子必须作废；没有备用帖子时不能回到同一帖子重试。
      const canRetry = attempt < FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS &&
        (hasNextPost || options.allowSamePostRetry !== false);
      if (canRetry) {
        job.retryAt = Date.now() + FOLLOWER_TARGET_V241_COMMENT_RETRY_MS;
        await save();
        await status(`@${candidate} 第${attempt}次评论失败（${reason}），20秒后${nextIndex < job.candidatePosts.length ? "换另一条帖子" : "再次尝试"}`);
        if (await pause(FOLLOWER_TARGET_V241_COMMENT_RETRY_MS)) {
          const retryPost = job.candidatePosts?.[job.postIndex];
          if (retryPost && await transition(
            `${location.origin}/${candidate}/status/${retryPost.id}`,
            `重试时间已到，准备进行第${attempt + 1}次评论`,
            2500,
            5000
          )) return true;
        }
        return false;
      }
      const finalReason = attempt < FOLLOWER_TARGET_V241_MAX_COMMENT_POSTS && !hasNextPost
        ? `已关注，但当前帖子模型等待超过90秒且没有备用帖子，已跳过当前博主：${reason}`
        : `已关注，但连续两次评论未成功：${reason}`;
      await finishCandidate(finalReason);
      if (await transition(
        `${location.origin}/${job.sourceAuthor}/verified_followers`,
        `@${candidate} 已失败两次，跳过并返回关注者列表`
      )) return true;
      return false;
    };
    while (active()) {
      lastLoopProgressAt = Date.now();
      if (Date.now() - lastHealthAt > 20000 && !await health()) return;
      if (getCurrentUsername() !== job.owner) { await status("登录账号信息发生变化，已中止当前操作并保留断点"); return; }
      if ((job.sessionFollowCount || 0) >= limit) {
        await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: `本次任务已成功关注 ${job.sessionFollowCount}/${limit} 人，任务已停止` });
        return;
      }
      if (job.retryAt && Date.now() < job.retryAt && !await pause(job.retryAt - Date.now())) return;
      const stage = followerTargetStageOf();
      const pathUser = followerTargetUsernameFromPath();
      await chrome.storage.local.set({
        followerTargetHeartbeat: `stage=${job.stage} 页面=${stage} 来源=${job.sourceAuthor || "-"} 候选=${job.candidateUsername || "-"} 批次=${job.candidateIndex}/${job.candidateBatch.length} 来源关注=${job.sourceFollowCount || 0}/${FOLLOWER_TARGET_V241_MAX_PER_SOURCE}`,
        followerTargetHeartbeatAt: Date.now()
      });

      if (job.stage === "home") {
        if (stage !== "home") { await save(); if (await transition(followerTargetHomeUrl(), "正在返回首页并刷新时间线")) return; }
        const source = followerTargetV241SourcePost(job);
        if (!source) {
          await status(`正在重新扫描首页关键词帖子，已排除本轮 ${job.sourceAuthorsSeen.length} 个来源博主`);
          window.scrollBy({ top: Math.max(600, window.innerHeight), behavior: "instant" });
          if (!await pause(2000)) return;
          continue;
        }
        job.sourceAuthorsSeen = [...new Set([...job.sourceAuthorsSeen, source])].slice(-500);
        await status(`首页重新筛选到新来源博主 @${source}，本轮已排除 ${job.sourceAuthorsSeen.length - 1} 个来源`);
        job.sourceAuthor = source; job.sourceFollowCount = 0; job.candidatesScanned = []; job.candidatesSeen = []; job.candidateScores = {}; job.candidateBatch = []; job.candidateIndex = 0; job.stage = "followers"; await save();
        if (await transition(`${location.origin}/${source}/verified_followers`, `已找到来源博主 @${source}，准备打开认证关注者列表`)) return;
      }

      if (job.stage === "followers") {
        if (stage !== "followers" || pathUser !== job.sourceAuthor) { await save(); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "正在返回来源博主的认证关注者列表")) return; }
        if ((job.sourceFollowCount || 0) >= FOLLOWER_TARGET_V241_MAX_PER_SOURCE) {
          job.stage = "home"; job.sourceAuthor = null; job.candidateBatch = []; job.candidateIndex = 0; await save(); if (await transition(followerTargetHomeUrl(), "当前来源博主已完成 5 个关注，刷新首页寻找新来源", FOLLOWER_TARGET_V242_SOURCE_REFRESH_MIN_MS, FOLLOWER_TARGET_V242_SOURCE_REFRESH_MAX_MS)) return;
        }
        const pendingCandidates = Array.isArray(job.candidateBatch) && job.candidateIndex < job.candidateBatch.length;
        if (!pendingCandidates) {
          job.candidateBatch = [];
          job.candidateIndex = 0;
          const scan = await followerTargetV243CollectCandidates(job, active, pause, status);
          if (!scan.candidates) {
            const sourceName = job.sourceAuthor || "来源博主";
            job.stage = "home";
            job.sourceAuthor = null;
            job.candidateBatch = [];
            job.candidateIndex = 0;
            await save();
            if (await transition(followerTargetHomeUrl(), `@${sourceName} 已没有更多中文合格候选，刷新首页寻找下一个来源`, FOLLOWER_TARGET_V242_SOURCE_REFRESH_MIN_MS, FOLLOWER_TARGET_V242_SOURCE_REFRESH_MAX_MS)) return;
          }
          await save();
        }
        job.candidateUsername = job.candidateBatch[job.candidateIndex];
        job.stage = "profile";
        job.retryAt = 0;
        await save();
        await status(`已从当前可见列表筛出 ${job.candidateBatch.length} 个中文候选，按评分处理第 ${job.candidateIndex + 1} 个：@${job.candidateUsername}`);
        if (await transition(`${location.origin}/${job.candidateUsername}`, `准备打开候选账号 @${job.candidateUsername} 的主页`)) return;
      }

      if (job.stage === "profile") {
        const candidate = job.candidateUsername;
        if (!candidate) { job.stage = "followers"; await save(); continue; }
        if (stage !== "profile" || pathUser !== candidate) { await save(); if (await transition(`${location.origin}/${candidate}`, `正在返回候选账号 @${candidate} 的主页`)) return; }
        await status(`正在检查 @${candidate} 的 followers，准备按顺序关注`);
        const ready = await waitForElement(() => readProfileFollowers(candidate) !== null ? true : null, FOLLOWER_TARGET_PROFILE_TIMEOUT_MS);
        if (!ready) { if (!await health()) return; await finishCandidate("主页或 followers 加载失败"); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "主页加载超时，准备返回关注者列表")) return; }
        const followers = readProfileFollowers(candidate);
        if (followers < FOLLOWER_TARGET_MIN_FOLLOWERS || followers > FOLLOWER_TARGET_MAX_FOLLOWERS) { await finishCandidate(`followers=${followers}，不在 [${FOLLOWER_TARGET_MIN_FOLLOWERS},${FOLLOWER_TARGET_MAX_FOLLOWERS}]`); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "当前账号不符合 followers 条件，准备返回列表")) return; }
        if (job.lastFollowAt) { const waitMs = FOLLOWER_TARGET_INTERVAL_MS - (Date.now() - job.lastFollowAt); if (waitMs > 0 && !await pause(waitMs)) return; }
        const follow = await followOnProfile(candidate);
        if (!active()) return;
        if (follow?.rateLimited) { await status("检测到 X 关注限速，任务暂停冷却"); await pause(FOLLOW_RATE_LIMIT_COOLDOWN_MS); continue; }
        if (follow?.error) { if (!await health()) return; await finishCandidate(`关注失败：${follow.error}`); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "关注操作未确认，准备返回列表")) return; }
        if (follow.followed) { job.lastFollowAt = Date.now(); job.sourceFollowCount = (job.sourceFollowCount || 0) + 1; job.sessionFollowCount = (job.sessionFollowCount || 0) + 1; await bumpFollowerTargetStat("follows"); await save(); }
        job.candidatePosts = await followerTargetV241CollectPosts(candidate, active); job.postIndex = 0; job.commentAttempt = 0;
        if (!job.candidatePosts.length) { if (!await health()) return; await finishCandidate("已关注，但最近24小时没有可评论原创帖子"); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "已关注但没有可评论帖子，准备返回列表")) return; }
        job.stage = "comment"; job.commentDeadlineAt = Date.now() + 90000; await save(); if (await transition(`${location.origin}/${candidate}/status/${job.candidatePosts[0].id}`, `已关注 @${candidate}，准备打开最近帖子`)) return;
      }

      if (job.stage === "comment") {
        const candidate = job.candidateUsername; const post = job.candidatePosts?.[job.postIndex];
        if (!job.commentDeadlineAt) { job.commentDeadlineAt = Date.now() + 90000; await save(); }
        budget();
        const deadline = job.commentDeadlineAt;
        let commentCancelled = false;
        const assertCommentActive = async () => {
          if (!active() || commentCancelled || Date.now() >= deadline || job.candidateUsername !== candidate || getCurrentUsername() !== job.owner) throw new Error("任务已停止、超时、账号改变或当前评论已作废");
          const state = await chrome.storage.local.get(["automationRunning", "automationTask", "followerTargetSessionId", "followerTargetRecoveryEpoch", "followerTargetRecovery", "followerTargetJob"]);
          if (!active() || getCurrentUsername() !== job.owner || !state.automationRunning || state.automationTask !== "followerTarget" ||
              state.followerTargetSessionId !== job.sessionId || (state.followerTargetRecoveryEpoch || 0) !== recoveryEpoch ||
              state.followerTargetRecovery?.waiting || state.followerTargetJob?.stage !== "comment" ||
              state.followerTargetJob?.candidateUsername !== candidate || Date.now() >= deadline) throw new Error("当前评论执行权已失效，禁止发送旧结果");
        };
        const withinDeadline = (operation) => followerTargetCommentDeadline(operation, deadline, () => { commentCancelled = true; });
        if (!candidate || !post) { await finishCandidate("没有可用候选帖子"); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "没有可用候选帖子，准备返回列表")) return; }
        if (stage !== "comment" || pathUser !== candidate || !location.pathname.includes(`/status/${post.id}`)) { await save(); if (await transition(`${location.origin}/${candidate}/status/${post.id}`, "正在返回目标帖子详情页")) return; }
        const article = await withinDeadline(() => waitForElement(() => getPostContainers().find((item) => getPostId(item)?.match(/\/status\/(\d+)/)?.[1] === post.id && getAuthor(item) === candidate), FOLLOWER_TARGET_PROFILE_TIMEOUT_MS));
        if (!article) throw new Error("目标帖子未加载");
        const key = `followerTargetReply:${job.owner}:${candidate}:${post.id}`;
        const priorReply = (await chrome.storage.local.get(key))[key];
        // 只有已确认发送成功的帖子才直接结束候选。失败记录允许进入第二次尝试，
        // 发送前已留下 pending/attempt 记录时，sendReplyToPost 会继续阻止重复发送。
        if (priorReply?.state === "done") { await finishCandidate("该帖子已有成功处理记录"); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, "该帖子已有成功处理记录，准备返回列表")) return; }
        await status(`正在评论 @${candidate} 的第 ${job.commentAttempt + 1} 条24小时内帖子`);
        const result = await withinDeadline(() => followerTargetRuntimeMessage({ type: "generateDraft", postText: findPostText(article) || post.text, replyContext: "timeline_influencer" }));
        if (!active()) return;
        budget();
        if (result?.error && ["API_NETWORK_ERROR", "API_TIMEOUT", "API_SERVICE_UNAVAILABLE"].includes(result.code)) {
          if (!await health("api", result.code === "API_SERVICE_UNAVAILABLE")) return;
        }
        const failure = result?.error || !result?.draft ? (result?.error || "模型没有返回评论") : result.draft === "[SKIP]" ? "模型判断不适合回复" : "";
        if (!failure) {
          const sent = await withinDeadline(() => sendReplyToPost(article, result.draft, generation, { inline: true, strict: true,
            assertActive: assertCommentActive, onStatus: status,
            beforeSend: async () => { await assertCommentActive(); await chrome.storage.local.set({ [key]: { state: "pending", updatedAt: Date.now() } }); } }));
          if (!active()) return;
          if (sent !== false) { await chrome.storage.local.set({ [key]: { state: "done", postId: post.id, updatedAt: Date.now() } }); await bumpFollowerTargetStat("comments"); await recordCandidateVerdict(candidate, null, "已关注并评论"); await finishCandidate("已关注并成功评论"); if (await transition(`${location.origin}/${job.sourceAuthor}/verified_followers`, `@${candidate} 评论完成，准备返回关注者列表`)) return; }
        }
        if (!failure && !await health()) return;
        const failureReason = failure || "评论发送未确认";
        await chrome.storage.local.set({ [key]: { state: "skipped", reason: failureReason, updatedAt: Date.now() } });
        if (await handleCommentFailure(failureReason, failure ? "model" : "send")) return;
      }
    }
  } catch (error) {
    if (active()) {
      if (["FOLLOWER_TARGET_RUNTIME_TIMEOUT", "FOLLOWER_TARGET_COMMENT_TIMEOUT"].includes(error?.code)) await status("评论已超过90秒，已禁止继续发送，正在检查网络后跳过或等待恢复");
      if (!await health(["API_NETWORK_ERROR", "API_TIMEOUT", "API_SERVICE_UNAVAILABLE"].includes(error?.code) ? "api" : "x", error?.code === "API_SERVICE_UNAVAILABLE")) return;
      const errorText = String(error?.message || error).slice(0, 240);
      await chrome.storage.local.set({ lastAutomationError: errorText });
      // 评论阶段的异常也必须消耗一次尝试，不能再走原来的无限“15 秒恢复当前候选”。
      if (job?.stage === "comment" && job?.candidateUsername && handleCommentFailure) {
        const timedOut = ["FOLLOWER_TARGET_RUNTIME_TIMEOUT", "FOLLOWER_TARGET_COMMENT_TIMEOUT"].includes(error?.code);
        await handleCommentFailure(
          error,
          timedOut ? "comment_timeout" : "exception",
          { allowSamePostRetry: !timedOut, abandonCandidate: timedOut }
        );
      } else if (job) {
        job.retryAt = Date.now() + 15000;
        await save();
        job.recoveryAttempts = (Number(job.recoveryAttempts) || 0) + 1;
        if (job.recoveryAttempts >= 2) {
          if (job.candidateUsername && finishCandidate) await finishCandidate(`页面异常连续两次：${errorText}`);
          else { job.stage = "home"; job.recoveryAttempts = 0; await save(); }
        }
        await save();
        const target = job.stage === "home" ? followerTargetHomeUrl() : job.stage === "followers"
          ? `${location.origin}/${job.sourceAuthor}/verified_followers` : `${location.origin}/${job.candidateUsername || job.sourceAuthor}`;
        if (await pause(15000)) await transition(target, "异常冷却结束，准备恢复当前候选", 3000, 6000);
      }
    }
  } finally {
    clearInterval(stallWatchdog);
    followerTargetBusy = false;
  }
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
async function followOnProfile(username) {
  const expected = username.toLowerCase();
  const startedAt = Date.now();
  let clickedFollow = false;
  // 人工延迟：进入主页后 1–5 秒内再开始点关注，避免瞬时操作。
  if (!await humanWaitActive(randomHumanDelay())) return { error: "任务已停止" };
  while (Date.now() - startedAt < 8000) {
    if (!isTaskActive(taskGeneration)) return { error: "任务已停止" };
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
    push("任务控制版本", "0.2.51-network-recovery");
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
