const commentQualityPanel = document.getElementById("commentQualityPanel");
let commentQualityReadVersion = 0;
async function refreshCommentQuality() {
  const version = ++commentQualityReadVersion;
  const { commentQualityLog = [], commentSentHistory = [] } = await chrome.storage.local.get({ commentQualityLog: [], commentSentHistory: [] });
  if (version !== commentQualityReadVersion) return;
  const names = { ranking: "榜单", specified: "指定博主", followerTarget: "列表关注", home: "首页", own_post: "我的帖子", manual: "草稿" };
  const results = { generated: "草稿合格", skipped: "已跳过", error: "生成失败", send_confirmed: "发送确认", send_blocked: "发送前拦截" };
  const counts = commentQualityLog.reduce((all, item) => { all[item.result] = (all[item.result] || 0) + 1; return all; }, {});
  document.getElementById("commentQualitySummary").textContent =
    `最近${commentQualityLog.length}条质量事件：草稿合格${counts.generated || 0}次，跳过${counts.skipped || 0}次，失败${counts.error || 0}次，发送前拦截${counts.send_blocked || 0}次；已确认发送记忆${commentSentHistory.length}/200条。草稿合格不代表已经发送，记录仅保存在本浏览器。`;
  document.getElementById("commentQualityRows").textContent = commentQualityLog.slice(-20).reverse().map(row =>
    `${new Date(row.at).toLocaleString()} ${names[row.task] || "评论"} ${row.target ? "@" + row.target : ""} ${results[row.result] || row.result}` +
    `${row.result.startsWith("send_") ? "" : `｜${row.elapsedMs}毫秒｜生成${row.calls}次`}${row.score == null ? "" : "｜本地评分" + row.score}${row.reason ? "｜" + row.reason : ""}`).join("\n") || "尚无质量记录";
}
commentQualityPanel.addEventListener("toggle", () => { if (commentQualityPanel.open) refreshCommentQuality().catch(() => {}); });
document.getElementById("refreshCommentQuality").addEventListener("click", () => refreshCommentQuality().catch(() => {}));
document.getElementById("exportCommentQuality").addEventListener("click", async () => {
  try {
    const { commentQualityLog = [] } = await chrome.storage.local.get({ commentQualityLog: [] });
    const blob = new Blob([JSON.stringify({ version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), records: commentQualityLog }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `X助手-评论质量-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { document.getElementById("commentQualitySummary").textContent = "读取质量记录失败，请刷新控制台后再试"; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && commentQualityPanel.open && (changes.commentQualityLog || changes.commentSentHistory)) refreshCommentQuality().catch(() => {});
});
