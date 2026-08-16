# cc-connect 平台桥接层 → Saros 复刻实施方案

> 目标：把 `G:\CustomWorkspaces\AIProjects\cc-connect`（Go 实现的「本地 Agent ↔ 聊天平台」桥接器）的核心能力，复刻进 Saros 客户端。
> Saros 侧 **Agent 侧已完整**：`IAgentOSService`（OS 编排层）、`IAgentChatService`（对话/流式）、`IAgentStudioService`（Agent 目录）都已存在。缺口是 **平台桥接层（Platform Bridge Layer）**：让飞书 / Telegram / Discord 等 IM 把消息喂给本地 Agent，并把 Agent 的流式输出回传。

---

## 1. 架构总览

```
                 ┌─────────────────────────────────────────────┐
   外部 IM        │               Saros 客户端                 │
  (飞书/Telegram)  │                                             │
      │          │   IBridgePlatform (适配器, 每平台一个)        │
      │  inbound │   ┌─────────────────────────────────────┐   │
      ├─────────►│   │  BridgeEngine (核心路由/编排)        │   │
      │          │   │   · sessionKey → SessionState 映射    │   │
      │          │   │   · slash 命令分发                     │   │
      │          │   │   · 调用 IAgentChatService.sendMessage│   │
      │          │   └───────────────┬─────────────────────┘   │
      │          │                   │ onDelta(流式)             │
      │          │                   ▼                          │
      │          │        IAgentChatService (已有)              │
      │          │        IAgentOSService / IAgentStudioService │
      │          │                                             │
      │◄─────────┤  platform.send / reply / sendCard         │
      │  outbound└─────────────────────────────────────────────┘
```

关键差异（对比 cc-connect 的 Go 实现）：
- cc-connect 用 **子进程** 拉起 Claude Code/Codex CLI；Saros 直接 **进程内** 调 `IAgentChatService.sendMessage`，无需子进程、无 stdin/stdout 协议解析。
- cc-connect 的 `Agent` 抽象（`StartSession`/持久进程）在 Saros 中由 `IAgentChatService` 的 `agentSessionId` 概念替代（每个会话一个 session）。
- 统一消息模型沿用 cc-connect 的 `Message`/`Event`/`Card` 思路，但改为 TS 类型 `InboundMessage`/`OutboundMessage`/`BridgeCard`。

---

## 2. cc-connect → Saros 模块映射表

| cc-connect (Go) | Saros 复刻位置 | 说明 |
|---|---|---|
| `core.Platform` 接口 (`interfaces.go:10`) | `common/bridge/bridgeTypes.ts` → `IBridgePlatform` | 平台适配器端口 |
| `core.Message` (`message.go:211`) | `InboundMessage` | 统一入站消息 |
| `core.Event` (`message.go:275`) | `OutboundMessage` + `IChatStreamDelta` 映射 | 出站流式事件 |
| `core.Card` (`card.go:11`) | `BridgeCard` | 富卡片/按钮 |
| `core.CommandRegistry` (`command.go:24`) | `common/bridge/bridgeCommands.ts` → `BridgeCommandRegistry` | slash 命令框架 |
| `core.Engine` (`engine.go`) | `browser/bridge/bridgeEngine.ts` → `BridgeEngine` | 路由/会话/权限编排 |
| `platform/feishu`、`platform/telegram`… | `browser/bridge/platforms/feishu.ts` … | 各平台适配器 |
| `core.cron.go` / `core.timer.go` | `browser/bridge/bridgeScheduler.ts` | 定时任务（P2） |
| `core/bridge.go` `BridgeServer` (WS) | `browser/bridge/bridgeServer.ts` | 外部控制/调试 WS（P2） |
| `core.AllowList` / `SaveFilesToDisk` | `bridgeEngine` 内 `allowFrom` 校验 + 附件落盘 | 安全（P1） |

---

## 3. 目录结构（新增文件）

```
src/vs/sessions/contrib/agentStudio/
├── common/bridge/
│   ├── bridgeTypes.ts        # 类型 + 接口（IBridgePlatform / IBridgeCommand / IBridgeEngineOps）
│   └── bridgeCommands.ts     # BridgeCommandRegistry + 内置命令（纯逻辑，无平台依赖）
└── browser/bridge/
    ├── bridgeEngine.ts        # BridgeEngine：路由/会话映射/流式回传/命令分发
    ├── bridgeService.ts       # IBridgeService（DI 单例）+ BridgeService
    ├── loopbackPlatform.ts    # LoopbackPlatform：测试/演示用适配器
    ├── bridge.contribution.ts  # 注册 IBridgeService + Loopback 平台
    └── platforms/            # (P1+) feishu.ts / telegram.ts / discord.ts …
```

**分层规则**：`common/bridge/` 只允许依赖 `base/` + `common/agentStudio.ts` 的类型；`browser/bridge/` 可依赖 `IAgentChatService` / `IAgentStudioService` 等浏览器服务。

---

## 4. 核心类型（`bridgeTypes.ts` 摘要）

```ts
export interface InboundMessage {
  sessionKey: string;      // "{platform}:{handle}"，如 "feishu:chatA:user1" / "loopback:default"
  platform: string;
  messageId: string;
  userId: string; userName: string; chatName?: string;
  content: string;
  images?: InboundAttachment[];
  files?: InboundAttachment[];
  replyCtx?: unknown;        // 平台特定回包句柄
  isPermissionResponse?: boolean;
  modeOverride?: string;
}
export interface OutboundMessage {
  sessionKey: string; type: OutboundType; content: string;
  toolName?: string; done?: boolean; replyCtx?: unknown;
}
export interface BridgeCard { header?: BridgeCardHeader; elements: BridgeCardElement[]; }
export interface IBridgePlatform {
  readonly id: string; readonly name: string;
  start(handler: (msg: InboundMessage) => void): Promise<void> | void;
  stop(): Promise<void> | void;
  send(ctx: BridgeReplyCtx, content: string): Promise<void>;
  reply(ctx: BridgeReplyCtx, content: string): Promise<void>;
  update?(ctx: BridgeReplyCtx, content: string): Promise<void>;
  sendCard?(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void>;
  replyCard?(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void>;
  sendWithButtons?(ctx: BridgeReplyCtx, content: string, buttons: BridgeButton[][]): Promise<void>;
}
export interface IBridgePlatformFactory { id: string; create(opts: Record<string, unknown>): IBridgePlatform; }
```

---

## 5. Slash 命令框架（`bridgeCommands.ts`）

- `BridgeCommandRegistry`：`register(cmd)` / `resolve(name)` / `list()`，与 cc-connect `CommandRegistry` 对齐（hyphen↔underscore 归一化）。
- `IBridgeCommand`：`{ name, description, usage?, run(ctx) }`，`ctx` 暴露 `IBridgeEngineOps`（建会话/切会话/设模型/列 Agent 等）+ `reply()` / `replyCard()`。
- **内置命令（P0）**：`/help` `/new` `/switch <n>` `/sessions` `/agents` `/agent <id>` `/model [name]` `/mode [craft|ask|plan|workflow]` `/stop` `/clear`。
- 后续（P1+）：从 Agent 目录扫描 `*.md` 命令文件注册自定义命令（对齐 `core.CommandProvider`）。

---

## 6. 平台适配器实现路线

`IBridgePlatform` 是稳定端口，**先实现 `LoopbackPlatform` 打通架构**（无外部凭证即可端到端测试），再横向扩展：

| 阶段 | 平台 | 入站 | 出站 |
|---|---|---|---|
| P0 | Loopback（测试/演示） | `postInbound()` 方法 | `onOutbound` 事件回调 |
| P1 | 飞书 Feishu | 长连接 WebSocket 事件 + Webhook 回掉 | `im.message.create` / 卡片 `Patch` |
| P1 | Telegram | Bot Long-Polling / Webhook | `sendMessage` + InlineKeyboard |
| P2 | Discord / Slack / 企业微信 | 各自 Gateway / Webhook | 各自 API |
| P2 | BridgeServer(WS) | 供外部调试面板驱动 | 转发出站事件 |

每个适配器只负责 **平台协议 ↔ InboundMessage/OutboundMessage/BridgeCard 的编解码**，业务逻辑全部在 `BridgeEngine`。

---

## 7. 富卡片与按钮

`BridgeCard` 元素类型对齐 cc-connect `Card`：`markdown` / `divider` / `actions`（按钮行）/ `note`。`BridgeButton.{value}` 携带回调数据（如 `"cmd:/new"`、`"nav:/model"`）。平台适配器在支持时渲染为原生卡片（飞书 Interactive Card、Telegram InlineKeyboard），不支持时降级为 `RenderText()` 纯文本（对齐 `card.go` 的 `RenderText`）。

---

## 8. 定时任务（P2，对齐 `cron.go`/`timer.go`）

- `bridgeScheduler.ts` 管理 recurring（cron 表达式）与 one-shot（timer 延迟）两类任务。
- 触发时复用 `BridgeEngine.handleSynthetic(sessionKey, prompt)`：无需用户入站消息即可向 Agent 发 prompt 并把结果回传给 `ReconstructReplyCtx(sessionKey)` 解析出的回复目标。
- Agent 侧通过系统提示感知调度能力（对齐 `interfaces.go:AgentSystemPrompt`）。

---

## 9. 安全与附件（P1）

- `allowFrom`：平台 `Start()` 时调用 `CheckAllowFrom`；`BridgeEngine` 在路由前用 `AllowList(allowFrom, userId)` 校验，拒绝时回 `UnauthorizedAccessMessage`。
- 附件落盘：入站 `files` 写入 `<workDir>/.saros/bridge/attachments/`，文件名 `sanitizeAttachmentFileName` 防目录穿越；prompt 末尾追加本地路径引用（对齐 `message.go:SaveFilesToDisk`）。
- 日志脱敏：token/secret 在落盘前 `RedactToken`。

---

## 10. 分阶段实施计划

| 阶段 | 范围 | 交付 |
|---|---|---|
| **P0（首切片）** | 类型 + 命令框架 + `BridgeEngine` + `LoopbackPlatform` + `IBridgeService` | 进程内端到端：loopback 入站 → Agent 流式 → loopback 出站；slash 命令可用 |
| P1 | 飞书/Telegram 适配器 + `allowFrom`/附件落盘 + 卡片降级 | 真实 IM 接入 |
| P2 | BridgeServer(WS) + 定时任务(cron/timer) + 更多平台 | 远程调试 + 自动化 |
| P3 | 多 Agent 编排路由、relay（bot↔bot）、Usage 上报 | 完整对齐 cc-connect |

---

## 11. P0 首切片验证

1. `npm run compile-check-ts-native`（tsgo 类型检查）
2. `npm run transpile-client`（esbuild 转译）
3. 新增 `bridgeEngine.test.ts`：用 mock `IAgentChatService` 驱动 `BridgeEngine` + `LoopbackPlatform`，断言：
   - 普通消息 → `sendMessage` 被调用且出站含文本；
   - `/new` → 新建会话并切到新 `agentSessionId`；
   - `/sessions` → 列出会话；
   - `/stop` → 调用 `cancelStream`。
