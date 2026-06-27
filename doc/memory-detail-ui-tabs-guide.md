# 记忆详情 UI 各页签功能说明

> 文件：`src/vs/sessions/contrib/agentStudio/browser/memoryDetailEditorPane.ts`
> 后端：`extensions/agentmemory-memory/src/memoryProvider.ts`

所有 7 个页签**前端和后端均已完整实现**。

---

## 1. 🧠 记忆（默认页签）

**含义**：记忆系统的主视图，展示所有 Working/Episodic/Semantic/Procedural 四层记忆。

**功能**：搜索、过滤（按层级/作用域）、展开查看详情、导出 JSON/Markdown。

**触发**：记忆通过 agent 对话自动写入（`observe` 操作），或用户在聊天中触发记忆提取。

---

## 2. 📌 槽位（Slots）

**含义**：固定槽位，类似 Claude Code 的 `#Important`。存储 agent 的持久化人设、指令或关键信息，**不会被遗忘机制清除**，每次会话固定注入。

**功能**：增/删/改槽位内容。

**触发**：用户手动添加。API：`getSlot/setSlot/getSlots`。

---

## 3. 📖 教训（Lessons）

**含义**：agent 从交互中学习到的经验总结。每条教训包含内容、上下文、标签和置信度，用于**避免重复犯错**。

**功能**：增/删教训，支持内容/上下文/标签。

**触发**：用户手动添加，或系统在任务失败时自动提取。API：`getLessons/addLesson/deleteLesson`。

---

## 4. 🔄 固化（Consolidation）

**含义**：4-Tier 固化体系，展示记忆从 Episodic（情景）→ Semantic（语义）→ Procedural（程序）的**分层迁移结构**。类似人类大脑的记忆固化过程。

**功能**：只读查看。顶部显示固化上下文摘要，下方按 3 个层级分类展示。

**触发**：固化过程由系统**自动执行**（记忆从 episodic 层向 semantic/procedural 层迁移），用户只能查看。API：`getEpisodicMemories/getSemanticMemories/getProceduralMemories/getConsolidationContext`。

---

## 5. 📋 审计（Audit）

**含义**：所有记忆操作的**审计追踪记录**（谁在什么时间对哪个 agent 做了什么操作），用于安全审计和操作回溯。

**功能**：只读查看。显示摘要统计 + 最近 200 条操作日志（write/delete 等），每条日志可展开查看完整 JSON。

**触发**：审计日志在其他 API 操作时**自动记录**（如 `setSlot` 内部调用 `this._audit.record('write', ...)`）。API：`getAuditLog/getAuditSummary`。

---

## 6. 🪝 钩子（Hooks）

**含义**：Hook 机制，在 agent 生命周期事件（会话开始、工具调用前后、任务完成等）触发的**回调处理器**，用于自动注入上下文或观察记忆。

**功能**：只读查看。显示 9 种 Hook 类型的注册状态、处理器数量和调用次数。

**触发**：系统初始化时自动注册 7 个默认 hook（`session_start`、`user_prompt_submit`、`pre_tool_use`、`post_tool_use`、`post_tool_failure`、`task_completed`、`notification`），在生命周期事件中**自动触发**。API：`getHookStats/registerHook/triggerHook`。

---

## 7. 🔀 提交（Commits）

**含义**：与 **Git 提交相关**的记忆条目。当 agent 工作中发生 Git commit 时，系统自动捕获提交信息（SHA、作者、分支、变更文件、概念等）并存入记忆，形成代码变更的可追溯记忆链。

**功能**：只读查看。显示统计（总提交数、新增/删除行数）+ 最近 50 条提交记录，每条可展开查看详情。

**触发**：通过 `onGitCommit()` 或 `captureCommit()` 被外部系统调用时**自动捕获**（可能由 Git hook 或 agent 操作触发）。API：`getRecentCommits/getCommitStats/captureCommit`。

---

## 8. 📊 报告（Report）

**含义**：记忆系统的**综合健康报告**，支持 5 种类型：摘要、健康、性能、使用、详细。包含整体健康状态、建议、分项指标和警告。

**功能**：点击工具栏按钮切换报告类型，自动生成。显示健康 badge + 建议列表 + 分项 sections（含 metrics 键值对和 warnings）。

**触发**：`await generateReport(type, agentId)` 异步生成，数据来自 18 个子系统的实时统计（记忆统计、健康摘要、告警、指标、访问追踪、搜索统计、配额、熔断器、通知、限流、子代理、事件总线等）。首次加载自动生成 summary 报告。

---

## 总结

| 页签 | 可操作 | 数据来源 | 自动/手动 |
|------|--------|----------|-----------|
| 记忆 | 搜索/导出 | agent 对话自动写入 | 自动 |
| 槽位 | **增/删/改** | 用户手动 | 手动 |
| 教训 | **增/删** | 用户手动或失败时自动提取 | 手动+自动 |
| 固化 | 只读 | 系统自动迁移 | 自动 |
| 审计 | 只读 | 所有操作自动记录 | 自动 |
| 钩子 | 只读 | 生命周期事件自动触发 | 自动 |
| 提交 | 只读 | Git commit 时自动捕获 | 自动 |
| 报告 | 切换类型 | 18 个子系统实时统计 | 自动 |
