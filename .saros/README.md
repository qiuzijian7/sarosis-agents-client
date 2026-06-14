# Sarosis Agent 配置目录

此目录包含 Sarosis Agent Studio 的所有配置文件和模板。

## 目录结构

```
.saros/
├── README.md              # 本文件
├── agents/               # Agent 实例配置目录
│   ├── example/         # 示例 Agent 实例
│   │   └── agent.yaml  # Agent 配置文件
│   └── {instance-id}/  # 每个 Agent 实例一个目录
│       └── agent.yaml
├── templates/            # Agent 模板目录
│   ├── general-assistant/
│   │   └── template.yaml
│   ├── code-generator/
│   │   └── template.yaml
│   └── data-analyst/
│       └── template.yaml
└── data/                # 数据目录（可选）
    ├── employees.json     # Employee 数据
    ├── workspaces.json   # Workspace 数据
    └── sessions.json     # Session 数据
```

## Agent 实例配置 (agent.yaml)

每个 Agent 实例在 `.saros/agents/{instance-id}/` 目录下有一个 `agent.yaml` 配置文件。

### 配置示例

```yaml
# Agent 实例配置
id: my-agent-001
name: My Code Assistant
description: 一个代码助手示例

# 来源模板
templateId: code-generator

# 所属工作区
workspaceId: default-workspace

# 模型配置
model:
  providerId: knot-agui
  modelId: gpt-4o
  temperature: 0.7
  maxTokens: 4096

# Memory 配置
memory:
  enabled: true
  providerId: mem0-memory

# Tool 配置
tools:
  - filesystem
  - search
  - code-execution

# Planning 配置
planning:
  enabled: true
  providerId: basic-planning

# Execution 配置
execution:
  enabled: true
  providerId: basic-execution
  maxIterations: 10

# Retrieval (RAG) 配置
retrieval:
  enabled: false
  providerId: basic-retrieval

# Kanban 配置
kanban:
  enabled: true
  providerId: basic-kanban
  defaultBoard: main

# 元数据
createdAt: 2026-01-01T00:00:00Z
updatedAt: 2026-01-01T00:00:00Z
status: active
```

## Agent 模板 (template.yaml)

模板用于快速创建预配置的 Agent 实例。模板位于 `.saros/templates/{template-id}/` 目录下。

### 模板示例

```yaml
id: code-generator
name: Code Generator
description: 代码生成助手，支持多种编程语言
category: codegen
icon: icon.png
defaultConfig:
  temperature: 0.3
  maxTokens: 8192
tags:
  - code
  - generation
```

## 使用方式

1. **创建 Agent 实例**：
   - 通过 UI：Agent Gallery → 选择模板 → 创建实例
   - 手动：复制模板配置，创建新的 `agent.yaml`

2. **编辑 Agent 配置**：
   - 直接编辑 `.saros/agents/{instance-id}/agent.yaml`
   - 通过 UI：Agent Studio → 选择 Agent → 编辑配置

3. **删除 Agent 实例**：
   - 通过 UI：Agent Studio → 选择 Agent → 删除
   - 手动：删除 `.saros/agents/{instance-id}/` 目录

## 注意事项

1. **备份**：定期备份 `.saros/` 目录，避免配置丢失
2. **版本控制**：可以将 `.saros/` 目录加入版本控制，但注意敏感信息（如 API 密钥）
3. **权限**：确保 VSCode 有权限读写 `.saros/` 目录

## 故障排除

1. **Agent 不显示**：检查 `.saros/agents/{instance-id}/agent.yaml` 是否存在且格式正确
2. **模板不显示**：检查 `.saros/templates/{template-id}/template.yaml` 是否存在
3. **配置不生效**：重启 VSCode 或重新加载窗口
