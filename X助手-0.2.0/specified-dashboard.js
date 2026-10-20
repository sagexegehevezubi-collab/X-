const specifiedAuthorsInput = document.getElementById("specifiedAuthors");
const specifiedLimitInput = document.getElementById("specifiedPerAuthorLimit");
const specifiedIntervalInput = document.getElementById("specifiedInterval");
const specifiedImportStatus = document.getElementById("specifiedImportStatus");

function specifiedLocalDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

chrome.storage.local.get({ specifiedAuthors: "", specifiedPerAuthorLimit: 5, specifiedInterval: 20 }).then((state) => {
  specifiedAuthorsInput.value = state.specifiedAuthors;
  specifiedLimitInput.value = String(Math.min(5, Math.max(1, Number(state.specifiedPerAuthorLimit) || 5)));
  specifiedIntervalInput.value = String(Math.max(20, Math.min(3600, Number(state.specifiedInterval) || 20)));
});

async function persistSpecifiedSettings() {
  const limit = Math.min(5, Math.max(1, Math.floor(Number(specifiedLimitInput.value) || 5)));
  const interval = Math.max(20, Math.min(3600, Math.floor(Number(specifiedIntervalInput.value) || 20)));
  specifiedLimitInput.value = String(limit);
  specifiedIntervalInput.value = String(interval);
  await chrome.storage.local.set({
    specifiedAuthors: specifiedAuthorsInput.value,
    specifiedPerAuthorLimit: limit,
    specifiedInterval: interval
  });
}

specifiedAuthorsInput.addEventListener("change", persistSpecifiedSettings);
specifiedLimitInput.addEventListener("change", persistSpecifiedSettings);
specifiedIntervalInput.addEventListener("change", persistSpecifiedSettings);

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

async function prepareSpecifiedJob(controller) {
  await persistSpecifiedSettings();
  const usernames = parseSpecifiedAuthors(specifiedAuthorsInput.value);
  if (!usernames.length) throw new Error("请先填写至少一个博主账号");
  const queue = usernames.filter((username) => username !== controller.username);
  if (!queue.length) throw new Error("指定列表中只有当前登录账号，请填写其他博主");
  const { specifiedPerAuthorLimit, specifiedInterval } = await chrome.storage.local.get({ specifiedPerAuthorLimit: 5, specifiedInterval: 20 });
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
    retryAt: 0,
    retryCounts: {}
  };
  await chrome.storage.local.set({ specifiedJob: job, specifiedStatus: `准备处理 ${queue.length} 位指定博主` });
  specifiedImportStatus.textContent = `已准备 ${queue.length} 位博主；近 4 小时内每位最多 ${job.perAuthorLimit} 条`;
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
});
updateSpecifiedProgress();
