const defaults = {
  provider: "vibe",
  endpoint: "https://api.vibe-subsapi.net/v1/chat/completions",
  model: "",
  apiKey: "",
  authMode: "bearer",
  authHeaderName: "Authorization",
  replyMode: "ai",
  fixedReplyText: ""
};

const providerField = document.getElementById("provider");
for (const [id, preset] of Object.entries(MODEL_PROVIDERS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = preset.label;
  providerField.appendChild(option);
}

function updateAuthMode() {
  const mode = document.getElementById("authMode").value;
  document.getElementById("customHeaderSettings").hidden = mode !== "custom";
  document.getElementById("apiKey").disabled = mode === "none";
}

function updateProviderNote() {
  document.getElementById("providerNote").textContent = providerPreset(providerField.value).note;
}

providerField.addEventListener("change", () => {
  const preset = providerPreset(providerField.value);
  document.getElementById("endpoint").value = preset.endpoint;
  document.getElementById("model").value = preset.model;
  document.getElementById("authMode").value = preset.authMode;
  updateAuthMode();
  updateProviderNote();
});
document.getElementById("authMode").addEventListener("change", updateAuthMode);

function updateReplyMode() {
  document.getElementById("fixedReplySettings").hidden = document.getElementById("replyMode").value !== "fixed";
}

document.getElementById("replyMode").addEventListener("change", updateReplyMode);

async function load() {
  const values = await chrome.storage.local.get({ ...defaults, apiKey: "" });
  values.provider = MODEL_PROVIDERS[values.provider] ? values.provider : inferProvider(values.endpoint);
  values.authMode = ["bearer", "x-api-key", "custom", "none"].includes(values.authMode) ? values.authMode : "bearer";
  values.authHeaderName = values.authHeaderName || "Authorization";
  values.replyMode = values.replyMode === "fixed" ? "fixed" : "ai";
  for (const field of Object.keys(defaults)) {
    document.getElementById(field).value = values[field];
  }
  providerField.value = values.provider;
  updateAuthMode();
  updateProviderNote();
  updateReplyMode();
}

document.getElementById("save").addEventListener("click", async () => {
  const values = Object.fromEntries(Object.keys(defaults).map((field) => [
    field,
    document.getElementById(field).value.trim()
  ]));
  if (values.replyMode === "fixed" && !values.fixedReplyText) {
    document.getElementById("status").textContent = "请输入固定回复内容";
    document.getElementById("fixedReplyText").focus();
    return;
  }
  if (!/^https:\/\//i.test(values.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(values.endpoint)) {
    document.getElementById("status").textContent = "API 地址必须使用 HTTPS（本机服务可用 localhost HTTP）";
    return;
  }
  try { new URL(values.endpoint); } catch {
    document.getElementById("status").textContent = "API 地址格式不正确";
    return;
  }
  if (!values.model && values.replyMode === "ai") {
    document.getElementById("status").textContent = "请填写模型名称或 Endpoint ID";
    return;
  }
  if (values.authMode === "custom" && !values.authHeaderName) {
    document.getElementById("status").textContent = "请填写自定义鉴权请求头名称";
    return;
  }
  await chrome.storage.local.set(values);
  document.getElementById("status").textContent = "已保存";
  setTimeout(() => { document.getElementById("status").textContent = ""; }, 2000);
});

load();
