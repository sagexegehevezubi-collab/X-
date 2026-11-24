// 供应商预设都使用 OpenAI Chat Completions 兼容协议。
// 用户仍可选择“自定义”并填写任意兼容此协议的服务。
const MODEL_PROVIDERS = Object.freeze({
  vibe: {
    label: "中转站（OpenAI 兼容）",
    endpoint: "https://api.vibe-subsapi.net/v1/chat/completions",
    model: "",
    authMode: "bearer",
    note: "沿用原 X 回复助手的中转站配置；模型名称以服务商控制台为准。"
  },
  heidawang: {
    label: "heidawang（推荐代理）",
    endpoint: "https://heidawang.top/v1/chat/completions",
    model: "gpt-6-sol",
    authMode: "bearer",
    note: "使用 OpenAI 兼容的 Chat Completions 接口。"
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    authMode: "bearer",
    note: "模型可填写 deepseek-chat 或 deepseek-reasoner。"
  },
  doubao: {
    label: "豆包（火山方舟）",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "",
    authMode: "bearer",
    note: "模型填写火山方舟控制台创建的 Endpoint ID，例如 ep-xxxx。"
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    authMode: "bearer",
    note: "模型填写 OpenRouter 的模型 ID，例如 deepseek/deepseek-chat。"
  },
  custom: {
    label: "自定义 OpenAI 兼容接口",
    endpoint: "",
    model: "",
    authMode: "bearer",
    note: "支持任意返回 choices[0].message.content 的 Chat Completions 服务。"
  }
});

function providerPreset(id) {
  return MODEL_PROVIDERS[id] || MODEL_PROVIDERS.custom;
}

function inferProvider(endpoint) {
  const value = String(endpoint || "").replace(/\/+$/, "");
  return Object.entries(MODEL_PROVIDERS).find(([, preset]) => preset.endpoint === value)?.[0] || "custom";
}
