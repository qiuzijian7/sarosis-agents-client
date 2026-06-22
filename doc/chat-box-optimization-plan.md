# 聊天框优化方案（native 迁移期）

> 背景：项目处于 React webview → native 迁移阶段。native 渲染核心为 `AgentChatPanel`（纯 DOM，~4866 行），由两个宿主驱动：
> - `ChatBarPart`（侧边栏，功能完整，已接线 Checkpoint）
> - `NativeChatEditorPane`（编辑器页，功能滞后，多处 TODO 空壳）
>
> 本文给出四项优化的落地方案、风险评估与分阶段实施顺序。

---

## 0. 关键现状（调研结论）

| 关注点 | 现状 | 锚点 |
|---|---|---|
| 实际持久化模型 | 扁平 `ChatMessage`（`role: user/assistant/tool/system`，`toolCalls` 内嵌在 assistant，靠 `turnId` 聚合 + `textPosition` 定位交织） | `common/agentStudioTypes.ts:733` |
| 理想模型（未接入） | void 风格判别联合 `UserMessage|AssistantMessage|ToolMessage|SystemMessage|CheckpointMessage`，tool/checkpoint 已是独立消息 | `contrib/agentStudio/common/chatTypes.ts:17` |
| 持久化布局 | 全局 `chat-history.json`（兜底全量）+ 每会话 `agents/{id}/sessions/{sid}.json` + `sessions.json` 索引；内存 `_historyCache` | `agentChatService.ts:104/134/226/250` |
| `textPosition` 持久化 | service 端已修复（`tool_start` 按 `currentTurnTextLen` 兜底并落盘） | `agentChatService.ts:903-921` |
| **缺陷①** | `ChatBarPart._adaptChatMessage` 重载时**丢失 `textPosition` 及多个 UI 字段** → 侧栏重载后 tool 卡全部排到末尾 | `chatBarPart.ts:1206-1229` |
| **缺陷②** | `NativeChatEditorPane.onOpenSession` 不重载历史 | `nativeChatEditorPane.ts:368-381` |
| **缺陷③** | `NativeChatEditorPane` Checkpoint 全 TODO，未注入 `ICheckpointService` | `nativeChatEditorPane.ts:515-518` |
| **缺陷④** | 用户消息编辑 / 截断重发 UI 完全缺失（service 已有 `deleteMessagesAfter`，无调用方） | `agentChatService.ts:669-700` |
| session id | `sessionId`(Fork/workspace) / `agentSessionId`(agent 内会话) / `workspaceSessionId`(仅事件) / `providerSessionId`(外部) 多层并存 | — |

---

## 1. 四项优化方案

### 项① 数据模型：tool 内嵌 → 独立消息（消除 textPosition）

**根因**：单条 assistant 内部出现 “文本A → tool1 → 文本B → tool2” 交织时，扁平模型只能用 `textPosition`（字符偏移）记录卡片插入点；任何一环漏存/错算都会导致卡片错位。

**根因级方案（阶段E）**：抛弃 `textPosition`，让消息粒度细化为 void 模型——assistant 文本段与 tool 调用各自独立成消息，渲染按数组顺序遍历，结构上不可能错位。复用已存在的 `chatTypes.ts` 判别联合。

**加固级方案（阶段A，先做）**：保留现模型，把 `textPosition` 作为持久化不变量：
1. 修复 `_adaptChatMessage` 字段丢失（最高 ROI，直接消除当前可见 bug）。
2. 序列化 round-trip 增加单测保护。

> 决策（已落地）：先做加固（阶段A，确定性收益、零回归），再做根因重构（阶段E）——最终以**有序 `parts[]`** 取代 `textPosition` 完成，采用读取期非破坏性派生 + 新写入落盘 parts 的安全迁移（详见 §3 阶段E）。

### 项② Checkpoint + 文件快照回滚

**现状**：`ChatBarPart` 已完整接线 `ICheckpointService`（创建监听、`_refreshCheckpointBar`、`_handleCheckpointAction` 的 undoAll/keepAll/openDiff），`AgentChatPanel` 已有 `CheckpointBar` 渲染。**唯一缺口是 `NativeChatEditorPane` 未接线**。

**方案（阶段B）**：将 `ChatBarPart` 的 checkpoint 接线移植到 `NativeChatEditorPane`：注入 `ICheckpointService` + `ICommandService`，实现 `onCheckpointAction`、`_refreshCheckpointBar`、`onDidCreateCheckpoint` 监听、session 切换时 `setActiveSession`。

### 项③ 用户消息编辑 → 截断 → 重生成闭环

**现状**：service 层 `deleteMessagesAfter(agentId, sessionId, messageId)` 已具备截断能力，但无 UI 调用方；Panel 用户气泡无编辑入口。

**方案（阶段C）**：
1. `AgentChatPanel`：用户气泡增加“编辑”按钮 → 进入内联编辑态 → 回调 `onEditMessage(messageId, newText)`。
2. 宿主：`deleteMessagesAfter(agentId, sessionId, messageId)` 截断 → 以 `newText` 重新走 `sendMessage` 流式重生成。

### 项④ 收敛多层 session id

**方案（阶段D）**：以 `agentSessionId` 为唯一会话主键贯穿 UI→service；`sessionId`(workspace) 退化为路由维度；`providerSessionId` 仅作会话元数据；移除/标注 `workspaceSessionId` 冗余路径。配套：统一两个宿主的 `getHistory+setMessages` 重载入口，减少 sanitize/guard 补丁。

---

## 2. 实施顺序（按风险/依赖/ROI）

| 阶段 | 内容 | 风险 | 收益 |
|---|---|---|---|
| **A** | 修复 `_adaptChatMessage` 字段丢失 + textPosition 不变量 | 低 | 立即消除侧栏 tool 卡错位（可见 bug） |
| **B** | `NativeChatEditorPane` 对齐：历史重载 + Checkpoint 接线 | 中低 | 编辑器页达成 Checkpoint 回滚能力 |
| **C** | 用户消息编辑→截断→重生成闭环 | 中 | 补齐对标 void 的核心交互 |
| **D** | session id 模型收敛 | 中高 | 降低一致性补丁复杂度 |
| **E** | 数据模型根因重构（tool 独立消息）⚠️关键决策点 | 高 | 结构性根除位置错乱；需数据迁移 |

阶段 A→B→C 串行落地、互不破坏；D、E 风险大，进入前单独评估。

---

## 3. 变更记录

### 阶段 A（已完成）— 修复 `_adaptChatMessage`
- `chatBarPart.ts`：`_adaptChatMessage` 改读持久化字段 `c.arguments`（原误读 `c.args`，导致 tool 参数重载丢失）；保留 `textPosition`（原被丢弃，导致重载后 tool 卡排到末尾）；正确映射 `status`（running/error/completed，原把 error 吞成 completed）；补齐 `displayName/renderType/defaultShow/error/filePath/duration/exitCode`。lint 0 错误。

### 阶段 B（已完成）— `NativeChatEditorPane` 对齐
- 注入 `ICheckpointService` + `ICommandService`；新增共享 `_adaptHistoryMessages`（过滤 `role==='tool'`、保留 textPosition 与全部 UI 字段）。
- 移植 `_activateCheckpointSession` / `_refreshCheckpointBar` / `_handleCheckpointAction`。
- `onOpenSession` 实装历史重载 + checkpoint 激活（原 TODO 空壳）；`onCheckpointAction` 实装（原 console.log）；`onNewSession`/`onDeleteSession` 补齐 checkpoint 与历史重载；`_initChatPanel` 注册 `onDidCreateCheckpoint`。lint 0 错误。

### 阶段 C（已完成）— 用户消息编辑→截断→重生成闭环
- `agentChatPanel.ts`：新增构造选项/字段 `onEditMessage`；用户气泡悬浮显示“编辑”按钮 `_addUserEditAffordance`；`_enterUserEditMode` 内联 textarea 编辑（Ctrl/Cmd+Enter 重新生成、Esc 取消），保存时先在内存截断 `_messages.slice(0, idx)` + `_renderMessages()`，再回调 `onEditMessage(messageId, newText)`。
- 宿主 `_handleEditMessage`（ChatBarPart + NativeChatEditorPane）：`getHistory` 定位消息 → idx<=0 走 `clearHistory`，否则 `deleteMessagesAfter(history[idx-1].id)`（注意：`deleteMessagesAfter` 语义为“保留到并含该 id”，故传**前一条**的 id 才能丢掉被编辑消息及其后续）→ 以 `newText` 重新走流式发送。
- `media/agentChat.css`：新增 `.chat-user-actions/.chat-user-edit-*` 样式。lint 0 错误。

### 阶段 D（已完成）— session id 收敛（宿主层）
- 调研结论：逻辑会话层 `agentSessionId = _currentSessionId = AgentSessionMeta.id = checkpoint sessionId = provider request.sessionId` 实为 **1:1 同值**，仅变量名不同；协议层 `conversationId/requestId/previousResponseId` 必须保持独立（合并会致 KV 缓存串台）。最大风险是 sessionId 为 undefined 时退化为“纯 agentId 的 noSession 桶”+ `?? 'claw'` 默认 agent，是历史串台根因。
- `NativeChatEditorPane`：新增 `_ensureSession()`，发送前确保 `_currentSessionId` 落地（缺失则 `getOrCreateActiveSession` 创建并激活 checkpoint）；`_sendMessageInternal` 改用 ensured 的 `agentId/sessionId`，消除 noSession 桶退化。
- `ChatBarPart._handleSendMessage`：发送前同样补 `getOrCreateActiveSession` 兜底，两个宿主行为对齐。lint 0 错误。

### 阶段 E（已完成 ✅）— 数据模型根因重构：有序 `parts` 取代 `textPosition`

**决策**：全量做 E。内部表示选用 **assistant 消息携带有序 `parts[]`**（VS Code Copilot Chat / void 的有序内容模型），与「tool 拆为独立消息」目标等价，但回归面更小：无需改动 turn 分组/消息数组结构。

**关键判断**：核实两个宿主（`ChatBarPart`/`NativeChatEditorPane`）均使用 native `AgentChatPanel`，React webview 聊天路径已无激活挂载点（全仓 grep 0 命中），故重构范围收敛为 持久化 + native 渲染 + 宿主适配，**无需维持 webview 兼容**。

**迁移策略（比"不可逆迁移器"更安全的等价实现）**：采用**读取期非破坏性派生** + **新写入落盘 parts**，零数据丢失风险、无需备份：
- 旧数据（`content` + 内嵌 `toolCalls[textPosition]`）在读取期由 `deriveMessageParts`/`deriveUiMessageParts` 即时派生为有序 parts，不改磁盘。
- 新写入的 assistant 消息直接落盘 `parts`，下次读取直接用；磁盘随使用自然升级。
- `textPosition` 仅在「落盘切分 parts」与「live 派生 parts」两处作为**本地排序信号**，不再跨持久化/重载/适配层传递（消除历史错位根因）。

**三层改动**：
- 类型（`agentStudioTypes.ts` / `agentChatTypes.ts`）：新增 `MessagePart=TextMessagePart|ToolMessagePart` 与 `parts?` 字段；`textPosition` 标 `@deprecated`（仅迁移可读）；新增 `deriveMessageParts`/`deriveUiMessageParts`/`flattenMessageParts`/`adaptPersistedChatMessage`/`adaptPersistedToolCall`。
- 持久化/流式（`agentChatService.ts`）：两处构建 assistant 消息（Hermes 多 turn + 单条回退）均写入 `parts`（由 `deriveMessageParts` 切分）；更新 textPosition 注释。
- 渲染（`agentChatPanel.ts`）：删除 `_renderInterleavedContent`/`_createToolCallCardAt`，新增 `_renderPartsContent`（按数组顺序遍历，文本段→markdown、工具段→卡片）；`_aggregateTurns` 改为按 turn 顺序拼接 `parts`（不再做 offset 运算）；`updateMessage` 集中式由 content+toolCalls 派生 parts（两个宿主流式共用此入口）；`_updateMessageDom`/`_updateStreamingContentInPlace` 按 parts 工具数判定结构变化。
- 宿主适配（`chatBarPart.ts` / `nativeChatEditorPane.ts`）：`_adaptChatMessage`/`_adaptHistoryMessages` 统一收敛到共享 `adaptPersistedChatMessage`（assistant 带 parts、过滤独立 tool 角色、字段对齐），删除重复的 textPosition 适配补丁。

**结果**：渲染按 `parts` 顺序遍历，结构上不可能错位；textPosition 退出跨层路径。全量 lint 0 错误。


