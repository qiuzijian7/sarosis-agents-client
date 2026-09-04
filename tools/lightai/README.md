# LightAI → OpenAI 兼容适配器

把腾讯光子内部的 **LightAI**（aigclsp.com 的 gemini-chat 应用）包装成 OpenAI 兼容接口，
以便像 `chatgpt2api` 一样在 VsSaros 里作为 **custom BYOK provider** 使用。

LightAI 本身不是 OpenAI 兼容服务，真实协议为：
- `POST /api/gemini/chat/create_conversation` → 建会话，返回 `{id}`
- `POST /api/gemini/chat/send_message/{id}` → SSE 流式返回（`data: {"text","thought"}` ... `data: {"done":true}`）

本适配器对外暴露：
- `POST /v1/chat/completions`（支持 `stream` / 非 stream）
- `GET  /v1/models`

## 零依赖
仅用 Node 内置 `http` / `https`，无需 `npm install`。要求 Node ≥ 14。

## 运行
```bash
cp .env.example .env      # 填入 cookie / x-user-id（从浏览器 DevTools 复制）
node server.js
```
健康检查：`curl http://localhost:8011/health`

## 获取 cookie / x-user-id
1. 浏览器登录 LightAI（会跳 Oasis/QQ OAuth）
2. F12 → Network → 选中任意一条 `aigclsp.com` 请求
3. 复制 Request Headers 里的 `cookie` 与 `x-user-id` 填进 `.env`
> 凭据会过期（sessionid 失效），届时重新复制即可。

## ⚠️ 重要：部署位置限制
LightAI 上游（`aigclsp.com`）对**来源 IP 有白名单限制**，只接受腾讯办公网内的请求。
经验证：从 **AnyDev 云主机**调用会返回 `{"detail":"没有访问权限"}`（cookie 有效也会被拒），
而**本机（已登录 LightAI 的办公网机器）调用正常**。

因此适配器**必须运行在腾讯办公网内的机器上**（本机或内网服务器），不能像 chatgpt2api 那样放 AnyDev。
推荐：直接在你运行 VsSaros 的本机后台启动此适配器，VsSaros 用 `http://localhost:8011/v1` 连接。

## 在本机运行（推荐）
```powershell
cd tools\lightai
copy .env.example .env        # 填入 cookie / x-user-id
# 后台启动
Start-Process -FilePath node -ArgumentList "$PWD\server.js" -WindowStyle Hidden
# 或简单点： node server.js  （保持终端开着）
```
> 仓库根 package.json 是 "type":"module"，本目录的 package.json 已声明 "type":"commonjs"，
> 所以请直接用 `node server.js`（不要改成 .mjs，也不要在根目录跑）。

## 在 VsSaros 注册为 custom provider
设置 → Agent Studio → 自定义 Provider → 新增：
- 名称：lightai
- 类型：OpenAI 兼容
- Base URL：`http://localhost:8011/v1`（本机）或内网机器 IP
- API Key：任意（上游不校验，填 `lightai` 即可）
- Models Endpoint：留空（适配器 `/v1/models` 返回静态列表）

保存后，聊天节点的 provider 下拉即可选择 `lightai`，模型选 `gemini-3.5-flash`。

## 多轮消息收发（仿 chatgpt2api）

本适配器仿照 chatgpt2api 的消息收发能力，支持多轮连续对话：

- **会话复用**：按 `X-Conversation-ID` header（VsSaros 每次请求自动携带）> body `user` >
  `Authorization` 的优先级复用同一个 LightAI conversation。历史由 LightAI 服务端按
  conversation_id 维护，复用会话即延续上下文。
- **完整 messages 解析**：`system` 消息在**新建会话**时注入到首条 `text` 前（多轮不重复注入），
  `user` 消息取最后一条作为本轮发送内容（历史不重复回放，避免重复计费/重复上下文）。
- **WAF 无害化**：发送前对 `<script>` / `javascript:` / `on*=` / `union select` 等字面量拆散
  （保持可读），避免上游 WAF 403 拦截。
- **会话失效自愈**：`send_message` 返回非 200 时自动清除映射，下次请求重建 conversation。

## 已知限制
- `thought`（深度思考）过程目前作为 `content` 透传；如需隐藏可改 `server.js` 中
  `obj.thought` 判断跳过。
- 模型名固定走 `LIGHTAI_MODELS`（默认 `gemini-3.5-flash`）。若 LightAI 开放更多模型，
  在 `.env` 里追加逗号分隔即可。
