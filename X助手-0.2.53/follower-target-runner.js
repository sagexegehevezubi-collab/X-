// 关注优先：成功关注之间40～50秒；单账号90秒、可选评论最多40秒，跨导航保存。
async function runFollowerTargetTask(generation) {
  if (followerTargetBusy) return;
  followerTargetBusy = true;
  let job, epoch, interrupted = false, navigating = false, watchdogBusy = false;
  let requestId = null;
  const active = () => !interrupted && !followerTargetNetworkPaused &&
    (epoch == null || followerTargetObservedEpoch == null || epoch === followerTargetObservedEpoch) &&
    isTaskActive(generation) && settings.automationTask === "followerTarget";
  const assertActive = async () => {
    if (!active() || (job && getCurrentUsername() !== job.owner)) throw new Error("当前任务已失效或登录账号发生变化");
    const state = await chrome.storage.local.get(["automationRunning", "automationTask", "followerTargetSessionId", "followerTargetRecoveryEpoch"]);
    if (!active() || !state.automationRunning || state.automationTask !== "followerTarget" ||
        state.followerTargetSessionId !== job.sessionId || (state.followerTargetRecoveryEpoch || 0) !== epoch)
      throw new Error("旧执行流程已作废，禁止继续操作");
    const expired = ftExpired(job);
    if (expired) { const error = new Error(expired === "comment" ? "评论达到截止时间（最多40秒）" : expired === "account" ? "当前账号处理超过90秒" : "当前阶段达到截止时间"); error.code = "FT_EXPIRED"; throw error; }
  };
  const save = async () => {
    ftTouchStage(job);
    await assertActive();
    await chrome.storage.local.set({ followerTargetJob: job, followerTargetLeaseAt: Date.now() });
  };
  const status = async (text) => {
    if (!active()) return;
    await chrome.storage.local.set({ followerTargetStatus: text, lastAutomationStatus: text,
      lastAutomationError: "", followerTargetLeaseAt: Date.now() });
  };
  const cancelModel = () => {
    if (requestId) chrome.runtime.sendMessage({ type: "cancelFollowerTargetDraft", requestId, sessionId: job?.sessionId }).catch(() => {});
  };
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until && active()) {
      await assertActive();
      await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
    }
    return active();
  };
  const navigate = async (text, sourceChange = false) => {
    await save();
    const home = job.stage === "home" || sourceChange;
    const ms = home ? ftRandomMs(FT_POLICY.sourceMinMs, FT_POLICY.sourceMaxMs) :
      ftRandomMs(FT_POLICY.navigationMinMs, FT_POLICY.navigationMaxMs);
    await status(`${text}，${Math.ceil(ms / 1000)}秒后继续`);
    if (!await pause(ms)) return;
    await assertActive();
    navigating = true;
    location.assign(ftContentJobUrl(job));
  };
  const pageReady = async (predicate, timeoutMs, text) => {
    const until = Date.now() + timeoutMs;
    await status(text);
    while (active()) {
      await assertActive();
      if (document.readyState !== "loading" && document.querySelector('[data-testid="primaryColumn"]') && predicate()) return true;
      if (Date.now() >= until || !await pause(Math.min(250, until - Date.now()))) return false;
    }
    return false;
  };
  const healthAfterFailure = async () => {
    const result = await followerTargetRuntimeMessage({ type: "followerTargetHealth", sessionId: job.sessionId }, 10000);
    if (!active() || !result?.ok) { interrupted = true; return false; }
    return true;
  };
  const finish = async (reason, abandoned = false) => {
    await assertActive();
    if (job.candidateUsername) await recordCandidateVerdict(job.candidateUsername, null, reason);
    if (abandoned) job.metrics.abandoned += 1;
    ftNextCandidate(job);
    const { followerTargetFollowLimit = 10 } = await chrome.storage.local.get({ followerTargetFollowLimit: 10 });
    if (job.sessionFollowCount >= Number(followerTargetFollowLimit)) {
      job.metrics.finishedAt = Date.now();
      await save();
      await chrome.storage.local.set({ automationRunning: false,
        followerTargetStatus: `已成功关注 ${job.sessionFollowCount} 人，任务完成；${reason}`,
        lastAutomationStatus: `已成功关注 ${job.sessionFollowCount} 人，任务完成` }); return;
    }
    await navigate(reason);
  };
  const failComment = async (error, phase = "comment") => {
    cancelModel();
    if (!active()) return;
    const candidate = job.candidateUsername;
    const reason = String(error?.message || error || "评论未成功").replace(/\s+/g, " ").slice(0, 240);
    await recordFollowerTargetCommentFailure({ candidate, postId: job.candidatePosts?.[0]?.id,
      attempt: 1, phase, reason, followed: true });
    await chrome.storage.local.set({ followerTargetLastCommentError: `@${candidate}（单次，${phase}）：${reason}` });
    await finish(`已关注，放弃评论：${reason}`, true);
  };
  const recoverExpired = async () => {
    if (watchdogBusy || !active()) return;
    watchdogBusy = true;
    interrupted = true; cancelModel();
    // 后台可在浏览器错误页上继续；失效代次会立即阻止迟到模型、关注和发送。
    await followerTargetRuntimeMessage({ type: "followerTargetHealth", sessionId: job?.sessionId,
      recoverExpired: true }, 12000).catch(() => {});
  };
  const watchdog = setInterval(() => {
    if (job && !navigating && active() && ftExpired(job)) recoverExpired().catch(() => {});
  }, 1000);
  try {
    const state = await chrome.storage.local.get({ followerTargetFollowLimit: 10, followerTargetSessionId: null,
      followerTargetRecoveryEpoch: 0, followerTargetRecovery: null, followerTargetJob: null });
    epoch = state.followerTargetRecoveryEpoch;
    followerTargetObservedEpoch = epoch; followerTargetObservedSession = state.followerTargetSessionId;
    followerTargetNetworkPaused = state.followerTargetRecovery?.waiting === true &&
      state.followerTargetRecovery.sessionId === state.followerTargetSessionId;
    if (!active()) return;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(state.followerTargetFollowLimit) || 10)));
    job = state.followerTargetJob?.sessionId === state.followerTargetSessionId ? state.followerTargetJob : null;
    if (job) ftTouchStage(job);
    const owner = await waitForElement(() => getCurrentUsername() || null, FOLLOWER_TARGET_PROFILE_TIMEOUT_MS);
    if (!active()) return;
    if (!owner) { await status("等待识别登录账号，进度已保存；后台将检查网络并恢复"); return; }
    if (job && job.owner !== owner) {
      await chrome.storage.local.set({ automationRunning: false, followerTargetStatus: "登录账号与任务账号不一致，已停止", lastAutomationStatus: "登录账号与任务账号不一致，已停止" });
      return;
    }
    if (!job) job = { owner, sessionId: state.followerTargetSessionId, stage: "home", sourceAuthor: null,
      sourceFollowCount: 0, sessionFollowCount: 0, lastFollowAt: 0, candidateIndex: 0, candidateBatch: [],
      candidatesSeen: [], candidatesScanned: [], candidateScores: {}, sourceAuthorsSeen: [] };
    ftTouchStage(job);
    if (ftExpired(job)) { await recoverExpired(); return; }
    await save();
    while (active() && !navigating) {
      await assertActive();
      const page = followerTargetStageOf(), pathUser = followerTargetUsernameFromPath();
      await chrome.storage.local.set({ followerTargetHeartbeat: `stage=${job.stage} 页面=${page} 来源=${job.sourceAuthor || "-"} 候选=${job.candidateUsername || "-"} 批次=${job.candidateIndex}/${job.candidateBatch.length} 来源关注=${job.sourceFollowCount || 0}/5`, followerTargetHeartbeatAt: Date.now() });
      // 达到关注上限后允许最后一个新关注账号完成其唯一一次可选评论。
      if ((job.sessionFollowCount || 0) >= limit && job.stage !== "comment") {
        job.metrics.finishedAt = Date.now(); await save();
        await chrome.storage.local.set({ automationRunning: false,
          followerTargetStatus: `已成功关注 ${job.sessionFollowCount}/${limit} 人，任务完成`, lastAutomationStatus: `已成功关注 ${job.sessionFollowCount}/${limit} 人，任务完成` }); return;
      }
      if (job.cooldownUntil) {
        if (job.cooldownUntil > Date.now()) { await status("X关注限速冷却中，保留进度"); if (!await pause(Math.min(30000, job.cooldownUntil - Date.now()))) return; continue; }
        job.cooldownUntil = 0; ftTouchAccount(job, Date.now(), true); ftTouchStage(job, Date.now(), true); await save();
      }
      if (job.stage === "home") {
        if (page !== "home") { await navigate("返回首页寻找新来源"); return; }
        if (!await pageReady(() => getPostContainers().length > 0, 12000, "等待首页时间线就绪")) {
          if (!await healthAfterFailure()) return;
          await navigate("首页内容未就绪，重新加载时间线"); return;
        }
        const source = followerTargetV241SourcePost(job);
        if (!source) { await status("正在扫描首页新的互关关键词帖子"); window.scrollBy({ top: Math.max(600, window.innerHeight), behavior: "instant" }); if (!await pause(1500)) return; continue; }
        job.sourceAuthorsSeen = [...new Set([...(job.sourceAuthorsSeen || []), source])].slice(-500);
        job.sourceAuthor = source; job.sourceFollowCount = 0; job.candidatesScanned = []; job.candidatesSeen = [];
        job.candidateScores = {}; job.candidateBatch = []; job.candidateIndex = 0; job.stage = "followers";
        await navigate(`发现来源 @${source}，打开认证关注者列表`, true); return;
      }
      if (job.stage === "followers") {
        if (job.sourceFollowCount >= FT_POLICY.perSource) { ftNextSource(job); await navigate("本来源已成功关注5人，寻找下一来源"); return; }
        // 有队列时直接处理下一人，不必再次加载来源列表。
        if (job.candidateBatch?.[job.candidateIndex]) {
          job.candidateUsername = job.candidateBatch[job.candidateIndex]; job.stage = "profile";
          await navigate(`直接处理下一候选 @${job.candidateUsername}`); return;
        }
        if (page !== "followers" || pathUser !== job.sourceAuthor) { await navigate("补充候选账号，返回认证关注者列表"); return; }
        if (!await pageReady(() => followerTargetListRows().length > 0 || document.querySelector('[data-testid="primaryColumn"] [data-testid="emptyState"]'),
          12000, "等待认证关注者列表就绪")) {
          if (!await healthAfterFailure()) return;
          ftNextSource(job); await navigate("关注者列表未能加载，寻找下一来源"); return;
        }
        if (!followerTargetListRows().length) { ftNextSource(job); await navigate("认证关注者列表为空，寻找下一来源"); return; }
        job.candidateBatch = []; job.candidateIndex = 0;
        await status("多屏浏览认证关注者列表，筛选中文候选及备用账号");
        await followerTargetV243CollectCandidates(job, active, pause, status);
        if (!active()) return;
        if (!job.candidateBatch.length) { ftNextSource(job); await navigate("本来源没有更多合格候选，寻找下一来源"); return; }
        job.candidateUsername = job.candidateBatch[0]; job.stage = "profile";
        await navigate(`筛选到${job.candidateBatch.length}人，处理 @${job.candidateUsername}`); return;
      }
      if (job.stage === "profile") {
        const candidate = job.candidateUsername;
        if (!candidate) { job.stage = "followers"; await save(); continue; }
        if (page !== "profile" || pathUser !== candidate) { await navigate(`打开 @${candidate} 的主页`); return; }
        await status(`正在检查 @${candidate} 的关注状态与粉丝数`);
        const ready = await pageReady(() => readProfileFollowers(candidate) !== null, FOLLOWER_TARGET_PROFILE_TIMEOUT_MS,
          `等待 @${candidate} 主页资料就绪`);
        await assertActive();
        if (!ready) { if (!await healthAfterFailure()) return; await finish("主页资料未加载，跳过账号"); return; }
        const followers = readProfileFollowers(candidate);
        if (followers < FOLLOWER_TARGET_MIN_FOLLOWERS || followers > FOLLOWER_TARGET_MAX_FOLLOWERS) {
          await finish(`粉丝数${followers}不在600～10000范围，跳过账号`); return;
        }
        if (followerTargetProfileAlreadyFollowing() && job.followConfirmedCandidate !== candidate) {
          await finish("已经关注过，直接处理下一人"); return;
        }
        if (job.followConfirmedCandidate !== candidate) {
          // 筛选、跳转、评论都计入同一个关注间隔，不逐步骤叠加完整等待。
          if (job.lastFollowAt && !job.nextFollowAt) {
            job.nextFollowAt = job.lastFollowAt + ftRandomMs(FT_POLICY.cadenceMinMs, FT_POLICY.cadenceMaxMs);
            await save();
          }
          const remaining = Math.max(0, (job.nextFollowAt || 0) - Date.now());
          if (remaining > 0) { await status(`主页已就绪，等待本次关注节奏，剩余${Math.ceil(remaining / 1000)}秒（已抵扣前面耗时）`); if (!await pause(remaining)) return; }
          const follow = await followOnProfile(candidate, assertActive);
          await assertActive();
          if (follow.rateLimited) { job.cooldownUntil = Date.now() + FOLLOW_RATE_LIMIT_COOLDOWN_MS; await save(); continue; }
          if (follow.error) { if (!await healthAfterFailure()) return; await finish(`关注未确认：${follow.error}`); return; }
          if (!follow.followed) { await finish("已经关注过，直接处理下一人"); return; }
          job.lastFollowAt = Date.now(); job.followConfirmedCandidate = candidate;
          job.nextFollowAt = job.lastFollowAt + ftRandomMs(FT_POLICY.cadenceMinMs, FT_POLICY.cadenceMaxMs);
          job.sessionFollowCount = (job.sessionFollowCount || 0) + 1; job.sourceFollowCount = (job.sourceFollowCount || 0) + 1;
          await save(); await bumpFollowerTargetStat("follows");
        }
        if (job.accountDeadlineAt - Date.now() < 12000) { await finish("已关注，账号剩余时间不足，放弃可选评论", true); return; }
        const api = await chrome.storage.local.get({ followerTargetApiCooldown: null, replyMode: "ai" });
        if (api.replyMode !== "fixed" && api.followerTargetApiCooldown?.sessionId === job.sessionId && api.followerTargetApiCooldown.until > Date.now()) {
          await finish("已关注，模型暂不可用，本次不评论", true); return;
        }
        await status(`已关注 @${candidate}，最多5秒寻找一条24小时内帖子`);
        job.candidatePosts = await followerTargetV241CollectPosts(candidate, active, job.owner);
        await assertActive();
        if (!job.candidatePosts.length) { await finish("已关注，没有可评论的24小时内原创帖", true); return; }
        job.postIndex = 0; job.commentAttempt = 0; job.commentStartedPostId = null;
        if (job.accountDeadlineAt - Date.now() < 12000) { await finish("已关注，找帖后剩余时间不足，放弃可选评论", true); return; }
        job.stage = "comment"; job.commentDeadlineAt = Math.min(Date.now() + FT_POLICY.commentMs, job.accountDeadlineAt);
        await navigate(`已关注 @${candidate}，只尝试一条帖子，评论最多40秒且不超过账号90秒总期限`); return;
      }
      if (job.stage === "comment") {
        const candidate = job.candidateUsername, post = job.candidatePosts?.[0];
        if (!candidate || !post) { await failComment("没有可用帖子"); return; }
        if (job.commentStartedPostId === post.id) { await failComment("该帖已有模型生成尝试，刷新后不重复生成"); return; }
        if (page !== "comment" || pathUser !== candidate || !location.pathname.endsWith(`/status/${post.id}`)) { await navigate("打开唯一目标帖子"); return; }
        let cancelled = false;
        const guard = async () => { if (cancelled) throw new Error("评论已取消，禁止迟到结果发送"); await assertActive(); };
        const within = operation => followerTargetCommentDeadline(operation, job.commentDeadlineAt, () => { cancelled = true; cancelModel(); });
        let article;
        await within(async () => { await pageReady(() => {
          article = getPostContainers().find(item => getPostId(item)?.match(/\/status\/(\d+)/)?.[1] === post.id && sanitizeUsername(getAuthor(item)) === candidate);
          return Boolean(article);
        }, 5000, "等待目标帖子就绪"); });
        if (!article) { if (!await healthAfterFailure()) return; await failComment("目标帖子5秒内未加载"); return; }
        const key = `followerTargetReply:${job.owner}:${candidate}:${post.id}`;
        const records = await chrome.storage.local.get([key, `replyAttempt:${job.owner}:${post.id}`, "uncertainReplyPostIds"]);
        if (records[key] || records[`replyAttempt:${job.owner}:${post.id}`] || records.uncertainReplyPostIds?.includes(post.id)) {
          await failComment("该帖已有处理或发送尝试记录，不重复评论"); return;
        }
        if (job.commentDeadlineAt - Date.now() <= FT_POLICY.sendReserveMs) { await failComment("剩余时间不足以生成并确认发送"); return; }
        job.commentStartedPostId = post.id; await save();
        requestId = `${job.sessionId}:${candidate}:${post.id}:${epoch}`;
        await status(`正在为 @${candidate} 生成一次回复，评论全流程剩余${Math.max(0, Math.ceil((job.commentDeadlineAt - Date.now()) / 1000))}秒`);
        const result = await within(() => followerTargetRuntimeMessage({ type: "followerTargetGenerateDraft", sessionId: job.sessionId,
          requestId, epoch, candidate, postId: post.id, deadlineAt: job.commentDeadlineAt,
          postText: findPostText(article) || post.text }, Math.max(1, job.commentDeadlineAt - Date.now())));
        await guard();
        const failure = result?.error || !result?.draft ? result?.error || "模型返回空内容" : result.draft === "[SKIP]" ? `内容不适合回复（${result.reason || "模型跳过"}）` : "";
        if (failure) { await failComment(failure, "model"); return; }
        const sent = await within(() => sendReplyToPost(article, result.draft, generation, { inline: true, strict: true,
          deadlineAt: job.commentDeadlineAt, composerTimeoutMs: 6000, assertActive: guard, onStatus: status,
          beforeSend: async () => { await guard(); await chrome.storage.local.set({ [key]: { state: "pending", updatedAt: Date.now() } }); } }));
        await guard();
        if (sent === false) { await failComment("发送未确认或已有发送尝试", "send"); return; }
        await chrome.storage.local.set({ [key]: { state: "done", postId: post.id, updatedAt: Date.now() } });
        job.metrics.comments += 1; await bumpFollowerTargetStat("comments");
        await finish("已关注并成功评论，直接处理下一人"); return;
      }
      ftNextSource(job); await navigate("阶段无效，回到首页继续"); return;
    }
  } catch (error) {
    cancelModel();
    if (!active()) return;
    if (job && (error.code === "FT_EXPIRED" || ftExpired(job))) { await recoverExpired(); return; }
    if (job?.stage === "comment") { await failComment(error, "exception"); return; }
    if (job && await healthAfterFailure()) {
      if (job.candidateUsername) await finish(`账号处理异常，跳过：${String(error.message).slice(0, 150)}`);
      else { ftNextSource(job); await navigate("页面异常，寻找下一来源"); }
    }
  } finally {
    cancelModel(); clearInterval(watchdog); followerTargetBusy = false;
  }
}

function ftContentJobUrl(job) {
  if (job.stage === "comment" && job.candidatePosts?.[0]) return `${location.origin}/${job.candidateUsername}/status/${job.candidatePosts[0].id}`;
  if (job.stage === "profile") return `${location.origin}/${job.candidateUsername}`;
  if (job.stage === "followers") return `${location.origin}/${job.sourceAuthor}/verified_followers`;
  return followerTargetHomeUrl();
}

function followerTargetProfileAlreadyFollowing() {
  const scope = document.querySelector('[data-testid="primaryColumn"]');
  return scope && [...scope.querySelectorAll('button,[role="button"]')].some(button =>
    button.getClientRects().length && !button.closest('article,[data-testid="UserCell"]') &&
    /(?:^|\s)(?:已关注|正在关注|following|unfollow)(?:\s|$)/i.test(`${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim()));
}
