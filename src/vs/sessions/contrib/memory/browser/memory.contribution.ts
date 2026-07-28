/*---------------------------------------------------------------------------------------------
 *  Memory Side View — agentmemory 4-Tier Consolidation Model
 *  Sidebar contribution: registers the Memory view container and view pane.
 *---------------------------------------------------------------------------------------------
 *
 *  ⚠️ 2026-07-21 活动栏入口已停用
 *  ─────────────────────────────────────────────────────────────────────────────────
 *  知识库导入流程统一走「知识库专家」agent 技能；记忆入口改放在
 *  知识库 view 顶部红框位置的「🧠 记忆库」按钮（打开 MemoryDetailEditorPane）。
 *  如需重新启用 activity-bar 入口，请恢复原 `MemorySidebarContribution` 类与
 *  `registerWorkbenchContribution2` 调用。
 *  ─────────────────────────────────────────────────────────────────────────────────
 */

// 此文件原本包含 `MemorySidebarContribution` 类的活动栏注册代码。
// 该注册已于 2026-07-21 注释/移除 — 记忆入口改走 MemoryDetailEditorPane。
// `MemoryViewPane` 类（memoryViewPane.ts）仍然保留，未来如需恢复活动栏入口
// 可在本文件重新添加注册代码。
