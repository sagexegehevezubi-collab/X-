// 内容脚本与后台共用同一套阶段期限和候选推进规则。
const FT_POLICY = Object.freeze({ stageMs: 60000, commentMs: 40000, modelMs: 25000,
  apiCooldownMs: 5 * 60000, perSource: 5 });

function ftStageKey(job) {
  return `${job.stage}:${job.sourceAuthor || ""}:${job.candidateUsername || ""}`;
}

function ftTouchStage(job, now = Date.now(), reset = false) {
  const key = ftStageKey(job);
  if (reset || job.stageKey !== key || !job.stageDeadlineAt) {
    job.stageKey = key;
    job.stageStartedAt = now;
    job.stageDeadlineAt = now + FT_POLICY.stageMs;
  }
  // 迁移旧版任务时也不再获得 90 秒评论预算。
  if (job.stage === "comment") {
    job.commentDeadlineAt = Math.min(job.commentDeadlineAt || now + FT_POLICY.commentMs, now + FT_POLICY.commentMs);
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
  job.candidatesSeen = []; job.candidatesScanned = []; job.candidateScores = {};
  ftClearComment(job);
  ftTouchStage(job, now, true);
}

function ftExpired(job, now = Date.now()) {
  // 冷却到期后由任务恢复并重置阶段时间，后台不能把冷却计为卡死。
  if (job.cooldownUntil) return "";
  if (job.stage === "comment" && job.commentDeadlineAt && now >= job.commentDeadlineAt) return "comment";
  return job.stageDeadlineAt && now >= job.stageDeadlineAt ? "stage" : "";
}

function ftSkipExpired(job, now = Date.now()) {
  const expired = ftExpired(job, now);
  if (!expired) return "";
  ftTouchStage(job, now);
  job.metrics.stageTimeouts += expired === "stage" ? 1 : 0;
  if (job.stage === "comment") {
    job.metrics.abandoned += 1;
    job.metrics.commentTimeouts += expired === "comment" ? 1 : 0;
  }
  const reason = expired === "comment" ? "评论全流程超过40秒，放弃评论并继续关注" : "当前阶段超过60秒，跳过并进入下一阶段";
  if (job.candidateUsername) ftNextCandidate(job, now);
  else ftNextSource(job, now);
  return reason;
}
