let rankingPoolOperations = Promise.resolve();
function withRankingPoolLock(operation) {
  const next = rankingPoolOperations.then(operation);
  rankingPoolOperations = next.catch(() => {});
  return next;
}
async function rankingPoolState() {
  return chrome.storage.local.get(["rankingPool", "automationRunning", "automationTask", "automationTargetTabId", "rankingJob", "rankingDailyStats"]);
}
function rankingDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
async function recordRankingCommentSuccess(message, state) {
  const date = rankingDateKey();
  const previous = state.rankingDailyStats || {};
  const commentKey = String(message.commentKey || "").trim();
  const keys = previous.date === date && Array.isArray(previous.keys) ? previous.keys : [];
  if (!commentKey || keys.includes(commentKey)) return;
  const count = previous.date === date ? Math.max(0, Number(previous.count) || 0) + 1 : 1;
  await chrome.storage.local.set({ rankingDailyStats: { date, count, keys: [...keys, commentKey].slice(-5000) } });
}
async function publishRankingPool(pool) {
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const total = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.total) || 0), 0);
  const text = `榜单进度：${completed}/${total || "?"} 位博主已完成\n` +
    pool.workers.map((worker, index) => `第 ${index + 1} 路：${worker.status || "准备中"}（${worker.completed || 0}/${worker.total || "?"}）`).join("\n");
  await chrome.storage.local.set({ rankingPool: pool, rankingStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
}
async function startRankingPool(senderTabId) {
  const state = await rankingPoolState();
  if (!state.automationRunning || state.automationTask !== "ranking" || state.automationTargetTabId !== senderTabId) throw new Error("榜单任务已停止或控制标签页不匹配");
  const job = state.rankingJob;
  if (!job?.queue?.length) throw new Error("榜单队列为空");
  if (state.rankingPool?.id === job.id) return;
  if (state.rankingPool) {
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of state.rankingPool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }
  const count = Math.min(job.queue.length, Math.max(1, Math.min(10, Number(job.concurrency) || 1)));
  const pool = { id: job.id, coordinatorTabId: senderTabId, workers: [] };
  try {
    for (let index = 0; index < count; index += 1) {
      const current = await rankingPoolState();
      if (!current.automationRunning || current.automationTask !== "ranking" || current.rankingJob?.id !== job.id) throw new Error("任务已停止");
      const queue = job.queue.filter((_, position) => position % count === index);
      const jobKey = `rankingWorkerJob:${job.id}:${index}`;
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      pool.workers.push({ tabId: tab.id, jobKey, done: false, completed: 0, total: queue.length, status: `待处理 ${queue.length} 位博主` });
      await chrome.storage.local.set({ [jobKey]: { ...job, queue, index: 0, stage: "posts", commentPostId: null, retryAt: 0 } });
      await publishRankingPool(pool);
      await chrome.tabs.update(tab.id, { url: `https://x.com/${queue[0].username}` });
    }
  } catch (error) {
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of pool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["startRankingPool", "rankingWorkerStatus", "rankingWorkerDone", "rankingWorkerCommentSuccess"].includes(message?.type)) return;
  withRankingPoolLock(async () => {
    if (message.type === "startRankingPool") { await startRankingPool(sender.tab?.id); return { ok: true }; }
    const state = await rankingPoolState();
    if (message.type === "rankingWorkerCommentSuccess") {
      const worker = state.rankingPool?.workers.find((item) => item.tabId === sender.tab?.id && item.jobKey === message.jobKey);
      if (!worker || !state.automationRunning || state.automationTask !== "ranking" || state.rankingJob?.id !== state.rankingPool?.id) return { stopped: true };
      await recordRankingCommentSuccess(message, state);
      return { ok: true };
    }
    const pool = state.rankingPool;
    const worker = pool?.workers.find((item) => item.tabId === sender.tab?.id && item.jobKey === message.jobKey);
    if (!worker || !state.automationRunning || state.automationTask !== "ranking" || state.rankingJob?.id !== pool.id) return { stopped: true };
    worker.status = String(message.status || "").slice(0, 300);
    if (Number.isFinite(Number(message.completed))) worker.completed = Math.max(0, Number(message.completed));
    if (Number.isFinite(Number(message.total))) worker.total = Math.max(0, Number(message.total));
    if (message.type === "rankingWorkerDone") worker.done = true;
    await publishRankingPool(pool);
    if (pool.workers.every((item) => item.done)) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "榜单并行任务已完成，所有分配账号均已检查" });
    }
    return { ok: true };
  }).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.automationRunning || changes.automationTask)) return;
  withRankingPoolLock(async () => {
    const state = await rankingPoolState();
    if (state.automationRunning && state.automationTask === "ranking") return;
    if (!state.rankingPool) return;
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of state.rankingPool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  withRankingPoolLock(async () => {
    const state = await rankingPoolState();
    if (!state.rankingPool || !state.automationRunning || state.automationTask !== "ranking") return;
    const worker = state.rankingPool.workers.find((item) => item.tabId === tabId && !item.done);
    if (worker || state.rankingPool.coordinatorTabId === tabId) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "榜单任务标签页已关闭，已停止全部并行任务" });
    }
  }).catch(() => {});
});
