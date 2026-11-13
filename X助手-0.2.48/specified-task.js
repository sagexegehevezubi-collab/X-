let specifiedTaskBusy = false;
const SPECIFIED_MAX_ATTEMPTS = 3;
const SPECIFIED_RETRY_DELAY_MS = 15_000;
const SPECIFIED_PRIMARY_WINDOW_MS = 2 * 60 * 60 * 1000;
const SPECIFIED_FALLBACK_WINDOW_MS = 4 * 60 * 60 * 1000;
const SPECIFIED_CANDIDATE_LIMIT = 5;

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
  const recordAuthorFailure = async (entry, reason, postId = "") => {
    job.authorFailureRecorded = job.authorFailureRecorded && typeof job.authorFailureRecorded === "object" ? job.authorFailureRecorded : {};
    const key = String(entry.username || "").toLowerCase();
    if (job.authorSucceeded?.[key] || job.authorFailureRecorded[key]) return;
    job.authorFailureRecorded[key] = true;
    await chrome.runtime.sendMessage({
      type: "specifiedWorkerFailure",
      jobKey: specifiedWorkerJobKey,
      username: entry.username,
      postId,
      stage: "博主未成功评论",
      reason: String(reason || "本轮没有成功评论").slice(0, 240),
      attempts: Math.max(1, Number(job.retryCounts?.[`${key}:author`]) || 1),
      scope: "author"
    });
  };
  const moveNext = async (reason, forceAuthor = false) => {
    if (job.stage === "comment" && !forceAuthor) {
      job.postIndex += 1;
      if (job.postIndex < job.posts.length) {
        job.stage = "comment";
        job.retryAt = Date.now() + job.interval * 1000;
      } else {
        const entry = job.queue[job.index];
        if (entry && !job.authorSucceeded?.[String(entry.username).toLowerCase()]) {
          await recordAuthorFailure(entry, job.authorFailureReason || "候选帖子均未成功评论", job.posts.at(-1)?.id || "");
        }
        job.index += 1;
        job.posts = [];
        job.postIndex = 0;
        job.stage = "posts";
        job.retryAt = Date.now() + job.authorInterval * 1000;
      }
    } else {
      const entry = job.queue[job.index];
      if (entry && !job.authorSucceeded?.[String(entry.username).toLowerCase()]) {
        await recordAuthorFailure(entry, reason || "没有成功评论", "");
      }
      job.index += 1;
      job.posts = [];
      job.postIndex = 0;
      job.stage = "posts";
      job.retryAt = Date.now() + job.authorInterval * 1000;
    }
    await status(reason);
    await save();
  };
  const finish = async () => {
    await status("指定博主任务已完成");
    await chrome.runtime.sendMessage({ type: "specifiedWorkerDone", jobKey: specifiedWorkerJobKey, status: "本路指定博主已全部检查" });
  };
  try {
    job = (await chrome.storage.local.get(specifiedWorkerJobKey))[specifiedWorkerJobKey];
    if (!job?.queue?.length) throw new Error("指定博主队列为空，请重新填写并启动");
    job.retryCounts = job.retryCounts && typeof job.retryCounts === "object" ? job.retryCounts : {};
    job.authorSucceeded = job.authorSucceeded && typeof job.authorSucceeded === "object" ? job.authorSucceeded : {};
    job.authorCommentCounts = job.authorCommentCounts && typeof job.authorCommentCounts === "object" ? job.authorCommentCounts : {};
    for (const [authorKey, succeeded] of Object.entries(job.authorSucceeded)) {
      if (succeeded) job.authorCommentCounts[authorKey] = Math.max(1, Number(job.authorCommentCounts[authorKey]) || 0);
    }
    job.authorFailureRecorded = job.authorFailureRecorded && typeof job.authorFailureRecorded === "object" ? job.authorFailureRecorded : {};
    job.interval = Math.max(20, Number(job.interval) || 20);
    job.authorInterval = Math.max(20, Number(job.authorInterval) || 30);
    job.perAuthorLimit = Math.min(5, Math.max(1, Number(job.perAuthorLimit) || 1));
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
      const authorKey = String(entry.username || "").toLowerCase();
      const trackedSuccessCount = Math.max(0, Number(job.authorCommentCounts[authorKey]) || 0);
      if (trackedSuccessCount >= job.perAuthorLimit) {
        job.authorCommentCounts[authorKey] = trackedSuccessCount;
        job.authorSucceeded[authorKey] = true;
        await moveNext(`跳过 @${entry.username}：已达到每位博主最多 ${job.perAuthorLimit} 条成功评论`, true);
        continue;
      }
      if (job.stage === "posts") {
        job.authorFailureReason = "";
        await status(`正在读取最近 2 小时内的帖子；没有合适内容时扩大到 4 小时`);
        const samples = await collectSpecifiedSamples(entry.username, Math.max(SPECIFIED_CANDIDATE_LIMIT, job.perAuthorLimit), active, pause);
        if (!active()) return;
        const available = [];
        for (const post of samples) {
          const key = `specifiedReply:${job.owner}:${entry.username}:${post.id}`;
          const saved = (await chrome.storage.local.get(key))[key];
          if (!saved) available.push(post);
        }
        if (!available.length) {
          await moveNext(`跳过 @${entry.username}：2 至 4 小时内也没有新的可评论帖子`);
          continue;
        }
        const now = Date.now();
        const primary = available.filter((post) => now - Date.parse(post.date) <= SPECIFIED_PRIMARY_WINDOW_MS);
        const fallback = available.filter((post) => now - Date.parse(post.date) > SPECIFIED_PRIMARY_WINDOW_MS);
        available.splice(0, available.length, ...primary, ...fallback);
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
        if (!Number.isFinite(Date.parse(post.date)) || Date.now() - Date.parse(post.date) > SPECIFIED_FALLBACK_WINDOW_MS) {
          await recordPost(entry, post, { state: "skipped", reason: "帖子已超过 4 小时" });
          job.authorFailureReason = "候选帖子已超过 4 小时";
          await moveNext(`跳过 @${entry.username}：目标帖子已超过 4 小时`);
          continue;
        }
        const article = await waitForElement(() => getPostContainers().find((item) =>
          getPostId(item)?.match(/\/status\/(\d+)/)?.[1] === post.id && getAuthor(item) === entry.username), 15000);
        if (!active()) return;
        if (!article) throw new Error("未加载到目标帖子");
        const key = `specifiedReply:${job.owner}:${entry.username}:${post.id}`;
        const prior = (await chrome.storage.local.get(key))[key];
        if (prior) {
          await moveNext(`跳过 @${entry.username}：该帖子已有处理记录`);
          continue;
        }
        const articleText = findPostText(article) || post.text || "";
        const result = await chrome.runtime.sendMessage({ type: "generateDraft", postText: articleText, replyContext: "timeline_influencer" });
        if (!active()) return;
        if (result?.error || !result?.draft) throw new Error(result?.error || "未生成评论内容");
        if (result.draft === "[SKIP]") {
          const reason = result.reason ? `模型跳过：${result.reason}` : "模型跳过：内容不适合回复";
          await recordPost(entry, post, { state: "skipped", reason });
          job.authorFailureReason = reason;
          await moveNext(`跳过 @${entry.username} 的一条帖子：${reason}`);
          continue;
        }
        if (Date.now() - Date.parse(post.date) > SPECIFIED_FALLBACK_WINDOW_MS) {
          await recordPost(entry, post, { state: "skipped", reason: "生成回复期间帖子已超过 4 小时" });
          job.authorFailureReason = "生成回复期间帖子已超过 4 小时";
          await moveNext(`跳过 @${entry.username}：生成回复期间帖子已超过 4 小时`);
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
          job.authorFailureReason = "未确认评论发送";
          await moveNext(`跳过 @${entry.username} 的一条帖子：未确认评论发送`);
          continue;
        }
        await chrome.runtime.sendMessage({ type: "specifiedWorkerCommentSuccess", jobKey: specifiedWorkerJobKey, commentKey: `${job.owner}:${entry.username}:${post.id}`, author: entry.username });
        const successKey = String(entry.username).toLowerCase();
        const successCount = (Number(job.authorCommentCounts[successKey]) || 0) + 1;
        job.authorCommentCounts[successKey] = successCount;
        job.authorSucceeded[successKey] = true;
        job.authorFailureReason = "";
        await recordPost(entry, post, { state: "done" });
        const reachedLimit = successCount >= job.perAuthorLimit;
        await moveNext(
          reachedLimit
            ? `已评论 @${entry.username}（${successCount}/${job.perAuthorLimit}），达到该博主上限`
            : `已评论 @${entry.username}（${successCount}/${job.perAuthorLimit}），继续尝试候选帖子`,
          reachedLimit
        );
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
      await chrome.runtime.sendMessage({
        type: "specifiedWorkerFailure",
        jobKey: specifiedWorkerJobKey,
        username: entry.username,
        postId: post?.id || "",
        stage: post ? "帖子评论" : "主页加载",
        reason: message,
        attempts
      });
      job.authorFailureReason = message;
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
  for (let page = 0; page < 8 && active(); page += 1) {
    const containers = [...new Set([
      ...getPostContainers(),
      ...document.querySelectorAll('article[data-testid="tweet"], [data-testid="tweet"]')
    ])];
    for (const article of containers) {
      if (getAuthor(article) !== username) continue;
      if (!isSpecifiedOriginalPost(article)) continue;
      const time = getOuterPostTime(article);
      const timestamp = Date.parse(time?.getAttribute("datetime") || "");
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      if (!id || !Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp > SPECIFIED_FALLBACK_WINDOW_MS) continue;
      const age = Date.now() - timestamp;
      if (age > SPECIFIED_FALLBACK_WINDOW_MS) continue;
      const text = findPostText(article) || [...article.querySelectorAll('img[alt], video[aria-label], [data-testid="tweetPhoto"]')]
        .map((node) => node.getAttribute("alt") || node.getAttribute("aria-label") || "")
        .filter(Boolean).join(" ");
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
