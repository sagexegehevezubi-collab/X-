importScripts("providers.js", "reply-emotion-pool.js", "reply-validation.js", "ranking-checkpoint.js", "ranking-pool.js", "specified-pool.js");
importScripts("follow-rate-limit.js");
const followRateRuleReady = chrome.storage.local.get(["followRateRuleVersion", "lastAutomationError", "rankingJob", "automationTask"]).then(async (state) => {
  if (state.automationTask === "hashtags") {
    await chrome.storage.local.set({ automationRunning: false, automationTask: "engagement", automationTargetTabId: null,
      lastAutomationError: "", lastAutomationStatus: "旧标签任务已停用" });
  }
  if (state.followRateRuleVersion === 2) return;
  const updates = { followRateRuleVersion: 2, followCooldownUntil: 0, followerMonitorCooldownUntil: 0, relationshipFollowCooldownUntil: 0 };
  if (/关注限速|回关限速/.test(state.lastAutomationError || "")) updates.lastAutomationError = "";
  if (state.rankingJob?.stage === "follow") updates.rankingJob = { ...state.rankingJob, retryAt: 0 };
  await chrome.storage.local.set(updates);
});
let followerMonitorStarting = null;
async function ensureFollowerMonitor(username, senderTabId) {
  if (followerMonitorStarting) return followerMonitorStarting;
  followerMonitorStarting = (async () => {
    const state = await chrome.storage.local.get(["automationRunning", "automationTask", "autoFollowBack", "automationTargetTabId", "followerMonitorTabId"]);
    if (!state.automationRunning || state.automationTask !== "engagement" || !state.autoFollowBack || senderTabId !== state.automationTargetTabId) return;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username || "")) throw new Error("无法识别当前账号，请等待 X 加载后重新启动");
    if (state.followerMonitorTabId) {
      const existing = await chrome.tabs.get(state.followerMonitorTabId).catch(() => null);
      if (existing) return;
    }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    await chrome.storage.local.set({ followerMonitorTabId: tab.id, followerMonitorStatus: "正在打开关注者列表…" });
    const current = await chrome.storage.local.get(["automationRunning", "autoFollowBack"]);
    if (!current.automationRunning || !current.autoFollowBack) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    await chrome.tabs.update(tab.id, { url: `https://x.com/${username}/followers` });
  })().finally(() => { followerMonitorStarting = null; });
  return followerMonitorStarting;
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.automationRunning || changes.autoFollowBack || changes.automationTask)) return;
  const state = await chrome.storage.local.get(["automationRunning", "automationTask", "autoFollowBack", "followerMonitorTabId"]);
  if (state.automationRunning && state.automationTask === "engagement" && state.autoFollowBack) return;
  if (state.followerMonitorTabId) await chrome.tabs.remove(state.followerMonitorTabId).catch(() => {});
  await chrome.storage.local.set({ followerMonitorTabId: null, followerMonitorStatus: "自动回关已停止" });
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await chrome.storage.local.get(["followerMonitorTabId"]);
  if (state.followerMonitorTabId === tabId) await chrome.storage.local.set({ followerMonitorTabId: null, followerMonitorStatus: "回关标签页已关闭" });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ensureFollowerMonitor") {
    ensureFollowerMonitor(message.username, _sender.tab?.id).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "getTaskStateForTab") {
    followRateRuleReady.then(() => chrome.storage.local.get({ automationRunning: false, automationTask: "engagement", automationTargetTabId: null, followerMonitorTabId: null, autoFollowBack: false, rankingPool: null, specifiedPool: null }))
      .then((state) => {
        const worker = state.automationTask === "ranking" ? state.rankingPool?.workers.find((item) => item.tabId === _sender.tab?.id && !item.done) : null;
        const specifiedWorker = state.automationTask === "specified" ? state.specifiedPool?.workers.find((item) => item.tabId === _sender.tab?.id && !item.done) : null;
        sendResponse({
        running: state.automationRunning === true && (state.automationTargetTabId === _sender.tab?.id || Boolean(worker) || Boolean(specifiedWorker)),
        rankingWorkerJobKey: worker?.jobKey || null,
        specifiedWorkerJobKey: specifiedWorker?.jobKey || null,
        followerMonitor: state.automationRunning && state.autoFollowBack && state.automationTask === "engagement" && state.followerMonitorTabId === _sender.tab?.id,
        taskMode: state.automationTask
      }); })
      .catch(() => sendResponse({ running: false, taskMode: "engagement" }));
    return true;
  }
  if (message?.type === "followUser") {
    followUser(message.username)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message || "无法关注作者" }));
    return true;
  }
  if (message?.type !== "generateDraft") return;

  generateDraft(message.postText, message.replyContext)
    .then((result) => sendResponse(typeof result === "string" ? { draft: result } : result))
    .catch((error) => sendResponse({ error: error.message || "请求失败" }));

  return true;
});

async function followUser(username) {
  await followRateRuleReady;
  const safeUsername = String(username || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(safeUsername)) throw new Error("作者账号名无效");
  const tab = await chrome.tabs.create({ url: `https://x.com/${safeUsername}`, active: false });
  if (!tab?.id) throw new Error("无法打开作者主页");
  try {
    await waitForTabLoad(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const { automationRunning = false } = await chrome.storage.local.get({ automationRunning: false });
    if (!automationRunning) throw new Error("任务已停止");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [safeUsername, X_FOLLOW_RATE_LIMIT_PATTERN],
      func: async (expectedUsername, rateLimitPattern) => {
        const expected = expectedUsername.toLowerCase();
        const waitForProfile = async () => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 10000) {
            const heading = document.querySelector('[data-testid="UserName"]');
            if (heading?.innerText) return heading;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return null;
        };
        const profileHeading = await waitForProfile();
        const headingText = profileHeading?.innerText?.toLowerCase() || "";
        if (location.pathname.toLowerCase() !== `/${expected}` || !headingText.includes(`@${expected}`)) {
          return { error: "主页身份校验失败，未执行关注" };
        }
        const startedAt = Date.now();
        let clickedFollow = false;
        while (Date.now() - startedAt < 8000) {
          const task = await chrome.storage.local.get({ automationRunning: false });
          if (!task.automationRunning) return { error: "任务已停止" };
          const limited = clickedFollow && [...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="toast"],[role="dialog"]')]
            .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" &&
              new RegExp(rateLimitPattern).test((node.innerText || "").replace(/\s+/g, "")));
          if (limited) return { rateLimited: true };
          const profileScope = document.querySelector('[data-testid="primaryColumn"]');
          const buttons = [...(profileScope || document).querySelectorAll('button,[role="button"]')]
            .filter((button) => button.getClientRects().length && !button.closest('article,[data-testid="UserCell"]'));
          const labels = buttons.map((button) => ({
            button,
            label: `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim().toLowerCase()
          }));
          const followed = labels.some(({ label }) => /(^|\s)(已关注|正在关注|following|unfollow)(\s|$)/i.test(label));
          if (followed) return { followed: clickedFollow, alreadyFollowing: !clickedFollow };
          const follow = labels.find(({ label }) => /(^|\s)(关注|follow)(\s|$)/i.test(label));
          if (follow && !clickedFollow) {
            follow.button.click();
            clickedFollow = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (clickedFollow) return { error: "点击关注后未能确认关注状态，请检查作者主页" };
        return { error: "主页未找到可确认的关注按钮" };
      }
    });
    if (result?.error) throw new Error(result.error);
    return result || { followed: false };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("作者主页加载超时"));
    }, 15000);
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((currentTab) => {
      if (currentTab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

const REPLY_SCENE_PROMPTS = Object.freeze({
  timeline_mutual: "【当前场景：经常互动的熟面孔】语气松弛、接地气，像评论区里认识很久的网友顺口搭话；不假定现实关系，不编共同经历。",
  timeline_influencer: "【当前场景：榜单博主的帖子】保持平视，像常刷到的网友顺手接话；可以幽默拆台，但只针对内容和情境，不攻击身份或外貌。",
  reply_to_my_post: "【当前场景：别人回复了我的帖子】以原帖作者身份简短接话，可以认同、解答或简单道谢，但不要写成长句。",
  manual_draft: "【当前场景：手动生成回复草稿】尽量生成一句自然短回复；遇到系统规定的不可回复情形仍输出 [SKIP]。"
});

function normalizeReplyScene(replyContext) {
  if (replyContext === "homeMutual") return "timeline_mutual";
  if (replyContext === "comment") return "reply_to_my_post";
  if (Object.prototype.hasOwnProperty.call(REPLY_SCENE_PROMPTS, replyContext)) return replyContext;
  return "timeline_influencer";
}

function buildReplySystemPrompt(scene, isRetry) {
  return [
    "你是 X 上一个幽默、嘴欠但真诚的段子手，像认识多年的网友在评论区松弛搭话。语气脑洞大、接地气、爱拆台也懂自嘲；不要真的冒犯作者。",
    "真人打字怎么顺口怎么来，优先省略主语和连接词，允许半句和不完整语法，不要为了工整补全解释。直接切入，不客套、不说教、不居高临下。",
    "绝不总结或复述原帖；不先夸赞再升华；不强行上价值；不编造我用过、我朋友遇到过等个人经历；不使用客服腔、播音腔、公文腔或翻译腔；不以哈哈、哇、天哪、太真实了、确实等感叹词开头；不添加固定结尾。",
    "按内容只选一种接法并自然带点幽默：吐槽/观点顺着荒诞处推半步或用大实话扎心；晒日常/炫耀抓一个奇怪盲点歪楼或轻松假装嫉妒；资讯/行业动态调侃对普通人的真实影响；玩梗就接下半句或一本正经胡说半句；求助给最直接管用的答案或点破常见坑。不要为了搞笑硬造笑点。",
    "纯抽奖、纯图无字、激烈骂战、严肃悲剧、看不懂的黑话或实在无法自然接话时，只输出 [SKIP]。",
    "使用与原帖一致的主要语言。日常回复以 6–22 个汉字为宜，轻松内容可短至 2–10 字，绝对不超过 30 个字符；最多一个逗号，句尾绝不加句号，少用感叹号，尽量不用 emoji。至少包含一个汉字或数字。",
    "只输出最终回复或 [SKIP]，严禁输出思考过程、解释、引号、标题或多选方案。",
    REPLY_SCENE_PROMPTS[scene],
    isRetry ? "上一版不自然或违反格式限制。重新想一句更短、更松弛、更像损友随口接茬的话；不超过 12 字，不要逗号，不要复述原帖。" : "严格执行全部内容与格式限制。"
  ].join("\n");
}

function buildReplyUserPrompt(postText, scene, isRetry) {
  const retry = isRetry ? "\n\n【重试】上一版不够自然，请换成更短、更像随口一说的表达。" : "";
  return `${REPLY_SCENE_PROMPTS[scene]}\n\n原帖内容：\n\"\"\"\n${String(postText || "").trim().slice(0, 4000)}\n\"\"\"${retry}`;
}

async function generateDraft(postText, replyContext = "post") {
  const { replyMode = "ai", fixedReplyText = "" } = await chrome.storage.local.get({
    replyMode: "ai", fixedReplyText: ""
  });
  if (replyMode === "fixed") {
    const text = String(fixedReplyText).trim();
    if (!text) throw new Error("请先在设置中填写固定回复内容并保存。");
    return { draft: text, reason: "fixed" };
  }
  const { apiKey, model, endpoint, provider = "", authMode = "bearer", authHeaderName = "Authorization" } = await chrome.storage.local.get({
    apiKey: "",
    model: "",
    endpoint: "https://api.vibe-subsapi.net/v1/chat/completions"
  });
  if (authMode !== "none" && !apiKey) throw new Error("请先在扩展选项中配置 API Key。");
  const scene = normalizeReplyScene(replyContext);
  const headers = { "Content-Type": "application/json" };
  if (authMode === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  if (authMode === "x-api-key") headers["X-API-Key"] = apiKey;
  if (authMode === "custom") {
    const headerName = String(authHeaderName || "").trim();
    if (!headerName) throw new Error("请填写自定义鉴权请求头名称。");
    headers[headerName] = apiKey;
  }

  const requestOnce = async (isRetry) => {
    const data = await requestModelJson(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.78,
        presence_penalty: 0.3,
        stream: false,
        ...((provider === "vibe" || /api\.vibe-subsapi\.net/i.test(endpoint))
          ? { max_completion_tokens: 60 }
          : { max_tokens: 60 }),
        messages: [
          { role: "system", content: buildReplySystemPrompt(scene, isRetry) },
          { role: "user", content: buildReplyUserPrompt(postText, scene, isRetry) }
        ]
      })
    });
    const raw = extractModelText(data);
    if (!raw) return { text: "", reason: "empty" };
    const cleaned = stripReplyDecorations(raw);
    const reason = getReplyCandidateIssue(cleaned);
    if (reason) return { text: "", reason };
    return { text: cleaned, reason: "" };
  };

  const first = await requestOnce(false);
  if (!first.text) {
    if (scene !== "manual_draft") return { draft: "[SKIP]", reason: first.reason || "invalid" };
    const manualRetry = await requestOnce(true).catch(() => "");
    if (manualRetry?.text) return { draft: manualRetry.text, reason: "" };
    throw new Error(`模型未生成可用草稿（${manualRetry?.reason || first.reason || "invalid"}）`);
  }
  const firstScore = scoreReplyNaturalness(first.text, postText);
  if (firstScore >= 65) return { draft: first.text, reason: "" };
  const retry = await requestOnce(true).catch(() => "");
  if (!retry?.text) return { draft: first.text, reason: "" };
  return { draft: scoreReplyNaturalness(retry.text, postText) >= firstScore ? retry.text : first.text, reason: "" };
}

function stripReplyDecorations(value) {
  let text = String(value || "").trim()
    .replace(/^```(?:text|plaintext)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(?:回复|评论|reply)\s*[:：]\s*/i, "")
    .replace(/^[“\"']|[”\"']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^\[skip\]$/i.test(text)) return "[SKIP]";
  const escapedEmotions = REPLY_EMOTION_POOL
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((emotion) => emotion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escapedEmotions.length) {
    text = text.replace(new RegExp(`^(?:${escapedEmotions.join("|")})(?:[，,、:：!！。\\s]*)`, "i"), "");
  }
  text = text.replace(/(?:记得回踩喔|记得回访喔)\s*[。.!！。]*\s*$/i, "").trim();
  return text;
}

function scoreReplyNaturalness(reply, originalTweet) {
  const text = String(reply || "").trim();
  if (!text || text === "[SKIP]") return 0;
  let score = 100;
  if (text.length > 30) score -= 25;
  else if (text.length > 24) score -= 10;
  const commaCount = (text.match(/[，,]/g) || []).length;
  if (commaCount >= 2) score -= 20;
  else if (commaCount === 1) score -= 5;
  const aiBuzzwords = ["确实很", "很有诚意", "非常到位", "值得", "期待", "不仅", "而且", "提供了", "展现了", "淋漓尽致", "相得益彰", "不言而喻", "完美中和", "很有食欲", "工作热情", "性价比提升", "各有优势", "很有道理", "值得深思"];
  for (const word of aiBuzzwords) if (text.includes(word)) score -= 20;
  if (/^(?:你|博主|作者|这篇帖子|这个作品)/.test(text)) score -= 10;
  if (/(不仅.*而且|这说明|这意味着|总体来看|由此可见)/.test(text)) score -= 20;
  const cleanOrig = String(originalTweet || "").replace(/\s+/g, "");
  const cleanReply = text.replace(/\s+/g, "");
  if (cleanReply.length >= 6) {
    for (let i = 0; i <= cleanReply.length - 4; i += 1) {
      if (cleanOrig.includes(cleanReply.slice(i, i + 4))) { score -= 15; break; }
    }
  }
  return score;
}

function chatCompletionsEndpoint(endpoint) {
  const url = new URL(String(endpoint || "").trim());
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") url.pathname = "/v1/chat/completions";
  else if (/\/(?:v1|v3|api\/v3)$/i.test(path)) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

async function requestModelJson(endpoint, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    let requestUrl = chatCompletionsEndpoint(endpoint);
    let requestBody = options.body;
    let response = await fetch(requestUrl, { ...options, body: requestBody, signal: controller.signal });
    let raw = await response.text();
    let data = parseResponseJson(raw);
    // Some OpenAI-compatible gateways use the newer field name and reject max_tokens.
    // Retry only for this explicit schema error so other provider failures are not duplicated.
    let errorText = responseErrorText(raw, data);
    if (!response.ok && response.status === 400 && /unknown field[^\n]*max_tokens/i.test(errorText)) {
      requestBody = replaceMaxTokensField(requestBody);
      if (requestBody) {
        response = await fetch(requestUrl, {
          ...options,
          body: requestBody,
          signal: controller.signal
        });
        raw = await response.text();
        data = parseResponseJson(raw);
        errorText = responseErrorText(raw, data);
      }
    }
    // A few gateways route newer models through the OpenAI Responses protocol and
    // return this Go JSON decoder error when Chat Completions' `messages` field is used.
    // Retry against /responses only for that explicit schema mismatch; standard
    // OpenAI, DeepSeek, 豆包 and other Chat Completions providers keep their normal path.
    if (!response.ok && response.status === 400 && /unknown field[^\n]*["']?messages/i.test(errorText)) {
      const retry = buildResponsesRequest(endpoint, requestBody);
      if (retry) {
        requestUrl = retry.url;
        requestBody = retry.body;
        response = await fetch(requestUrl, {
          ...options,
          body: requestBody,
          signal: controller.signal
        });
        raw = await response.text();
        data = parseResponseJson(raw);
      }
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || raw.slice(0, 160);
      throw new Error(`API 返回 ${response.status}${detail ? `：${detail}` : "，请检查模型、密钥和服务状态"}`);
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("模型请求超过 45 秒，已取消本次请求");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseResponseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {}
  // Some gateways still emit Server-Sent Events even when stream:false is sent.
  const events = raw.split(/\r?\n/)
    .map((line) => line.replace(/^data:\s*/, "").trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  if (!events.length) return {};
  const deltas = events.map(streamDeltaFromEvent).filter(Boolean).join("");
  const finalEvent = events[events.length - 1];
  return deltas ? { ...finalEvent, output_text: deltas } : finalEvent;
}

function streamDeltaFromEvent(event) {
  return event?.delta || event?.output_text?.delta || event?.response?.output_text?.delta ||
    event?.choices?.[0]?.delta?.content || event?.text || "";
}

function responseErrorText(raw, data) {
  return [raw, data?.error?.message, data?.message].filter(Boolean).join(" ");
}

function responsesEndpoint(endpoint) {
  const url = new URL(String(endpoint || "").trim());
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") url.pathname = "/v1/responses";
  else if (/\/chat\/completions$/i.test(path)) url.pathname = path.replace(/\/chat\/completions$/i, "/responses");
  else if (/\/(?:v1|v3|api\/v3)$/i.test(path)) url.pathname = `${path}/responses`;
  else if (!/\/responses$/i.test(path)) url.pathname = `${path}/responses`;
  return url.toString();
}

function buildResponsesRequest(endpoint, body) {
  if (typeof body !== "string") return null;
  try {
    const payload = JSON.parse(body);
    if (!Array.isArray(payload.messages)) return null;
    const input = payload.messages.map((message) => ({
      role: message.role || "user",
      content: typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("")
          : String(message.content || "")
    }));
    const responsePayload = {
      model: payload.model,
      input,
      stream: false,
      max_output_tokens: payload.max_output_tokens ?? payload.max_completion_tokens ?? payload.max_tokens
    };
    if (payload.temperature !== undefined) responsePayload.temperature = payload.temperature;
    if (payload.presence_penalty !== undefined) responsePayload.presence_penalty = payload.presence_penalty;
    return { url: responsesEndpoint(endpoint), body: JSON.stringify(responsePayload) };
  } catch {
    return null;
  }
}

function replaceMaxTokensField(body) {
  if (typeof body !== "string") return null;
  try {
    const payload = JSON.parse(body);
    if (!Object.prototype.hasOwnProperty.call(payload, "max_tokens")) return null;
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function extractModelText(data) {
  return textFromResponseValue(data);
}

function textFromResponseValue(value, depth = 0) {
  if (depth > 10 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => textFromResponseValue(item, depth + 1)).filter(Boolean).join("").trim();
  }
  if (typeof value !== "object") return "";
  // These keys cover Chat Completions, Responses, Anthropic and Gemini-compatible
  // wrappers, including gateways that nest the upstream response under data/result.
  for (const key of [
    "output_text", "text", "content", "message", "output", "response",
    "choices", "candidates", "parts", "data", "result", "value"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = textFromResponseValue(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}
