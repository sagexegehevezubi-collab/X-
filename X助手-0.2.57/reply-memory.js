// 后台串行处理评论记忆与发送预占，避免榜单/指定博主多路并发丢记录或同时发重复句。
let commentMemoryQueue = Promise.resolve();
function queueCommentMemory(operation) {
  const request = commentMemoryQueue.catch(() => {}).then(operation);
  commentMemoryQueue = request.catch(() => {});
  return request;
}

function safeCommentIdentity(value) {
  const text = String(value || "").replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(text) ? text : "";
}

async function recentSentComments(owner) {
  const username = safeCommentIdentity(owner);
  if (!username) return [];
  const { commentSentHistory = [] } = await chrome.storage.local.get({ commentSentHistory: [] });
  return commentSentHistory.filter(item => item.owner === username).slice(-200);
}

function recordCommentQuality(entry) {
  return queueCommentMemory(async () => {
    const { commentQualityLog = [] } = await chrome.storage.local.get({ commentQualityLog: [] });
    const row = { version: REPLY_STYLE_VERSION, at: Date.now(), scene: String(entry.scene || ""), task: String(entry.task || ""),
      owner: safeCommentIdentity(entry.owner), target: safeCommentIdentity(entry.target), postId: String(entry.postId || "").slice(0, 24),
      result: String(entry.result || ""), reason: String(entry.reason || "").slice(0, 160), score: entry.score ?? null,
      elapsedMs: Math.max(0, Number(entry.elapsedMs) || 0), calls: Number(entry.calls) || 0 };
    await chrome.storage.local.set({ commentQualityLog: [...commentQualityLog, row].slice(-200) });
  });
}

function updateCommentMemory(message, tabId) {
  return queueCommentMemory(async () => {
    const owner = safeCommentIdentity(message.owner), target = safeCommentIdentity(message.target);
    const token = String(message.token || ""), now = Date.now();
    if (!owner || !target || !/^\d+$/.test(String(message.postId || "")) || !token || token.length > 120 || tabId == null)
      return { ok: false, reason: "评论身份或发送标识无效" };
    const { commentSentHistory = [], commentSendReservations = [] } = await chrome.storage.local.get({ commentSentHistory: [], commentSendReservations: [] });
    const reservations = commentSendReservations.filter(item => item.until > now);
    const matching = reservations.find(item => item.token === token && item.tabId === tabId && item.owner === owner && item.target === target && item.postId === String(message.postId));
    if (message.action === "release") {
      await chrome.storage.local.set({ commentSendReservations: reservations.filter(item => item !== matching) });
      return { ok: true };
    }
    if (message.action === "confirm") {
      if (commentSentHistory.some(item => item.token === token && item.owner === owner)) return { ok: true };
      // 结果确认偶尔晚于预占有效期，仍用原预占核对；绝不凭传入正文伪造成功历史。
      const original = matching || commentSendReservations.find(item => item.token === token && item.tabId === tabId && item.owner === owner && item.target === target && item.postId === String(message.postId));
      if (!original) return { ok: false, reason: "发送预占已失效，未记为成功" };
      const { until, tabId: _tab, ...row } = original;
      await chrome.storage.local.set({ commentSentHistory: [...commentSentHistory, { ...row, at: now }].slice(-200),
        commentSendReservations: reservations.filter(item => item.token !== token) });
      return { ok: true };
    }
    if (message.action !== "reserve" || !Number.isFinite(message.requestDeadlineAt) || now >= message.requestDeadlineAt)
      return { ok: false, reason: "发送检查已超时" };
    const text = String(message.text || "").trim();
    const issue = getReplyPolicyIssue(text, message.postText, message.postContext) || getReplyCandidateIssue(text);
    if (issue) return { ok: false, reason: commentIssueLabel(issue), code: issue };
    if (matching) return { ok: true };
    const rows = [...commentSentHistory, ...reservations].filter(item => item.owner === owner);
    const duplicate = getCommentDuplicateIssue(text, target, rows);
    if (duplicate) return { ok: false, reason: commentIssueLabel(duplicate) };
    const reservation = { token, owner, target, postId: String(message.postId), text, normalized: normalizeCommentBody(text),
      scene: "semi_familiar", task: String(message.task || "").slice(0, 24), at: now, until: now + 120000, tabId };
    if (reservations.length >= 200) return { ok: false, reason: "发送预占过多，请稍后继续" };
    await chrome.storage.local.set({ commentSendReservations: [...reservations, reservation] });
    return { ok: true };
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["commentMemory", "commentFactBlocked"].includes(message?.type)) return;
  if (!/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(sender.tab?.url || sender.url || "")) {
    sendResponse({ ok: false, reason: "发送检查仅用于X任务页" }); return;
  }
  if (message.type === "commentFactBlocked") {
    if (!isReplyPolicySkip(message.code)) { sendResponse({ ok: false }); return; }
    recordCommentQuality({ owner: message.owner, target: message.target, postId: message.postId, task: message.task,
      scene: "semi_familiar", result: "send_blocked", reason: replyFactIssueLabel(message.code) })
      .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  updateCommentMemory(message, sender.tab?.id).then(result => {
    sendResponse(result);
    if ((message.action === "reserve" && !result.ok) || (message.action === "confirm" && result.ok))
      recordCommentQuality({ owner: message.owner, target: message.target, postId: message.postId, task: message.task, scene: "semi_familiar",
        result: message.action === "confirm" ? "send_confirmed" : "send_blocked", reason: result.reason || "" }).catch(() => {});
  }).catch(() => sendResponse({ ok: false, reason: "本地评论记录暂不可用" }));
  return true;
});
