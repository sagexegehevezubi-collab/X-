// 纯本地风格和重复检查：不调用评审模型，不决定或延长任务期限。
const REPLY_STYLE_VERSION = "0.2.56";

function normalizeCommentBody(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function commentShape(value) {
  const text = String(value || "").trim();
  if (/[?？]/.test(text)) return "question";
  if (/[，,]/.test(text)) return "comma";
  return "plain";
}

function commentSimilarity(a, b) {
  const left = normalizeCommentBody(a), right = normalizeCommentBody(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const l = grams(left), r = grams(right);
  const union = new Set([...l, ...r]);
  return union.size ? [...l].filter(item => r.has(item)).length / union.size : 0;
}

function getCommentDuplicateIssue(text, target, entries) {
  const body = normalizeCommentBody(text);
  const username = String(target || "").replace(/^@/, "").toLowerCase();
  for (const item of entries || []) {
    const previous = item.normalized || normalizeCommentBody(item.text);
    if (!body || !previous) continue;
    if (username && username === item.target && body === previous) return "same_author_duplicate";
    // 很短的通用接话仅对同一作者拦截；不同作者的短句只参与软检查。
    if (Math.min(body.length, previous.length) >= 10 && Math.min(body.length, previous.length) / Math.max(body.length, previous.length) >= 0.85 &&
        commentSimilarity(body, previous) >= 0.88) return "recent_duplicate";
  }
  return "";
}

function buildRecentCommentHint(entries) {
  const recent = (entries || []).slice(-30);
  const counts = new Map();
  for (const item of recent) {
    const body = normalizeCommentBody(item.text);
    if (body.length >= 2) counts.set(body.slice(0, 2), (counts.get(body.slice(0, 2)) || 0) + 1);
  }
  const openings = [...counts].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([opening]) => opening);
  const lines = [];
  if (openings.length) lines.push(`近期常用开头：${openings.join("、")}，这次自然换个说法`);
  const tail = recent.slice(-5);
  if (tail.length === 5 && tail.every(item => commentShape(item.text) === "question")) lines.push("近期连续问句，这次不要硬凑问题");
  if (tail.length === 5 && tail.every(item => commentShape(item.text) === "comma")) lines.push("近期连续两段句，这次可只接半句");
  if (recent.slice(-3).length === 3 && recent.slice(-3).every(item => countReplyEmoji(item.text))) lines.push("近期连续用了表情，这次不用表情");
  return lines.join("；").slice(0, 100);
}

function analyzeCommentStyle(reply, original, entries = []) {
  const text = String(reply || "").trim(), body = normalizeCommentBody(text);
  let score = 100;
  const issues = [];
  const deduct = (points, reason) => { score -= points; issues.push(reason); };
  if (/感谢分享|感谢支持|受益匪浅|值得深思|引人深思|令人惊叹|淋漓尽致|相得益彰|不言而喻/.test(text)) deduct(25, "空泛捧场或书面套话");
  if (body.length > 6) {
    if (/(?:不仅.*而且|这说明|这意味着|总体来看|由此可见|充分体现|完美诠释)/.test(text)) deduct(25, "总结升华或答题结构");
    if (/^(?:博主|作者|这篇帖子|这个作品)/.test(text)) deduct(10, "点评作者的口吻");
    const orig = normalizeCommentBody(original);
    // 允许正常引用专有词，只有大部分正文照搬连续原文时才扣分。
    let overlap = 0;
    for (let i = 0; i < body.length; i++) {
      for (let size = overlap + 1; i + size <= body.length; size++) {
        if (orig.includes(body.slice(i, i + size))) overlap = size; else break;
      }
    }
    if (overlap >= 8 && overlap / body.length >= 0.8) deduct(25, "大段复述原文");
    const recent = entries.slice(-10);
    if (recent.filter(item => normalizeCommentBody(item.text).slice(0, 2) === body.slice(0, 2)).length >= 3)
      deduct(15, "近期相同开头过多");
    if (entries.slice(-5).length === 5 && entries.slice(-5).every(item => commentShape(item.text) === commentShape(text)) && commentShape(text) !== "plain")
      deduct(10, "近期问句或两段句过于集中");
  }
  if (entries.some(item => commentSimilarity(text, item.text) >= 0.6)) deduct(15, "与近期评论相似");
  if (/[!！]{2,}/.test(text)) deduct(10, "感叹号堆叠");
  return { score: Math.max(0, score), issues };
}

function commentIssueLabel(issue) {
  if (replyFactIssueLabel(issue)) return replyFactIssueLabel(issue);
  return ({ too_long: "超过30字符，表情标点也计算在内", too_many_commas: "逗号超过一个", trailing_period: "句尾使用句号",
    too_many_emoji: "使用了多个表情", model_meta: "出现模型分析或候选方案", refusal: "模型拒绝说明", empty: "没有回复正文",
    punctuation: "只有标点或表情", same_author_duplicate: "对同一账号重复相同正文", recent_duplicate: "照搬近期较长评论",
    unsolicited_contact: "包含链接、账号提及或话题标签", low_style: "多项模板表达叠加" })[issue] || issue;
}
