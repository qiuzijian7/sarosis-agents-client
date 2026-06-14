# Workspace Session 设计框架 — 缺陷分析与优化建议

> 本文针对 `doc/workspace-session-design.md` 的设计方案，对照当前 `src/vs/sessions/contrib/agentStudio/` 真实代码进行审查，列出**致命缺陷、隐藏前提风险、结构性优化空间**。

---

## 一、致命缺陷 (Blockers)

设计文档建立在若干**与代码现实不符的假设**之上，必须修正后方能落地。

### 🔴 缺陷 1：聊天历史根本没有持久化 — Fork 切换将"切了个寂寞"

**设计假设**：切换 Session 时通过 `loadHistory(employeeId, agentSessionId)` 从 `agents/{slug}/sessions/{id}/history.json` 读出对应 Fork 的历史消息。

**代码现实** (`browser/agentChatService.ts:104-111`)：
```ts
async getHistory(_employeeId: string, _sessionId?: string): Promise<ChatMessage[]> {
    // TODO: Read from persisted chat history
    return [];
}
async clearHistory(_employeeId: string, _sessionId?: string): Promise<void> {
    // TODO: Clear persisted chat history
}
```
- **聊天消息从未写入磁盘**：`AgentChatService.sendMessage` → `AgentDriverService.executeTurn` → `AgentOSService.executeAgentTurn` 全链路无 `writeFile`，最终 `chatMessage` 仅存在于 webview 的 zustand store（运行时内存）。
- 关闭/重启窗口后所有对话**直接丢失**。
- `agentStudioWebviewController.ts` 中流式事件 `chat.stream.delta` 的 `sessionId` 字段已硬编码为 `''`。
- `.sarosworkspace/agents/{slug}/sessions/` 目录虽已被 `_ensureDir` 创建（`agentStudioService.ts:944`），但**完全空置**，注释明确说"Future: per-agent session transcripts"。

**影响**：设计文档的"Fork 独立 Session"功能在当前代码上**不可能工作**——切换到 Fork 永远显示空对话，发送消息后写入哪里也未定义。

**修复方案**：必须**前置**实施 Phase 0 — 聊天历史持久化基础设施
1. 在 `AgentChatService` 中实现真正的 `getHistory` / `clearHistory` / 内部 `appendMessage`。
2. 在 `sendMessage` 流结束后将完整 `ChatMessage` 写入 `agents/{slug}/sessions/{sessionId|'default'}/history.json`（追加式）。
3. 让 `IChatStreamDelta` 真正携带 `sessionId`（去掉硬编码 `''`）。
4. 协议层 `messageProtocol.ts` 的 `chat.history` / `chat.send` 需要明确 `sessionId` 语义（默认走 `default`，Fork 走 Fork 的 agentSessionId）。

**只有 Phase 0 完成后，设计文档的 Phase 1~4 才有意义。**

---

### 🔴 缺陷 2：Driver 层 turnId = agentId — 同 Agent 多 Fork 并发会互相取消

**设计假设**：Fork 之间数据隔离，可独立运行（"定时任务并发触发：每次触发创建独立 Fork，互不影响"）。

**代码现实** (`browser/agentDriverService.ts:38-45`)：
```ts
async *executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
    const turnId = request.agentId;          // ❗ turnId 仅用 agentId
    this.cancelTurn(turnId);                  // ❗ 同一 agent 新轮次直接 abort 旧的
    const controller = new AbortController();
    this._activeTurns.set(turnId, controller);
    ...
}
```
- 同样在 `AgentChatService.sendMessage`（line 46）：`this.cancelStream(employeeId)` 用 `employeeId` 作为唯一 key。
- `_activeStreams = new Map<string, AbortController>()` 也以 `employeeId` 为键。

**影响场景**：
- 用户在 Root 模式正在和 Agent A 对话，此时定时任务 Fork 触发并要求 Agent A 执行任务 → **Root 的对话会被中途 abort**。
- 多个 Fork 同时运行，Agent A 在 Fork-1 和 Fork-2 都需要工作 → 后者会取消前者。
- `OverlapPolicy.Parallel`（`agentScheduler.ts:228-237` 已定义 4 种策略）虽然在类型上存在，但**实现里没有任何地方读它**，代码强制 Skip/Replace 语义。

**修复方案**（必须修复，否则 Fork 设计失去价值）：
1. **复合 turnId**：`turnId = ${workspaceSessionId ?? 'root'}::${agentId}` 或 `${agentSessionId}`。
2. `_activeTurns` / `_activeStreams` 改成 `Map<turnId, ...>`，cancel 接口改为按 `turnId` 操作。
3. `IAgentTurnRequest` / `IChatSendOptions` 增加 `workspaceSessionId` 与 `agentSessionId` 必需字段（Root 时用 `'default'`）。
4. Memory Provider 的 `loadContext(agentId, sessionId)` 当前 `sessionId` 来自 `request.sessionId`，需保证 Driver 把 Fork 的 `agentSessionId` 透传下去（设计文档没明确这点）。

---

### 🔴 缺陷 3：调度器没有持久化 + 没有 Fork 概念 — 集成是空中楼阁

**设计假设**：定时任务触发 → 自动创建 Fork（设计文档 §4.3）。

**代码现实**：
- `AgentSchedulerService` 已存在 (`browser/agentSchedulerService.ts`，589 行)，但：
  - `_schedules = new Map<string, ScheduleInternal>()` (line 40) — **纯内存**，**重启全丢**。
  - 触发时直接调用 `this._driverService.executeFromChatOptions(instanceId, message, ...)`，**没有任何 Fork/Session 创建逻辑**。
  - `OverlapPolicy` 字段已定义但无消费者。
- UI 端 `views/scheduleView.ts` 的 `scheduledTasks: ScheduledTask[] = []` 是**纯前端 mock**，没和 `AgentSchedulerService` 联通。

**影响**：设计文档 §4.3"定时任务触发 → 创建 Fork"流程的**触发端不存在**。

**修复方案**：
1. 调度器先做磁盘持久化（建议 `.sarosworkspace/schedules.json`）。
2. 定义触发钩子接口 `IScheduleTriggerListener`，让 `WorkspaceSessionService` 注册为监听者，接到触发后创建 Fork。
3. 调度器 `executeFromChatOptions` 调用前先创建 Fork、拿到该 Agent 的 `agentSessionId`，再带着 `sessionId` 进入 Driver。
4. `views/scheduleView.ts` 的 mock 数据替换为真正的 `workspaceSession.list` 协议消息。

---

### 🔴 缺陷 4：定时任务在后台静默运行 vs 用户在前台 Root 编辑 — 状态机定义缺失

**设计假设**：用户切换 Session 时改变 `isReadOnly`、`activeSessionId`，画布跟着切换。

**未定义的关键场景**：
- **场景 A**：用户正在 Root 模式编辑画布，定时任务 Fork-X 在后台触发并运行。**画布是否要强制切换？** 设计文档没说。强制切换会打断用户工作；不切换则用户看不到执行进度。
- **场景 B**：Fork-X 正在跑，用户切回 Root；此时 Fork-X 中有 Agent 正在流式输出。该流要不要继续？要不要在切回时静默丢弃 UI 更新但保留磁盘写入？
- **场景 C**：用户在 Fork-Y 浏览历史，定时任务 Fork-X 同时触发；UI 是否需要在 SessionSwitcher 上提示"Fork-X running"？
- **场景 D**：用户**不在编辑器中**（窗口关闭/隐藏），定时任务触发后**没有 webview** 接收事件 → Fork 必须仍然能在 host 端独立完成执行并持久化。当前 webview-host 通信链是单向依赖 webview 已打开。

**修复方案**：定义清晰的"Active Session UI 视角" vs "Running Sessions 集合"二分：
- **UI 视角**：用户当前正在画布上看的 Fork，由 `useWorkspaceSessionStore.activeSessionId` 单一来源决定。
- **Running 集合**：可同时多个 Fork 在 host 端跑（互不依赖 webview），由 `WorkspaceSessionService` 管理，状态变更通过 event 通知。
- 明确：定时任务触发**绝不**强制切换 UI 视角；只在 SessionSwitcher 标记"running"角标 + Toast 通知。
- Host 端执行**不依赖**webview 是否打开（持久化由 host 完成）。
- 切换 UI 视角时不影响其他 Fork 的后台执行。

---

## 二、结构性问题 (Should Fix)

### 🟠 问题 5：Fork 等于"全 Agent 全 Session" — 粒度过粗

**当前设计**：Fork 创建时为 Workspace 中**所有 Agent** 都生成新 Session。

**问题**：
- 定时任务可能只需要触发 1 个 Agent（如 `instanceId` 单 Agent 触发），却为 N 个 Agent 都建空 Session 文件夹，产生大量空目录。
- 一个 Workspace 有 20 个 Agent + 每天 24 次定时任务 = 一年 175200 个空 session 文件夹。
- 设计文档 `snapshotAgentIds` 字段记录"创建时有哪些 Agent"，但**没说明是否所有都需要 Session**。

**优化方案**：
- `agentSessions` 改为**懒创建**：Fork 元数据先记录 `snapshotAgentIds`，只在该 Agent 真正被调用时再 `addAgentSession()`。
- `AgentSessionEntry` 增加 `lastInvokedAt`，从未被调用过的就不落 `history.json`。
- 切换到 Fork 后，未运行过的 Agent 节点 UI 上加"未启动"角标，点击该节点时 Chat 区域提示"该 Agent 在此 Fork 中尚未执行"。

---

### 🟠 问题 6：Connection / 工作流执行链与 Session 的耦合未定义

**代码现实**：`Workspace.connections: Connection[]` 已存在，但当前**没有任何工作流执行引擎**消费它（搜索 `connections` 在 service 层只是 CRUD 存储）。

**设计文档遗漏**：
- 假设定时任务触发 Agent A，A 通过 Connection 把上下文转交给 Agent B（A→B 工作流）。两人共用 Fork 的 `workspaceSessionId`，但各自的 `agentSessionId` 不同。
- 转交时如何把 A 的输出/共享上下文喂给 B？是 Memory Provider 的 `loadContext(B, agentSessionId_B)` 自己读 Fork 共享内存，还是消息传递？
- B 调用 A 时，A 的当前 `agentSessionId` 状态怎么定？

**优化方案**：
- 在 `WorkspaceSession` 元数据中增加 `sharedContext?: { ... }` 槽位，作为 Fork 内 Agent 间共享的"工作记忆"。
- 定义 `IWorkflowExecutor` 接口（即使先做空实现），明确规定 Fork 内的连接执行规则。
- 至少在文档中明确"Phase 当前不实现工作流，Connection 只用于 UI 展示"，避免用户期望落差。

---

### 🟠 问题 7：Agent 配置快照机制缺失 — Fork 不是真"快照"

**设计声称**："Fork 中 Agent 配置保持创建时的快照，不受 Root 修改影响"（§11 边界情况表）。

**代码现实**：Agent 配置存储在 `agents/{slug}/agent.yaml`，**全局唯一一份**，Root 修改后 Fork 读到的就是新版。

设计文档 §12 后续扩展中提到"Agent 快照深拷贝"标记为"后续"，但**这是 Fork 不可编辑承诺的核心兑现**。如果做不到快照，"Fork 不受影响"的承诺是假的。

**优化方案** A（彻底）：Fork 创建时把每个 Agent 的 yaml/SOUL/IDENTITY/TOOLS 文件复制到 `workspace_sessions/{forkId}/agents/{slug}/`，Driver 在 Fork 模式下从该路径读配置。
**优化方案** B（轻量）：在 `WorkspaceSession.agentSessions[].configSnapshot?: AgentConfig` 中嵌入序列化快照（缺点：与文件配置不一致时优先级规则要写清楚）。
**优化方案** C（折衷，推荐）：
- 元数据记录 `agent.yaml` 的版本号 / hash。
- Root 修改 Agent 时如果有 active Fork 引用旧版本 → 弹窗提示"修改将影响进行中的定时任务，是否复制为新版？"。
- 用户选择"复制"则触发深拷贝；否则 Fork 沿用最新配置（接受设计承诺打折）。

---

### 🟠 问题 8：Memory Provider 与 Fork 边界冲突

**代码现实** (`agentDriverService.ts:62, 109`)：
```ts
memoryContext = await memoryProvider.loadContext(request.agentId, request.sessionId || '');
await memoryProvider.writeMemory(request.agentId, {...});  // ❗ 写入未带 sessionId
```
- `loadContext` 接受 `sessionId`，但 `writeMemory` **没传 sessionId** → 所有 Fork 写入的记忆**串到同一个 agent 全局记忆桶**。
- `localFileMemory` provider（搜索结果中存在）若按 agentId 分文件存储而不分 Fork → Fork 间记忆污染。

**修复方案**：
1. `IMemoryProvider.writeMemory` 必须接受 `sessionId` 参数。
2. localFileMemory 路径模式：`agents/{slug}/sessions/{sessionId|default}/memory.json`。
3. 设计文档需要专门一节描述 Memory 的 Fork 边界（按 agentSessionId 隔离短期记忆、长期记忆全局共享、规则可配）。

---

## 三、优化空间 (Nice to Have)

### 🟡 优化 9：`activeSessionId` 应该按 Workspace 持久化，而非全局单值

**当前设计**：`useWorkspaceSessionStore.activeSessionId: string | null` 是全局变量。

**问题**：用户 A workspace 切到 Fork-X，再切到 B workspace 浏览，再切回 A — A 应该**记住**之前选的 Fork-X 还是回到 Root？

**建议**：在 `Workspace.rootInfo.activeSessionId` 持久化（设计文档已定义 `WorkspaceRootInfo` 但未说明持久化时机）。切换 Workspace 时从该字段恢复。

---

### 🟡 优化 10：Fork 命名建议加入幂等键，防止定时任务重试重复创建 Fork

**风险**：定时任务执行失败重试机制（`agentScheduler.ts` 中有 `retry` 字段）若重新触发，会创建第二个空 Fork。

**建议**：`createFork` 增加 `idempotencyKey?: string`，调度器用 `${scheduleId}-${triggerTimestamp}` 作为 key；同 key 已存在时返回原 Fork 而非新建。

---

### 🟡 优化 11：Webview 协议消息量优化

**风险**：当 Fork 列表达上百，每次 `workspaceSession.list` 全量返回 + 每个 status 变更触发 `workspace.sessionUpdated` event → webview 频繁重渲染。

**建议**：
- `list` 接口分页 + 默认只返 `status in (running, pending)` 的 + 最近 30 条 completed。
- `sessionUpdated` event 仅推送 `{ id, status, updatedAt, messageCount }` diff，避免整对象。
- agentSessions 数组改为按需懒加载（`workspaceSession.get` 才返回完整 agentSessions）。

---

### 🟡 优化 12：只读保护应该统一抽象，避免散落

**当前设计**：`useEmployeeStore` 的 create/update/delete 三处各自 `if (isReadOnly) throw`。

**建议**：抽 HOF/装饰器：
```ts
const guardWritable = <T extends (...args: any[]) => any>(name: string, fn: T): T => 
    ((...args) => {
        if (useWorkspaceStore.getState().isReadOnly) {
            throw new ReadOnlyModeError(`Fork 模式下不可执行 ${name}`);
        }
        return fn(...args);
    }) as T;
```
- 同时确保**所有**写路径都覆盖：connections add/remove、layout 修改、workspace 设置修改、provider 配置（Fork 不应改 provider 凭据吧？）等。设计文档目前只列了 employee 的 3 个方法，遗漏面很大。

---

### 🟡 优化 13：取消 Stream 与 Session 切换的竞态

**设计文档** §11："切换 Fork 时有正在进行的对话：先 cancel 当前 stream，再切换 Session"。

**风险细节**：
- `cancelStream` 是异步的（`AbortController.abort` 同步触发但 stream 消费者要走完 finally），切换前若不 await，可能产生切换后还有旧 Fork 的 delta 写入新 UI 的竞态。
- 建议引入 `streamGeneration` 序号（每次切换 ++），delta 携带 generation 号，消费时校验过期。

---

### 🟡 优化 14：手动创建 Fork 用例缺细节

设计文档只在 §1.1 出现 "manual001" 例子，但：
- 谁来命名？默认名 / 必填？
- 基于当前 Root 还是基于另一个 Fork 创建？（Fork-of-Fork 是否允许？建议明确禁止）。
- 创建后是否自动切换到新 Fork？建议：手动创建 → 自动切换；定时任务创建 → 不切换（与缺陷 4 的修复联动）。

---

### 🟡 优化 15：Session 数据生命周期 / 配额

**设计文档** §11：「大量 Fork 堆积：提供归档/删除功能，可设定自动清理策略」— 太粗。

**建议明确**：
- 默认保留策略：completed Fork 30 天后自动 archive，archived 90 天后自动删除（配置可改）。
- 容量软限：单 Workspace 超过 200 个 Fork 给警告。
- 手动清理 UI：批量按时间范围/状态筛选删除。
- archive 不删 history.json，仅打 archived 标记 + UI 折叠（不要在 list 默认结果中）。

---

## 四、补充的实施计划重排建议

文档现 Phase 1-4 的顺序在缺陷 1/2/3 修复前**不可执行**。建议改为：

| 阶段 | 内容 | 解决项 |
|---|---|---|
| **Phase 0** (新增·必做) | 聊天历史持久化基础 + Driver turnId 复合键 + 调度器持久化 + Memory writeMemory 带 sessionId | 缺陷 1 / 2 / 3 / 8 |
| Phase 1 | 类型 + WorkspaceSessionService + 协议 | 设计原 Phase 1 |
| Phase 2 | Webview Stores + 只读保护抽象 | 设计原 Phase 2 + 优化 12 |
| Phase 3 | UI 组件 + Banner + 节点只读 | 设计原 Phase 3 |
| Phase 4 | Schedule→Fork 钩子 + 后台执行链路 + UI 视角与运行集合解耦 | 设计原 Phase 4 + 缺陷 4 |
| Phase 5 (新增) | Agent 配置快照 / Memory 边界 / Fork 容量管理 | 问题 7 / 8 / 优化 15 |
| Phase 6 (新增) | Workflow / Connection 执行 (或明示推迟) | 问题 6 |

---

## 五、整体评价

| 维度 | 评分 | 说明 |
|---|---|---|
| 概念清晰度 | ⭐⭐⭐⭐⭐ | Root/Fork 隐喻贴切，分层职责清楚 |
| 落地可行性 | ⭐⭐ | 三个致命缺陷都建立在错误的代码假设上 |
| 边界覆盖 | ⭐⭐ | 缺并发执行、配置快照、Memory 边界、UI 视角与运行解耦等关键场景 |
| 数据模型 | ⭐⭐⭐⭐ | 类型设计基本合理，少数字段需补全（idempotencyKey、configSnapshot、sharedContext） |
| 实施编排 | ⭐⭐ | 缺 Phase 0 基础设施，Phase 1-4 依赖未实现的能力 |

**结论**：设计方向正确、概念良好，但**不能直接进入 Phase 1 实施**。必须先用 Phase 0 修复"聊天历史未持久化、Driver turnId 冲突、调度器无持久化、Memory 边界"四大基础缺陷；同时澄清"UI Active Session vs 后台 Running Sessions 集合"二分模型；并将 Agent 配置快照从"后续"提前为正式阶段。完成上述补强后，整体方案即可成为生产可行的架构。
