function rankingWorkerCount(job) {
  return Math.min(job.queue.length, Math.max(1, Math.min(10, Math.floor(Number(job.concurrency) || 1))));
}

// Read all durable positions before creating workers: older content scripts may
// have saved their job index without sending a completed count to the pool.
async function readRankingCheckpoint(job) {
  const count = rankingWorkerCount(job);
  const keys = Array.from({ length: count }, (_, index) => `rankingWorkerJob:${job.id}:${index}`);
  const state = await chrome.storage.local.get(["rankingCheckpoint", "rankingPool", ...keys]);
  const checkpoint = state.rankingCheckpoint?.jobId === job.id ? state.rankingCheckpoint : null;
  const pool = state.rankingPool?.id === job.id ? state.rankingPool : null;
  let found = Boolean(checkpoint || pool || job.resumeFrom?.length);
  const completedByWorker = keys.map((key, index) => {
    const queue = job.queue.filter((_, position) => position % count === index);
    const saved = state[key];
    const matches = saved?.id === job.id && saved.owner === job.owner &&
      saved.queue?.length === queue.length && queue.every((entry, position) =>
        entry.username.toLowerCase() === String(saved.queue[position]?.username || "").toLowerCase());
    if (matches) found = true;
    const worker = pool?.workers?.find((item) => item.jobKey === key);
    const values = [job.resumeFrom?.[index], checkpoint?.completedByWorker?.[index],
      worker?.completed, matches ? saved.index : 0];
    return Math.min(queue.length, Math.max(0, ...values.map((value) =>
      Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0)));
  });
  return { jobId: job.id, completedByWorker, found, updatedAt: Date.now() };
}
