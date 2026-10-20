let specifiedPoolOperations = Promise.resolve();
function withSpecifiedPoolLock(operation) {
  const next = specifiedPoolOperations.then(operation);
  specifiedPoolOperations = next.catch(() => {});
  return next;
}

async function specifiedPoolState() {
  return chrome.storage.local.get([
    "specifiedPool", "specifiedJob", "automationRunning", "automationTask", "automationTargetTabId", "specifiedDailyStats"
  ]);
}

function specifiedDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function recordSpecifiedCommentSuccess(message, state) {
  const date = specifiedDateKey();
  const previous = state.specifiedDailyStats || {};
  const commentKey = String(message.commentKey || "").trim();
  const authorKey = String(message.author || "").replace(/^@/, "").trim().toLowerCase();
  const keys = previous.date === date && Array.isArray(previous.keys) ? previous.keys : [];
  const authors = previous.date === date && Array.isArray(previous.authors) ? previous.authors : [];
  if (!commentKey || keys.includes(commentKey)) return;
  const nextAuthors = authorKey && !authors.includes(authorKey) ? [...authors, authorKey] : authors;
  const count = previous.date === date ? Math.max(0, Number(previous.count) || 0) + 1 : 1;
  await chrome.storage.local.set({
    specifiedDailyStats: {
      date,
      count,
      authorCount: nextAuthors.length,
      authors: nextAuthors.slice(-5000),
      keys: [...keys, commentKey].slice(-5000)
    }
  });
}

async function publishSpecifiedPool(pool) {
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const total = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.total) || 0), 0);
  const text = `指定博主进度：${completed}/${total || "?"} 位博主已完成\n` +
    pool.workers.map((worker, index) => `第 ${index + 1} 路：${worker.status || "准备中"}（${worker.completed || 0}/${worker.total || "?"}）`).join("\n");
  await chrome.storage.local.set({ specifiedPool: pool, specifiedStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
}

async function startSpecifiedPool(senderTabId) {
  const state = await specifiedPoolState();
  if (!state.automationRunning || state.automationTask !== "specified" || state.automationTargetTabId !== senderTabId) {
    throw new Error("指定博主任务已停止或控制标签页不匹配");
  }
  const job = state.specifiedJob;
  if (!job?.queue?.length) throw new Error("指定博主列表为空");
  if (state.specifiedPool?.id === job.id) return;
  if (state.specifiedPool) {
    await chrome.storage.local.set({ specifiedPool: null });
    for (const worker of state.specifiedPool.workers || []) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }
  const pool = { id: job.id, coordinatorTabId: senderTabId, workers: [] };
  try {
    const queue = job.queue;
    const jobKey = `specifiedWorkerJob:${job.id}:0`;
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.workers.push({ tabId: tab.id, jobKey, done: false, completed: 0, total: queue.length, status: `待处理 ${queue.length} 位指定博主` });
    await chrome.storage.local.set({ [jobKey]: { ...job, queue, index: 0, posts: [], postIndex: 0, stage: "posts", retryAt: 0, retryCounts: {} } });
    await publishSpecifiedPool(pool);
    await chrome.tabs.update(tab.id, { url: `https://x.com/${queue[0].username}` });
  } catch (error) {
    await chrome.storage.local.set({ specifiedPool: null });
    for (const worker of pool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["startSpecifiedPool", "specifiedWorkerStatus", "specifiedWorkerDone", "specifiedWorkerCommentSuccess"].includes(message?.type)) return;
  withSpecifiedPoolLock(async () => {
    if (message.type === "startSpecifiedPool") { await startSpecifiedPool(sender.tab?.id); return { ok: true }; }
    const state = await specifiedPoolState();
    const pool = state.specifiedPool;
    const worker = pool?.workers.find((item) => item.tabId === sender.tab?.id && item.jobKey === message.jobKey);
    if (!worker || !state.automationRunning || state.automationTask !== "specified" || state.specifiedJob?.id !== pool.id) return { stopped: true };
    if (message.type === "specifiedWorkerCommentSuccess") {
      await recordSpecifiedCommentSuccess(message, state);
      return { ok: true };
    }
    worker.status = String(message.status || "").slice(0, 300);
    if (Number.isFinite(Number(message.completed))) worker.completed = Math.max(0, Number(message.completed));
    if (Number.isFinite(Number(message.total))) worker.total = Math.max(0, Number(message.total));
    if (message.type === "specifiedWorkerDone") worker.done = true;
    await publishSpecifiedPool(pool);
    if (pool.workers.every((item) => item.done)) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "指定博主任务已完成，所有指定账号均已检查" });
    }
    return { ok: true };
  }).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.automationRunning || changes.automationTask)) return;
  withSpecifiedPoolLock(async () => {
    const state = await specifiedPoolState();
    if (state.automationRunning && state.automationTask === "specified") return;
    if (!state.specifiedPool) return;
    await chrome.storage.local.set({ specifiedPool: null });
    for (const worker of state.specifiedPool.workers || []) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withSpecifiedPoolLock(async () => {
    const state = await specifiedPoolState();
    if (!state.specifiedPool || !state.automationRunning || state.automationTask !== "specified") return;
    const worker = state.specifiedPool.workers.find((item) => item.tabId === tabId && !item.done);
    if (worker || state.specifiedPool.coordinatorTabId === tabId) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "指定博主任务标签页已关闭，已停止任务" });
    }
  }).catch(() => {});
});
