# 存储路径规划

> 日期：2026-06-28

## 内置资源（只读，随应用发布）

```
resources/.agents/
├── skills/           # 内置技能 SKILL.md
├── tools/            # 内置工具定义 *.json
├── mcp-presets/      # 内置 MCP 预设 *.json
├── knowledge-base/   # 内置知识库
├── workflows/        # 内置工作流模板
└── agents/           # 内置 Agent 定义 .agent.md
```

## 用户资源（可写，安装或创建）

```
~/.saros/
├── skills/           # 用户技能（原 skills-library/）
├── tools/            # 用户工具（原 resources/tools/）
├── mcp.json          # MCP 配置
├── mcp/              # MCP 安装包（原 mcp-servers/）
├── knowledge-base/   # 知识库
├── workflows/        # 工作流
├── agents/           # Agent 定义
│   └── custom/       # 商城安装的 Agent
├── memory/           # 记忆存储（per agent）
└── installed-packages.json  # 包安装注册表
```

## 路径变更记录

| 资源 | 原路径 | 新路径 | 修改文件 |
|------|--------|--------|---------|
| 用户 Skills | `~/.saros/skills-library/` | `~/.saros/skills/` | skillRegistryService.ts, skillInstaller.ts, marketplaceService.ts, marketplaceEditorPane.ts, skills.ts, marketplace.ts |
| 用户 Tools | `~/.saros/resources/tools/` | `~/.saros/tools/` | bundledResourceService.ts |
| 用户 MCP 包 | `~/.saros/mcp-servers/` | `~/.saros/mcp/` | marketplaceService.ts, marketplaceEditorPane.ts |
