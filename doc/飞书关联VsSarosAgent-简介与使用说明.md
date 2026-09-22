# 飞书关联 VsSaros Agent（Channel / Bridge）

> **一句话**：把飞书自建应用（机器人）绑定到本机 VsSaros，让**飞书里的消息直接进入 Agent 会话** —— 在飞书 @机器人 → 长连接收事件 → BridgeEngine 按绑定关系路由到指定 Agent/会话 → Agent 执行 → 回复回投飞书（含卡片）。**无需公网回调地址、无需外部桥接进程、无需重启窗口**。
>
> 本文档分两部分：**一、简介**（对比其他方案存在的问题，以及我们如何解决）；**二、使用说明**（详细操作步骤）。

---

## 一、简介

### 1.1 它是什么

**端到端链路**：

```
飞书服务器
  (1) 换地址   POST https://open.feishu.cn/callback/ws/endpoint   {AppID, AppSecret}
  (2) 长连接   wss  WebSocket（protobuf/pbbp2 二进制帧；心跳 ping / 分片重组 / 回执 / 自动重连）
  (3) 事件     DATA/event → 事件名白名单（im.message.receive_v1）→ sessionKey = feishu:<chat_id>:<open_id>
  (4) 准入     BridgeEngine.handleInbound → allowFrom 白名单 → 是 slash 命令走命令 → 否则 _routeToAgent
  (5) 路由     ensureSession：精确 chat 绑定 > 渠道默认会话 > 渠道默认 Agent > 引擎默认 > 偏好 coder
  (6) 执行     AgentChatService.sendMessage(agentId, content, {agentSessionId, chatMode, model}, onDelta)
  (7) 回投     reply（POST /im/v1/messages/{messageId}/reply）或 send（POST /im/v1/messages?receive_id_type=chat_id）
               token：POST /auth/v3/tenant_access_token/internal（60s 安全窗口缓存）
```

**关键设计约束**：

| 约束 | 原因 |
| --- | --- |
| **入站只走长连接**（WebSocket），不做 Webhook | 桌面端渲染进程**没有 Node `http`**，也没有公网回调地址；长连接无同源限制、无需公网入口 |
| **所有 HTTP 走主进程出口**（`VSSAROS_LLM_CHANNEL#httpRequest`） | 桌面端 origin 是 `vscode-file://vscode-app`，飞书 OpenAPI 不返回 CORS 头 ⇒ renderer 直连全部被拦（`net::ERR_FAILED`）。**注意**：DI 的 `IRequestService` 在桌面端仍是 renderer fetch，不是主进程出口 |
| **无外部 SDK / 无外部进程** | 桥接层是**进程内**实现（复刻 cc-connect 设计）；HTTP 走注入的 requestService，WS 用渲染进程全局 `WebSocket`；protobuf 帧手写编解码（22 条字节级用例锁定） |
| **配置热重载** | 配置变更 800ms 防抖后重新装配平台，**无需重启窗口** |

**模块清单**（均在 `src/vs/sessions/contrib/agentStudio/`）：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 类型 / 命令 / 安全（common） | `common/bridge/bridgeTypes.ts`、`bridgeCommands.ts`、`bridgeSecurity.ts` | 平台接口与状态机（`disconnected/connecting/connected/error`）、内置 slash 命令、`allowFromCheck` |
| 引擎 / 服务 | `browser/bridge/bridgeEngine.ts`、`bridgeService.ts` | 入站准入 → 会话解析 → Agent 路由 → 出站分发；DI 单例（`IBridgeService`） |
| 生命周期 | `browser/bridge/bridge.contribution.ts` | 启动装配 + **配置变更热重载** |
| 飞书适配器 | `browser/bridge/platforms/feishu.ts` | 长连接 / 入站解析 / 出站（文本+卡片）/ token / 重连 |
| 飞书装配 | `browser/bridge/platforms/feishu.contribution.ts` | 凭证解析（**env 优先、配置兜底**）、白名单归一化、按条件注册平台 |
| 长连接协议 | `browser/bridge/platforms/feishuWsProtocol.ts` | pbbp2 帧编解码、`/callback/ws/endpoint` |
| 绑定 / 会话映射 | `browser/bridge/bridgeBindings.ts`、`bridgeSessionMap.ts` | `bindings.json`、`sessionMap.json`（工作目录 `<cwd>/.saros/bridge`） |
| 主进程 HTTP 出口 | `browser/mainProcessRequestService.ts` | 把 `VSSAROS_LLM_CHANNEL#httpRequest` 包成请求服务 |
| 配置 UI | `browser/channelEditorPane.ts` / `channelEditorInput.ts` / `feishuRegistration.ts` / `feishuQrCode.ts` | 渠道配置页、扫码绑定（device flow）、二维码生成、测试连接 |
| 状态与图标 | `browser/bridge/channelStatus.ts`、`browser/channelIcons.ts` | 状态徽章判定（纯函数）、品牌 SVG |
| 绑定 UI | `browser/settingsEditorPane.ts`、`agentSettingsEditorPane.ts`、`sessionHistoryView.ts`、`nativeChatEditorPane.ts` | 设置页渠道条目徽章入口、Agent 渠道绑定 Tab、会话列表绑定、聊天框 header 标签 |

> **两条「绑定」必须分清**：
> ① **凭证绑定** = 把飞书**应用**（App ID/Secret）接到本机 → 决定「渠道能否收发」；
> ② **会话绑定** = 把飞书**会话/群**（`chat_id`）或整个渠道接到某个 **Agent** → 决定「消息交给谁处理」。

### 1.2 其他方案存在的问题

| 方案 | 存在的问题 |
| --- | --- |
| **飞书官方「事件订阅 → 请求地址（Webhook 回调）」** | ① 必须有一个**公网可达**的回调地址（本机开发要内网穿透/反向代理）；② 要自行实现 `verificationToken` 校验、`encryptKey` AES 解密、`challenge` 应答，任一环漏掉事件就被**静默丢弃**；③ 在桌面 IDE 里**渲染进程没有 Node `http`**，根本无法自己起 HTTP 入口（本项目早期注释就与实现不符，属 D-04 未修）；④ 回调不可达时飞书侧只报错，本地无日志可查。 |
| **外部桥接程序（cc-connect 等独立 Go 进程 / OpenClaw CLI 等）** | ① 需要**额外下载、安装、常驻**一个外部二进制，跨平台分发与杀软拦截都是问题；② 要自己维护端口、路径、配置文件，跨机器需重新配；③ 与本机 Agent Studio 的会话/Agent 元数据是两套，绑定关系要跨进程同步；④ 出问题时链路跨两个进程，排查成本高。 |
| **飞书官方 MCP / OpenAPI 工具（`feishu_doc_*` / `feishu_drive_*`）** | 这是**「Agent 主动读写飞书文档/云盘」**，不是「在飞书里和 Agent 对话」：① 没有对话入口 —— 用户必须在 IDE 里操作，无法随手在飞书里提问；② 没有会话路由与身份白名单；③ 没有常驻连接，不解决「消息实时到达」。 |
| **手工复制粘贴 / 脚本轮询飞书消息** | ① 无实时性（轮询延迟 + 限流）；② 无会话上下文（每次都是新对话）；③ 无并发、去重、重连、回执机制；④ 没人维护就断。 |
| **自己写代码直连飞书 OpenAPI** | 需要自己实现：`tenant_access_token` 换取与缓存、事件订阅长连接（**含 protobuf 二进制帧、心跳、分片重组、回执、重连**）、消息去重、CORS 绕行、错误可读化、会话映射与绑定持久化 —— 每一项都是坑（本项目内部报告记录的 D-01…D-17 里，多数正是这些）。 |

### 1.3 我们如何解决

| 上游问题 | 我们的解法 |
| --- | --- |
| 需要公网回调地址 / 无法起 HTTP 服务 | **长连接入站**：官方协议 `POST /callback/ws/endpoint` 换 wss 地址，然后 WebSocket 长连（**无需公网回调地址**）。实现含：心跳（`ping`，service_id，心跳 120s）、分片重组（`sum/seq` + 5s TTL）、回执（复用原帧 + `biz_rt`）、自动重连；握手失败有单一入口 `_linkDown()` 处理（修掉「只发 `onerror` 不发 `onclose` ⇒ 渠道永久死链」的历史缺陷）。 |
| 需要外部桥接进程 | **进程内桥接层**：`BridgeEngine` + 平台适配器直接在 IDE 进程里跑；**无外部 SDK 依赖**（protobuf 帧手写编解码，22 条字节级用例锁定协议）；工作目录固定 `<cwd>/.saros/bridge`，绑定/会话映射落 JSON。 |
| 桌面端 CORS 拦死请求 | **统一主进程 HTTP 出口**：`VSSAROS_LLM_CHANNEL#httpRequest`（对齐仓库既定的「renderer ↔ node ↔ electron-main」通道范式）。并有**契约用例**用「一旦被调用即抛错的 `fetch`」锁死「渠道平台内不得回落到 renderer fetch」。 |
| 手工配凭证麻烦 | **扫码绑定（Device Flow）**：走飞书官方 PersonalAgent 注册协议（`action=init` → `begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id` → `poll&device_code`），成功后**自动写入 App ID / App Secret、打开「启用」、并把授权人 open_id 追加进 `Allow From`**（即「自己给自己开白名单」）。二维码为自研生成（V1–V7 EC-L），超长授权链接自动回落「🔗 复制授权链接」。 |
| 配了值不生效 / 要重启 | **配置即真相 + 热重载**：装配读取 `sessions.channel.feishu.*`（**env 优先、配置兜底**），`enabled === true` 且凭证完整才注册平台；配置变更 800ms 防抖热重载，**无需重启窗口**（关闭「启用」会卸载平台）。多行白名单自动归一化为逗号分隔（修掉「多行白名单整体失效」）。 |
| 不知道消息会交给哪个 Agent | **明确的路由优先级链**：精确 `chat_id` 绑定 > 渠道默认会话 > 渠道默认 Agent > 引擎默认 Agent > 偏好（coder/general）；并支持每条消息自动建专属会话。绑定关系可用 UI / 会话列表 / `/bind` 命令三种方式管理，落盘 `bindings.json` **跨重启保持**。 |
| 出问题只能猜 | **失败不静默 + 可视化**：未知事件名记日志、非文本消息明确跳过并记日志（`忽略暂不支持的消息类型：image`）；状态徽章 8 种文案（`未配置 / 已停用 / 已启用 · 未装配 / 已连接 / 连接中… / 异常 / 已启用 · 未连接 / 未实现`）；`lastError` / `lastFrameAt` 可查；聊天框 header 与会话列表都有绑定标签（含「飞书 · 默认会话」实底态）。 |
| 连接是否真的活着无法自证 | **真实自检**：`🧪 测试连接` 调 `tenant_access_token` 真实校验凭证（成功回显有效期、失败回显 HTTP 状态与飞书 `code/msg`，appSecret 脱敏）；另有**离线探针**可在不启动客户端的情况下验证长连接（退出码 0/2/3/4 对症）。 |

**仍然存在的限制（诚实标注）**：

- **入站仅支持长连接**：`Verification Token` / `Encrypt Key` 两个字段在 UI 上已标注「仅 Webhook 回调模式使用，**当前版本未启用该模式**」；Webhook 入口（D-04）与事件验签/解密（D-09）**未实现**。
- **四个策略字段未接线**：`dmPolicy` / `groupPolicy` / `groupAllowFrom` / `defaultAccount` 无运行时消费者（UI 描述已如实标注「当前版本未生效」）。目前生效的准入控制是 `Allow From` 白名单与 `enabled` 开关。
- **仅 bot 身份**（`tenant_access_token`），不支持 `user_access_token`。
- **出站无真正流式**：文本在 Agent `done` 时整体发送（中间只发 `⚙️ <tool>` / `✅ <tool> 完成` 事件文本）。
- **卡片按钮回调未实现**：收到 `card.action.trigger` 帧只记日志「收到卡片交互帧（card），当前版本未实现处理」。
- **图片/文件等非文本消息跳过**（不转发给 Agent）。
- **端到端实测未闭合**：协议/基址/响应形状已用真实网络探测验证，但「握手能否通过」需在真实应用上连一次（见 2.11）。

### 1.4 能力矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 单聊 / 群聊 / @机器人 · 文本消息 | ✅ | 会话维度按 `chat_id`，`sessionKey = feishu:<chat_id>:<open_id>` |
| 出站富卡片（`interactive`） | ✅ | markdown / hr / note / 操作按钮（`sendCard` / `replyCard`） |
| 长连接入站（含心跳/分片/回执/重连） | ✅ | 唯一入站路径 |
| 多 Agent 绑定与路由规则 | ✅ | 见 1.3 优先级链 |
| Telegram 渠道 | ✅ | 另一真实适配器（出站同样走主进程出口） |
| 卡片按钮回调 `card.action.trigger` | ❌ | 仅记日志 |
| 图片 / 文件 / 其它消息类型 | ❌ | 明确跳过并记日志 |
| Webhook 回调入站 | ❌ | 无 HTTP 入口（产品口径：入站仅长连接） |
| user_access_token 身份 | ❌ | 仅 bot |
| 其它渠道（Discord / Slack…） | ❌ | 仅配置 schema，无适配器（状态显示「未实现」） |

### 1.5 与相邻功能的边界（别混用）

| 功能 | 干什么 | 入口 |
| --- | --- | --- |
| **本文档：飞书渠道（Bridge）** | 飞书**对话** ↔ Agent **会话**双向 | 设置页 → Channel 配置 → Feishu |
| 飞书文档 MCP 工具（5 个） | Agent **主动读写**飞书文档/云盘评论：`feishu_doc_read`、`feishu_drive_add_comment`、`feishu_drive_list_comments`、`feishu_drive_list_comment_replies`、`feishu_drive_reply_comment` | 内置工具（`category: feishu`） |
| 知识库 → 飞书同步 | 把**知识库笔记**单向镜像到飞书 wiki（走 `lark-cli`，hash 去重） | 知识库设置 → 📤 飞书同步（见 `doc/kb-feishu-sync-spec.md`） |

---

## 二、使用说明

### 2.1 前置条件：准备飞书自建应用

**不用手工建应用**（推荐走 2.2 的扫码绑定，会自动创建 PersonalAgent 应用）；如果你想用已有企业应用，请在飞书开放平台确认：

| 项 | 要求 |
| --- | --- |
| 应用类型 | **自建应用**（企业内） |
| 机器人能力 | **已开启**（否则收不到单聊/群聊消息） |
| 权限 | 至少 **接收与发送消息**（`im:message` / `im:message:send_as_bot`） |
| **事件订阅方式** | **长连接**（不是「请求地址」！） |
| 订阅事件 | 勾选 **`im.message.receive_v1`**（收到消息） |
| 凭证 | 记下 **App ID** / **App Secret**（扫码方式会自动写入，无需手抄） |

> ⚠ 三项最容易漏：**机器人能力未开**、**事件订阅方式选了请求地址**、**没勾 `im.message.receive_v1`** —— 任一不满足都会表现为「连上了但收不到消息」。

### 2.2 第一步：把飞书应用绑定到本机（三选一）

#### 方式 A：扫码绑定（推荐，自动创建/接续 PersonalAgent 应用）

1. 打开 **Agent Studio 设置 → 📡 Channel 配置**。
2. 找到 **Feishu** 条目，**点击它的状态徽章**（例如「● 未配置」）→ 打开「渠道配置」编辑器。
   > 徽章即入口，点击只打开面板、不会折叠分组。
3. 在「**📷 扫码绑定飞书（PersonalAgent）**」卡片上点 **「📷 开始扫码绑定」** → 出现二维码。
4. 用**飞书 App 扫码**并在手机上确认授权。
5. 成功后提示 **「✅ 飞书已绑定，凭证已保存并启用渠道」** —— 系统会写入 `appId` / `appSecret`、把 `enabled` 置为 `true`，并把你的 `open_id` 追加进 `Allow From`。

状态不好时的文案与处置：

| 界面提示 | 含义 / 处置 |
| --- | --- |
| ❌ 你已拒绝授权，绑定已取消 | 重新点 **「📷 重新扫码绑定」** |
| ⌛ 二维码已过期，请重新发起 | 二维码有有效期，重新发起 |
| ⌛ 等待超时，请重新发起 | 同上 |
| 出现 **🔗 复制授权链接** | 二维码内容超长（>154 字节）时的回落：复制链接在飞书里打开 |

#### 方式 B：手填凭证

在渠道配置编辑器里填写 **App ID** / **App Secret**，并打开 **「启用」**。字段改动**即时写入配置，无需保存**（面板上就写着「字段改动即时生效（含热重载装配），无需保存」）。

#### 方式 C：环境变量（CI / 无头环境）

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOW_FROM=ou_xxx,ou_yyy     # 可选，逗号或换行分隔
FEISHU_USE_WS=1                     # 可选，默认即长连接
```

**env 优先于 UI 配置**。另有本地 WS 调试服务开关：`BRIDGE_WS_ENABLE=1` + `BRIDGE_WS_PORT`（仅本地调试协议，**不是**飞书 Webhook 入口）。

### 2.3 第二步：配置字段说明（Feishu 共 12 个字段）

| 字段 | 键（前缀 `sessions.channel.feishu.`） | 默认 | 当前是否生效 |
| --- | --- | --- | --- |
| 启用 | `.enabled` | `false` | ✅ **真实前置条件**：未启用/凭证不完整则平台不注册 |
| App ID | `.appId` | `''` | ✅ |
| App Secret | `.appSecret` | `''` | ✅（password 型，回显脱敏） |
| 长连接接收事件 | `.useWs` | **`true`** | ✅ 入站唯一路径（关掉后仅出站可用） |
| Allow From | `.allowFrom` | `''` | ✅ 发送者白名单（逗号或换行分隔；留空 = 不限制） |
| 默认 Agent | `.defaultAgent` | `''` | ✅ 该渠道新建会话的默认 Agent（留空跟随引擎默认） |
| DM Policy | `.dmPolicy` | `pairing` | ❌ 未接线（UI 标注「当前版本未生效」） |
| Group Policy | `.groupPolicy` | `disabled` | ❌ 未接线 |
| Group Allow From | `.groupAllowFrom` | `''` | ❌ 未接线 |
| Default Account | `.defaultAccount` | `''` | ❌ 未接线（多帐号场景） |
| Verification Token | `.verificationToken` | `''` | ❌ 仅 Webhook 模式使用，当前未启用该模式 |
| Encrypt Key | `.encryptKey` | `''` | ❌ 同上 |
| （单列注册）渠道默认会话 | `sessions.channel.feishu.defaultSession` | `''` | ✅ 未精确绑定 chat 的消息进入此会话；留空则每群自动建专属会话 |

> 所有渠道配置为 **MACHINE 作用域**（存机器级用户设置，**非 keychain**）。绑定关系与会话映射另存 `<工作目录>/bindings.json`、`sessionMap.json`，工作目录 = `<cwd>/.saros/bridge`。

### 2.4 第三步：测试连接（确认真实可用）

在渠道配置编辑器点 **「🧪 测试连接」**：

- ✅ 成功：`连接成功：已获取 tenant_access_token（有效期 7200s）`
- ❌ 失败：`凭证校验失败（HTTP 200 / code 99991663）：app not found`（会回显飞书返回码，appSecret 已脱敏）

旁边还有 **「🔄 恢复默认」** 可还原字段默认值。（早期版本那个「💾 保存配置」空壳按钮已移除。）

### 2.5 第四步：把飞书消息接到某个 Agent（三种方式）

**方式 1：设为渠道默认 Agent（最省事）**

**Agents → 选择某个 Agent → 设置 → 「渠道绑定」Tab**：

- 打开开关 **「将此 Agent 设为飞书渠道的默认处理 Agent（无精确群绑定时生效）」**；
- 可选：在 **「默认会话（未精确绑定的消息进入此会话；留空则每群自动建专属会话）」** 下拉里选一个会话。

**方式 2：按 `chat_id` 精确绑定某个群/会话**

同 Tab 下：在 **「输入飞书群聊会话 ID（chat_id）」** 里粘贴 chat_id → 点 **「➕ 绑定」**。

**方式 3：从会话列表绑定 / 用命令绑定**

- 会话列表里每个会话的绑定按钮：tooltip **「绑定飞书会话（chat_id）」** / **「飞书绑定：…（点击切换或解绑）」**；弹出的输入框标题为 **「绑定飞书会话」** / **「切换飞书绑定」**，占位符 `oc_xxxxxxxxxxxxxxxx`。
- 在**飞书里直接对机器人**发 slash 命令：

```text
/bind <agentId>                 # 把当前飞书会话绑到该 Agent
/bind <会话id> <agentId>        # 把指定会话绑到该 Agent
/bind list                      # 查看现有绑定
/bind clear [会话id]            # 解绑
```

**路由优先级（消息来了交给谁）**：

```
精确 chat_id 绑定  >  渠道默认会话（defaultSession）  >  渠道默认 Agent（defaultAgent）
                 >  引擎默认 Agent  >  偏好（coder / general）
```

三种绑定方式都会落盘 `bindings.json`，**跨重启保持**。

### 2.6 第五步：在飞书里验证

1. 在飞书里找到你的机器人，发一条**文字**消息（单聊直接发；群里需要 @机器人）。
2. 期望看到的日志序列（用来判定链路各段是否通）：

```text
[vssaros-llm] httpRequest POST https://open.feishu.cn/callback/ws/endpoint     ← 主进程出口（无 CORS；注意是域名根，不带 /open-apis）
[Feishu] WS 长连接已建立（service_id=…，心跳 120s）
[Bridge] registered platform: feishu                                            ← 平台已装配
… 事件路由到 Agent，机器人回消息 …
```

3. 判定标准：机器人**能收能回**；`platform.lastFrameAt` 有值说明 pong 在回来（连接真的活着）。
4. 发一张图片测试：应**不回话**，但日志出现 `忽略暂不支持的消息类型：image`（这是预期行为，不是故障）。

### 2.7 可用的内置命令与示例

飞书里可直接对机器人使用的 slash 命令：

```text
/help    /new    /switch   /sessions  /list    /agents  /agent
/model   /mode   /stop     /clear     /relay   /usage   /bind
```

可以这样用（示例）：

```text
# 飞书私聊里
/agents                      # 看有哪些 Agent
/bind coder                  # 把本会话交给 coder
帮我看看这个报错的栈怎么修？   # 直接当聊天用，回答会回到飞书
/mode plan                   # 切模式
/stop                        # 停止当前任务
```

### 2.8 状态与可视化（怎么知道现在什么情况）

**渠道状态徽章（8 种，纯函数判定）**：

| 文案 | 含义 |
| --- | --- |
| `未实现` | 该渠道尚无适配器 |
| `未配置` | 缺凭证 / 未启用 |
| `已停用` | `enabled = false` |
| `已启用 · 未装配` | 已启用但平台还没注册（配置变更后短暂状态） |
| `已连接` | 长连接已建立 |
| `连接中…` | 正在建立 |
| `异常` | 装配/连接出错（可看 `lastError`） |
| `已启用 · 未连接` | 已启用但连接断开（等待重连） |

**平台运行时状态**（渠道配置页内）：`长连接已建立（service_id=…）` / `正在建立长连接…` / `等待重连…` / `未连接` / `未启用长连接（useWs=false，仅出站可用）`。

**绑定可视化**：

- **聊天框 header**（agent 选择器右侧）：蓝框药丸 **「飞书」**；若该会话是渠道默认会话则显示**实底** **「飞书 · 默认会话」**（内含飞书品牌 logo）。
- **会话列表**：对应会话显示 `.session-history-feishu-tag` 标记，与聊天框口径一致。
- 两处标签由 `onDidChangeBindings` 事件驱动，**增删绑定即时刷新**。

### 2.9 生效规则（什么时候需要重启？）

| 改动 | 生效方式 |
| --- | --- |
| 渠道字段（App ID/Secret、启用、Allow From、useWs、默认 Agent…） | **即时生效**（800ms 防抖热重载装配），无需保存、无需重启窗口 |
| 关闭「启用」 | 平台被卸载（日志：`飞书渠道配置已变更 → 未启用或凭证不完整，平台已卸载`） |
| Agent 渠道绑定（默认 Agent / chat_id / 默认会话） | 即时（写入 `bindings.json`，事件广播刷新 UI） |
| `dmPolicy` / `groupPolicy` / `groupAllowFrom` / `defaultAccount` | **改了没有任何运行时变化**（未接线，UI 已标注） |
| 环境变量 | 进程启动时读取，改动需重启进程 |

### 2.10 排错速查

| 现象 | 排查 |
| --- | --- |
| 徽章显示「未配置 / 已停用」 | 检查「启用」是否打开、App ID / Secret 是否填写；env 是否覆盖 |
| 「🧪 测试连接」失败 | 看回显的飞书 `code/msg`：`app not found` = 凭证错；另确认应用未被停用 |
| 徽章「已连接」但飞书发消息没反应 | ① 应用是否开启**机器人能力**；② 事件订阅方式是否为**长连接**；③ 是否勾选 `im.message.receive_v1`；④ 你的 `open_id` 是否在 `Allow From` 里（非白名单用户会被拒） |
| 日志 `忽略未处理的消息事件类型：…` | 说明事件名与白名单不匹配（飞书侧新事件类型）——按日志补白名单 |
| 日志 `忽略暂不支持的消息类型：image` | 正常行为：目前只处理文本消息 |
| 收得到但回不出去 / 控制台 CORS 报错 | 渠道网络必须走**主进程出口**；若栈里出现 `requestImpl.ts … net::ERR_FAILED` 说明走成了 renderer fetch（历史 D-12） |
| 长连接握手失败（`长连接握手失败（请确认应用已开启长连接、事件已勾选、App 凭证与权限正确）`） | 浏览器 WS 读不到官方 `handshake-status` 响应头，只能给可能性提示；请回开放平台核对「事件订阅方式 = 长连接」+ 事件勾选 + 凭证权限 |
| 换地址返回 404 `page not found` | 端点**必须**是 `https://open.feishu.cn/callback/ws/endpoint`（域名根，**不带 `/open-apis`**） |
| 群聊里 @机器人没响应 | 群聊是否被 `Allow From` 拦截；是否 `groupPolicy`（该字段当前未生效，不构成拦截原因） |
| 改了策略字段没反应 | 预期：该四个字段未接线（见 1.3 限制） |

### 2.11 未闭合项与验证工具（重要，先看这里）

| 未闭合项 | 状态与做法 |
| --- | --- |
| **① 长连接端到端实测** | 协议/基址/响应形状已用真实网络探测验证、编解码有 22 条字节级用例兜底，但**握手能否通过**只能真实环境确认。**先跑探针**（不需要启动客户端）： |
| **② Webhook 入站（D-04）+ 验签/解密（D-09）** | 未实现。若要支持：需在**主进程**补 HTTP 入口 + `verificationToken` 校验 + `encryptKey` AES 解密 + `challenge` 应答 |
| **③ 四个策略字段（D-08 剩余）** | 未接线。需要把 `dmPolicy` / `groupPolicy` / `groupAllowFrom` 落到 `BridgeEngine` 的消息准入判定（属安全语义变更，建议先确认取值与默认值语义） |
| **④ Telegram 附件真下载** | 出站 POST 已修（原被 CORS 预检拦死）；附件目前仅文本通路 |

**长连接探针（推荐先跑）**：

```powershell
# node <仓库>/src/vs/sessions/contrib/agentStudio/test/node/run-feishu-ws-probe.mjs --appId <AppID> --appSecret <AppSecret>
node src/vs/sessions/contrib/agentStudio/test/node/run-feishu-ws-probe.mjs --appId cli_xxx --appSecret xxx
```

退出码即结论（自带对症提示）：

| 退出码 | 含义 |
| --- | --- |
| `0` | 长连接可用 |
| `2` | 换地址失败（错误会带飞书 `code/msg`，如应用未开启长连接、凭证错误） |
| `3` | 握手失败（确认应用已开启长连接、事件已勾选、凭证与权限正确） |
| `4` | 建连成功但无帧（连接活着但没收到 pong/数据帧） |

> 另有同目录的联测 runner：`run-feishuWsLive-tests.mjs`（真连联测）。注意：`package.json` 中当前**没有**注册 `probe-feishu-ws` / `test-agentstudio-feishu-ws` 这类 npm script，请直接调用上面的 runner 文件。

---

## 附录：源码与文档索引

| 模块 | 路径（相对 `src/vs/sessions/contrib/agentStudio/`） |
| --- | --- |
| 渠道定义 / 配置 schema | `common/constants.ts`（`CHANNEL_DEFINITIONS`、Feishu 12 字段）、`browser/agentStudio.contribution.ts`（`MACHINE` 作用域注册） |
| 渠道配置编辑器 / 扫码绑定 / 二维码 / 测试连接 | `browser/channelEditorPane.ts`、`channelEditorInput.ts`、`feishuRegistration.ts`、`feishuQrCode.ts` |
| 渠道状态与图标 | `browser/bridge/channelStatus.ts`、`browser/channelIcons.ts` |
| 平台装配（env 优先 / 配置兜底 / 热重载） | `browser/bridge/platforms/feishu.contribution.ts`、`browser/bridge/bridge.contribution.ts` |
| 飞书适配器与长连接协议 | `browser/bridge/platforms/feishu.ts`、`feishuWsProtocol.ts` |
| 路由引擎 / 桥接服务 | `browser/bridge/bridgeEngine.ts`、`bridgeService.ts` |
| 准入 / 命令 / 类型 | `common/bridge/bridgeSecurity.ts`、`bridgeCommands.ts`、`bridgeTypes.ts` |
| 绑定与会话映射持久化 | `browser/bridge/bridgeBindings.ts`、`bridgeSessionMap.ts`（工作目录 `<cwd>/.saros/bridge`） |
| 主进程 HTTP 出口 | `browser/mainProcessRequestService.ts` |
| 绑定 UI（Agent 设置 / 会话列表 / 聊天框标签） | `browser/agentSettingsEditorPane.ts`、`contrib/sessionHistory/browser/sessionHistoryView.ts`、`browser/nativeChatEditorPane.ts` |
| 设置页渠道条目与徽章入口 | `browser/settingsEditorPane.ts` |
| 联调探针与测试 | `test/node/feishuWsProbe.ts`、`feishuWsLive.test.ts`、`run-feishu-ws-probe.mjs`、`test/browser/feishuChannel.test.ts`、`feishuWsProtocol.test.ts`、`mainProcessRequestService.test.ts` |
| 设计文档 | `docs/cc-connect-bridge-design.md`（桥接层模块映射与分阶段路线） |
| 可用性报告（缺陷 D-01…D-17 / mockup / 用例 / 手工验收） | `doc/channel-feishu-usage-report.html` |
| 相邻功能（别混用） | 飞书文档 MCP：`resources/.agents/tools/feishu_*.json`；知识库→飞书同步：`resources/.agents/kb/feishu-sync.mjs` + `doc/kb-feishu-sync-spec.md` |
