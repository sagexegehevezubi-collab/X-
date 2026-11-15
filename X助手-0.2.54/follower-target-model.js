// 该模块专用的单次模型请求，停止/超时/切换账号后真正 Abort fetch。
const ftDraftRequests = new Map();

function ftDraftMatches(state, message, tabId) {
  const job = state.followerTargetJob;
  return ftRecoveryActive(state, message.sessionId, tabId) &&
    state.followerTargetRecoveryEpoch === message.epoch && !state.followerTargetRecovery?.waiting &&
    job.stage === "comment" && job.candidateUsername === message.candidate &&
    job.candidatePosts?.[0]?.id === message.postId && job.commentStartedPostId === message.postId &&
    job.commentDeadlineAt === message.deadlineAt && !ftExpired(job);
}

async function ftNoteModelResult(sessionId, error) {
  const state = await ftRecoveryState();
  if (!ftRecoveryActive(state, sessionId)) return;
  const { followerTargetApiCooldown: previous } = await chrome.storage.local.get({ followerTargetApiCooldown: null });
  const failures = error ? (previous?.sessionId === sessionId ? previous.failures || 0 : 0) + 1 : 0;
  const cooldown = { sessionId, failures, until: failures >= 3 ? Date.now() + FT_POLICY.apiCooldownMs : 0 };
  await chrome.storage.local.set({ followerTargetApiCooldown: cooldown });
  // 异步检查X本身是否断网；模型故障不会被当成X断网暂停关注。
  if (error) ftQueueRecovery().catch(() => {});
}

async function ftGenerateOneDraft(message, tabId) {
  let state = await ftRecoveryState();
  if (!ftDraftMatches(state, message, tabId)) return { error: "当前评论请求已失效", code: "API_CANCELLED" };
  const id = String(message.requestId || "");
  if (!id || ftDraftRequests.has(id) || [...ftDraftRequests.values()].some(request =>
      request.message.sessionId === message.sessionId && request.message.candidate === message.candidate && request.message.postId === message.postId))
    return { error: "该帖已经开始生成，不重复请求", code: "API_CANCELLED" };
  const attemptKey = `followerTargetModelAttempt:${message.sessionId}:${message.candidate}:${message.postId}`;
  const controller = new AbortController();
  // 在下一个异步读取前占位，拦截同时到达、请求ID不同的同帖请求。
  ftDraftRequests.set(id, { controller, message, tabId });
  try {
    if ((await chrome.storage.local.get(attemptKey))[attemptKey]) return { error: "该帖已有模型生成尝试", code: "API_CANCELLED" };
    await chrome.storage.local.set({ [attemptKey]: { startedAt: Date.now() } });
    state = await ftRecoveryState();
    if (!ftDraftMatches(state, message, tabId)) { controller.abort(); return { error: "评论已作废", code: "API_CANCELLED" }; }
    const modelBudget = Math.min(FT_POLICY.modelMs, message.deadlineAt - Date.now() - FT_POLICY.sendReserveMs);
    if (modelBudget <= 0) return { error: "剩余评论时间不足，保留发送确认时间并放弃本次评论", code: "API_CANCELLED" };
    const result = await generateDraft(message.postText, "timeline_influencer", { singleAttempt: true,
      owner: state.followerTargetJob.owner, target: message.candidate, postId: message.postId, task: "followerTarget",
      signal: controller.signal, deadlineAt: message.deadlineAt, timeoutMs: modelBudget });
    state = await ftRecoveryState();
    if (controller.signal.aborted || !ftDraftMatches(state, message, tabId)) return { error: "迟到的模型结果已作废", code: "API_CANCELLED" };
    await ftNoteModelResult(message.sessionId, null);
    return result;
  } catch (error) {
    if (["API_NETWORK_ERROR", "API_TIMEOUT", "API_SERVICE_UNAVAILABLE", "API_CONFIG_ERROR"].includes(error.code)) await ftNoteModelResult(message.sessionId, error);
    return { error: error.message || "模型请求失败", code: error.code || "", status: error.status || 0 };
  } finally { ftDraftRequests.delete(id); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "cancelFollowerTargetDraft") {
    const request = ftDraftRequests.get(message.requestId);
    if (request?.tabId === sender.tab?.id && request.message.sessionId === message.sessionId) request.controller.abort();
    sendResponse({ ok: true }); return;
  }
  if (message?.type !== "followerTargetGenerateDraft") return;
  if (sender.tab?.id == null) { sendResponse({ error: "请求没有任务标签页" }); return; }
  ftGenerateOneDraft(message, sender.tab.id).then(sendResponse).catch(error => sendResponse({ error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || !ftDraftRequests.size) return;
  ftRecoveryState().then(state => {
    for (const request of ftDraftRequests.values()) if (!ftDraftMatches(state, request.message, request.tabId)) request.controller.abort();
  }).catch(() => {});
});
