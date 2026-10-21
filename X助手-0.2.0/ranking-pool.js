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
  const { rankingJob: job } = await chrome.storage.local.get("rankingJob");
  if (job?.id !== pool.id) return;
  const checkpoint = await readRankingCheckpoint(job);
  pool.workers.forEach((worker, index) => {
    worker.completed = Math.min(worker.total, Math.max(worker.completed || 0, checkpoint.completedByWorker[index] || 0));
  });
  checkpoint.completedByWorker = pool.workers.map((worker) => worker.completed);
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const total = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.total) || 0), 0);
  const text = `榜单进度：${completed}/${total || "?"} 位博主已完成\n` +
    pool.workers.map((worker, index) => `第 ${index + 1} 路：${worker.status || "准备中"}（${worker.completed || 0}/${worker.total || "?"}）`).join("\n");
  await chrome.storage.local.set({ rankingPool: pool, rankingCheckpoint: checkpoint, rankingStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
}
async function closeRankingPool() {
  const state = await rankingPoolState();
  const pool = state.rankingPool;
  if (!pool) return;
  if (state.rankingJob?.id === pool.id) {
    const checkpoint = await readRankingCheckpoint(state.rankingJob);
    const completed = checkpoint.completedByWorker.reduce((sum, value) => sum + value, 0);
    await chrome.storage.local.set({ rankingCheckpoint: checkpoint,
      rankingStatus: `榜单进度：${completed}/${state.rankingJob.queue.length} 位博主已完成，断点已保存\n` +
        checkpoint.completedByWorker.map((value, index) => `第 ${index + 1} 路：已完成 ${value} 位博主`).join("\n") });
  }
  await chrome.storage.local.set({ rankingPool: null });
  for (const worker of pool.workers) {
    if (worker.tabId != null) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }
}
async function startRankingPool(senderTabId) {
  const state = await rankingPoolState();
  if (!state.automationRunning || state.automationTask !== "ranking" || state.automationTargetTabId !== senderTabId) throw new Error("榜单任务已停止或控制标签页不匹配");
  const job = state.rankingJob;
  if (!job?.queue?.length) throw new Error("榜单队列为空");
  if (state.rankingPool?.id === job.id) return;
  if (state.rankingPool) await closeRankingPool();
  const count = rankingWorkerCount(job);
  const { completedByWorker: resumeFrom } = await readRankingCheckpoint(job);
  const pool = { id: job.id, coordinatorTabId: senderTabId, workers: Array.from({ length: count }, (_, index) => {
    const total = job.queue.filter((_, position) => position % count === index).length;
    const completed = resumeFrom[index];
    return { tabId: null, jobKey: `rankingWorkerJob:${job.id}:${index}`, done: completed >= total,
      completed, total, status: completed >= total ? `本路已完成 ${total} 位博主` : `继续处理，已完成 ${completed}/${total} 位博主` };
  }) };
  try {
    // Publish every lane at once, so initialization cannot erase other lanes.
    await publishRankingPool(pool);
    for (let index = 0; index < count; index += 1) {
      const current = await rankingPoolState();
      if (!current.automationRunning || current.automationTask !== "ranking" || current.rankingJob?.id !== job.id) throw new Error("任务已停止");
      const queue = job.queue.filter((_, position) => position % count === index);
      const jobKey = `rankingWorkerJob:${job.id}:${index}`;
      if (pool.workers[index].done) continue;
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      const startIndex = Math.min(queue.length, Math.max(0, Number(resumeFrom[index]) || 0));
      const done = startIndex >= queue.length;
      pool.workers[index].tabId = tab.id;
      await chrome.storage.local.set({ [jobKey]: { ...job, queue, index: startIndex, stage: "posts", commentPostId: null, retryAt: 0 } });
      await publishRankingPool(pool);
      if (!done) await chrome.tabs.update(tab.id, { url: `https://x.com/${queue[startIndex].username}` });
    }
    if (pool.workers.every((worker) => worker.done)) {
      await chrome.storage.local.set({
        automationRunning: false,
        rankingJob: { ...job, completed: true },
        rankingCheckpoint: { jobId: job.id, completedByWorker: pool.workers.map((worker) => worker.completed), updatedAt: Date.now() },
        lastAutomationStatus: "榜单任务已完成，没有剩余账号需要继续"
      });
    }
  } catch (error) {
    await closeRankingPool();
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["startRankingPool", "stopRankingPool", "rankingWorkerStatus", "rankingWorkerDone", "rankingWorkerCommentSuccess"].includes(message?.type)) return;
  withRankingPoolLock(async () => {
    if (message.type === "startRankingPool") { await startRankingPool(sender.tab?.id); return { ok: true }; }
    if (message.type === "stopRankingPool") {
      const state = await rankingPoolState();
      if (state.automationTask === "ranking") await chrome.storage.local.set({ automationRunning: false });
      await closeRankingPool();
      return { ok: true };
    }
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
    if (Number.isFinite(Number(message.completed))) worker.completed = Math.max(worker.completed || 0, Number(message.completed));
    if (Number.isFinite(Number(message.total))) worker.total = Math.max(0, Number(message.total));
    if (message.type === "rankingWorkerDone") worker.done = true;
    const checkpoint = state.rankingJob;
    await publishRankingPool(pool);
    if (pool.workers.every((item) => item.done)) {
      await chrome.storage.local.set({ automationRunning: false, rankingJob: { ...checkpoint, completed: true }, lastAutomationStatus: "榜单并行任务已完成，所有分配账号均已检查" });
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
    await closeRankingPool();
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
