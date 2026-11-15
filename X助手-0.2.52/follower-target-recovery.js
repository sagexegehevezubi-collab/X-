// X断网暂停并恢复；模型故障只暂停评论，不停止关注。
const FT_RECOVERY_ALARM = "follower-target-recovery-v251";
let ftRecoveryChecking = null;
let ftAlarmSync = Promise.resolve();

async function ftRecoveryState() {
  return chrome.storage.local.get({ automationRunning: false, automationTask: "", automationTargetTabId: null,
    followerTargetSessionId: null, followerTargetJob: null, followerTargetRecovery: null,
    followerTargetRecoveryEpoch: 0, followerTargetLeaseAt: 0, followerTargetXHealth: null,
    endpoint: "", replyMode: "ai" });
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
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    const response = await fetch(url.href, { method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal });
    const reachable = response.status >= 200 && response.status < 500 && ![408, 429].includes(response.status);
    if (response.body) await response.body.cancel().catch(() => {});
    return reachable;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

function ftRecoveryUrl(job) {
  const user = /^[A-Za-z0-9_]{1,15}$/;
  if (job.stage === "comment" && user.test(job.candidateUsername || "")) {
    const post = job.candidatePosts?.[0];
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
      followerTargetStatus: "任务标签页已关闭，已停止自动恢复", lastAutomationStatus: "任务标签页已关闭，已停止自动恢复" }); return false;
  }
  const address = tab.pendingUrl || tab.url || "";
  if (!/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(address) && !/^chrome-error:|^edge-error:/i.test(address)) return false;
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, tab.id) || latest.followerTargetRecoveryEpoch !== state.followerTargetRecoveryEpoch) return false;
  await chrome.tabs.update(tab.id, { url: ftRecoveryUrl(latest.followerTargetJob) });
  return true;
}

async function ftPauseForNetwork(state) {
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, state.automationTargetTabId) ||
      latest.followerTargetRecoveryEpoch !== state.followerTargetRecoveryEpoch) return { cancelled: true };
  const previous = latest.followerTargetRecovery;
  const waiting = previous?.waiting && previous.sessionId === latest.followerTargetSessionId;
  const job = latest.followerTargetJob;
  const recovery = waiting ? { ...previous, scope: "x", lastCheckAt: Date.now() } : {
    sessionId: latest.followerTargetSessionId, waiting: true, scope: "x", waitingSince: Date.now(), lastCheckAt: Date.now(),
    stageRemainingMs: Math.max(1000, (job.stageDeadlineAt || Date.now() + FT_POLICY.stageMs) - Date.now()),
    deadlineRemainingMs: Math.max(1000, (job.commentDeadlineAt || Date.now() + FT_POLICY.commentMs) - Date.now())
  };
  const text = "等待X网络恢复，进度已保存；每30秒自动检查";
  await chrome.storage.local.set({ followerTargetRecovery: recovery,
    followerTargetRecoveryEpoch: latest.followerTargetRecoveryEpoch + (waiting ? 0 : 1),
    followerTargetXHealth: null, followerTargetStatus: text, lastAutomationStatus: text,
    lastAutomationError: "X连接异常，暂停操作以免连续跳过账号" });
  return { waiting: true, scope: "x" };
}

async function ftRecoveryCheck({ tabId = null, sessionId = null, heartbeat = false, recoverExpired = false } = {}) {
  let state = await ftRecoveryState();
  if (!ftRecoveryActive(state, sessionId, tabId)) return { cancelled: true };
  const epoch = state.followerTargetRecoveryEpoch;
  const cached = state.followerTargetXHealth;
  const useCache = !heartbeat && !state.followerTargetRecovery?.waiting && cached?.sessionId === state.followerTargetSessionId && Date.now() - cached.at < 20000;
  const xOk = useCache || await ftProbeUrl("https://x.com/robots.txt");
  const latest = await ftRecoveryState();
  if (!ftRecoveryActive(latest, state.followerTargetSessionId, state.automationTargetTabId) || latest.followerTargetRecoveryEpoch !== epoch) return { cancelled: true };
  state = latest;
  if (!xOk) return ftPauseForNetwork(state);
  if (!useCache) await chrome.storage.local.set({ followerTargetXHealth: { sessionId: state.followerTargetSessionId, at: Date.now() } });
  const recovery = state.followerTargetRecovery, job = state.followerTargetJob;
  if (recovery?.waiting && recovery.sessionId === state.followerTargetSessionId) {
    ftTouchStage(job);
    const remaining = Math.min(FT_POLICY.stageMs, Math.max(1000, recovery.stageRemainingMs || FT_POLICY.stageMs));
    job.stageDeadlineAt = Date.now() + remaining; job.stageStartedAt = job.stageDeadlineAt - FT_POLICY.stageMs;
    if (job.stage === "comment") job.commentDeadlineAt = Date.now() + Math.min(FT_POLICY.commentMs, Math.max(1000, recovery.deadlineRemainingMs || FT_POLICY.commentMs));
    state.followerTargetRecoveryEpoch += 1;
    const text = "X网络已恢复，从保存的进度继续；已有发送尝试的帖子不重发";
    await chrome.storage.local.set({ followerTargetJob: job, followerTargetRecovery: null,
      followerTargetRecoveryEpoch: state.followerTargetRecoveryEpoch, followerTargetLeaseAt: Date.now(),
      followerTargetStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
    await ftRecoveryNavigate(state); return { resumed: true };
  }
  // 截止时间与心跳独立，更新状态或重新加载同一阶段不会续期。
  const checkpoint = JSON.stringify(job);
  const expired = ftExpired(job);
  const legacyStalled = !job.stageDeadlineAt && Date.now() - (state.followerTargetLeaseAt || 0) >= FT_POLICY.stageMs;
  if (!expired && !legacyStalled) {
    if (heartbeat && !recoverExpired) await chrome.storage.local.set({ followerTargetLeaseAt: Date.now() });
    return { ok: true, epoch };
  }
  const candidate = job.candidateUsername, wasComment = job.stage === "comment", postId = job.candidatePosts?.[0]?.id;
  if (legacyStalled) { ftTouchStage(job); job.stageDeadlineAt = Date.now(); }
  const reason = ftSkipExpired(job);
  const records = await chrome.storage.local.get({ followerTargetCommentFailures: [], followerTargetVerdicts: [] });
  const updates = {};
  if (candidate) updates.followerTargetVerdicts = [...records.followerTargetVerdicts, { candidate, verdict: reason, at: new Date().toLocaleTimeString() }].slice(-20);
  if (candidate && wasComment) updates.followerTargetCommentFailures = [...records.followerTargetCommentFailures,
    { candidate, postId, phase: expired === "comment" ? "comment_timeout" : "stage_timeout", attempt: 1, reason, followed: true, at: new Date().toISOString() }].slice(-100);
  const beforeWrite = await ftRecoveryState();
  if (!ftRecoveryActive(beforeWrite, state.followerTargetSessionId, state.automationTargetTabId) ||
      beforeWrite.followerTargetRecoveryEpoch !== epoch || JSON.stringify(beforeWrite.followerTargetJob) !== checkpoint) return { cancelled: true };
  state.followerTargetRecoveryEpoch += 1;
  await chrome.storage.local.set({ ...updates, followerTargetJob: job,
    followerTargetRecoveryEpoch: state.followerTargetRecoveryEpoch, followerTargetLeaseAt: Date.now(),
    followerTargetStatus: reason, lastAutomationStatus: reason, lastAutomationError: reason });
  await ftRecoveryNavigate(state); return { recovered: true };
}

function ftQueueRecovery(options) {
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
function ftSyncRecoveryAlarm() { ftAlarmSync = ftAlarmSync.catch(() => {}).then(ftSyncRecoveryAlarmNow); return ftAlarmSync; }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "followerTargetHealth") return;
  if (sender.tab?.id == null || message.sessionId == null) { sendResponse({ cancelled: true }); return; }
  ftQueueRecovery({ tabId: sender.tab.id, sessionId: message.sessionId, heartbeat: !message.recoverExpired, recoverExpired: message.recoverExpired === true })
    .then(sendResponse).catch(() => sendResponse({ error: "后台网络检查失败，等待下次自动恢复" })); return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === FT_RECOVERY_ALARM) ftQueueRecovery().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.automationRunning || changes.automationTask || changes.followerTargetSessionId)) ftSyncRecoveryAlarm().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => ftSyncRecoveryAlarm().catch(() => {}));
ftSyncRecoveryAlarm().catch(() => {});
