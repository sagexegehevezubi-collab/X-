# X助手（Chrome MV3）

## 安装
1. 在 Chrome 打开 `chrome://extensions` 并开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本目录。
3. 点击工具栏中的扩展图标，再点“打开网页版控制台”。控制台选择任务，通过“设置模型 API”。
4. 重新加载扩展并刷新 X 页面。

## 模型接口

设置页支持 OpenAI Chat Completions 兼容接口，可直接选择 DeepSeek、豆包（火山方舟）、OpenRouter 或自定义服务。选择豆包时，API 地址使用火山方舟地址，模型名称填写控制台创建的 Endpoint ID（例如 `ep-xxxx`）。自定义服务需要填写完整的 HTTPS 接口地址、模型名称和对应的 API Key；兼容本机网关时可使用 `http://localhost`。


