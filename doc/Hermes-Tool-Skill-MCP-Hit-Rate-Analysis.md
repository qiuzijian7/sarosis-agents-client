# Hermes-Agent 工具命中率优化机制分析

> 分析对象：`G:\CustomWorkspaces\AIProjects\Hermes-Agent`
> 对比项目：VsSaros（CodeBuddy CN）
> 日期：2026-06-27

## 核心策略：渐进式披露（Progressive Disclosure）

Hermes-Agent 不把所有工具一次性发给 LLM，而是采用**多层漏斗式过滤 + 按需加载**：

## 1. 工具集分组（Toolset Grouping）

```
用户配置: enabled_toolsets = ["web", "terminal", "coding"]
     ↓
resolve_toolset() 递归解析（支持 includes 嵌套）
     ↓
disabled_toolsets 减法（核心工具受保护不被删除）
     ↓
只把选中工具集的工具发给 LLM
```

**对比本项目**：本项目无工具集概念，88 个 builtin 工具全部发送。

## 2. Tool Search 桥接（核心创新）

当 MCP + 插件工具的 schema 总量超过上下文窗口 10% 时，自动替换为 3 个桥接工具：

```
原始: [get_architecture, search_code, trace_path, ...14个MCP工具 + N个插件工具]
     ↓ schema token 超阈值
替换: [tool_search, tool_describe, tool_call]  ← 仅 3 个工具
```

**工作流程**：
1. LLM 调用 `tool_search("architecture")` → BM25 搜索，返回 `{name, description}` 摘要（最多 5 个）
2. LLM 调用 `tool_describe("get_architecture")` → 返回完整 JSON schema
3. LLM 调用 `tool_call("get_architecture", {project: "..."})` → 执行

**BM25 搜索引擎**：对工具名、描述、参数名分词索引，支持子串回退。

**对比本项目**：本项目直接发送 14 个 MCP 工具定义，当 builtin 工具也多时（88个），总量 102 个导致 CodeBuddy API 30 秒超时。

## 3. 技能索引（Skill Index）而非全量加载

系统提示中只注入技能的**名称 + 描述摘要（60字符截断）**：

```
<available_skills>
  mlops:
    - axolotl: Fine-tune models with Axolotl...
  github:
    - github-code-review: Review pull requests...
</available_skills>
```

LLM 看到匹配的技能后，通过 `skill_view(name)` 主动加载完整内容。

**三层渐进式披露**：
- Tier 1: `skills_list()` → name + description（系统提示中）
- Tier 2: `skill_view(name)` → 完整 SKILL.md 内容
- Tier 3: `skill_view(name, file_path)` → references/templates/scripts 中的具体文件

**对比本项目**：本项目在系统提示中注入完整技能内容，占用大量 token。

## 4. 条件过滤

技能/工具根据环境动态显示或隐藏：
- `requires_toolsets`: 技能需要的工具集不可用时隐藏
- `fallback_for_toolsets`: 主工具集可用时隐藏替代技能
- `platforms`: 非当前平台的技能隐藏
- `environments`: 非当前环境的技能隐藏

## 5. 编码姿态自动切换

在代码工作区自动收窄工具集：
- `auto` 模式：注入编码指导到系统提示，不改工具集
- `focus` 模式：工具集收窄到 `coding` + 启用的 MCP 服务器
- 非编码类技能降级为"仅显示名称"（保留记忆锚定，删除描述减少噪音）

## 6. 动态 Schema 修正

过滤后根据实际可用工具动态修正其他工具的 schema：
- 如果 `web_search` 不可用，从 `browser_navigate` 描述中删掉 "prefer web_search" 引用
- `execute_code` 的 schema 重建，只列出实际可用的沙箱工具

## 7. 多层缓存

- **系统提示缓存**：工具定义部分用稳定结构（JSON dump 后 hash 比较），未变化时复用缓存
- **check_fn TTL 缓存**：条件检查函数结果缓存 60 秒，避免每次调用都执行
- **tool_defs memoization**：工具 schema 构建结果缓存，输入未变时直接返回

## 对比总结

| 维度 | Hermes-Agent | 本项目（VsSaros） | 差距 |
|------|-------------|---------------------|------|
| 工具发送策略 | 工具集分组 + Tool Search 桥接 | 全量发送（102个） | ❌ 导致 API 超时 |
| MCP 工具管理 | BM25 搜索 + 按需加载 schema | 全量定义发送 | ❌ schema 过大 |
| 技能加载 | 索引摘要 + skill_view 按需加载 | 全量内容注入 | ❌ 占用 token |
| 工具数量控制 | 核心~40 + 桥接3 = ~43 | 102（已限制到30） | ⚠️ 已改善但仍硬编码 |
| 过滤机制 | 工具集 + check_fn + 条件过滤 | _filterToolsForLLM 核心工具集 | ⚠️ 简化版 |
| 缓存 | 系统提示缓存 + check_fn TTL + tool_defs memoization | 无 | ❌ 每次重建 |

## 本项目优化建议

### P0: Tool Search 桥接（最高优先级）

用 `mcp_tool_search` + `mcp_tool_call` 2 个桥接工具替代 14 个 MCP 工具定义：

```
当前: 16 核心 builtin + 14 MCP = 30 个工具定义
优化: 16 核心 builtin + 2 桥接 = 18 个工具定义
```

**实现方案**：
1. `mcp_tool_search(query: string)` — 搜索 MCP 工具，返回 `{name, description}` 列表
2. `mcp_tool_call(name: string, args: object)` — 按名称执行 MCP 工具
3. 搜索引擎：简单子串匹配（不需要 BM25，MCP 工具数量通常 <50）
4. 在 `_filterToolsForLLM` 中：核心 builtin 工具保留，MCP 工具替换为桥接工具

### P1: 工具集分组

将 88 个 builtin 工具分为工具集：
- `coding`: file_read, file_write, search_files, terminal, grep, etc.
- `web`: web_search, web_fetch, browser_*
- `media`: image_gen, video_gen, etc.
- `social`: send_message, broadcast, etc.
- `home-automation`: IoT 相关

在代码工作区只启用 `coding` 工具集，非相关工具集不发送。

### P2: 技能索引化

系统提示中只注入技能名 + 描述摘要（60 字符截断），通过 `skill_view` 工具按需加载完整内容。

**三层渐进式披露**：
1. 系统提示：`<available_skills>` 仅 name + description
2. `skill_view(name)`: 加载 SKILL.md 完整内容
3. `skill_view(name, file_path)`: 加载 references/scripts 中的具体文件

### P3: 动态 Schema 修正

如果 MCP 工具被桥接，从系统提示中删掉对具体 MCP 工具名的引用。如果某个工具不可用，从其他工具描述中删掉对它的引用。

## 关键文件参考

- Hermes-Agent 工具管理：`G:\CustomWorkspaces\AIProjects\Hermes-Agent\src\hermes\tools\`
- 本项目工具过滤：`src/vs/sessions/contrib/agentStudio/browser/builtinToolProvider.ts`（`_filterToolsForLLM`）
- 本项目 MCP 工具：`src/vs/workbench/contrib/mcp/browser/mcpToolProvider.ts`
- 本项目技能注册：`src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts`
