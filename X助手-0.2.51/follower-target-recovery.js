// 后台恢复独立于 X 内容脚本：浏览器错误页上没有内容脚本，也能等网络恢复。
const FT_RECOVERY_ALARM = "follower-target-recovery-v251";
let ftRecoveryChecking = null;
let ftAlarmSync = Promise.resolve();

async function ftRecoveryState() {
  return chrome.storage.local.get({ automationRunning: false, automationTask: "", automationTargetTabId: null,
    followerTargetSessionId: null, followerTargetJob: null, followerTargetRecovery: null,
    followerTargetRecoveryEpoch: 0, followerTargetLeaseAt: 0, endpoint: "", replyMode: "ai" });
}

function ftRecoveryActive(state, sessionId, tabId) {
  return state.automationRunning === true && state.automationTask === "followerTarget" &&
    state.automationTargetTabId != null && state.followerTargetJob?.sessionId === state.followerTargetSessionId &&
    (sessionId == null || state.followerTargetSessionId === sessionId) &&
    (tabId == null || state.automationTargetTabId === tabId);
}

async function ftProbeUrl(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(address);
    if (!/^https?:$/.test(url.protocol)) return false;
    // 探测只做不带密钥的 GET，不生成回复、不发送评论、不消耗模型生成额度。
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    const response = await fetch(url.href, { method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal });
    // 401/403/404/405 说明能连到服务；不能据此声称 API 配置或模型正确。
    const reachable = response.status >= 200 && response.status < 500 && ![408, 429].includes(response.status);
    if (response.body) await response.body.cancel().catch(() => {});
    return reachable;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

function ftRecoveryUrl(job) {
  const user = /^[A-Za-z0-9_]{1,15}$/;
  if (job.stage === "comment" && user.test(job.candidateUsername || "")) {
    const post = job.candidatePosts?.[job.postIndex];
    if (/^\d+$/.test(post?.id || "")) return `https://x.com/${job.candidateUsername}/status/${post.id}`;
  }
  if (job.stage === "profile" && user.test(job.candidateUsername || "")) return `https://x.com/${job.candidateUsername}`;
  if (job.stage === "followers" && user.test(job.sourceAuthor || "")) return `https://x.com/${job.sourceAuthor}/verified_followers`;
  return `https://x.com/home?followerTargetRefresh=${Date.now()}`;
}

async function ftRecoveryNavigate(state) {
  const current = await ftRecoveryState();
  if (!ftRecoveryActive(current, state.followerTargetSessionId, state.automationTargetTabId) ||
      current.followerTargetRecoveryEpoch !== state.followerTargetRecoveryEpoch) return false;
  const tab = await chrome.tabs.get(current.automationTargetTabId).catch(() => null);
  if (!tab) {
    await chrome.storage.local.set({ automationRunning: false, followerTargetRecovery: null,
      followerTargetStatus: "任务标签页已关闭，已停止自动恢复", lastAutomationStatus: "任务标签页已关闭，已停止自动恢复" });
    return false;
  }
  // 不抢占用户主动转去其他网站的标签页；错误页和原 X 标签页允许恢复。
  const address = tab.pendingUrl || tab.url || "";
  if (!/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(address) && !/^chrome-error:|^edge-error:/i.test(address)) return false;
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, tab.id) ||
      latest.followerTargetRecoveryEpoch !== state.followerTargetRecoveryEpoch) return false;
  await chrome.tabs.update(tab.id, { url: ftRecoveryUrl(latest.followerTargetJob) });
  return true;
}

async function ftPauseForNetwork(state, scope) {
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, state.automationTargetTabId) ||
      latest.followerTargetRecoveryEpoch !== state.followerTargetRecoveryEpoch) return { cancelled: true };
  const previous = latest.followerTargetRecovery;
  const alreadyWaiting = previous?.waiting && previous.sessionId === latest.followerTargetSessionId;
  const recovery = {
    sessionId: latest.followerTargetSessionId, waiting: true,
    scope: scope === "api" || (alreadyWaiting && previous.scope === "api") ? "api" : "x",
    waitingSince: alreadyWaiting ? previous.waitingSince : Date.now(), lastCheckAt: Date.now(),
    deadlineRemainingMs: alreadyWaiting ? previous.deadlineRemainingMs :
      (latest.followerTargetJob.commentDeadlineAt ? Math.max(1000, latest.followerTargetJob.commentDeadlineAt - Date.now()) : 90000)
  };
  const text = `等待${recovery.scope === "api" ? "模型接口/网络" : "X 网络"}恢复，进度已保存；每30秒自动检查`;
  await chrome.storage.local.set({ followerTargetRecovery: recovery,
    followerTargetRecoveryEpoch: latest.followerTargetRecoveryEpoch + (alreadyWaiting ? 0 : 1),
    followerTargetStatus: text, lastAutomationStatus: text, lastAutomationError: "连接异常，暂停操作以免连续跳过博主" });
  await chrome.alarms.create(FT_RECOVERY_ALARM, { periodInMinutes: 0.5 });
  return { waiting: true, scope: recovery.scope };
}

async function ftRecoveryCheck({ scope = "x", tabId = null, sessionId = null, heartbeat = false, serviceUnavailable = false } = {}) {
  let state = await ftRecoveryState();
  if (!ftRecoveryActive(state, sessionId, tabId)) return { cancelled: true };
  const epoch = state.followerTargetRecoveryEpoch;
  const checkApi = state.replyMode !== "fixed" && (scope === "api" || state.followerTargetRecovery?.scope === "api");
  const xOk = await ftProbeUrl("https://x.com/robots.txt");
  const apiOk = !checkApi || !state.endpoint || await ftProbeUrl(state.endpoint);
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, state.automationTargetTabId) ||
      latest.followerTargetRecoveryEpoch !== epoch) return { cancelled: true };
  state = latest;
  if (!xOk || !apiOk || serviceUnavailable) return ftPauseForNetwork(state, !apiOk || serviceUnavailable ? "api" : "x");

  const recovery = state.followerTargetRecovery;
  if (recovery?.waiting && recovery.sessionId === state.followerTargetSessionId) {
    const job = state.followerTargetJob;
    if (job.stage === "comment") job.commentDeadlineAt = Date.now() + Math.min(90000, Math.max(1000, recovery.deadlineRemainingMs || 90000));
    state.followerTargetRecoveryEpoch += 1;
    const text = "网络已恢复，正在从保存的进度继续（发送结果不确定的帖子不重发）";
    await chrome.storage.local.set({ followerTargetJob: job, followerTargetRecovery: null,
      followerTargetRecoveryEpoch: state.followerTargetRecoveryEpoch, followerTargetLeaseAt: Date.now(),
      followerTargetStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
    await ftRecoveryNavigate(state);
    return { resumed: true };
  }
  if (heartbeat) {
    await chrome.storage.local.set({ followerTargetLeaseAt: Date.now() });
    return { ok: true, epoch };
  }
  const job = state.followerTargetJob;
  const checkpoint = JSON.stringify(job);
  const commentExpired = job.stage === "comment" && job.commentDeadlineAt && Date.now() >= job.commentDeadlineAt;
  const stalled = Date.now() - (state.followerTargetLeaseAt || 0) > 110000;
  if (!commentExpired && !stalled) return { ok: true, epoch };

  const reason = commentExpired ? "评论累计超过90秒，强制跳过当前博主" : "任务循环超过110秒没有进度，后台恢复断点";
  const candidate = job.candidateUsername;
  let skip = job.stage === "comment";
  if (!skip) {
    job.recoveryAttempts = (Number(job.recoveryAttempts) || 0) + 1;
    skip = job.recoveryAttempts >= 2;
  }
  if (skip) {
    job.candidateIndex = (Number(job.candidateIndex) || 0) + 1;
    job.candidateUsername = null; job.candidatePosts = []; job.postIndex = 0;
    job.commentAttempt = 0; job.commentDeadlineAt = 0; job.retryAt = 0; job.recoveryAttempts = 0;
    job.stage = candidate ? "followers" : "home";
  }
  const records = await chrome.storage.local.get({ followerTargetCommentFailures: [], followerTargetVerdicts: [] });
  const updates = {};
  if (candidate && skip) {
    updates.followerTargetCommentFailures = [...records.followerTargetCommentFailures, { candidate, phase: "watchdog", attempt: 2,
      reason, at: new Date().toISOString() }].slice(-100);
    updates.followerTargetVerdicts = [...records.followerTargetVerdicts, { candidate, verdict: reason, at: new Date().toLocaleTimeString() }].slice(-20);
  }
  // 网络探测、存储读取期间用户可能按了停止；再次校验后才修改进度/导航。
  const beforeWrite = await ftRecoveryState();
  if (!ftRecoveryActive(beforeWrite, state.followerTargetSessionId, state.automationTargetTabId) ||
      beforeWrite.followerTargetRecoveryEpoch !== epoch || beforeWrite.followerTargetLeaseAt !== state.followerTargetLeaseAt ||
      JSON.stringify(beforeWrite.followerTargetJob) !== checkpoint) return { cancelled: true };
  state.followerTargetRecoveryEpoch += 1;
  await chrome.storage.local.set({ ...updates, followerTargetJob: job,
    followerTargetRecoveryEpoch: state.followerTargetRecoveryEpoch, followerTargetLeaseAt: Date.now(),
    followerTargetStatus: reason, lastAutomationStatus: reason, lastAutomationError: reason });
  await ftRecoveryNavigate(state);
  return { recovered: true };
}

function ftQueueRecovery(options) {
  // 同一时刻只允许一个后台恢复流程。不同请求等待当前检查后再独立校验身份。
  const previous = ftRecoveryChecking || Promise.resolve();
  const request = previous.catch(() => {}).then(() => ftRecoveryCheck(options));
  ftRecoveryChecking = request;
  request.finally(() => { if (ftRecoveryChecking === request) ftRecoveryChecking = null; }).catch(() => {});
  return request;
}

async function ftSyncRecoveryAlarmNow() {
  const state = await ftRecoveryState();
  if (state.automationRunning && state.automationTask === "followerTarget") {
    await chrome.alarms.create(FT_RECOVERY_ALARM, { periodInMinutes: 0.5 });
    if (state.followerTargetRecovery && state.followerTargetRecovery.sessionId !== state.followerTargetSessionId)
      await chrome.storage.local.set({ followerTargetRecovery: null });
  } else {
    await chrome.alarms.clear(FT_RECOVERY_ALARM);
    if (state.followerTargetRecovery) await chrome.storage.local.set({ followerTargetRecovery: null });
  }
}

function ftSyncRecoveryAlarm() {
  ftAlarmSync = ftAlarmSync.catch(() => {}).then(ftSyncRecoveryAlarmNow);
  return ftAlarmSync;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "followerTargetHealth") return;
  if (sender.tab?.id == null || message.sessionId == null) { sendResponse({ cancelled: true }); return; }
  ftQueueRecovery({ scope: message.scope, tabId: sender.tab.id, sessionId: message.sessionId, heartbeat: true,
    serviceUnavailable: message.serviceUnavailable === true })
    .then(sendResponse).catch(() => sendResponse({ error: "后台网络检查失败，等待下次自动恢复" }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FT_RECOVERY_ALARM) ftQueueRecovery().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.automationRunning || changes.automationTask || changes.followerTargetSessionId)) ftSyncRecoveryAlarm().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => ftSyncRecoveryAlarm().catch(() => {}));
ftSyncRecoveryAlarm().catch(() => {});
