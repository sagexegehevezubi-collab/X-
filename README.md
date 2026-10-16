# X助手

X助手 Chrome MV3 扩展的版本备份仓库。

## 版本

- `X助手-0.2.0`：初始备份版本，标签 `v0.2.0`
- `v0.2.1`：扩展首页互关/评论关键词，保留原有关键词并加入用户指定词语
- `v0.2.2`：加入按顺序轮换的 AI 回复情绪开头词池，严肃语境自动跳过
- `v0.2.3`：功能二每条评论至少间隔 20 秒，并在总控制台显示当日成功评论数
- `v0.2.4`：兼容拒绝 `max_tokens`、要求 `max_completion_tokens` 的 API 网关
- `v0.2.5`：中转站直接使用 `max_completion_tokens`，并增强字段错误识别
- `v0.2.6`：中转站返回 `unknown field "messages"` 时自动切换到 Responses `/v1/responses` 协议
- `v0.2.7`：兼容嵌套 Responses、Anthropic、Gemini 等多种返回文本格式，避免误报空草稿

以后每次迭代保留一个版本目录，并使用对应的 Git 标签记录，便于回退和恢复。
