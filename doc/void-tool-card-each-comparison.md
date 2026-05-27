# Void vs Sarosis 聊天框工具卡片逐一对比

> 生成日期：2026-05-27
> 逐一对比每个工具/卡片类型在两个项目中的渲染差异

---

## 一、卡片类型全景

### Void 卡片类型（共 9 种）

| # | 卡片 | 组件 | 数据源 |
|---|------|------|--------|
| 1 | ReadFileWrapper | `builtinToolNameToComponent['read_file'].resultWrapper` | `ToolMessage<read_file>` |
| 2 | EditFileWrapper | `builtinToolNameToComponent['edit_file'].resultWrapper` | `ToolMessage<edit_file>` |
| 3 | RunCommandWrapper | `builtinToolNameToComponent['run_command'].resultWrapper` | `ToolMessage<run_command>` |
| 4 | CreateFileWrapper | `builtinToolNameToComponent['create_file_or_folder'].resultWrapper` | `ToolMessage<create_file_or_folder>` |
| 5 | DeleteFileWrapper | `builtinToolNameToComponent['delete_file_or_folder'].resultWrapper` | `ToolMessage<delete_file_or_folder>` |
| 6 | LsDirWrapper | `builtinToolNameToComponent['ls_dir'].resultWrapper` | `ToolMessage<ls_dir>` |
| 7 | SearchWrapper | `builtinToolNameToComponent['search_files'].resultWrapper` | `ToolMessage<search_files>` |
| 8 | MCPToolWrapper | `MCPToolWrapper` | `ToolMessage<MCP>` |
| 9 | InvalidTool | `InvalidTool` | `ToolMessage<invalid_params>` |

### Sarosis 卡片类型（共 10 种）

| # | 卡片 | 组件 | 数据源 |
|---|------|------|--------|
| 1 | ToolCallCard (Generic) | `GenericToolCallCard` | `message.toolCalls[]` |
| 2 | ListItemsRenderer | `ListItemsRenderer` | `toolCall` (renderType=ListItems) |
| 3 | RunTerminalRenderer | `RunTerminalRenderer` | `toolCall` (renderType=RunTerminal) |
| 4 | CodeApplyRenderer | `CodeApplyRenderer` | `toolCall` (renderType=CodeApply) |
| 5 | ThinkingCard | 内嵌于 `ChatMessage.tsx` | `message.thinking` |
| 6 | ReferencesCard | `ReferencesCard` | `message.references[]` |
| 7 | ProgressCard | `ProgressCard` | `message.progress` |
| 8 | ConfirmationCard | `ConfirmationCard` | `message.confirmation` |
| 9 | SubAgentCard | `SubAgentCard` | `message.subAgents[]` |
| 10 | TodoListCard | `TodoListCard` | `message.todos[]` |

**额外辅助卡片**：`TipCard`、`QuestionCarouselCard`、`OrchestrationPlanInline`

---

## 二、按工具功能逐一对比

### 1. read_file / 读取文件

| 维度 | Void — ReadFileWrapper | Sarosis — CodeApplyRenderer |
|------|----------------------|---------------------------|
| **标题** | done: "Read file" / proposed: "Read file" / running: "Reading file..." (蓝色加载) | 📄 "读取文件" + `path` 详情 |
| **描述行** | `desc1`: 文件路径，可点击跳转 | 折叠态显示参数摘要（文件路径） |
| **图标** | 📄 (硬编码) | 📄 (ToolDisplayRegistry) |
| **内容区** | SmallProseWrapper 包裹的 Markdown（带行号） | `<pre><code>` 包裹的代码预览 |
| **行号** | **有** — 每行左侧显示行号 | **无** |
| **行高亮** | **有** — 支持 offset/limit 行范围高亮 | **无** |
| **搜索高亮** | **无**（read_file 不搜索） | **无** |
| **Apply 按钮** | **有** — 代码块悬浮 Apply 按钮 | **有** — "查看文件"按钮 |
| **折叠** | 可折叠（ChevronRight 动画） | 可折叠（Generic 卡片展开/折叠） |
| **结果截断** | 无显式限制 | 500 → 5000 → 全部 三级 |

**视觉对比**：
```
Void:
┌─────────────────────────────────────────┐
│ 📄 Read file   src/main.ts          [▼] │
├─────────────────────────────────────────┤
│  1 │ import React from 'react'          │
│  2 │ import { useState } from 'react'   │  ← 行号 + 可高亮
│  3 │                                    │
│                        [Apply] ← 悬浮   │
└─────────────────────────────────────────┘

Sarosis:
┌─────────────────────────────────────────┐
│ 🔄 📄 读取文件  src/main.ts     [查看] │
├─────────────────────────────────────────┤
│ 输入                                    │
│ ┌─────────────────────────────────────┐ │
│ │ {                                   │ │
│ │   "path": "src/main.ts"            │ │  ← JSON 格式
│ │ }                                   │ │
│ └─────────────────────────────────────┘ │
│ 输出                                    │
│ ┌─────────────────────────────────────┐ │
│ │ import React from 'react'...        │ │  ← 无行号
│ │ ...                                 │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**差异要点**：
- Void **有行号**，Sarosis 无
- Void 内容用 **SmallProseWrapper（Markdown 渲染）**，Sarosis 用 **pre/code（纯文本）**
- Void 有 **Apply 悬浮按钮**（一键应用代码块），Sarosis 只有"查看文件"
- Sarosis 有 **三级结果截断**，Void 无显式限制

---

### 2. edit_file / 编辑文件

| 维度 | Void — EditFileWrapper | Sarosis — CodeApplyRenderer |
|------|----------------------|---------------------------|
| **标题** | done: "Edited file" / proposed: "Edit file" / running: "Editing file..." | 📝 "编辑文件" + `path` 详情 |
| **描述行** | `desc1`: 文件路径，可点击跳转 | 折叠态显示参数摘要（文件路径） |
| **图标** | ✏️ (硬编码) | 📝 (ToolDisplayRegistry) |
| **内容区** | **Diff 视图**（SmallProseWrapper） | **代码预览**（pre/code） |
| **Diff 高亮** | **有** — 红色删除 / 绿色添加 | **无** — 仅显示代码内容 |
| **Apply 按钮** | **有** — 代码块悬浮 Apply 按钮 | **有** — "查看文件"按钮 |
| **Lint 检查** | **有** — 底部 bottomChildren 显示 Lint 错误 | **无** |
| **错误展示** | **有** — bottomChildren 显示 Error | 标准错误区 |

**视觉对比**：
```
Void:
┌─────────────────────────────────────────┐
│ ✏️ Edited file   src/main.ts        [▼] │
├─────────────────────────────────────────┤
│ - const old = "hello";                  │  ← 红色删除行
│ + const new = "world";                  │  ← 绿色添加行
│                        [Apply] ← 悬浮   │
├─────────────────────────────────────────┤
│ ⚠ Lint Errors (1)                   [▼] │  ← Lint 检查
└─────────────────────────────────────────┘

Sarosis:
┌─────────────────────────────────────────┐
│ 📝 编辑文件  src/main.ts        [查看] │
├─────────────────────────────────────────┤
│ 输入                                    │
│ ┌─────────────────────────────────────┐ │
│ │ {                                   │ │
│ │   "path": "src/main.ts",           │ │
│ │   "code": "const new = ..."        │ │  ← 无 Diff 高亮
│ │ }                                   │ │
│ └─────────────────────────────────────┘ │
│ 输出                                    │
│ ┌─────────────────────────────────────┐ │
│ │ Successfully edited src/main.ts     │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**差异要点**：
- Void 有 **Diff 视图**（红绿高亮），Sarosis 无
- Void 有 **Lint 检查**（bottomChildren），Sarosis 无
- Void 有 **Apply 悬浮按钮**，Sarosis 只有"查看文件"

---

### 3. run_command / 运行命令

| 维度 | Void — RunCommandWrapper | Sarosis — RunTerminalRenderer |
|------|-------------------------|-------------------------------|
| **标题** | done: "Ran terminal" / proposed: "Run terminal" / running: "Running terminal..." | ⌨️ "运行命令" + `command` 详情 |
| **描述行** | `desc1`: 命令文本，可点击跳转终端 | 折叠态显示 command 参数 |
| **图标** | ⌨️ (硬编码) | ⌨️ (ToolDisplayRegistry) |
| **内容区** | SmallProseWrapper（终端输出 Markdown） | 终端样式（绿色 $ + 命令 + 输出） |
| **退出码** | **有** — 显示 exit code | **无** |
| **持续终端** | **有** — run_persistent_command / open_persistent_terminal | **无** |
| **Kill 终端** | **有** — kill_persistent_terminal | **无** |
| **折叠** | 可折叠 | **不可折叠**（renderType 卡片无折叠） |
| **输出样式** | SmallProseWrapper（Markdown） | `<pre>` 等宽字体 |

**视觉对比**：
```
Void:
┌─────────────────────────────────────────┐
│ ⌨️ Ran terminal   npm run build     [▼] │
│                                    exit:0│  ← 退出码
├─────────────────────────────────────────┤
│ > my-project@1.0.0 build                │
│ > tsc && vite build                      │
│                                          │
│ Build completed successfully.            │
└─────────────────────────────────────────┘

Sarosis:
┌─────────────────────────────────────────┐
│ ⌨️ 运行命令  npm run build              │  ← 无折叠
├─────────────────────────────────────────┤
│ $ npm run build                         │  ← 绿色 $ 提示符
│ > my-project@1.0.0 build                │
│ > tsc && vite build                      │
│ Build completed successfully.            │
└─────────────────────────────────────────┘
```

**差异要点**：
- Void 显示 **退出码**，Sarosis 无
- Void 支持 **持续终端**（持久化运行 + Kill），Sarosis 无
- Void **可折叠**，Sarosis RunTerminal 渲染器不可折叠
- Sarosis 有 **绿色 $ 提示符**，终端风格更地道

---

### 4. create_file_or_folder / 创建文件

| 维度 | Void — CreateFileWrapper | Sarosis — CodeApplyRenderer |
|------|-------------------------|---------------------------|
| **标题** | done: "Created file" / proposed: "Create file" / running: "Creating file..." | ✏️ "写入文件" + `path` 详情 |
| **描述行** | `desc1`: 文件路径 | 折叠态显示文件路径 |
| **图标** | 📄 (硬编码) | ✏️ (ToolDisplayRegistry) |
| **内容区** | SmallProseWrapper（文件内容 Markdown） | 代码预览 + 结果区 |
| **Apply 按钮** | **有** — 代码块悬浮 Apply 按钮 | **有** — "查看文件"按钮 |
| **文件夹创建** | **有** — 独立判断文件夹 vs 文件 | **无** — 统一 CodeApply |

**差异要点**：
- Void 区分 **文件创建** vs **文件夹创建**，Sarosis 统一处理
- Void 有 **Apply 悬浮按钮**，Sarosis 只有"查看文件"

---

### 5. delete_file_or_folder / 删除文件

| 维度 | Void — DeleteFileWrapper | Sarosis — GenericToolCallCard |
|------|-------------------------|-------------------------------|
| **标题** | done: "Deleted file" / proposed: "Delete file" / running: "Deleting file..." | 🗑️ (fallback 🔧) + "delete_file_or_folder" |
| **描述行** | `desc1`: 文件路径 | 折叠态显示参数摘要 |
| **图标** | 🗑️ (硬编码) | 🔧 (fallback，Registry 无配置) |
| **内容区** | "Deleted {path}" 确认信息 | 标准 输入/输出 区 |
| **审批** | **有** — edits 类别需审批 | 无 |

**差异要点**：
- Void **需要用户审批**（edits 类别），Sarosis 静默执行
- Void 有 **专用图标** 🗑️，Sarosis 使用 fallback 🔧
- Void 显示 **简洁确认信息**，Sarosis 显示完整 JSON

---

### 6. ls_dir / 列出目录

| 维度 | Void — LsDirWrapper | Sarosis — ListItemsRenderer |
|------|---------------------|----------------------------|
| **标题** | done: "Inspected folder" / proposed: "Inspect folder" / running: "Inspecting folder..." | 📂 "列出目录" + `path` 详情 |
| **描述行** | `desc1`: 目录路径，可点击 | 折叠态显示路径 |
| **图标** | 📂 (硬编码) | 📂 (ToolDisplayRegistry) |
| **内容区** | ListableToolItem 列表（可点击） | 文件列表（📁 目录 / 📄 文件） |
| **分页** | **有** — numResults + hasNextPage（"N+ results"） | **无** |
| **可点击** | **有** — 每项可点击跳转 | **有** — item_click_event 支持 |
| **图标区分** | 小圆点标记 | 📁/📄 emoji 区分 |
| **折叠** | 可折叠 | **不可折叠** |

**视觉对比**：
```
Void:
┌─────────────────────────────────────────┐
│ 📂 Inspected folder   src/          [▼] │
│                                    5+ results│  ← 分页指示
├─────────────────────────────────────────┤
│ • main.ts                               │
│ • components/                            │  ← 可点击
│ • utils.ts                              │
└─────────────────────────────────────────┘

Sarosis:
┌─────────────────────────────────────────┐
│ 📂 列出目录  src/                       │  ← 无折叠
├─────────────────────────────────────────┤
│ 📄 main.ts                              │
│ 📁 components/                           │  ← 📁/📄 区分
│ 📄 utils.ts                             │
└─────────────────────────────────────────┘
```

**差异要点**：
- Void 有 **分页指示**（N+ results），Sarosis 无
- Void 用 **小圆点** 标记列表项，Sarosis 用 **📁/📄 emoji**
- Sarosis 的 ListItems 支持 **Knot ListItem 格式**（content_tip, suffix_content, item_click_event），Void 不支持

---

### 7. search_files / 搜索文件

| 维度 | Void — SearchWrapper | Sarosis — ListItemsRenderer |
|------|---------------------|----------------------------|
| **标题** | done: "Searched files" / proposed: "Search files" / running: "Searching files..." | 🔍 "搜索文件" + `query` 详情 |
| **描述行** | `desc1`: 搜索词，`numResults`: 结果数 | 折叠态显示 query/pattern |
| **图标** | 🔍 (硬编码) | 🔍 (ToolDisplayRegistry) |
| **内容区** | ListableToolItem 列表 | 文件列表 |
| **搜索高亮** | **有** — 匹配词高亮 | **无** |
| **分页** | **有** — numResults + hasNextPage | **无** |
| **可点击** | **有** — 跳转到文件 | **有** — openFile() |

**差异要点**：
- Void 有 **搜索词高亮**，Sarosis 无
- Void 有 **分页指示**，Sarosis 无

---

### 8. MCP 工具

| 维度 | Void — MCPToolWrapper | Sarosis — GenericToolCallCard |
|------|----------------------|-------------------------------|
| **标题** | "Called {serverName}" / "Calling {serverName}..." | 🔧 (fallback) + 工具名 |
| **描述行** | `desc1`: MCP 服务器名 | 折叠态显示参数摘要 |
| **图标** | 🔌 (推断) | 🔧 (fallback) |
| **内容区** | SmallProseWrapper（参数 + 结果） | 标准 输入/输出 区 |
| **服务器名显示** | **有** — 标题中包含 | **无** — 不区分 MCP vs 内置 |
| **参数展示** | Markdown 渲染 | JSON 格式化 |
| **审批** | **有** — MCP 类别需审批 | 无 |

**差异要点**：
- Void 对 MCP 工具有 **专用视觉标识**（标题显示服务器名），Sarosis 无区分
- Void MCP 工具 **需要审批**，Sarosis 静默处理

---

### 9. InvalidTool（参数无效）

| 维度 | Void — InvalidTool | Sarosis |
|------|-------------------|---------|
| **存在** | **有** — 独立组件 | **无** — 无对应状态 |
| **显示内容** | 红色警告：工具名 + 错误信息 | — |
| **交互** | 无（仅提示） | — |
| **对循环影响** | 不阻塞 Agent Loop（仅添加消息） | — |

**差异要点**：Void 有独立的参数校验失败展示，Sarosis 完全没有。

---

### 10. 工具审批（Tool Request）

| 维度 | Void — ToolRequestAcceptRejectButtons | Sarosis |
|------|--------------------------------------|---------|
| **存在** | **有** — 独立组件 | **无** |
| **触发条件** | `type === 'tool_request'` 且 `!autoApprove` | — |
| **显示内容** | "Allow" / "Deny" 按钮 | — |
| **按钮样式** | 绿色 Allow + 灰色 Deny | — |
| **位置** | 工具卡片下方独立行 | — |
| **审批后** | 重新启动 _runChatAgent（callThisToolFirst） | — |
| **拒绝后** | 消息标记 rejected，流式状态结束 | — |

---

## 三、Sarosis 独有的卡片类型（Void 中不存在）

### 11. ThinkingCard（思考过程）

**Void 无对应卡片。** Void 的思考过程在 `ThreadStreamState.isRunning === 'LLM'` 时的 `reasoningSoFar` 字段中，作为流式状态的一部分，不是独立卡片。

**Sarosis 实现**：
```
┌─────────────────────────────────────────┐
│ 💡 思考过程                          [▼] │  ← 默认折叠
├─────────────────────────────────────────┤
│ *让我分析一下这个问题...*                 │  ← Markdown 渲染
│ 1. 首先需要读取文件                      │
│ 2. 然后修改相关代码                      │
└─────────────────────────────────────────┘
```
- 流式时：旋转 spinner + "思考中..." + 脉冲发光动画
- 完成时：灯泡图标 + "思考过程" + Markdown 渲染内容

---

### 12. ReferencesCard（引用卡片）

**Void 无对应卡片。** Void 的文件引用通过 `stagingSelections` 在消息发送前处理，不在消息中展示。

**Sarosis 实现**：
```
┌─────────────────────────────────────────┐
│ 📚 使用了 3 个引用                    [▼] │
├─────────────────────────────────────────┤
│ 📄 src/main.ts                          │
│ 📝 helper.ts     已修改                  │  ← state badge
│ 🔗 https://...                          │
└─────────────────────────────────────────┘
```
- 5 种引用类型：file / code / url / symbol / text
- 3 种状态标签：已修改(绿) / 待处理(黄) / 已排除(灰)

---

### 13. ProgressCard（进度卡片）

**Void 无对应卡片。** Void 没有进度展示卡片。

**Sarosis 实现**：
```
┌─────────────────────────────────────────┐
│ ○ 步骤1: 读取文件                       │
│ ○ 步骤2: 分析代码                       │
│ ● 步骤3: 生成修改   ← 旋转 spinner      │
│ ○ 步骤4: 应用变更                       │
└─────────────────────────────────────────┘
```
- 4 种状态：pending(○) / in-progress(●旋转) / completed(✓) / error(⚠️)
- 可折叠模式：标题显示 "N/M 步骤完成"

---

### 14. ConfirmationCard（确认卡片）

**Void 的对应**：`ToolRequestAcceptRejectButtons`（简单的批准/拒绝按钮）。

**Sarosis 的 ConfirmationCard 更强大**：
```
┌─────────────────────────────────────────┐
│ 📋 执行计划确认                      [▼] │
├─────────────────────────────────────────┤
│ 计划: 重构认证模块                       │
│                                         │
│ 1. 修改 login.ts        低 🤖 explorer  │
│    修改登录逻辑...                       │
│    📄 src/auth/login.ts                  │
│                                         │
│ 2. 更新测试文件         中 🤖 general   │
│    添加新的测试用例                       │
│    📄 tests/auth.test.ts                 │
│    依赖: #1                              │
│                                         │
│ 执行模式: Craft (Agent)                  │
│                                         │
│ [🚀 批准并执行]  [仅批准]  [拒绝]        │
└─────────────────────────────────────────┘
```
- 支持 **plan-approval** 类型：显示结构化任务列表
- 每个任务显示：标题、描述、文件列表、复杂度(低/中/高)、建议角色、依赖关系
- 两种批准模式："批准并执行" + "仅批准"
- 3 种提交状态：approved(✓) / rejected(✕) / cancelled(−)

---

### 15. SubAgentCard（子 Agent 卡片）

**Void 无对应卡片。** Void 没有子 Agent 概念。

**Sarosis 实现**：
```
单个 Agent:
┌─────────────────────────────────────────┐
│ 🔄 探索 Agent    1/1 执行中          [▼] │
├─────────────────────────────────────────┤
│ 🔍 ● 分析代码结构...                    │  ← shimmer 动画
│    ●●● 正在搜索相关文件...              │
└─────────────────────────────────────────┘

并行执行:
┌─────────────────────────────────────────┐
│ 🔄 并行执行    2/3 完成              [▼] │
├─────────────────────────────────────────┤
│ 批次 (3 个任务)                          │
│ 🔍 ✓ 分析代码结构                       │
│ ⚙️ ✓ 修改登录逻辑                       │
│ 🌐 ● 搜索最新文档...                    │  ← shimmer
└─────────────────────────────────────────┘
```
- 3 种 Agent 类型：探索(🔍蓝) / 通用(⚙️绿) / 研究(🌐紫)
- 4 种状态：pending / running(shimmer) / done(✓) / error(✕) / cancelled(■)
- 支持 **groupId 分组**（并行批次）
- 完成 Agent 可展开查看输出预览

---

### 16. TodoListCard（任务清单卡片）

**Void 无对应卡片。**

**Sarosis 实现**：
```
┌─────────────────────────────────────────┐
│ ☑️ 任务清单    2/3                     [▼] │
├─────────────────────────────────────────┤
│ ☑ 读取文件                              │
│ ☑ 分析代码结构                          │
│ ☐ 生成修改方案     👤 explorer          │
│                                         │
│ [添加新任务...]                     [+]  │
└─────────────────────────────────────────┘
```
- 可交互：复选框勾选 + 添加新任务
- 显示进度：N/M 完成
- 支持描述、指派人

---

### 17. TipCard / QuestionCarouselCard（辅助卡片）

**Void 无对应卡片。**

**TipCard**：可关闭的提示条，带操作按钮。
**QuestionCarouselCard**：推荐问题列表，支持分类过滤，点击即发送。

---

## 四、共享核心组件对比

### ToolHeaderWrapper (Void) vs ToolCallCard (Sarosis)

| 维度 | Void — ToolHeaderWrapper | Sarosis — ToolCallCard |
|------|-------------------------|----------------------|
| **设计模式** | 每工具传入 params → 统一渲染 | renderType 分发 → 专用渲染器 |
| **标题生成** | `titleOfBuiltinToolName` 硬编码 3 变体 | `ToolDisplayRegistry` 配置化 |
| **折叠动画** | CSS transition (max-height + opacity) | CSS display toggle (无动画) |
| **状态指示** | isError ⚠️ / isRejected 🚫 / loading 蓝色闪烁 | running 旋转 / error ✕ / completed ✓ |
| **右侧信息** | info(⍰) + numResults + desc2 | duration + 折叠箭头 |
| **内容区** | SmallProseWrapper (Markdown) | pre/code (格式化文本) |
| **Apply 按钮** | 悬浮在代码块上 | 卡片内"查看文件"按钮 |
| **BottomChildren** | 支持（Error + Lint） | 不支持 |

---

## 五、完整对比矩阵

| 功能 | Void | Sarosis | 优势方 |
|------|------|---------|--------|
| 文件读取 | 行号 + 高亮 + Apply | 无行号 + 查看文件 + 截断 | Void |
| 文件编辑 | Diff 视图 + Lint + Apply | 纯文本 + 查看文件 | Void |
| 运行命令 | 退出码 + 持续终端 + Kill | 绿色 $ 提示符 + 终端样式 | 各有优势 |
| 创建文件 | Apply 按钮 | 查看文件 | Void |
| 删除文件 | 需审批 + 专用图标 | 静默执行 + fallback 图标 | Void |
| 列出目录 | 分页 + 可点击 | 📁/📄 区分 + Knot 格式 | 各有优势 |
| 搜索文件 | 搜索高亮 + 分页 | 列表展示 | Void |
| MCP 工具 | 专用标识 + 审批 | 与内置统一 | Void |
| 参数无效 | 独立 InvalidTool 组件 | 无 | Void |
| 工具审批 | 批准/拒绝按钮 | 无 | Void |
| 思考过程 | 流式状态中（非卡片） | 独立 ThinkingCard | Sarosis |
| 引用展示 | 无 | ReferencesCard + 状态标签 | Sarosis |
| 进度展示 | 无 | ProgressCard + 步骤跟踪 | Sarosis |
| 确认/审批 | 简单按钮 | ConfirmationCard + 计划审批 | Sarosis |
| 子 Agent | 无 | SubAgentCard + 并行分组 | Sarosis |
| 任务清单 | 无 | TodoListCard + 交互 | Sarosis |
| 推荐问题 | 无 | QuestionCarouselCard | Sarosis |
| 配置化 | 硬编码 | ToolDisplayRegistry | Sarosis |
| 结果截断 | 无 | 500/5000/全部 | Sarosis |
| 交织布局 | 独立消息 | Placeholder 精确定位 | Sarosis |

---

## 六、优化建议（针对 Sarosis）

### 紧急（体验差距大）

1. **为 CodeApplyRenderer 添加行号**：read_file 结果应带行号，支持 offset/limit 行范围高亮
2. **为 edit_file 添加 Diff 视图**：红色删除行 + 绿色添加行，参考 VS Code 的 diff editor
3. **添加 Apply 悬浮按钮**：edit_file / create_file / write_file 的代码块上添加"应用更改"按钮

### 重要（功能缺失）

4. **添加工具审批 UI**：增加 `approval_required` / `rejected` 状态，渲染批准/拒绝按钮
5. **添加退出码显示**：run_command 结果显示 exit code
6. **为 delete 工具添加 Registry 配置**：`delete_file_or_folder` → 🗑️ + 需审批
7. **添加参数校验失败状态**：增加 `invalid_params` 独立渲染

### 改进（体验优化）

8. **添加搜索结果高亮**：search_files / grep 结果高亮匹配词
9. **添加分页指示**：ls_dir / search_files 显示 "N+ results"
10. **MCP 工具视觉区分**：添加 "MCP" 标签 + 服务器名
11. **RunTerminal 支持折叠**：长输出应可折叠
12. **添加 Lint 检查展示**：edit_file 后显示 Lint 错误
13. **添加持续终端支持**：run_persistent_command / kill_persistent_terminal
