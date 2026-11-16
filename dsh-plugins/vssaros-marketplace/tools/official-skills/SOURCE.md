# Epic 官方 Unreal Engine Skills（商城收录源）

- 上游仓库：<https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin>
- 主体：Epic Games, Inc.（GitHub `EpicGames` 官方组织；`.claude-plugin/plugin.json` 作者 Thomas Mansencal `<thomas.mansencal@epicgames.com>`）
- 收录 commit：`0e27bde2b55c5d3f6948532f4296aaa3654d8f4b`（`main`，2026-11-13 浅克隆核实）
- 插件版本：`plugin.json` v3.1.2
- 许可证：**MIT**，Copyright (c) 2026 Epic Games, Inc. —— 全文见同目录 `LICENSE`

## 收录范围

`skills/` 下 3 个官方技能，**逐字原样**（不改 frontmatter、不改正文）：

| 目录 | 文件 | 用途 |
|---|---|---|
| `unreal-mcp/` | `SKILL.md` + `references/operations.md` + `references/setup.md` | 经实时 MCP 驱动正在运行的 Unreal Editor |
| `create-toolset/` | `SKILL.md` | 编写 / 扩展注册到 `ToolsetRegistry` 的 UE Toolset |
| `unreal-skill/` | `SKILL.md` | 编写 UE 编辑器内的 Agent Skill（UAsset / Python class） |

**刻意不收录**：`hooks/`（Claude Code 专用 SessionStart bash 钩子，依赖 `.claude-plugin/` 与 PATH 上的 bash）、`.claude-plugin/`、`README.md`、`CODEOWNERS`。这些是 Claude Code 插件装载机制，不是技能正文。

## 为什么放在 `vssaros-marketplace/tools/` 下

商城运行时清单在服务端 DB，本目录是**可复现的登记源**：`tools/sync-official-skills.mjs` 从这里打包发布成 `kind=skill` 商品，并把 `LICENSE` 附进每个包（MIT 要求副本保留版权与许可声明）。

⚠ 不要挪进 `dsh-plugins/vssaros-skill-bundle/skills/`：那是随包技能根，`check-skill-tier.mjs` / `check-skill-scope.mjs` 硬编码 174 条且要求 `tier` 字段，塞进去会同时破坏官方原文与守卫。商城商品安装到用户 `<数据根>/skills/<slug>/`，与随包根是两条独立链路。

## 配套关系

技能正文里的 `list_toolsets` / `describe_toolset` / `call_tool` 由 **UE 5.8 编辑器内嵌的官方 MCP server** 提供。在 VsSaros 里请配合商城的「Unreal 官方 MCP（UE 5.8）」商品（`unreal-official-mcp`，`kind=mcp`）安装，它会把 `http://127.0.0.1:8000/mcp` 注册进 `mcp.json`。

`references/setup.md` 讲的是 Claude Code 的 `.mcp.json` 配置步骤，在 VsSaros 里以上述 MCP 商品为准；该文档按官方原文保留，未做改写。
