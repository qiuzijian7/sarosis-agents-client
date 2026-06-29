# VsSaros 存储路径配置文档

## 概述

本文档描述了 VsSaros 项目中各类资源（Skills、Tools、MCP、知识库、工作流、Agents）的存储路径配置。路径分为两类：
- **内置资源（只读）**：存放在项目 `resources/.agents/` 目录下
- **用户资源（可写）**：存放在用户目录 `~/.saros/` 下

## 目录结构

### 1. 内置资源路径（项目自带，只读）

```
resources/.agents/
├── skills/                # 内置技能包
├── tools/                 # 内置工具定义
├── mcp-presets/          # MCP 服务器预设配置
├── knowledge-base/        # 内置知识库
├── workflows/            # 内置工作流
└── agents/               # 内置 Agent 定义
```

**说明**：
- 这些资源随项目安装包分发，用户不应直接修改
- 项目更新时可能会被覆盖

### 2. 用户资源路径（用户可写）

```
~/.saros/
├── skills/               # 用户安装的技能包（原：skills-library）
├── tools/                # 用户自定义工具（原：resources/tools）
├── mcp.json              # MCP 服务器配置文件
├── mcp/                  # MCP 服务器相关文件（原：mcp-servers）
├── knowledge-base/       # 用户知识库
├── workflows/            # 用户工作流
├── agents/               # 用户自定义 Agents
├── memory/               # Agentic Memory 存储
└── installed-packages.json  # 已安装包记录
```

**说明**：
- `~` 表示用户主目录
  - Windows: `C:\Users\<Username>\.saros\`
  - macOS/Linux: `~/.saros/`
- 这些资源由用户安装和管理，不受项目更新影响

## 路径修改历史

### Skills 路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| 内置 skills | `resources/skills/` | `resources/.agents/skills/` | 统一内置资源目录 |
| 用户 skills | `~/.saros/skills-library/` | `~/.saros/skills/` | 简化命名，与其他资源一致 |

### Tools 路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| 内置 tools | `resources/tools/` | `resources/.agents/tools/` | 统一内置资源目录 |
| 用户 tools | `~/.saros/resources/tools/` | `~/.saros/tools/` | 简化路径层级 |

### MCP 路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| MCP 配置 | 多处散落 | `~/.saros/mcp.json` | 统一配置文件位置 |
| MCP 相关文件 | `~/.saros/mcp-servers/` | `~/.saros/mcp/` | 简化命名 |

### 知识库路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| 内置知识库 | 未统一 | `resources/.agents/knowledge-base/` | 新增统一目录 |
| 用户知识库 | 未统一 | `~/.saros/knowledge-base/` | 新增统一目录 |

### 工作流路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| 内置工作流 | 未统一 | `resources/.agents/workflows/` | 新增统一目录 |
| 用户工作流 | 未统一 | `~/.saros/workflows/` | 新增统一目录 |

### Agents 路径
| 项目 | 原路径 | 新路径 | 修改原因 |
|------|--------|--------|----------|
| 内置 Agents | 未统一 | `resources/.agents/agents/` | 新增统一目录 |
| 用户 Agents | 未统一 | `~/.saros/agents/` | 新增统一目录 |

## 配置文件详解

### `~/.saros/mcp.json` 格式

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "env": {},
      "disabled": false
    },
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      },
      "disabled": true
    }
  }
}
```

**字段说明**：
- `type`: `stdio`（本地进程）或 `http`（远程服务）
- `disabled`: `true` 表示禁用，`false` 或不存在表示启用
- 支持环境变量插值：`${VAR_NAME}`

## 相关代码文件

| 文件 | 职责 |
|------|------|
| `src/vs/sessions/contrib/agentStudio/browser/bundledResourceService.ts` | 管理内置资源路径 |
| `src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts` | Skills 注册与发现 |
| `src/vs/sessions/contrib/agentStudio/browser/marketplaceService.ts` | 资源市场服务 |
| `src/vs/sessions/contrib/agentStudio/browser/views/integrationView.ts` | MCP 管理界面 |
| `src/vs/workbench/contrib/mcp/common/mcpConfiguration.ts` | MCP 配置发现 |

## 迁移指南

### 从旧版本迁移

1. **Skills 迁移**：
   ```bash
   # Windows
   move %USERPROFILE%\.saros\skills-library\* %USERPROFILE%\.saros\skills\
   
   # macOS/Linux
   mv ~/.saros/skills-library/* ~/.saros/skills/
   ```

2. **Tools 迁移**：
   ```bash
   # Windows
   move %USERPROFILE%\.saros\resources\tools\* %USERPROFILE%\.saros\tools\
   
   # macOS/Linux
   mv ~/.saros/resources/tools/* ~/.saros/tools/
   ```

3. **MCP 配置迁移**：
   - 旧的 MCP 配置可能分布在：
     - `.vscode/mcp.json`
     - `settings.json` 中的 `mcp.servers`
     - `~/.saros/mcp.json`（如果已存在）
   - 统一迁移到 `~/.saros/mcp.json`

## 注意事项

1. **路径分隔符**：
   - Windows 使用反斜杠 `\`
   - macOS/Linux 使用正斜杠 `/`
   - 代码中使用 `path.join()` 或 `path.sep` 保证跨平台兼容

2. **权限问题**：
   - `~/.saros/` 目录需要读写权限
   - `resources/.agents/` 只需要读权限

3. **版本兼容**：
   - 旧版本项目可能使用不同的路径
   - 启动时应检测并提示迁移

## 更新记录

| 日期 | 版本 | 修改内容 |
|------|------|----------|
| 2026-06-28 | v1.0 | 初始版本，统一存储路径配置 |
