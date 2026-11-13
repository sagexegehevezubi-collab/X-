const autoFollowBackOption = document.getElementById("autoFollowBack");
const pageStatus = document.getElementById("pageStatus");
const taskStatus = document.getElementById("taskStatus");
const actionStatus = document.getElementById("actionStatus");
const rankingProgress = document.getElementById("rankingProgress");
const startTaskButtons = [...document.querySelectorAll("[data-start-task]")];
const stopTaskButtons = [...document.querySelectorAll("[data-stop-task]")];
const homeFollowMutualOption = document.getElementById("homeFollowMutualPosts");
const homeReplyMutualOption = document.getElementById("homeReplyMutualPosts");
const ownPostCommentReplyOption = document.getElementById("ownPostCommentReply");
const idleRefreshMinutes = document.getElementById("idleRefreshMinutes");
const targetTabSelect = document.getElementById("targetTab");
const refreshTabsButton = document.getElementById("refreshTabs");
const RELATIONSHIP_SETTING_DEFAULTS = {
  unfollowAccountLimit: 50,
  unfollowIntervalSeconds: 10,
  followBackAccountLimit: 50,
  followBackIntervalSeconds: 10
};
const FOLLOWER_TARGET_SETTING_DEFAULTS = { followerTargetFollowLimit: 10 };
const relationshipSettingInputs = Object.fromEntries(Object.keys(RELATIONSHIP_SETTING_DEFAULTS)
  .map((key) => [key, document.getElementById(key)]));
let activeTab;
let activeTabIsX = false;
let taskOptionsReady = false;
let statusReadVersion = 0;
let followerTargetMidnightTimer = null;

async function updateRankingProgress() {
  if (!rankingProgress) return;
  const state = await chrome.storage.local.get({
    rankingPool: null,
    rankingJob: null,
    rankingStatus: "",
    rankingDailyStats: {}
  });
  const dailyCount = state.rankingDailyStats?.date === localDateKey()
    ? Math.max(0, Number(state.rankingDailyStats.count) || 0) : 0;
  const dailyCountElement = document.getElementById("rankingDailyCount");
  if (dailyCountElement) dailyCountElement.textContent = `榜单博主今日评论：${dailyCount} 条`;
  const pool = state.rankingPool;
  const job = state.rankingJob;
  if (!pool?.workers?.length) {
    rankingProgress.textContent = state.rankingStatus || (job?.queue?.length ? `榜单进度：已准备 ${job.queue.length} 位博主，等待启动` : "榜单进度：未启动");
    return;
  }
  const total = Math.max(0, Number(job?.queue?.length) || 0);
  const completed = pool.workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.completed) || 0), 0);
  const lines = pool.workers.map((worker, index) => {
    const workerTotal = Math.max(0, Number(worker.total) || 0);
    const workerCompleted = Math.min(workerTotal, Math.max(0, Number(worker.completed) || 0));
    return `第 ${index + 1} 路：${worker.status || "准备中"}（${workerCompleted}/${workerTotal}）`;
  });
  const displayedCompleted = Math.min(total || completed, completed);
  rankingProgress.textContent = `榜单进度：${displayedCompleted}/${total || "?"} 位博主已完成\n${lines.join("\n")}`;
}

function localDateKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function updateHomeReplyDailyCount() {
  const { homeReplyDailyStats = {} } = await chrome.storage.local.get({ homeReplyDailyStats: {} });
  const count = homeReplyDailyStats.date === localDateKey() ? Math.max(0, Number(homeReplyDailyStats.count) || 0) : 0;
  document.getElementById("homeReplyDailyCount").textContent = `功能二今日评论：${count} 条`;
}

async function updateFollowerTargetDailyCount() {
  const element = document.getElementById("followerTargetDailyCount");
  const progress = document.getElementById("followerTargetProgress");
  if (!element && !progress) return;
  const state = await chrome.storage.local.get({ followerTargetStats: {}, followerTargetJob: null, followerTargetFollowLimit: 10, followerTargetStatus: "" });
  const today = state.followerTargetStats?.date === localDateKey();
  if (element) element.textContent = `列表关注加评论：今日累计关注 ${today ? Number(state.followerTargetStats.follows) || 0 : 0} 人，今日已评论 ${today ? Number(state.followerTargetStats.comments) || 0 : 0} 条`;
  if (progress) {
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(state.followerTargetFollowLimit) || 10)));
    const session = Math.max(0, Number(state.followerTargetJob?.sessionFollowCount) || 0);
    progress.textContent = state.followerTargetStatus || `本轮进度：${Math.min(session, limit)}/${limit} 位已关注，${session >= limit ? "已达到上限，任务已停止" : "达到上限后停止"}`;
  }
}

// 控制台如果跨过零点仍保持打开，需要主动刷新显示；统计数据按本地日期判断，
// 因此不会把昨天的关注数带到今天。
function scheduleFollowerTargetMidnightRefresh() {
  if (followerTargetMidnightTimer) clearTimeout(followerTargetMidnightTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 1, 0);
  const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());
  followerTargetMidnightTimer = setTimeout(async () => {
    followerTargetMidnightTimer = null;
    await updateFollowerTargetDailyCount();
    scheduleFollowerTargetMidnightRefresh();
  }, delay);
}

async function loadTaskOptions() {
  const values = await chrome.storage.local.get([
    "autoFollowBack", "homeFollowMutualPosts", "homeReplyMutualPosts", "mutualTaskEnabled", "homeAutoFollowMutual", "ownPostCommentReply", "autoReply", "autoFollow",
    "idleRefreshMinutes",
    ...Object.keys(RELATIONSHIP_SETTING_DEFAULTS)
    , ...Object.keys(FOLLOWER_TARGET_SETTING_DEFAULTS)
  ]);
  const legacyCombined = values.mutualTaskEnabled ?? (values.autoReply === true || values.autoFollow === true);
  const homeFollowMutualPosts = values.homeFollowMutualPosts ?? (values.homeAutoFollowMutual === true || legacyCombined);
  const homeReplyMutualPosts = values.homeReplyMutualPosts ?? legacyCombined;
  const ownPostCommentReply = values.ownPostCommentReply === true;
  homeFollowMutualOption.checked = homeFollowMutualPosts;
  homeReplyMutualOption.checked = homeReplyMutualPosts;
  ownPostCommentReplyOption.checked = ownPostCommentReply;
  autoFollowBackOption.checked = values.autoFollowBack === true;
  await chrome.storage.local.set({ homeFollowMutualPosts, homeReplyMutualPosts, ownPostCommentReply });
  idleRefreshMinutes.value = String([1, 3, 5, 10].includes(Number(values.idleRefreshMinutes)) ? values.idleRefreshMinutes : 3);
  if (![1, 3, 5, 10].includes(Number(values.idleRefreshMinutes))) {
    await chrome.storage.local.set({ idleRefreshMinutes: 3 });
  }
  const relationshipSettings = {};
  for (const [key, fallback] of Object.entries(RELATIONSHIP_SETTING_DEFAULTS)) {
    const maximum = key.endsWith("IntervalSeconds") ? 3600 : 1000;
    const selected = Math.min(maximum, Math.max(1, Math.floor(Number(values[key]) || fallback)));
    relationshipSettings[key] = selected;
    relationshipSettingInputs[key].value = String(selected);
  }
  await chrome.storage.local.set(relationshipSettings);
  const followerTargetFollowLimit = Math.min(1000, Math.max(1, Math.floor(Number(values.followerTargetFollowLimit) || 10)));
  const followerTargetFollowLimitInput = document.getElementById("followerTargetFollowLimit");
  if (followerTargetFollowLimitInput) followerTargetFollowLimitInput.value = String(followerTargetFollowLimit);
  await chrome.storage.local.set({ followerTargetFollowLimit });
  taskOptionsReady = true;
}

async function updateTaskStatus() {
  const readVersion = ++statusReadVersion;
  const monitor = await chrome.storage.local.get({ followerMonitorStatus: "" });
  await updateHomeReplyDailyCount();
  await updateFollowerTargetDailyCount();
  const { automationRunning = false, automationTask = "engagement", lastAutomationError = "", lastAutomationStatus = "", rankingJob = null } = await chrome.storage.local.get({
    automationRunning: false,
    automationTask: "engagement",
    lastAutomationError: "",
    lastAutomationStatus: "",
    rankingJob: null
  });
  if (readVersion !== statusReadVersion) return;
  await updateRankingProgress();
  document.getElementById("followerMonitorStatus").textContent = autoFollowBackOption.checked ? monitor.followerMonitorStatus : "";
  const hasSelectedTask = autoFollowBackOption.checked || homeFollowMutualOption.checked || homeReplyMutualOption.checked || ownPostCommentReplyOption.checked;
  const taskLabels = {
    engagement: "关注 / 评论",
    ranking: "榜单博主互动",
    specified: "指定博主互动",
    unfollowNonMutual: "取消单向关注",
    followBackFollowers: "回关关注者"
    ,followerTarget: "列表关注加评论"
  };
  const taskLabel = taskLabels[automationTask] || automationTask;
  const currentAction = lastAutomationStatus || (automationRunning ? "正在等待内容脚本响应…" : "暂无上一条任务记录");
  const errorLine = lastAutomationError ? `\n最近错误：${lastAutomationError}` : "";
  taskStatus.textContent = automationRunning
    ? `任务状态：运行中\n任务类型：${taskLabel}\n当前动作：${currentAction}${errorLine}`
    : `任务状态：已停止\n上次状态：${currentAction}${errorLine}`;
  const actionMessage = [lastAutomationStatus, lastAutomationError
    ? `最近错误：${lastAutomationError}` : ""].filter(Boolean).join("\n");
  actionStatus.hidden = !actionMessage;
  actionStatus.style.whiteSpace = "pre-line";
  actionStatus.textContent = actionMessage;
  for (const button of startTaskButtons) {
    const mode = button.dataset.startTask;
    const resumeUnavailable = mode === "ranking" && button.dataset.rankingStartMode === "resume" &&
      (!rankingJob?.queue?.length || rankingJob.completed === true);
    button.disabled = !activeTabIsX || (mode === "engagement" && !hasSelectedTask) || !taskOptionsReady;
    if (resumeUnavailable) button.disabled = true;
    button.textContent = automationRunning && automationTask === mode
      ? mode === "engagement" ? "重新开始关注 / 评论" : button.dataset.rankingStartMode === "resume" ? "继续执行中" : "重新开始"
      : button.dataset.defaultLabel;
  }
  for (const button of stopTaskButtons) {
    button.disabled = !automationRunning || automationTask !== button.dataset.stopTask;
  }
  for (const state of document.querySelectorAll("[data-state-for]")) {
    const running = automationRunning && automationTask === state.dataset.stateFor;
    state.textContent = running ? "运行中" : "未运行";
    state.classList.toggle("running", running);
  }
}

async function updatePageStatus() {
  const xTabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const currentSelection = Number(targetTabSelect.value) || Number(new URLSearchParams(location.search).get("tabId"));
  const [focusedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chosenTab = xTabs.find((tab) => tab.id === currentSelection) ||
    xTabs.find((tab) => tab.id === focusedTab?.id) || xTabs[0];
  targetTabSelect.replaceChildren();
  for (const tab of xTabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.title || "X 页面"} · ${new URL(tab.url).pathname}`;
    targetTabSelect.append(option);
  }
  if (chosenTab) targetTabSelect.value = String(chosenTab.id);
  activeTab = chosenTab;
  activeTabIsX = Boolean(activeTab?.url && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(activeTab.url));
  pageStatus.textContent = activeTabIsX
    ? `已连接：${activeTab.title || activeTab.url}`
    : "没有检测到打开的 X 标签页。请先打开 X。";
  await updateTaskStatus();
}

targetTabSelect.addEventListener("change", updatePageStatus);
refreshTabsButton.addEventListener("click", updatePageStatus);

async function startTask(mode, rankingStartMode = "restart", specifiedStartMode = "restart") {
  if (!activeTab?.id || !activeTabIsX) return;
  if (mode === "engagement" && !autoFollowBackOption.checked && !homeFollowMutualOption.checked && !homeReplyMutualOption.checked && !ownPostCommentReplyOption.checked) return;
  startTaskButtons.forEach((button) => { button.disabled = true; });
  try {
    let controller = await checkTaskController(activeTab.id);
    if (controller?.controllerVersion !== 52) {
      taskStatus.textContent = "正在刷新所选 X 页面，以加载新版任务脚本…";
      await chrome.tabs.reload(activeTab.id);
      await waitForTabLoad(activeTab.id);
      controller = await checkTaskController(activeTab.id);
    }
    if (controller?.controllerVersion !== 52) {
      throw new Error("新版任务脚本仍未响应。请确认扩展已重新加载，再刷新 X 页面重试。");
    }
    if ((mode !== "engagement" || autoFollowBackOption.checked) && !controller.identityAvailable) {
      throw new Error("无法识别当前登录账号。请确认 X 已登录并等待页面加载完成。");
    }
    if (mode === "engagement" && !controller.feedSupported) {
      throw new Error("首页互关任务请打开 X 首页；“我的帖子”任务请打开自己发布的帖子详情页。");
    }
    if (mode === "engagement" && ownPostCommentReplyOption.checked && !controller.ownPostReplySupported) {
      throw new Error("请先打开自己发布的帖子详情页，再启动“我的帖子：自动回复他人评论”。");
    }
    const selectedTasks = {
      autoFollowBack: autoFollowBackOption.checked,
      homeFollowMutualPosts: homeFollowMutualOption.checked,
      homeReplyMutualPosts: homeReplyMutualOption.checked,
      ownPostCommentReply: ownPostCommentReplyOption.checked,
      ...Object.fromEntries(Object.entries(relationshipSettingInputs).map(([key, input]) => [key, Number(input.value)]))
      ,followerTargetFollowLimit: Math.min(1000, Math.max(1, Math.floor(Number(document.getElementById("followerTargetFollowLimit")?.value) || 10)))
      ,followerTargetSessionId: mode === "followerTarget" ? Date.now() : null
    };
    const stopped = await chrome.runtime.sendMessage({ type: "stopRankingPool" });
    if (stopped?.error) throw new Error(stopped.error);
    const stoppedSpecified = await chrome.runtime.sendMessage({ type: "stopSpecifiedPool" });
    if (stoppedSpecified?.error) throw new Error(stoppedSpecified.error);
    await chrome.storage.local.set({ automationRunning: false });
    await chrome.tabs.sendMessage(activeTab.id, { type: "taskControl", running: false }).catch(() => {});
    if (mode === "ranking") await prepareRankingJob(controller, rankingStartMode);
    if (mode === "specified") await prepareSpecifiedJob(controller, specifiedStartMode);
    await chrome.storage.local.set({
      ...selectedTasks,
      automationTask: mode,
      automationTargetTabId: activeTab.id,
      automationRunning: true,
      lastAutomationError: "",
      lastAutomationStatus: "任务启动中…"
    });
    const result = await chrome.tabs.sendMessage(activeTab.id, {
      type: "taskControl",
      running: true,
      taskMode: mode,
      settings: selectedTasks
    });
    if (!result?.supported) throw new Error(result?.error || "当前页面不支持此任务");
    await updateTaskStatus();
    taskStatus.textContent = result.status ||
      `任务已启动：当前页 ${result.postCount} 条帖子，其中 ${result.matchCount} 条符合所选任务`;
  } catch (error) {
    await chrome.storage.local.set({ automationRunning: false });
    await updateTaskStatus();
    taskStatus.textContent = `启动失败：${String(error?.message || "内容脚本未响应，请刷新 X 页面后重试。")}`;
    actionStatus.hidden = false;
    actionStatus.textContent = String(error?.message || "扩展与 X 页面连接失败").slice(0, 240);
  }
}

async function checkTaskController(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "taskHandshake" });
  } catch {
    return null;
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("X 页面刷新超时，请确认网络连接后重试。"));
    }, 20000);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(resolve, 500);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 500);
      }
    }).catch((error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

for (const button of startTaskButtons) {
  button.dataset.defaultLabel = button.textContent;
  button.addEventListener("click", () => startTask(button.dataset.startTask, button.dataset.rankingStartMode || "restart", button.dataset.specifiedStartMode || "restart"));
}

for (const option of [autoFollowBackOption, homeFollowMutualOption, homeReplyMutualOption, ownPostCommentReplyOption]) {
  option.addEventListener("change", async () => {
    if (!taskOptionsReady) return;
    await chrome.storage.local.set({
      autoFollowBack: autoFollowBackOption.checked,
      homeFollowMutualPosts: homeFollowMutualOption.checked,
      homeReplyMutualPosts: homeReplyMutualOption.checked,
      ownPostCommentReply: ownPostCommentReplyOption.checked
    });
    await updateTaskStatus();
  });
}

for (const button of stopTaskButtons) {
  button.addEventListener("click", async () => {
    const mode = button.dataset.stopTask;
    const { automationRunning = false, automationTask = "engagement" } = await chrome.storage.local.get({
      automationRunning: false,
      automationTask: "engagement"
    });
    if (!automationRunning || automationTask !== mode) return;
    const stopped = await chrome.runtime.sendMessage({ type: "stopRankingPool" });
    if (stopped?.error) { actionStatus.textContent = stopped.error; actionStatus.hidden = false; return; }
    const stoppedSpecified = await chrome.runtime.sendMessage({ type: "stopSpecifiedPool" });
    if (stoppedSpecified?.error) { actionStatus.textContent = stoppedSpecified.error; actionStatus.hidden = false; return; }
    await chrome.storage.local.set({ automationRunning: false, lastAutomationError: "", lastAutomationStatus: "任务已停止" });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { type: "taskControl", running: false }).catch(() => {});
    }
    await updateTaskStatus();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.followerMonitorStatus || changes.autoFollowBack || changes.automationRunning || changes.automationTask || changes.lastAutomationError || changes.lastAutomationStatus || changes.homeReplyDailyStats || changes.rankingPool || changes.rankingJob || changes.rankingStatus || changes.rankingDailyStats) updateTaskStatus();
  if (changes.followerTargetStats || changes.followerTargetJob || changes.followerTargetStatus || changes.followerTargetFollowLimit) updateFollowerTargetDailyCount();
  if (changes.rankingFailureLog) updateRankingFailures();
});

idleRefreshMinutes.addEventListener("change", () => {
  chrome.storage.local.set({ idleRefreshMinutes: Number(idleRefreshMinutes.value) });
});

document.getElementById("followerTargetFollowLimit")?.addEventListener("change", async (event) => {
  const value = Math.min(1000, Math.max(1, Math.floor(Number(event.target.value) || 10)));
  event.target.value = String(value);
  await chrome.storage.local.set({ followerTargetFollowLimit: value });
});

for (const [key, input] of Object.entries(relationshipSettingInputs)) {
  input.addEventListener("change", async () => {
    const maximum = key.endsWith("IntervalSeconds") ? 3600 : 1000;
    const selected = Math.min(maximum, Math.max(1, Math.floor(Number(input.value) || RELATIONSHIP_SETTING_DEFAULTS[key])));
    input.value = String(selected);
    await chrome.storage.local.set({ [key]: selected });
  });
}

document.getElementById("openX").addEventListener("click", async () => {
  const tab = await chrome.tabs.create({ url: "https://x.com/home" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await updatePageStatus();
  if (tab?.id) {
    targetTabSelect.value = String(tab.id);
    activeTab = tab;
    activeTabIsX = true;
    pageStatus.textContent = `已连接：${tab.title || tab.url}`;
    await updateTaskStatus();
  }
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

updatePageStatus();
loadTaskOptions().then(updateTaskStatus);
scheduleFollowerTargetMidnightRefresh();

const followerTargetSelfCheckButton = document.getElementById("followerTargetSelfCheck");
const followerTargetSelfCheckResult = document.getElementById("followerTargetSelfCheckResult");
if (followerTargetSelfCheckButton && followerTargetSelfCheckResult) {
  followerTargetSelfCheckButton.addEventListener("click", async () => {
    followerTargetSelfCheckResult.hidden = false;
    followerTargetSelfCheckResult.textContent = "正在自检，请稍候…";
    try {
      if (!activeTab?.id || !activeTabIsX) throw new Error("没有检测到打开的 X 标签页。请先打开 X。");
      const result = await chrome.tabs.sendMessage(activeTab.id, { type: "followerTargetSelfCheck" });
      if (!result?.ok) throw new Error(result?.text || "自检无响应");
      followerTargetSelfCheckResult.replaceChildren();
      const textarea = document.createElement("textarea");
      textarea.readOnly = true; textarea.rows = 18; textarea.value = result.text;
      textarea.style.width = "100%"; textarea.style.fontFamily = "monospace"; textarea.style.fontSize = "12px";
      const copyButton = document.createElement("button"); copyButton.type = "button"; copyButton.textContent = "复制结果";
      copyButton.addEventListener("click", async () => { try { await navigator.clipboard.writeText(result.text); } catch { textarea.select(); document.execCommand("copy"); } copyButton.textContent = "已复制"; setTimeout(() => { copyButton.textContent = "复制结果"; }, 1500); });
      followerTargetSelfCheckResult.append("自检结果（可直接复制发给我）：", textarea, copyButton);
    } catch (error) { followerTargetSelfCheckResult.textContent = `自检失败：${String(error?.message || error)}`; }
  });
}
