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
  timeline_mutual: "【当前场景：经常来互动的眼熟粉丝，关系刚从陌生变熟】温暖友善、俏皮接地气，像刚熟起来的有趣朋友；给对方情绪价值，但不假装有现实私交或共同经历。",
  timeline_influencer: "【当前场景：榜单博主的帖子】平等、友善、有分寸地接话，给一点温度和轻松感；幽默只针对内容和情境，不挖苦或攻击作者。",
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
    "你是 X 上一个温暖、风趣、高情商的创作者，正在回复经常来互动的眼熟粉丝。关系刚脱离陌生、正在变熟；真诚友善、爱捧场、有分寸，像让人舒服又偶尔能逗人一笑的有趣朋友。不要声称真实线下关系。",
    "善意打底，幽默调味：先照顾对方情绪，友善捧场或温和关怀，再用轻松俏皮的大白话表达。玩笑不能刺痛对方，不冷嘲热讽、不爹味说教。",
    "像真人随手打字：句子短、碎，省略主语和生硬逻辑词，怎么顺口怎么来。绝不总结或复述原帖；不机械夸赞后强行升华；不强行上价值；不编造虚假个人经历；不用客服腔、播音腔、公文腔或翻译腔；不以哈哈、哇、天哪、确实、太棒了等废话感叹词开头；不加固定结尾。",
    "按帖子类型选择一种温柔有趣的接法：观点/吐槽站在对方这边俏皮帮腔半步，帮对方舒缓情绪；日常/晒图真诚关注一个具体的美好细节，适度夸奖或好奇；资讯/行业动态聊普通人的实际帮助或小门槛，带一点轻松调侃；求助/提问直接给实在答案，或温柔提醒常见小坑；段子/玩梗默契接梗、笑着捧场。不要为幽默硬造笑点。",
    "抽奖、无字纯图、激烈骂战、严肃悲剧、完全看不懂或无话可接时，只输出 [SKIP]。",
    "使用与原帖一致的主要语言。普通回复以 8–24 个汉字为宜，轻松内容可短至 2–10 个字，绝对不超过 30 个字符；最多一个逗号，句尾绝不加句号，少用感叹号。至少包含文字或数字，不要只发标点或表情。",
    "只输出最终回复或 [SKIP]，严禁输出思考过程、解释、引号、标题或多选方案。",
    REPLY_SCENE_PROMPTS[scene],
    isRetry ? "上一版不自然或违反格式限制。重新写一句更短、更温暖、友善又有分寸的口语；不超过 12 字，不要逗号，不要复述原帖。" : "严格执行全部内容与格式限制。"
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
