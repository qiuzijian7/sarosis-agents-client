# 聊天框功能差异对比：Void vs Saros

> 分析日期：2026-06-27
> Void 项目：`G:\CustomWorkspaces\AIProjects\void`（VS Code fork，含 React 聊天）
> Saros 项目：`G:\CustomWorkspaces\AIProjects\vssaros-agents-client`

---

## 一、Void 有但 Saros 没有的功能

### 1.1 代码块功能差异

| 功能 | Void 实现 | Saros 状态 |
|------|-----------|-------------|
| **Diff 视图（Accept/Reject）** | `ApplyBlockHoverButtons.tsx` L378-419 — Apply 后显示 Keep/Remove 按钮，可视化 diff | ❌ 缺失 — Apply 仅写入文件，无 diff 预览 |
| **跳转到文件** | `ApplyBlockHoverButtons.tsx` L104-119 — 代码块旁显示文件路径按钮 | ❌ 缺失 |
| **终端运行按钮** | `ApplyBlockHoverButtons.tsx` L257-315 — shell 语言代码块显示"Run"按钮 | ❌ 缺失 |
| **Apply 状态指示器** | `ApplyBlockHoverButtons.tsx` L212-239 — idle/streaming/idle-has-changes 三态 | ❌ 缺失 — Apply 是一次性操作 |
| **代码块 URI 检测** | `ChatMarkdownRender.tsx` L284-301 — 第一行是文件路径时自动检测 | ❌ 缺失 |
| **Diff 编辑器** | `util/inputs.tsx` L1850-1950 — search/replace 块渲染为 diff | ❌ 缺失 |

### 1.2 上下文/@提及

| 功能 | Void 实现 | Saros 状态 |
|------|-----------|-------------|
| **@提及文件搜索** | `util/inputs.tsx` L195-215 — 模糊匹配文件路径 | ❌ 缺失 — 有附件但无 @提及 |
| **@提及文件夹** | `util/inputs.tsx` L218-278 — 文件夹级别上下文 | ❌ 缺失 |
| **面包屑导航** | `util/inputs.tsx` L375-385 — 路径层级逐级选择 | ❌ 缺失 |
| **模糊匹配** | `util/inputs.tsx` L73-137 — 子序列匹配 + 评分排序 | ❌ 缺失 |
| **Ctrl+Backspace 清除全部** | `util/inputs.tsx` L789-790 | ❌ 缺失 |
| **建议文件（当前打开）** | `SidebarChat.tsx` L596-635 — 自动建议当前打开的文件 | ❌ 缺失 |
| **"当前文件"标记** | `SidebarChat.tsx` L725-729 | ❌ 缺失 |
| **代码选择作为上下文** | `SidebarChat.tsx` L651, L710-712 — CodeSelection 类型 | ❌ 缺失 |

### 1.3 会话管理

| 功能 | Void 实现 | Saros 状态 |
|------|-----------|-------------|
| **删除线程（带确认）** | `SidebarThreadSelector.tsx` L133-169 — 两步确认 | ❌ 缺失 — 无删除会话功能 |
| **复制线程** | `SidebarThreadSelector.tsx` L118-131 | ❌ 缺失 |
| **线程运行状态指示器** | `SidebarThreadSelector.tsx` L247-251 — spinner/问号 | ❌ 缺失 |
| **线程消息数量显示** | `SidebarThreadSelector.tsx` | ❌ 缺失 |

### 1.4 其他 Void 独有功能

| 功能 | Void 实现 | Saros 状态 |
|------|-----------|-------------|
| **Gather 模式** | `SidebarChat.tsx` L256-258 — 只读文件不能编辑 | ❌ 缺失 — 有 craft/plan 模式但无 Gather |
| **拖放文件** | `SidebarChat.tsx` — 拖放文件到聊天框 | ❌ 缺失 — 有文件选择按钮但无拖放 |
| **图片预览** | 消息中的图片可点击预览 | ❌ 缺失 |
| **消息内代码选择高亮** | 选中的代码片段作为上下文 chip 显示 | ❌ 缺失 |

---

## 二、Sarosis 有但 Void 没有的功能

### 2.1 Agent/工具系统

| 功能 | Saros 实现 | Void 状态 |
|------|-------------|-----------|
| **Agent 选择器** | 多 Agent 切换，含搜索过滤 | ❌ Void 只有单线程 |
| **工具调用审批** | 4 级审批（allow_once/session/always/deny） | ❌ 缺失 |
| **工具卡状态管理** | 5 种状态（success/running/error/approval/rejected） | Void 有状态但更简单 |
| **工具卡增量更新** | data-tool-id + 状态变化只重建单卡 | ❌ Void 全量更新 |
| **子代理卡 (Sub-Agent)** | 子 Agent 执行卡片 + 并行分组 | ❌ 缺失 |
| **工作流执行追踪** | `workflowExecutions` + `workflowEvents` | ❌ 缺失 |
| **MCP 工具桥接** | mcp_tool_search + mcp_tool_call | ❌ 缺失 |
| **技能系统** | 技能 chip + 技能索引 | ❌ 缺失 |

### 2.2 Token/上下文显示

| 功能 | Saros 实现 | Void 状态 |
|------|-------------|-----------|
| **Token 消耗明细弹窗** | 完整的 input/output/cached/cacheMiss/cacheWrite/reasoning 分组 + 缓存命中率 | ❌ 缺失 |
| **Footer 积分显示** | `tokenUsage.credit` | ❌ 缺失 |
| **Footer 耗时显示** | 单次 LLM 耗时 | ❌ 缺失 |
| **Context Usage Ring** | 环形进度条 + 3 层计算（空闲/流式/真值） | ❌ Void 有简单的 token 显示 |
| **Context Ring 防抖** | 流式期间 500ms 防抖 | ❌ 缺失 |

### 2.3 系统消息面板

| 功能 | Saros 实现 | Void 状态 |
|------|-------------|-----------|
| **上下文压缩提示** | 压缩前/后消息数、节省 token、耗时 | ❌ 缺失 |
| **记忆注入通知** | `<agentmemory-context>` 注入提示 | ❌ 缺失 |
| **代码库索引提示** | 代码库变更通知 | ❌ 缺失 |
| **系统消息可折叠面板** | 系统栏 + 展开/折叠 | ❌ 缺失 |

### 2.4 消息交互

| 功能 | Saros 实现 | Void 状态 |
|------|-------------|-----------|
| **用户消息 Undo** | 回撤 checkpoint 改动 + 确认对话框 | ❌ 缺失 |
| **回合聚合** | 相同 turnId 的多条助手消息合并为一条气泡 | ❌ 缺失 |
| **Ask-User 卡片** | 模型主动提问 + 用户回答 | ❌ 缺失 |
| **Todo List 卡片** | 任务列表显示 | ❌ 缺失 |
| **Question Carousel** | 多问题轮播 | ❌ 缺失 |
| **References 卡片** | 引用列表 | ❌ 缺失 |
| **Progress 卡片** | 进度条 | ❌ 缺失 |
| **消息导航覆盖层** | 消息列表快速跳转 | ❌ 缺失 |

### 2.5 流式/滚动优化

| 功能 | Saros 实现 | Void 状态 |
|------|-------------|-----------|
| **增量 Markdown 渲染** | 只解析追加部分 | ❌ Void 用渐进式渲染（不同方案） |
| **消息列表懒加载** | IntersectionObserver 30+20 分块 | ❌ Void 用 Tree 虚拟化 |
| **SVG 模板缓存** | cloneNode 替代逐元素创建 | ❌ 缺失 |
| **流式结束宽限期** | 500ms 绕过 80px 阈值 | ❌ 缺失 |
| **未读消息 badge** | 红色数字 + 脉冲动画 | ❌ 缺失 |
| **rAF 批处理** | 流式 delta 合并为每帧一次 | ❌ Void 用 Event.accumulate |

---

## 三、两者都有但实现不同的功能

### 3.1 代码块 Apply

| 维度 | Void | Saros |
|------|------|---------|
| Apply 按钮 | ✅ 有，含状态指示器 | ✅ 有，一次性操作 |
| Diff 预览 | ✅ Keep/Remove 可视化 | ❌ 直接写入 |
| 跳转文件 | ✅ 有 | ❌ 缺失 |
| 终端运行 | ✅ shell 代码块 | ❌ 缺失 |
| 大块折叠 | ❌ 缺失 | ✅ >30 行自动折叠 |

### 3.2 消息编辑

| 维度 | Void | Saros |
|------|------|---------|
| 编辑用户消息 | ✅ 内联编辑 + 重新流式 | ✅ 内联编辑覆盖层 + 截断重生成 |
| 键盘快捷键 | ✅ Enter/Shift+Enter/Esc | ✅ Ctrl/Cmd+Enter/Esc |
| Undo | ❌ 缺失 | ✅ Checkpoint 回撤 + 确认对话框 |
| 编辑模式 toolbar | ✅ 简化版 | ✅ 完整（附件/模式/Provider/Model + Ring） |

### 3.3 聊天模式

| 维度 | Void | Saros |
|------|------|---------|
| 模式 | Chat / Gather / Agent | Craft / Plan / etc. |
| Gather（只读） | ✅ 有 | ❌ 缺失 |
| 模式描述 | ✅ 有 | ✅ 有 |
| 持久化 | ✅ 全局设置 | ✅ 有 |

### 3.4 滚动管理

| 维度 | Void | Saros |
|------|------|---------|
| 虚拟化 | ✅ WorkbenchObjectTree | ✅ IntersectionObserver 懒加载 |
| 渐进式渲染 | ✅ 50ms 定时器 + 词数节流 | ✅ 200ms markdown 节流 + 增量更新 |
| 内容 Diff | ✅ 逐 part diff | ✅ 工具卡增量更新 |
| 滚动到底部按钮 | ✅ 简单按钮 | ✅ 按钮 + 未读 badge + 脉冲 |
| 平滑滚动 | ❌ instant | ✅ smooth |
| 宽限期 | ❌ 缺失 | ✅ 500ms 绕过阈值 |

### 3.5 性能架构

| 维度 | Void | Saros |
|------|------|---------|
| 列表虚拟化 | Tree 模板回收 | IntersectionObserver 懒加载 |
| Markdown 渲染 | 增量 tryIncrementalUpdate | 增量追加渲染 |
| 事件批处理 | Event.accumulate | rAF 批处理 |
| 离屏优化 | Tree 自动处理 | content-visibility:auto |
| SVG 优化 | ❌ | ✅ 模板缓存 |
| Disposable 管理 | 三层体系 | Map + cleanup |

---

## 四、优先级建议（Void 有 → Saros 应补齐）

### P0: 高价值，用户体验影响大

1. **代码块 Diff 视图（Accept/Reject）** — Apply 后显示 diff，用户可 Keep/Remove
   - 参考：`Void/ApplyBlockHoverButtons.tsx` L378-419
   - 价值：防止误操作，可视化代码变更

2. **@提及文件搜索** — 输入 `@` 触发文件搜索 + 模糊匹配
   - 参考：`Void/util/inputs.tsx` L195-215
   - 价值：快速添加文件上下文，比文件选择按钮高效

3. **拖放文件到聊天框** — 支持拖放文件/代码片段
   - 价值：最自然的上下文添加方式

### P1: 中等价值

4. **终端运行按钮** — shell 代码块显示 Run 按钮
   - 参考：`Void/ApplyBlockHoverButtons.tsx` L257-315

5. **删除/复制会话** — 会话管理
   - 参考：`Void/SidebarThreadSelector.tsx`

6. **代码选择作为上下文** — 选中编辑器代码后发送到聊天
   - 参考：`Void/SidebarChat.tsx` L651

7. **Apply 状态指示器** — idle/streaming/has-changes 三态
   - 参考：`Void/ApplyBlockHoverButtons.tsx` L212-239

### P2: 锦上添花

8. **图片预览** — 消息中图片可点击放大
9. **跳转到文件** — 代码块旁显示文件路径按钮
10. **建议文件（当前打开）** — 自动建议打开的文件作为上下文
11. **Gather 模式** — 只读分析模式
12. **线程消息数量** — 会话列表显示消息数

---

## 五、总结

### Saros 的优势
- **Agent 生态完善**：多 Agent、工具审批、子代理、工作流、MCP 桥接、技能系统
- **Token 可视化**：详细消耗弹窗、积分、耗时、缓存命中率
- **消息类型丰富**：Ask-User、Todo、Question、References、Progress 等 8+ 种卡片
- **性能优化深入**：增量 Markdown、懒加载、SVG 缓存、工具卡增量、rAF 批处理
- **滚动体验**：未读 badge + 脉冲 + 平滑滚动 + 宽限期

### Void 的优势
- **代码交互**：Diff 视图（Accept/Reject）、终端运行、跳转文件、Apply 状态
- **上下文管理**：@提及搜索、模糊匹配、面包屑、代码选择、拖放
- **会话管理**：删除、复制、状态指示器
- **渐进式渲染**：50ms 词数节流打字机效果（比 textContent 中间态体验更好）
- **Tree 虚拟化**：成熟的模板回收机制

### 核心差距
Saros 在 **Agent/工具系统** 和 **性能优化** 方面领先，但在 **代码交互**（Diff/终端/跳转）和 **上下文管理**（@提及/拖放）方面有较大差距。补齐 P0 的 3 项功能将显著提升编码体验。
