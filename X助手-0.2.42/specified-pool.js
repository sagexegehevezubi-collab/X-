let specifiedPoolOperations = Promise.resolve();
function specifiedWorkerCount(job) {
  return Math.min(job.queue.length, Math.max(1, Math.min(10, Math.floor(Number(job.concurrency) || 1))));
}

async function readSpecifiedCheckpoint(job) {
  const count = specifiedWorkerCount(job);
  const keys = Array.from({ length: count }, (_, index) => `specifiedWorkerJob:${job.id}:${index}`);
  const state = await chrome.storage.local.get(["specifiedCheckpoint", "specifiedPool", ...keys]);
  const checkpoint = state.specifiedCheckpoint?.jobId === job.id ? state.specifiedCheckpoint : null;
  const pool = state.specifiedPool?.id === job.id ? state.specifiedPool : null;
  let found = Boolean(checkpoint || pool || job.resumeFrom?.length);
  const completedByWorker = keys.map((key, index) => {
    const queue = job.queue.filter((_, position) => position % count === index);
    const saved = state[key];
    const matches = saved?.id === job.id && saved.owner === job.owner && saved.queue?.length === queue.length &&
      queue.every((entry, position) => entry.username.toLowerCase() === String(saved.queue[position]?.username || "").toLowerCase());
    if (matches) found = true;
    const worker = pool?.workers?.find((item) => item.jobKey === key);
    const values = [job.resumeFrom?.[index], checkpoint?.completedByWorker?.[index], worker?.completed, matches ? saved.index : 0];
    return Math.min(queue.length, Math.max(0, ...values.map((value) => Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0)));
  });
  return { jobId: job.id, completedByWorker, found, updatedAt: Date.now() };
}

function withSpecifiedPoolLock(operation) {
  const next = specifiedPoolOperations.then(operation);
  specifiedPoolOperations = next.catch(() => {});
  return next;
}

async function specifiedPoolState() {
  return chrome.storage.local.get([
    "specifiedPool", "specifiedJob", "specifiedCheckpoint", "automationRunning", "automationTask", "automationTargetTabId", "specifiedDailyStats", "specifiedFailures"
  ]);
}

async function recordSpecifiedFailure(message) {
  const username = String(message.username || "").replace(/^@/, "").trim().toLowerCase();
  if (!username) return;
  const state = await chrome.storage.local.get({ specifiedFailures: [] });
  const previous = Array.isArray(state.specifiedFailures) ? state.specifiedFailures : [];
  const record = {
    username,
    postId: String(message.postId || ""),
    stage: String(message.stage || "任务").slice(0, 40),
    reason: String(message.reason || "未知失败").slice(0, 240),
    attempts: Math.max(1, Number(message.attempts) || 1),
    time: new Date().toISOString(),
    scope: message.scope === "author" ? "author" : "post"
  };
  const key = `${record.username}:${record.postId}:${record.stage}:${record.reason}`;
  const next = previous.filter((item) => `${item.username}:${item.postId || ""}:${item.stage || ""}:${item.reason || ""}` !== key);
  next.push(record);
  await chrome.storage.local.set({ specifiedFailures: next.slice(-1000) });
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
  const { specifiedJob: job } = await chrome.storage.local.get("specifiedJob");
  if (job?.id !== pool.id) return;
  const checkpoint = await readSpecifiedCheckpoint(job);
  pool.workers.forEach((worker, index) => {
    worker.completed = Math.min(worker.total, Math.max(worker.completed || 0, checkpoint.completedByWorker[index] || 0));
  });
  checkpoint.completedByWorker = pool.workers.map((worker) => worker.completed);
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const total = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.total) || 0), 0);
  const text = `指定博主进度：${completed}/${total || "?"} 位博主已完成\n` +
    pool.workers.map((worker, index) => `第 ${index + 1} 路：${worker.status || "准备中"}（${worker.completed || 0}/${worker.total || "?"}）`).join("\n");
  await chrome.storage.local.set({ specifiedPool: pool, specifiedCheckpoint: checkpoint, specifiedStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
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
  const count = specifiedWorkerCount(job);
  const { completedByWorker: resumeFrom } = await readSpecifiedCheckpoint(job);
  const pool = { id: job.id, coordinatorTabId: senderTabId, workers: Array.from({ length: count }, (_, index) => {
    const total = job.queue.filter((_, position) => position % count === index).length;
    const completed = resumeFrom[index] || 0;
    return { tabId: null, jobKey: `specifiedWorkerJob:${job.id}:${index}`, done: completed >= total, completed, total,
      status: completed >= total ? `本路已完成 ${total} 位博主` : `继续处理，已完成 ${completed}/${total} 位博主` };
  }) };
  try {
    await publishSpecifiedPool(pool);
    for (let index = 0; index < count; index += 1) {
      const worker = pool.workers[index];
      const queue = job.queue.filter((_, position) => position % count === index);
      if (worker.done) continue;
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      worker.tabId = tab.id;
      const startIndex = Math.min(queue.length, Math.max(0, Number(resumeFrom[index]) || 0));
      await chrome.storage.local.set({ [worker.jobKey]: { ...job, queue, index: startIndex, posts: [], postIndex: 0, stage: "posts", retryAt: 0, retryCounts: {} } });
      await publishSpecifiedPool(pool);
      await chrome.tabs.update(tab.id, { url: `https://x.com/${queue[startIndex].username}` });
    }
    if (pool.workers.every((worker) => worker.done)) await chrome.storage.local.set({ automationRunning: false, specifiedJob: { ...job, completed: true }, lastAutomationStatus: "指定博主任务已完成，没有剩余账号需要继续" });
  } catch (error) {
    await chrome.storage.local.set({ specifiedPool: null });
    for (const worker of pool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
    throw error;
  }
}

async function closeSpecifiedPool() {
  const state = await specifiedPoolState();
  const pool = state.specifiedPool;
  if (!pool) return;
  if (state.specifiedJob?.id === pool.id) {
    const checkpoint = await readSpecifiedCheckpoint(state.specifiedJob);
    const completed = checkpoint.completedByWorker.reduce((sum, value) => sum + value, 0);
    await chrome.storage.local.set({ specifiedCheckpoint: checkpoint,
      specifiedStatus: `指定博主进度：${completed}/${state.specifiedJob.queue.length} 位博主已完成，断点已保存\n` +
        checkpoint.completedByWorker.map((value, index) => `第 ${index + 1} 路：已完成 ${value} 位博主`).join("\n") });
  }
  await chrome.storage.local.set({ specifiedPool: null });
  for (const worker of pool.workers || []) if (worker.tabId != null) await chrome.tabs.remove(worker.tabId).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["startSpecifiedPool", "stopSpecifiedPool", "specifiedWorkerStatus", "specifiedWorkerDone", "specifiedWorkerCommentSuccess", "specifiedWorkerFailure"].includes(message?.type)) return;
  withSpecifiedPoolLock(async () => {
    if (message.type === "startSpecifiedPool") { await startSpecifiedPool(sender.tab?.id); return { ok: true }; }
    if (message.type === "stopSpecifiedPool") {
      const state = await specifiedPoolState();
      if (state.automationTask === "specified") await chrome.storage.local.set({ automationRunning: false });
      await closeSpecifiedPool();
      return { ok: true };
    }
    const state = await specifiedPoolState();
    const pool = state.specifiedPool;
    const worker = pool?.workers.find((item) => item.tabId === sender.tab?.id && item.jobKey === message.jobKey);
    if (!worker || !state.automationRunning || state.automationTask !== "specified" || state.specifiedJob?.id !== pool.id) return { stopped: true };
    if (message.type === "specifiedWorkerFailure") {
      await recordSpecifiedFailure(message);
      return { ok: true };
    }
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
      const checkpoint = await readSpecifiedCheckpoint(state.specifiedJob);
      await chrome.storage.local.set({ automationRunning: false, specifiedJob: { ...state.specifiedJob, completed: true }, specifiedCheckpoint: checkpoint,
        lastAutomationStatus: "指定博主任务已完成，所有指定账号均已检查" });
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
    await closeSpecifiedPool();
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
