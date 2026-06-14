# cc-wf-studio vs saros-agents-client Workflow 功能对比分析

> 分析时间：2026-06-06  
> cc-wf-studio 版本：v3.34.3  
> 本项目实现版本：v0.1（初版）

---

## 一、节点类型对比

| 节点类型 | cc-wf-studio | 本项目 | 差距分析 |
|----------|:-----------:|:-----:|---------|
| **Start** | ✅ 绿色药丸，仅 source Handle | ✅ 绿色药丸，仅 source Handle | 基本一致 |
| **End** | ✅ 红色药丸，仅 target Handle，可多个 | ✅ 红色药丸，仅 target Handle | 基本一致 |
| **Task** | ✅ SubAgent 节点（含 agentDefinition/prompt/tools/model/memory/color/8项配置） | ✅ Task 节点（仅 name/executorId/taskId） | 🔴 **严重不足** — 缺少 agent 定义、prompt、工具、模型、内存等核心配置 |
| **Condition/IfElse** | ✅ IfElse 节点（2分支 + evaluationTarget） + Switch 节点（2-10分支 + 默认分支） | ✅ Condition 节点（2分支） | 🟡 缺少 Switch 多分支、evaluationTarget |
| **Parallel** | ❌ 无（通过 Group 节点 + 并行放置实现） | ✅ Parallel 节点 | 🟢 本项目独有 |
| **Loop** | ❌ 无 | ✅ Loop 节点 | 🟢 本项目独有 |
| **Prompt** | ✅ 独立 Prompt 节点（支持 Mustache 模板变量） | ❌ 无 | 🔴 缺少 — 工作流中无法注入纯提示文本 |
| **Skill** | ✅ 完整 Skill 集成（name/scope/allowedTools/executionMode/source 等 12 个字段） | ❌ 无 | 🔴 缺少 — 无法在工作流中调用 Skill |
| **MCP Tool** | ✅ 三种模式：手动配置/AI参数/AI工具选择，支持 ToolParameter 递归结构 | ❌ 无 | 🔴 缺少 — 无法在工作流中调用 MCP 工具 |
| **SubAgent** | ✅ 完整 SubAgent（3 个内置预设 + 自定义，含 YAML front matter 路径解析） | ❌ 无 | 🔴 缺少 — 无子代理委派机制 |
| **SubAgentFlow** | ✅ 嵌套子工作流（独立 nodes/connections/conversationHistory） | ❌ 无 | 🔴 缺少 — 无子工作流嵌套 |
| **Codex** | ✅ OpenAI Codex CLI 集成（promptMode/ sandbox/reasoningEffort/skipGitRepoCheck） | ❌ 无 | 🟡 低优先级 |
| **AskUserQuestion** | ✅ 用户交互节点（2-4选项/多选/AI建议） | ❌ 无 | 🟡 低优先级 |
| **Group** | ✅ 可视化分组容器（含 NodeResizer/高亮/拖入拖出检测） | ❌ 无 | 🟡 低优先级 |

**汇总**：本项目 5 种节点，cc-wf-studio 12 种。**核心缺失**：SubAgent、Skill、MCP Tool、Prompt、SubAgentFlow。

---

## 二、编辑器体验对比

| 功能 | cc-wf-studio | 本项目 | 差距 |
|------|:-----------:|:-----:|------|
| **画布渲染** | ReactFlow 11.10 | @xyflow/react 12 | ✅ 一致（新版本） |
| **节点调色板** | 按分类分组 + 按钮点击添加 + 非重叠位置计算（20次尝试/50px阈值） | 简单按钮列表 + 随机位置（200+250 范围） | 🟡 缺少分组/非重叠算法 |
| **属性面板** | 浮动 PropertyOverlay + 每种节点专用编辑器（12 个组件）+ 支持 resize | 浮动 PropertyPanel + 3 种节点编辑器（task/condition/loop） | 🔴 缺少大量节点类型编辑器 |
| **撤销/重做** | Zundo temporal 中间件（仅追踪 nodes/edges，排除 selected/width/height；50步历史；拖拽期间暂停；跨工作流清除） | ❌ 无 | 🔴 **严重缺失** |
| **连接验证** | runtime isValidConnection（Start无入/End无出/Group无连接）+ 静态 validate-workflow（1180行） | 无验证 | 🔴 缺少 — 可能导致无效连接 |
| **网格吸附** | 15px grid | 15px grid | ✅ 一致 |
| **MiniMap** | 按节点类型颜色编码 | 按节点类型颜色编码 | ✅ 一致 |
| **交互模式** | Pan/Selection 两种模式 + 拖拽期间 Ctrl 反转 + Figma 风格 freehand 滚动 | 仅默认模式 | 🟡 缺少 freehand 滚动 |
| **删除确认** | 需确认对话框（pendingDeleteNodeIds）+ Delete键拦截 | 直接删除（Backspace/Delete键） | 🟡 有误删风险 |
| **Start节点保护** | 不可删除/不可移除出画布 | 不可删除 | ✅ 一致 |
| **拖拽体验** | 单步撤销（拖拽开始暂停追踪，拖拽结束恢复） | 无 | 🔴 拖拽会产生大量撤销步骤 |
| **Group 分组** | 完整实现（拖入/拖出检测、坐标转换、NodeResizer、高亮脉冲动画） | ❌ 无 | 🟡 低优先级 |

**汇总**：核心缺失是**撤销/重做**和**连接验证**，这两者直接影响编辑体验和数据完整性。

---

## 三、数据模型对比

| 维度 | cc-wf-studio | 本项目 | 差距 |
|------|-------------|--------|------|
| **Workflow ID** | `workflow-{timestamp}` | UUID (generateUuid) | ✅ 本项目更优 |
| **节点定义** | `WorkflowNode[]`（每节点含 type/id/name/position/data/style/parentId） | `nodes: WorkflowGraphNode[]` | ⚠️ 基本一致，但本项目缺 schemaVersion/migration |
| **连接定义** | `Connection[]`（id/from/to/fromPort/toPort/condition） | `connections: WorkflowGraphConnection[]` | ✅ 一致 |
| **Steps 兼容层** | 无（纯 graph） | IWorkflow.steps[] + nodes[] 双模态 | 🟢 本项目更灵活 |
| **Schema 版本** | schemaVersion "1.0.0"/"1.1.0"/"1.2.0" + migrateWorkflow() | ❌ 无 | 🟡 后续迭代需要 |
| **SubAgentFlow** | subAgentFlows: SubAgentFlow[] + 快照/恢复机制 | ❌ 无 | 🔴 |
| **ConversationHistory** | AI 细化对话记录（20轮/消息/错误码） | ❌ 无 | 🟡 |
| **SlashCommandOptions** | context/model/hooks/allowedTools/argumentHint | ❌ 无 | 🟡 |
| **Metadata** | 开放 tags/author + unknown | ❌ 无 | 🟡 |
| **验证规则** | VALIDATION_RULES 常量（100节点限制/各字段 min-max/regex）+ validate-workflow.ts (1180行) | ❌ 无 | 🔴 |
| **数据迁移** | normalizeMcpNodeData() / 向后兼容 Branch 节点 | ❌ 无 | 🟡 |

---

## 四、AI 集成对比

| 功能 | cc-wf-studio | 本项目 | 差距 |
|------|:-----------:|:-----:|------|
| **Refinement Chat** | 完整 AI 细化面板（支持3种 Provider/流式/双模式/错误重试/拖拽调整大小） | ❌ 无 | 🔴 |
| **MCP Server** | 内置 MCP 服务器（6个工具：get/schema/apply/list_agents/update/highlight） | ❌ 无 | 🔴 |
| **AI 工作流名称生成** | ✅ | ❌ 无 | 🟡 |
| **AI 指标收集** | ✅ A/B 测试（TOON vs JSON） | ❌ 无 | 🟡 |

---

## 五、其他功能对比

| 功能 | cc-wf-studio | 本项目 |
|------|:-----------:|:-----:|
| **多提供者导出** | 8 种（Claude Code/Copilot/Codex/Gemini/Roo/Antigravity/Cursor/Slack） | ❌ |
| **Mermaid 导出** | flowchart TD/LR + subgraph + 边标签 | ❌ |
| **概览模式** | Mermaid 图示 + Markdown 面板 + 双向联动/跟随模式 | ❌ |
| **Skill 导出** | 自动生成 SKILL.md（含 YAML front matter） | ❌ |
| **Slack 集成** | 导入/导出/深度链接/频道分享 | ❌ |
| **i18n** | 5 种语言（en/ja/ko/zh-CN/zh-TW） | 仅中文 |
| **Sample Workflows** | beginner/intermediate/advanced 模板 | ❌ |
| **Workflow Preview** | CustomEditor + 实时文档监听 | ❌ |
| **Changelog** | 应用内变更日志 | ❌ |

---

## 六、优化优先级建议

### 🔴 P0 — 必须立即实现（影响核心可用性）

| 功能 | 理由 | 预计工作量 |
|------|------|-----------|
| **撤销/重做** | 编辑器中最重要的功能之一，无撤销无法安全编辑 | 2-3h（引入 zundo 中间件） |
| **连接验证** | 防止无效连线（Start无入/End无出/自环等）导致崩溃 | 1h（isValidConnection 回调） |
| **Task 节点增强** | 当前 Task 节点过于简陋，无法携带足够的 Agent 配置 | 3-4h（参考 SubAgent node） |
| **属性面板完善** | 支持所有节点类型的属性编辑（当前仅3种） | 2-3h |

### 🟡 P1 — 高优先级（提升编辑体验）

| 功能 | 理由 | 预计工作量 |
|------|------|-----------|
| **Skill 节点** | Agent Studio 已有 Skill 系统，工作流应能编排 Skill 调用 | 3-4h |
| **Prompt 节点** | 工作流中需要注入纯提示文本 | 1-2h |
| **节点调色板改进** | 分组显示 + 非重叠位置计算 | 1h |
| **删除确认对话框** | 防止误删节点 | 1h |
| **拖拽单步撤销** | 避免拖拽污染撤销历史 | 1h |

### 🟢 P2 — 中期规划

| 功能 | 理由 |
|------|------|
| **MCP Tool 节点** | Agent Studio 已有 MCP 系统，工作流应能编排 MCP 调用 |
| **SubAgent 节点** | Agent Studio 已有 Employee/PresetAgent 系统，直接映射 |
| **Schema 版本 + 迁移** | 数据模型向后兼容 |
| **Mermaid 导出** | 概览/文档化工作流 |
| **Switch 多分支节点** | Condition 节点的自然扩展 |

### 🔵 P3 — 长期规划

| 功能 | 理由 |
|------|------|
| **SubAgentFlow 嵌套** | 复杂工作流需要子工作流抽象 |
| **Refinement Chat** | AI 辅助工作流编辑 |
| **概览模式** | Mermaid 图 + 文档 |
| **多提供者导出** | 技能导出到多种 AI 工具 |
| **i18n** | 国际化支持 |

---

## 七、架构层面差异

| 层面 | cc-wf-studio | 本项目 | 优势方 |
|------|-------------|--------|--------|
| **项目类型** | VSCode Extension | VSCode 源码 Fork（内置） | 本项目 — 更深集成 |
| **WebView 构建** | 独立 Vite 构建 | 共享 esbuild 构建 | 本项目 — 代码复用 |
| **状态管理** | Zustand + Zundo | Zustand（无中间件） | cc-wf-studio |
| **数据持久化** | CustomEditor + vscode.workspace.fs | IFileService + IWorkflowStorageService | 本项目 — 更底层 |
| **节点组件** | 12 个专用 React 组件 | 6 个组件（4 实用 + Start/End） | cc-wf-studio |
| **类型系统** | 核心包共享类型（monorepo） | sessions 层内部类型 | 本项目 — 更内聚 |
| **测试** | 无（仅声明了 Vitest） | 无 | 持平 😅 |

---

## 八、实施路线图建议

### 第一阶段（本周完成）：完善编辑器核心体验
1. ✅ 撤销/重做（Zundo 中间件）
2. ✅ 连接验证（isValidConnection）
3. ✅ 删除确认对话框
4. ✅ 节点调色板分组 + 非重叠位置

### 第二阶段（下周）：扩展节点类型
1. Task 节点增强（agentDefinition/prompt/tools/model/memory）
2. Skill 节点（复用现有 Skill 系统）
3. Prompt 节点
4. 属性面板全面扩展

### 第三阶段（两周内）：AI 集成 + 高级功能
1. MCP Tool 节点
2. SubAgent 节点
3. Schema 版本 + 数据迁移
4. Mermaid 导出

### 第四阶段（一月内）：生态完善
1. SubAgentFlow 嵌套
2. Refinement Chat
3. 概览模式
4. 多提供者导出
