// 内容脚本与后台共用同一套阶段期限和候选推进规则。
const FT_POLICY = Object.freeze({ stageMs: 60000, accountMs: 90000, commentMs: 40000, modelMs: 25000,
  navigationMinMs: 1500, navigationMaxMs: 3000, sourceMinMs: 4000, sourceMaxMs: 7000,
  followMinMs: 1000, followMaxMs: 3000, cadenceMinMs: 40000, cadenceMaxMs: 50000,
  sendReserveMs: 8000, apiCooldownMs: 5 * 60000, perSource: 5 });

function ftRandomMs(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// 同一账号跨主页、帖子页和重载共用90秒，不因阶段变化或心跳续期。
function ftTouchAccount(job, now = Date.now(), reset = false) {
  if (!job.candidateUsername || !["profile", "comment"].includes(job.stage)) return;
  const key = `${job.sessionId}:${job.candidateUsername}`;
  if (reset || job.accountKey !== key || !job.accountDeadlineAt) {
    job.accountKey = key;
    job.accountStartedAt = now;
    job.accountDeadlineAt = now + FT_POLICY.accountMs;
  }
}

function ftStageKey(job) {
  return `${job.stage}:${job.sourceAuthor || ""}:${job.candidateUsername || ""}`;
}

function ftTouchStage(job, now = Date.now(), reset = false) {
  ftTouchAccount(job, now);
  const key = ftStageKey(job);
  if (reset || job.stageKey !== key || !job.stageDeadlineAt) {
    job.stageKey = key;
    job.stageStartedAt = now;
    job.stageDeadlineAt = now + (job.stage === "profile" ? FT_POLICY.accountMs : FT_POLICY.stageMs);
  }
  // 迁移旧版任务时也不再获得 90 秒评论预算。
  if (job.stage === "comment") {
    job.commentDeadlineAt = Math.min(job.commentDeadlineAt || now + FT_POLICY.commentMs, now + FT_POLICY.commentMs);
    if (job.accountDeadlineAt) job.commentDeadlineAt = Math.min(job.commentDeadlineAt, job.accountDeadlineAt);
  }
  job.metrics = { startedAt: now, comments: 0, abandoned: 0, commentTimeouts: 0, stageTimeouts: 0, ...job.metrics };
}

function ftClearComment(job) {
  job.candidatePosts = []; job.postIndex = 0; job.commentAttempt = 0;
  job.commentDeadlineAt = 0; job.commentStartedPostId = null; job.retryAt = 0;
}

function ftNextCandidate(job, now = Date.now()) {
  if (job.candidateUsername) job.candidateIndex = (Number(job.candidateIndex) || 0) + 1;
  job.candidateUsername = null; job.recoveryAttempts = 0;
  job.followConfirmedCandidate = null;
  job.accountKey = null; job.accountStartedAt = 0; job.accountDeadlineAt = 0;
  ftClearComment(job);
  if ((job.sourceFollowCount || 0) >= FT_POLICY.perSource) return ftNextSource(job, now);
  const next = job.candidateBatch?.[job.candidateIndex];
  if (next) { job.candidateUsername = next; job.stage = "profile"; }
  else job.stage = job.sourceAuthor ? "followers" : "home";
  ftTouchStage(job, now);
}

function ftNextSource(job, now = Date.now()) {
  job.stage = "home"; job.sourceAuthor = null; job.sourceFollowCount = 0;
  job.candidateUsername = null; job.candidateBatch = []; job.candidateIndex = 0;
  job.followConfirmedCandidate = null;
  job.accountKey = null; job.accountStartedAt = 0; job.accountDeadlineAt = 0;
  job.candidatesSeen = []; job.candidatesScanned = []; job.candidateScores = {};
  ftClearComment(job);
  ftTouchStage(job, now, true);
}

function ftExpired(job, now = Date.now()) {
  // 冷却到期后由任务恢复并重置阶段时间，后台不能把冷却计为卡死。
  if (job.cooldownUntil) return "";
  if (job.candidateUsername && ["profile", "comment"].includes(job.stage) && job.accountDeadlineAt && now >= job.accountDeadlineAt) return "account";
  if (job.stage === "comment" && job.commentDeadlineAt && now >= job.commentDeadlineAt) return "comment";
  return job.stageDeadlineAt && now >= job.stageDeadlineAt ? "stage" : "";
}

function ftSkipExpired(job, now = Date.now()) {
  const expired = ftExpired(job, now);
  if (!expired) return "";
  ftTouchStage(job, now);
  job.metrics.stageTimeouts += expired !== "comment" ? 1 : 0;
  job.metrics.accountTimeouts = (job.metrics.accountTimeouts || 0) + (expired === "account" ? 1 : 0);
  if (job.stage === "comment") {
    job.metrics.abandoned += 1;
    job.metrics.commentTimeouts += expired === "comment" ? 1 : 0;
  }
  const reason = expired === "comment" ? "评论全流程达到截止时间（最多40秒），放弃评论并继续关注" :
    expired === "account" ? "当前账号处理超过90秒，跳过并处理下一人" : "当前阶段达到截止时间，跳过并进入下一阶段";
  if (job.candidateUsername) ftNextCandidate(job, now);
  else ftNextSource(job, now);
  return reason;
}
