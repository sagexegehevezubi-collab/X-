let specifiedTaskBusy = false;
const SPECIFIED_MAX_ATTEMPTS = 3;
const SPECIFIED_RETRY_DELAY_MS = 15_000;
const SPECIFIED_RECENT_WINDOW_MS = 4 * 60 * 60 * 1000;

function specifiedTargetUrl(job) {
  const entry = job.queue[job.index];
  const post = job.posts?.[job.postIndex];
  return job.stage === "comment" && post
    ? `https://x.com/${entry.username}/status/${post.id}`
    : `https://x.com/${entry.username}`;
}

async function runSpecifiedTask(generation) {
  if (!specifiedWorkerJobKey) {
    const result = await chrome.runtime.sendMessage({ type: "startSpecifiedPool" });
    if (result?.error && isTaskActive(generation)) scheduleErrorRecovery(new Error(result.error), generation);
    return;
  }
  if (specifiedTaskBusy) {
    setTimeout(() => {
      if (isTaskActive(generation) && settings.automationTask === "specified") runSpecifiedTask(generation);
    }, 500);
    return;
  }
  specifiedTaskBusy = true;
  const active = () => isTaskActive(generation) && settings.automationTask === "specified";
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
    if (!active()) return;
    const entry = job?.queue?.[job.index];
    const postCount = job?.posts?.length || 0;
    await chrome.runtime.sendMessage({
      type: "specifiedWorkerStatus",
      jobKey: specifiedWorkerJobKey,
      status: entry?.username ? `@${entry.username}：${text}` : text,
      completed: Math.min(job?.queue?.length || 0, Math.max(0, Number(job?.index) || 0)),
      total: job?.queue?.length || 0,
      postCount,
      postIndex: Math.min(postCount, Math.max(0, Number(job?.postIndex) || 0))
    });
  };
  const save = () => chrome.storage.local.set({ [specifiedWorkerJobKey]: job });
  const recordPost = (entry, post, value) => chrome.storage.local.set({
    [`specifiedReply:${job.owner}:${entry.username}:${post.id}`]: { ...value, postId: post.id, updatedAt: Date.now() }
  });
  const moveNext = async (reason) => {
    await status(reason);
    if (job.stage === "comment") {
      job.postIndex += 1;
      if (job.postIndex < job.posts.length) {
        job.stage = "comment";
        job.retryAt = Date.now() + job.interval * 1000;
      } else {
        job.index += 1;
        job.posts = [];
        job.postIndex = 0;
        job.stage = "posts";
        job.retryAt = Date.now() + job.interval * 1000;
      }
    } else {
      job.index += 1;
      job.posts = [];
      job.postIndex = 0;
      job.stage = "posts";
      job.retryAt = Date.now() + job.interval * 1000;
    }
    await save();
  };
  const finish = async () => {
    await status("指定博主任务已完成");
    await chrome.runtime.sendMessage({ type: "specifiedWorkerDone", jobKey: specifiedWorkerJobKey, status: "本路指定博主已全部检查" });
    updateTaskState(false);
  };
  try {
    job = (await chrome.storage.local.get(specifiedWorkerJobKey))[specifiedWorkerJobKey];
    if (!job?.queue?.length) throw new Error("指定博主队列为空，请重新填写并启动");
    job.retryCounts = job.retryCounts && typeof job.retryCounts === "object" ? job.retryCounts : {};
    if (!Array.isArray(job.posts)) job.posts = [];
    if (!Number.isInteger(job.postIndex)) job.postIndex = 0;
    await save();
    while (active()) {
      if (job.index >= job.queue.length) { await finish(); return; }
      if (Date.now() < job.retryAt && !await pause(job.retryAt - Date.now())) return;
      const entry = job.queue[job.index];
      const target = specifiedTargetUrl(job);
      if (location.pathname.toLowerCase() !== new URL(target).pathname.toLowerCase()) {
        await save();
        if (active()) location.assign(target);
        return;
      }
      await status(`正在处理第 ${job.index + 1}/${job.queue.length} 位指定博主`);
      const identity = await waitForElement(() => getCurrentUsername() || null, 15000);
      if (!active()) return;
      if (identity !== job.owner) throw new Error("当前登录账号与启动时不一致");
      if (job.stage === "posts") {
        await status(`正在读取最近 4 小时内的原创帖子（最多 ${job.perAuthorLimit} 条）`);
        const samples = await collectSpecifiedSamples(entry.username, job.perAuthorLimit, active, pause);
        if (!active()) return;
        const available = [];
        for (const post of samples) {
          const key = `specifiedReply:${job.owner}:${entry.username}:${post.id}`;
          const saved = (await chrome.storage.local.get(key))[key];
          if (!saved || saved.state !== "done" && saved.state !== "pending") available.push(post);
        }
        if (!available.length) {
          await moveNext(`跳过 @${entry.username}：最近 4 小时没有新的可评论原创帖子`);
          continue;
        }
        job.posts = available;
        job.postIndex = 0;
        job.stage = "comment";
        await save();
        location.assign(specifiedTargetUrl(job));
        return;
      }
      if (job.stage === "comment") {
        const post = job.posts[job.postIndex];
        if (!post) { job.stage = "posts"; await save(); continue; }
        const article = await waitForElement(() => getPostContainers().find((item) =>
          getPostId(item)?.match(/\/status\/(\d+)/)?.[1] === post.id && getAuthor(item) === entry.username), 15000);
        if (!active()) return;
        if (!article) throw new Error("未加载到目标帖子");
        const key = `specifiedReply:${job.owner}:${entry.username}:${post.id}`;
        const prior = (await chrome.storage.local.get(key))[key];
        if (prior?.state === "done" || prior?.state === "pending") {
          await moveNext(`跳过 @${entry.username}：该帖子已有处理记录`);
          continue;
        }
        const result = await chrome.runtime.sendMessage({ type: "generateDraft", postText: findPostText(article), replyContext: "timeline_influencer" });
        if (!active()) return;
        if (result?.error || !result?.draft) throw new Error(result?.error || "未生成评论内容");
        if (result.draft === "[SKIP]") {
          await recordPost(entry, post, { state: "skipped", reason: "内容不适合回复" });
          await moveNext(`跳过 @${entry.username} 的一条帖子：内容不适合回复`);
          continue;
        }
        const sent = await sendReplyToPost(article, result.draft, generation, {
          inline: true,
          strict: true,
          beforeSend: () => recordPost(entry, post, { state: "pending" })
        });
        if (!active()) return;
        if (sent === false) {
          await recordPost(entry, post, { state: "skipped", reason: "未确认评论发送" });
          await moveNext(`跳过 @${entry.username} 的一条帖子：未确认评论发送`);
          continue;
        }
        await chrome.runtime.sendMessage({ type: "specifiedWorkerCommentSuccess", jobKey: specifiedWorkerJobKey, commentKey: `${job.owner}:${entry.username}:${post.id}`, author: entry.username });
        await recordPost(entry, post, { state: "done" });
        await moveNext(`已评论 @${entry.username}（${job.postIndex + 1}/${job.posts.length}）`);
      }
    }
  } catch (error) {
    if (!active()) return;
    const message = String(error?.message || error).slice(0, 180);
    if (!job || job.index >= job.queue.length) { await status(`${message}；本路任务无法继续`); return; }
    const entry = job.queue[job.index];
    const post = job.stage === "comment" ? job.posts?.[job.postIndex] : null;
    const retryKey = `${entry.username.toLowerCase()}:${post?.id || "profile"}`;
    const attempts = Math.max(0, Number(job.retryCounts[retryKey]) || 0) + 1;
    job.retryCounts[retryKey] = attempts;
    if (attempts >= SPECIFIED_MAX_ATTEMPTS) {
      if (post) await recordPost(entry, post, { state: "skipped", reason: message });
      await moveNext(`跳过 @${entry.username}${post ? " 的一条帖子" : ""}：连续 ${attempts} 次失败，避免任务卡住`);
      if (job.index < job.queue.length) { location.assign(specifiedTargetUrl(job)); return; }
      await finish();
      return;
    }
    await status(`${message}；第 ${attempts}/${SPECIFIED_MAX_ATTEMPTS} 次失败，${SPECIFIED_RETRY_DELAY_MS / 1000} 秒后重试`);
    job.retryAt = Date.now() + SPECIFIED_RETRY_DELAY_MS;
    await save();
    if (await pause(SPECIFIED_RETRY_DELAY_MS)) location.assign(specifiedTargetUrl(job));
  } finally { specifiedTaskBusy = false; }
}

async function collectSpecifiedSamples(username, limit, active, pause) {
  const samples = new Map();
  const first = await waitForElement(() => document.querySelector('article[data-testid="tweet"]'), 12000);
  if (!first) return [];
  for (let page = 0; page < 5 && active(); page += 1) {
    for (const article of getPostContainers()) {
      if (getAuthor(article) !== username) continue;
      if (!isSpecifiedOriginalPost(article)) continue;
      const time = getOuterPostTime(article);
      const timestamp = Date.parse(time?.getAttribute("datetime") || "");
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      if (!id || !Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp > SPECIFIED_RECENT_WINDOW_MS) continue;
      const reply = article.querySelector('[data-testid="reply"]');
      if (!reply || reply.disabled || reply.getAttribute("aria-disabled") === "true") continue;
      const text = findPostText(article);
      if (!text) continue;
      samples.set(id, { id, author: username, date: new Date(timestamp).toISOString(), text: text.slice(0, 1800) });
    }
    if (samples.size >= limit) break;
    window.scrollBy({ top: Math.max(600, window.innerHeight), behavior: "instant" });
    if (!await pause(1200)) break;
  }
  return [...samples.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
}

function isSpecifiedOriginalPost(article) {
  const postText = findPostText(article);
  const fullText = String(article.innerText || "").replace(/\s+/g, " ").trim();
  const firstText = postText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const firstTextIndex = firstText ? fullText.indexOf(firstText) : -1;
  const headerText = firstTextIndex >= 0 ? fullText.slice(0, firstTextIndex) : fullText.slice(0, 260);
  const socialText = [...article.querySelectorAll('[data-testid="socialContext"]')]
    .map((node) => node.innerText || node.getAttribute("aria-label") || "")
    .join(" ");
  const markerText = `${socialText} ${headerText}`;
  return !/(?:回复了|回复给|回复于|转发|转推|被转发|replied to|replying to|reposted|retweeted)/i.test(markerText);
}
