let rankingTaskBusy = false;
// One initial attempt plus one retry. A second failure skips this author so
// one broken profile cannot hold the whole ranking task.
const RANKING_MAX_ATTEMPTS = 2;
const RANKING_RETRY_DELAY_MS = 15_000;
function rankingPostId(value) {
  const text = String(value || "");
  return text.match(/\/status\/(\d+)/)?.[1] || (/^\d+$/.test(text) ? text : null);
}

async function getRankingHandledPostIds(owner, username, postIds) {
  const state = await chrome.storage.local.get([
    "uncertainReplyPostIds", "repliedPostIds", "rankingHistory",
    `rankingAccount:${owner}:${username}`,
    ...postIds.flatMap((id) => [`replyAttempt:${owner}:${id}`, `rankingReply:${owner}:${id}`])
  ]);
  const handled = new Set([...(state.uncertainReplyPostIds || []), ...(state.repliedPostIds || [])]
    .map(rankingPostId).filter(Boolean));
  // Older releases stored one result per author. Preserve that post's protection,
  // without excluding the author's other posts or future imports.
  for (const prior of [state[`rankingAccount:${owner}:${username}`], state.rankingHistory?.[`${owner}:${username}`]]) {
    const id = rankingPostId(prior?.postId);
    if (id && ["done", "pending", "commented"].includes(prior.state)) handled.add(id);
  }
  for (const id of postIds) {
    const prior = state[`rankingReply:${owner}:${id}`];
    if (state[`replyAttempt:${owner}:${id}`] || ["done", "pending"].includes(prior?.state)) handled.add(id);
  }
  return handled;
}

function rankingTargetUrl(job) {
  const entry = job.queue[job.index];
  if (job.stage === "comment") return `https://x.com/${entry.username}/status/${job.commentPostId}`;
  return `https://x.com/${entry.username}`;
}
async function runRankingTask(generation) {
  if (!rankingWorkerJobKey) {
    const result = await chrome.runtime.sendMessage({ type: "startRankingPool" });
    if (result?.error && isTaskActive(generation)) scheduleErrorRecovery(new Error(result.error), generation);
    return;
  }
  if (rankingTaskBusy) {
    setTimeout(() => {
      if (isTaskActive(generation) && settings.automationTask === "ranking") runRankingTask(generation);
    }, 500);
    return;
  }
  rankingTaskBusy = true;
  const active = () => isTaskActive(generation) && settings.automationTask === "ranking";
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!active()) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    }
    return active();
  };
  let job;
  const status = async (text) => {
    if (active()) {
      const entry = job?.queue?.[job.index];
      await chrome.runtime.sendMessage({
        type: "rankingWorkerStatus",
        jobKey: rankingWorkerJobKey,
        status: entry?.username ? `@${entry.username}：${text}` : text,
        completed: Math.min(job?.queue?.length || 0, Math.max(0, Number(job?.index) || 0)),
        total: job?.queue?.length || 0
      });
    }
  };
  const save = () => chrome.storage.local.set({ [rankingWorkerJobKey]: job });
  const recordFailure = async (entry, reason, attempts = 1) => {
    if (!entry?.username) return;
    await chrome.runtime.sendMessage({ type: "rankingWorkerFailure", jobKey: rankingWorkerJobKey, failure: {
      rank: entry.rank, username: entry.username, stage: job.stage === "comment" ? "评论发送" : "帖子识别",
      reason: String(reason || "未记录原因").replace(/^跳过\s*@[^：:]+[：:]?\s*/, "").slice(0, 300), attempts, createdAt: Date.now()
    }});
  };
  const record = async (entry, value) => {
    const postId = rankingPostId(value.postId || job.commentPostId);
    if (!postId) return;
    await chrome.storage.local.set({ [`rankingReply:${job.owner}:${postId}`]: { ...value, postId, author: entry.username, updatedAt: Date.now() } });
  };
  const advance = async (reason) => {
    if (/^跳过/.test(String(reason || ""))) await recordFailure(job.queue[job.index], reason, Math.max(1, Number(job.retryCounts?.[job.queue[job.index]?.username?.toLowerCase()]) || 1));
    await status(reason);
    const current = job.queue[job.index];
    if (current?.username && job.retryCounts) delete job.retryCounts[current.username.toLowerCase()];
    job.index += 1;
    job.stage = "posts";
    job.posts = [];
    job.commentPostId = null;
    job.retryAt = Date.now() + job.interval * 1000;
    await save();
    await status(job.index >= job.queue.length ? "本路已完成，断点已保存" : "已保存断点，准备处理下一位");
  };
  try {
    job = (await chrome.storage.local.get(rankingWorkerJobKey))[rankingWorkerJobKey];
    if (!job?.queue?.length) throw new Error("榜单队列为空，请重新导入并启动");
    if (job.selectionVersion !== 3 || job.stage === "follow") {
      job.stage = "posts";
      job.commentPostId = null;
      job.selectionVersion = 3;
      await save();
    }
    if (!job.retryCounts || typeof job.retryCounts !== "object") {
      job.retryCounts = {};
      await save();
    }
    while (active()) {
      if (job.index >= job.queue.length) {
        await status("榜单任务已完成，所有导入账号均已检查");
        await chrome.runtime.sendMessage({ type: "rankingWorkerDone", jobKey: rankingWorkerJobKey, status: "本路账号已全部检查" });
        updateTaskState(false);
        return;
      }
      if (Date.now() < job.retryAt && !await pause(job.retryAt - Date.now())) return;
      const entry = job.queue[job.index];
      const target = rankingTargetUrl(job);
      if (location.pathname.toLowerCase() !== new URL(target).pathname.toLowerCase()) {
        await save();
        if (active()) location.assign(target);
        return;
      }
      await status(`榜单 ${job.index + 1}/${job.queue.length}：正在检查 @${entry.username}`);
      const identity = await waitForElement(() => getCurrentUsername() || null, 15000);
      if (!active()) return;
      if (identity !== job.owner) throw new Error("当前登录账号与启动时不一致，请切回原账号");
      if (job.stage === "posts") {
        await status(`正在选择 @${entry.username} 最近一条未评论的帖子`);
        const samples = await collectRankingSamples(entry.username, active, pause);
        if (!active()) return;
        const handled = await getRankingHandledPostIds(job.owner, entry.username, samples.map((post) => post.id));
        const latest = samples.find((post) => !handled.has(post.id));
        if (!latest) {
          await advance(`跳过 @${entry.username}：已加载帖子中没有可评论且未处理的帖子`);
          continue;
        }
        job.commentPostId = latest.id;
        job.stage = "comment";
        await save();
        location.assign(rankingTargetUrl(job));
        return;
      }
      if (job.stage === "comment") {
        const article = await waitForElement(() => getPostContainers().find((post) => getPostId(post)?.match(/\/status\/(\d+)/)?.[1] === job.commentPostId && getAuthor(post) === entry.username), 15000);
        if (!active()) return;
        if (!article) throw new Error("未加载到目标博主的帖子");
        const handled = await getRankingHandledPostIds(job.owner, entry.username, [job.commentPostId]);
        if (handled.has(job.commentPostId)) {
          await advance(`跳过 @${entry.username}：目标帖子已有评论或发送尝试记录`);
          continue;
        }
        const result = await chrome.runtime.sendMessage({ type: "generateDraft", postText: findPostText(article), replyContext: "timeline_influencer" });
        if (!active()) return;
        if (result?.error || !result?.draft) throw new Error(result?.error || "未生成评论内容");
        if (result.draft === "[SKIP]") {
          await advance(`跳过 @${entry.username}：内容不适合回复`);
          continue;
        }
        if (!hasMeaningfulReplyText(result.draft)) {
          await advance(`跳过 @${entry.username}：模型只返回了标点或表情，已阻止发送`);
          continue;
        }
        const sent = await sendReplyToPost(article, result.draft, generation, {
          inline: true,
          strict: true,
          beforeSend: () => record(entry, { state: "pending", postId: job.commentPostId })
        });
        if (!active()) return;
        if (sent === false) { await advance(`跳过 @${entry.username}：未确认评论发送`); continue; }
        await chrome.runtime.sendMessage({
          type: "rankingWorkerCommentSuccess",
          jobKey: rankingWorkerJobKey,
          commentKey: `${job.owner}:${job.commentPostId}`
        });
        await record(entry, { state: "done", postId: job.commentPostId });
        await advance(`已确认评论成功 @${entry.username}，进入下一位`);
        continue;
      }
    }
  } catch (error) {
    if (!active()) return;
    const message = String(error?.message || error).slice(0, 180);
    if (!job || job.index >= job.queue.length) {
      await status(`${message}；本路任务无法继续`);
      return;
    }
    const entry = job.queue[job.index];
    const retryKey = entry?.username?.toLowerCase() || `index-${job.index}`;
    job.retryCounts = job.retryCounts || {};
    const attempts = Math.max(0, Number(job.retryCounts[retryKey]) || 0) + 1;
    job.retryCounts[retryKey] = attempts;
    if (attempts >= RANKING_MAX_ATTEMPTS) {
      await record(entry, { state: "skipped", reason: message });
      await advance(`跳过 @${entry.username}：连续 ${attempts} 次无法识别或加载，避免任务卡住`);
      if (job.index < job.queue.length) {
        location.assign(rankingTargetUrl(job));
      } else {
        await chrome.runtime.sendMessage({ type: "rankingWorkerDone", jobKey: rankingWorkerJobKey, status: "本路账号已全部检查" });
        updateTaskState(false);
      }
      return;
    }
    const remaining = RANKING_MAX_ATTEMPTS - attempts;
    await status(`${message}；第 ${attempts}/${RANKING_MAX_ATTEMPTS} 次失败，${RANKING_RETRY_DELAY_MS / 1000} 秒后重试，剩余 ${remaining} 次`);
    job.retryAt = Date.now() + RANKING_RETRY_DELAY_MS;
    await save();
    if (await pause(RANKING_RETRY_DELAY_MS)) location.assign(rankingTargetUrl(job));
  } finally { rankingTaskBusy = false; }
}

async function collectRankingSamples(username, active, pause) {
  const samples = new Map();
  await waitForElement(() => document.querySelector('article[data-testid="tweet"]'), 12000);
  for (let page = 0; page < 4 && active(); page += 1) {
    for (const article of getPostContainers()) {
      if (getAuthor(article) !== username) continue;
      const time = getOuterPostTime(article);
      const timestamp = Date.parse(time?.getAttribute("datetime") || "");
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      if (!id || !Number.isFinite(timestamp) || timestamp > Date.now()) continue;
      const reply = article.querySelector('[data-testid="reply"]');
      if (!reply || reply.disabled || reply.getAttribute("aria-disabled") === "true") continue;
      const text = findPostText(article);
      if (!text) continue;
      const context = article.innerText || "";
      const textStart = context.indexOf(text);
      const header = textStart >= 0 ? context.slice(0, textStart) : "";
      samples.set(id, { id, author: username, date: new Date(timestamp).toISOString(), text: text.slice(0, 1800), header: header.slice(0, 1000), context: context.slice(0, 3000) });
    }
    if (samples.size >= 20) break;
    window.scrollBy({ top: Math.max(600, window.innerHeight), behavior: "instant" });
    if (!await pause(1500)) break;
  }
  return [...samples.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
