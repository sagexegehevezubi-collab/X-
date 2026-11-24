const specifiedAuthorsInput = document.getElementById("specifiedAuthors");
const specifiedLimitInput = document.getElementById("specifiedPerAuthorLimit");
const specifiedIntervalInput = document.getElementById("specifiedInterval");
const specifiedConcurrencyInput = document.getElementById("specifiedConcurrency");
const specifiedAuthorIntervalInput = document.getElementById("specifiedAuthorInterval");
const specifiedImportStatus = document.getElementById("specifiedImportStatus");
const specifiedExcelFile = document.getElementById("specifiedExcelFile");
const downloadSpecifiedTemplate = document.getElementById("downloadSpecifiedTemplate");
const importSpecifiedFailures = document.getElementById("importSpecifiedFailures");
const exportSpecifiedFailures = document.getElementById("exportSpecifiedFailures");
const specifiedFailureSummary = document.getElementById("specifiedFailureSummary");

function specifiedLocalDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

chrome.storage.local.get({ specifiedAuthors: "", specifiedPerAuthorLimit: 5, specifiedInterval: 20, specifiedConcurrency: 1, specifiedAuthorInterval: 30 }).then((state) => {
  specifiedAuthorsInput.value = state.specifiedAuthors;
  specifiedLimitInput.value = String(Math.min(5, Math.max(1, Number(state.specifiedPerAuthorLimit) || 5)));
  specifiedIntervalInput.value = String(Math.max(20, Math.min(3600, Number(state.specifiedInterval) || 20)));
  specifiedConcurrencyInput.value = String(Math.max(1, Math.min(10, Math.floor(Number(state.specifiedConcurrency) || 1))));
  specifiedAuthorIntervalInput.value = String(Math.max(20, Math.min(3600, Number(state.specifiedAuthorInterval) || 30)));
});

async function persistSpecifiedSettings() {
  const limit = Math.min(5, Math.max(1, Math.floor(Number(specifiedLimitInput.value) || 5)));
  const interval = Math.max(20, Math.min(3600, Math.floor(Number(specifiedIntervalInput.value) || 20)));
  const concurrency = Math.max(1, Math.min(10, Math.floor(Number(specifiedConcurrencyInput.value) || 1)));
  const authorInterval = Math.max(20, Math.min(3600, Math.floor(Number(specifiedAuthorIntervalInput.value) || 30)));
  specifiedLimitInput.value = String(limit);
  specifiedIntervalInput.value = String(interval);
  specifiedConcurrencyInput.value = String(concurrency);
  specifiedAuthorIntervalInput.value = String(authorInterval);
  await chrome.storage.local.set({
    specifiedAuthors: specifiedAuthorsInput.value,
    specifiedPerAuthorLimit: limit,
    specifiedInterval: interval,
    specifiedConcurrency: concurrency,
    specifiedAuthorInterval: authorInterval
  });
}

specifiedAuthorsInput.addEventListener("change", persistSpecifiedSettings);
specifiedLimitInput.addEventListener("change", persistSpecifiedSettings);
specifiedIntervalInput.addEventListener("change", persistSpecifiedSettings);
specifiedConcurrencyInput.addEventListener("change", persistSpecifiedSettings);
specifiedAuthorIntervalInput.addEventListener("change", persistSpecifiedSettings);

function mergeSpecifiedAuthors(values) {
  const existing = parseSpecifiedAuthors(specifiedAuthorsInput.value);
  const imported = parseSpecifiedAuthors(values.join("\n"));
  const merged = [...new Set([...existing, ...imported])];
  specifiedAuthorsInput.value = merged.map((username) => `@${username}`).join("\n");
  return merged;
}

specifiedExcelFile?.addEventListener("change", async () => {
  const file = specifiedExcelFile.files?.[0];
  if (!file) return;
  try {
    const cells = await parseSpecifiedSpreadsheet(file);
    const imported = mergeSpecifiedAuthors(cells);
    await persistSpecifiedSettings();
    specifiedImportStatus.textContent = imported.length ? `已从 ${file.name} 导入并合并 ${imported.length} 位博主` : "Excel 中没有读取到博主账号";
  } catch (error) {
    specifiedImportStatus.textContent = `Excel 导入失败：${String(error?.message || error).slice(0, 180)}`;
  } finally {
    specifiedExcelFile.value = "";
  }
});

downloadSpecifiedTemplate?.addEventListener("click", () => {
  const url = URL.createObjectURL(createSpecifiedXlsxTemplate());
  const link = document.createElement("a");
  link.href = url;
  link.download = "X助手-指定博主名单模板.xlsx";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function updateSpecifiedFailureButton() {
  const state = await chrome.storage.local.get({ specifiedFailures: [] });
  const failures = Array.isArray(state.specifiedFailures) ? state.specifiedFailures : [];
  const authorFailures = failures.filter((item) => item.scope === "author" || item.stage === "博主未成功评论");
  const usernames = [...new Set(authorFailures.map((item) => String(item.username || "").replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  if (importSpecifiedFailures) {
    importSpecifiedFailures.textContent = `导入失败博主（${usernames.length}）`;
    importSpecifiedFailures.disabled = !usernames.length;
    importSpecifiedFailures.dataset.usernames = JSON.stringify(usernames);
  }
  if (exportSpecifiedFailures) exportSpecifiedFailures.disabled = !failures.length;
  if (specifiedFailureSummary) specifiedFailureSummary.textContent = `失败组：${usernames.length} 位博主，${failures.length} 条记录`;
}

function specifiedCsvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

exportSpecifiedFailures?.addEventListener("click", async () => {
  const state = await chrome.storage.local.get({ specifiedFailures: [] });
  const failures = Array.isArray(state.specifiedFailures) ? state.specifiedFailures : [];
  if (!failures.length) return;
  const header = ["博主账号", "帖子ID", "失败阶段", "失败原因", "尝试次数", "时间"];
  const rows = failures.map((item) => [item.username, item.postId, item.stage, item.reason, item.attempts, item.time]);
  const csv = "\\uFEFF" + [header, ...rows].map((row) => row.map(specifiedCsvCell).join(",")).join("\\r\\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `X助手-指定博主失败记录-${specifiedLocalDateKey()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

importSpecifiedFailures?.addEventListener("click", async () => {
  try {
    const usernames = JSON.parse(importSpecifiedFailures.dataset.usernames || "[]");
    const merged = mergeSpecifiedAuthors(usernames);
    await persistSpecifiedSettings();
    specifiedImportStatus.textContent = `已导入 ${usernames.length} 位失败博主，当前名单共 ${merged.length} 位`;
  } catch (error) {
    specifiedImportStatus.textContent = `失败名单导入失败：${String(error?.message || error).slice(0, 180)}`;
  }
});

function parseSpecifiedAuthors(value) {
  const tokens = String(value || "").split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
  const usernames = [];
  for (const token of tokens) {
    const match = token.match(/(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})(?:\/?(?:[?#].*)?)?$/i);
    if (!match) throw new Error(`无法识别账号格式：${token}`);
    const username = match[1].toLowerCase();
    if (!usernames.includes(username)) usernames.push(username);
  }
  return usernames;
}

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
    const matches = saved?.id === job.id && saved.owner === job.owner &&
      saved.queue?.length === queue.length && queue.every((entry, position) =>
        entry.username.toLowerCase() === String(saved.queue[position]?.username || "").toLowerCase());
    if (matches) found = true;
    const worker = pool?.workers?.find((item) => item.jobKey === key);
    const values = [job.resumeFrom?.[index], checkpoint?.completedByWorker?.[index], worker?.completed, matches ? saved.index : 0];
    return Math.min(queue.length, Math.max(0, ...values.map((value) => Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0)));
  });
  return { jobId: job.id, completedByWorker, found, updatedAt: Date.now() };
}

async function prepareSpecifiedJob(controller, startMode = "restart") {
  await persistSpecifiedSettings();
  if (startMode === "resume") {
    const { specifiedJob: previous } = await chrome.storage.local.get({ specifiedJob: null });
    if (!previous?.queue?.length || previous.owner !== controller.username || previous.completed) {
      throw new Error("没有属于当前账号的未完成指定博主任务，请先从头开始");
    }
    const checkpoint = await readSpecifiedCheckpoint(previous);
    if (!checkpoint.found) throw new Error("没有找到可恢复的指定博主断点，请从头开始");
    const unfinished = checkpoint.completedByWorker.some((position, index) => position < previous.queue.filter((_, item) => item % specifiedWorkerCount(previous) === index).length);
    if (!unfinished) throw new Error("上次指定博主任务已经完成，请从头开始新一轮");
    previous.resumeFrom = checkpoint.completedByWorker;
    previous.completed = false;
    await chrome.storage.local.set({ specifiedJob: previous, specifiedCheckpoint: checkpoint,
      specifiedStatus: `继续上次指定博主任务：${checkpoint.completedByWorker.reduce((sum, value) => sum + value, 0)}/${previous.queue.length} 位已完成` });
    specifiedAuthorsInput.value = previous.queue.map((entry) => `@${entry.username}`).join("\n");
    specifiedLimitInput.value = String(previous.perAuthorLimit);
    specifiedIntervalInput.value = String(previous.interval);
    specifiedConcurrencyInput.value = String(Math.max(1, Math.min(10, Math.floor(Number(previous.concurrency) || 1))));
    specifiedAuthorIntervalInput.value = String(Math.max(20, Math.min(3600, Math.floor(Number(previous.authorInterval) || 30))));
    specifiedImportStatus.textContent = `已恢复上次任务；${previous.queue.length} 位博主，继续未完成部分`;
    return;
  }
  const usernames = parseSpecifiedAuthors(specifiedAuthorsInput.value);
  if (!usernames.length) throw new Error("请先填写至少一个博主账号");
  const queue = usernames.filter((username) => username !== controller.username);
  if (!queue.length) throw new Error("指定列表中只有当前登录账号，请填写其他博主");
  const { specifiedPerAuthorLimit, specifiedInterval, specifiedConcurrency, specifiedAuthorInterval } = await chrome.storage.local.get({ specifiedPerAuthorLimit: 5, specifiedInterval: 20, specifiedConcurrency: 1, specifiedAuthorInterval: 30 });
  const job = {
    id: crypto.randomUUID(),
    owner: controller.username,
    queue: queue.map((username) => ({ username })),
    index: 0,
    stage: "posts",
    posts: [],
    postIndex: 0,
    perAuthorLimit: Math.min(5, Math.max(1, Number(specifiedPerAuthorLimit) || 5)),
    interval: Math.max(20, Number(specifiedInterval) || 20),
    concurrency: Math.max(1, Math.min(10, Math.floor(Number(specifiedConcurrency) || 1))),
    authorInterval: Math.max(20, Math.min(3600, Math.floor(Number(specifiedAuthorInterval) || 30))),
    authorCommentCounts: {},
    authorSucceeded: {},
    authorFailureRecorded: {},
    retryAt: 0,
    retryCounts: {}
  };
  await chrome.storage.local.set({ specifiedJob: job, specifiedCheckpoint: null, specifiedStatus: `准备处理 ${queue.length} 位指定博主` });
  specifiedImportStatus.textContent = `已准备 ${queue.length} 位博主；${job.concurrency} 路并行；优先近 2 小时，必要时扩大到近 4 小时`;
}

async function updateSpecifiedProgress() {
  const state = await chrome.storage.local.get({ specifiedPool: null, specifiedJob: null, specifiedStatus: "", specifiedDailyStats: {} });
  const daily = state.specifiedDailyStats?.date === specifiedLocalDateKey() ? state.specifiedDailyStats : {};
  const comments = Math.max(0, Number(daily.count) || 0);
  const authors = Math.max(0, Number(daily.authorCount) || 0);
  document.getElementById("specifiedDailyCount").textContent = `指定博主今日评论：${comments} 条，涉及 ${authors} 位博主`;
  const target = document.getElementById("specifiedProgress");
  const pool = state.specifiedPool;
  if (!pool?.workers?.length) {
    target.textContent = state.specifiedStatus || (state.specifiedJob?.queue?.length ? `指定博主进度：已准备 ${state.specifiedJob.queue.length} 位博主，等待启动` : "指定博主进度：未启动");
    return;
  }
  const total = Math.max(0, Number(state.specifiedJob?.queue?.length) || 0);
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const lines = pool.workers.map((worker, index) => `第 ${index + 1} 路：${worker.status || "准备中"}（${worker.completed || 0}/${worker.total || "?"}）`);
  target.textContent = `指定博主进度：${Math.min(completed, total || completed)}/${total || "?"} 位博主已完成\n${lines.join("\n")}`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.specifiedPool || changes.specifiedJob || changes.specifiedStatus || changes.specifiedDailyStats)) updateSpecifiedProgress();
  if (area === "local" && changes.specifiedFailures) updateSpecifiedFailureButton();
});
updateSpecifiedProgress();
updateSpecifiedFailureButton();
