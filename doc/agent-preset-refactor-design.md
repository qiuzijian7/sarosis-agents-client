# Agent 预设与实例重构设计

> 目标：移除 Agent 实例（Employee）概念，每个 Agent 预设都可直接聊天

---

## 一、当前架构分析

### 1.1 双重概念

```
┌─────────────────────────────────────────────────────────┐
│               AgentPreset (预设/模板)                     │
│  presetAgentView.ts                                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │ id, name, role, description, icon, model,       │    │
│  │ skills, tools, systemPrompt, temperature,       │    │
│  │ bootstrapTemplates, handOffs, hooks, visibility │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ _deployPreset()                  │
│                       ▼                                  │
├─────────────────────────────────────────────────────────┤
│               Employee (实例)                            │
│  agentStudioTypes.ts + agentStudioService.ts            │
│  ┌─────────────────────────────────────────────────┐    │
│  │ id ← 系统生成 (timestamp-random7)                │    │
│  │ presetId ← 追溯链接                              │    │
│  │ agentDir ← name-id 生成 slug                     │    │
│  │ name, role, model, customPrompt, skills, tools  │    │
│  │ status, position, tokenUsage, workspaceId ...   │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │                                  │
│              ┌────────┴────────┐                         │
│        employees.json    agents/{slug}/                  │
│        (索引)             ├ agent.yaml                   │
│                           ├ AGENTS.md                    │
│                           ├ SOUL.md                      │
│                           ├ IDENTITY.md                  │
│                           ├ TOOLS.md                     │
│                           ├ MEMORY.md                    │
│                           ├ config.md                    │
│                           └ sessions/{id}.json           │
└─────────────────────────────────────────────────────────┘
```

### 1.2 字段映射关系

| Preset 字段 | Employee 字段 | 说明 |
|---|---|---|
| `preset.id` | `employee.presetId` | 追溯链接 |
| `preset.name` | `employee.name` | 直接复制 |
| `preset.role` | `employee.role` | 直接复制 |
| `preset.systemPrompt` | `employee.customPrompt` | **键名改变** |
| `preset.model` | `employee.model` | 直接复制 |
| `preset.skills` | `employee.skills` | 数组复制 + 合并默认 skills |
| `preset.tools` | `employee.tools` | 数组复制 |
| *(无)* | `employee.id` | 系统生成 |
| *(无)* | `employee.agentDir` | 系统生成 slug |
| *(无)* | `employee.status` | 系统生成 |
| *(无)* | `employee.position` | 系统生成 |
| *(无)* | `employee.workspaceId` | 运行时注入 |

**问题**: 大量字段只是简单复制，造成 50+ 字段的 Employee 中 ~40% 是冗余的。

### 1.3 存储文件分析

| 文件 | 用途 | 大小评估 |
|---|---|---|
| `employees.json` | 所有 Employee 元数据数组 | 每个 ~2KB |
| `agent.yaml` | 单个 Agent 的 JSON 配置（实际内容与 employees.json 高度重复） | ~500B |
| `AGENTS.md` | 操作指令 | ~3KB |
| `SOUL.md` | 核心人格 | ~1KB |
| `IDENTITY.md` | 身份记录 | ~600B |
| `TOOLS.md` | 本地工具说明 | ~1KB |
| `MEMORY.md` | 长期记忆 | 空/少量 |
| `config.md` | ConfigMD 面板源 | ~500B |
| `sessions/{id}.json` | 聊天会话 | 可变 |

**实际利用率分析**:
- `employees.json` + `agent.yaml`: **高度重复**，属于双写
- `AGENTS.md`/`SOUL.md`/`IDENTITY.md`/`TOOLS.md`/`MEMORY.md`/`config.md`:
  这些文件设计用于 **autonomous agent** 场景（agent 自己读取自己的身份/指令/记忆），
  但在 **chat-first** 模式下，agent 通过 system prompt 获得全部上下文，
  这些文件**从未被 agent 读取**，纯属浪费。
- `agent.yaml` 的实际作用：仅 `model.providerId`/`model.modelId` 两个字段被 `updateEmployeeModelConfig` 读写

### 1.4 聊天链路中的 Employee 使用

```
EmployeeChat.tsx → sendMessage(employeeId, ...)
  ├─ 加载历史 → agentChatService.getHistory(employeeId)
  ├─ 读取 system prompt → employee.customPrompt
  ├─ 读取 skills/tools → employee.skills / employee.tools
  ├─ 读取模型 → agent.yaml 的 model.providerId/modelId（需要 agentDir 定位）
  └─ 发送到 LLM
```

**核心依赖**: `employeeId` 贯穿始终，几乎所有操作都用它做 key。

---

## 二、当前设计的问题

### 结构性问题

1. **概念冗余**: Preset（模板）→ Employee（实例）两层映射，90% 字段只是复制
2. **presetId 脱钩**: 部署后 Employee 与 Preset 独立，修改 Preset 不影响已有 Employee
3. **目录膨胀**: 每个 Employee 生成 8+ 个文件，其中 6 个从未被 agent 读取
4. **双写问题**: employees.json 和 agent.yaml 内容高度重复
5. **复杂度高**: `createEmployee` 方法 ~120 行，`_createAgentInstanceDir` ~80 行

### 用户体验问题

6. **两步操作**: 用户需要先"部署"预设 → 才能在聊天中选择 agent
7. **不可逆**: 部署后修改 agent 配置需要分别操作 employees.json 和 agent.yaml
8. **实例污染**: 同一个预设部署多次会产生多个孤立实例

---

## 三、新设计方案

### 3.1 核心理念

**Agent = Preset = 可直接聊天的实体**

- 预设就是 Agent，Agent 就是预设。不需要"部署"步骤。
- 所有 Agent（builtin + custom）统一管理，扁平化存储。
- 移除 agent 实例目录的复杂文件结构。
- 每个 Agent 有自己的聊天会话。

### 3.2 新数据模型

```typescript
interface Agent {
  // ── 身份 ──────────────────────────────────────────
  id: string;                // 唯一标识，builtin 用有意义 id，custom 用 UUID
  name: string;              // 显示名称
  role: string;              // 角色标签
  description: string;       // 简短描述（用于预设列表）
  icon: string;              // emoji 图标
  avatar?: string;           // 自定义头像 Data URI
  category: AgentCategory;   // 分类

  // ── 聊天配置 ──────────────────────────────────────
  model: ModelSpec;          // 模型选择（字符串 | 数组 | IModelChain）
  providerId?: string;       // 用户最后选择的 provider（持久化偏好）
  modelId?: string;          // 用户最后选择的 model（持久化偏好）
  systemPrompt: string;      // 系统提示词
  temperature?: number;      // 温度
  maxTokens?: number;        // 最大 token

  // ── 能力配置 ──────────────────────────────────────
  skills: string[];          // 技能 ID 列表
  tools: string[];           // 工具名列表

  // ── 可选高级配置 ──────────────────────────────────
  handOffs?: IAgentHandOff[];
  hooks?: IAgentHooks;
  visibility?: IAgentVisibility;
  agents?: string[];
  confidenceThreshold?: number;
  parallelStrategy?: 'voting' | 'coverage';

  // ── 记忆配置 ──────────────────────────────────────
  memoryConfig?: MemoryConfig;

  // ── 元数据 ────────────────────────────────────────
  source: 'builtin' | 'custom';
  workspaceId?: string;      // 所属 workspace（null 表示全局）
  status: AgentStatus;       // idle | working | thinking | error
  sortOrder?: number;        // 排序权重
  createdAt: string;
  updatedAt: string;
}

type AgentCategory = 'General' | 'Development' | 'Research' | 'Creative' | 'Management' | 'DevOps' | 'Analytics';
```

**关键变化**:
- ✅ 移除 `presetId` — 不再需要追溯
- ✅ 移除 `agentDir` — 不再有实例目录
- ✅ `customPrompt` → `systemPrompt` — 统一命名
- ✅ 新增 `providerId`/`modelId` — 替代 agent.yaml 的 model 选择功能
- ✅ 新增 `source` / `category` — 替代 PresetCategory + Preset 来源

### 3.3 新存储方案

```
{workspacePath}/
  .sarosworkspace/
    agents.json              ← ★ 所有 Agent 定义（替代 employees.json + presets.json）
    sessions/
      {agentId}/
        index.json           ← 会话列表 [{id, title, createdAt, updatedAt}]
        {sessionId}.json     ← 单个会话的完整消息历史
    workspaces.json          ← workspace 索引（不变）

{userRoamingDataHome}/agent-studio/
    agents.json              ← 全局 agents（无 workspace 回退）
```

**存储对比**:

| 项目 | 旧方案 | 新方案 |
|---|---|---|
| Agent 定义 | `employees.json` + `agent.yaml` | `agents.json`（单个文件） |
| 实例文件 | `agents/{slug}/*.md` (6-8 个文件) | **删除** |
| 会话存储 | `agents/{slug}/sessions/{id}.json` | `sessions/{agentId}/{id}.json` |
| 预设存储 | `BUILTIN_PRESETS` (代码) + `presets.json` | 全部进 `agents.json` |

### 3.4 移除的内容

| 移除项 | 原因 |
|---|---|
| `_createAgentInstanceDir()` | 不再创建实例目录 |
| `_generateAgentSlug()` | 不再需要目录 slug |
| `agent.yaml` 读写 | provider/model 偏好存 agents.json |
| `AGENTS.md` / `SOUL.md` / `IDENTITY.md` / `TOOLS.md` / `MEMORY.md` | chat-first 模式下从未被 agent 读取 |
| `config.md` + ConfigMD | 可后续按需恢复 |
| `Employee` 接口 | 合并到 `Agent` 接口 |
| `bootstrapTemplates` | 不再生成模板文件 |
| `_deployPreset()` | 不再需要"部署"操作 |
| `presets.json` | 自定义预设也存 agents.json |
| `BUILTIN_PRESETS` 常量 | 改为 `getBuiltinAgents()` 函数，返回 Agent[] |

### 3.5 Builtin Agents 定义

Builtin agents 通过代码定义，首次加载时自动写入 `agents.json`。

```typescript
// 新文件: common/builtinAgents.ts
export function getBuiltinAgents(): Agent[] {
  return [
    {
      id: 'saros-claw',
      name: 'Sarosis Claw',
      role: 'AI Assistant',
      description: 'General-purpose AI assistant...',
      icon: '🦞',
      avatar: 'data:image/svg+xml,...',
      category: 'General',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are Sarosis Claw...',
      skills: ['code-gen', 'code-review', 'analysis', 'summarize', 'writing', 'planning'],
      tools: ['write_to_file', 'read_file', 'terminal', 'list_dir', 'search_files', 'grep_search', 'replace_in_file'],
      source: 'builtin',
      status: 'idle',
      handOffs: [...],
      visibility: { userInvocable: true, agentInvocable: true },
      agents: ['Coder', 'Researcher', 'Planner', 'Code Reviewer', 'Tester'],
    },
    // ... 其他 13 个 builtin agents
  ];
}
```

### 3.6 CRUD 设计

```typescript
interface IAgentStore {
  // ── Host 侧 (agentStudioService.ts) ────────────────
  getAgents(workspaceId?: string): Promise<Agent[]>;
  createAgent(data: Partial<Agent>): Promise<Agent>;
  updateAgent(id: string, data: Partial<Agent>): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  getBuiltinAgents(): Agent[];

  // ── WebView 侧 (useAgentStore.ts) ──────────────────
  agents: Agent[];
  selectedAgentId: string | null;
  loadAgents: (workspaceId?: string) => Promise<void>;
  selectAgent: (id: string | null) => void;
  createAgent: (data: Partial<Agent>) => Promise<Agent>;
  updateAgent: (id: string, data: Partial<Agent>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
}
```

### 3.7 聊天流程变化

```
旧: EmployeeChat → employeeId → employee.customPrompt/skills/tools → LLM
                                 → agentDir → agent.yaml → providerId/modelId
                                 → agentDir/sessions/ → 历史

新: AgentChat → agentId → agent.systemPrompt/skills/tools → LLM
                         → agents.json → providerId/modelId
                         → sessions/{agentId}/ → 历史
```

**关键简化**:
- 不再需要 `agentDir` 定位文件
- provider/model 偏好直接从 `agents.json` 读取
- 会话路径从 `agents/{slug}/sessions/` 变为 `sessions/{agentId}/`

---

## 四、迁移计划

### 4.1 重命名映射

| 旧概念 | 新概念 | 旧文件/函数 | 新文件/函数 |
|---|---|---|---|
| Employee | Agent | `agentStudioTypes.ts` → `Employee` | `agentStudioTypes.ts` → `Agent` |
| Employee Store | Agent Store | `useEmployeeStore.ts` | `useAgentStore.ts` |
| Employee Chat | Agent Chat | `EmployeeChat.tsx` | `AgentChat.tsx` |
| PresetAgentView | AgentLibrary | `presetAgentView.ts` | `agentLibraryView.ts` |
| employees.json | agents.json | `DATA_FILE_EMPLOYEES` | `DATA_FILE_AGENTS` |

### 4.2 阶段划分

**Phase 1: 新类型 + 新存储（兼容双写）**
1. 新增 `Agent` 接口（`agentStudioTypes.ts`）
2. 新增 `agents.json` 读写（`agentStudioService.ts`）
3. 启动时从 `employees.json` + `presets.json` 迁移到 `agents.json`
4. 新创建写入 `agents.json`，旧数据保留不动
5. 聊天优先读 Agent，回退读 Employee

**Phase 2: 替换引用**
6. `useEmployeeStore.ts` → `useAgentStore.ts`
7. `EmployeeChat.tsx` → `AgentChat.tsx`
8. `presetAgentView.ts` → `agentLibraryView.ts`
9. `BUILTIN_PRESETS` → `getBuiltinAgents()`

**Phase 3: 清理**
10. 移除 `_createAgentInstanceDir()`
11. 移除 `agent.yaml` 读写
12. 移除 agent 实例目录结构
13. 移除 `Employee` 接口（保留别名兼容）
14. 移除旧 `presets.json`

### 4.3 数据迁移

```typescript
// 首次启动时的迁移逻辑
async function migrateToAgents(workspaceId?: string): Promise<void> {
  const agentsUri = joinPath(dataDir, 'agents.json');
  if (await exists(agentsUri)) return; // 已迁移

  const agents: Agent[] = [];

  // 1. 从 employees.json 读取
  const employeesUri = joinPath(dataDir, 'employees.json');
  if (await exists(employeesUri)) {
    const employees = await readJson<Employee>(employeesUri);
    for (const emp of employees) {
      agents.push({
        id: emp.id,
        name: emp.name,
        role: emp.role,
        description: `${emp.name} — ${emp.role}`,
        icon: getIconForRole(emp.role),
        avatar: emp.avatar,
        category: getCategoryForRole(emp.role),
        model: emp.model || 'claude-sonnet-4-20250514',
        systemPrompt: emp.customPrompt || '',
        skills: emp.skills || [],
        tools: emp.tools || [],
        handOffs: emp.handOffs,
        hooks: emp.hooks,
        visibility: emp.visibility,
        agents: emp.agents,
        memoryConfig: emp.memoryConfig,
        source: emp.presetId ? 'builtin' : 'custom',
        workspaceId: emp.workspaceId,
        status: 'idle',
        temperature: emp.temperature,
        maxTokens: emp.maxTokens,
        createdAt: emp.createdAt,
        updatedAt: emp.updatedAt,
      });
    }
  }

  // 2. 合并 builtin agents（如果还没从 employees 迁移过来）
  const builtins = getBuiltinAgents();
  for (const builtin of builtins) {
    if (!agents.find(a => a.id === builtin.id || a.name === builtin.name)) {
      agents.push(builtin);
    }
  }

  // 3. 写入 agents.json
  await writeJson(agentsUri, agents);
}
```

---

## 五、影响范围

### 需要修改的文件（预估 ~25 个）

| 层级 | 文件 | 改动类型 |
|---|---|---|
| **common** | `agentStudioTypes.ts` | 新增 `Agent` 接口，保留 `Employee` 别名 |
| **common** | `constants.ts` | 新增 `DATA_FILE_AGENTS` 常量 |
| **common** | 新增 `builtinAgents.ts` | 内置 agent 定义 |
| **browser** | `agentStudioService.ts` | CRUD 从 employees.json → agents.json |
| **browser** | `agentStudioToolbarView.ts` | "Claw Chat" → agent 名称 |
| **browser** | `agentStudioWebviewController.ts` | employee → agent 消息处理 |
| **browser** | `agentChatService.ts` | 会话路径调整 |
| **browser** | `agentDriverService.ts` | options.employeeId → agentId |
| **browser** | `views/presetAgentView.ts` | → `agentLibraryView.ts` |
| **browser** | `views/clawChatView.ts` | 可能不再需要 |
| **browser** | `agentStudio.contribution.ts` | preset agent view → agent library |
| **browser** | `agentStudioEditorInput.ts` | panel type |
| **webview** | `store/useEmployeeStore.ts` | → `useAgentStore.ts` |
| **webview** | `store/useChatStore.ts` | employeeId → agentId |
| **webview** | `features/chat/EmployeeChat.tsx` | → `AgentChat.tsx` |
| **webview** | `features/employees/*` | → `features/agents/*` |
| **webview** | `App.tsx` | employee → agent |
| **webview** | `index.tsx` | employee → agent 事件 |

### 不需要改的

- model provider 层（不感知 Employee/Agent）
- agent OS 层（通过 options 接收参数）
- 工具执行层
- TaskBoard / Workflow（这些是独立功能）

---

## 六、总结

| 维度 | 旧设计 | 新设计 | 收益 |
|---|---|---|---|
| 概念数量 | 2 (Preset + Employee) | 1 (Agent) | **简化 50%** |
| 核心文件数 | `employees.json` + `agent.yaml` + 6 个 .md | `agents.json` | **减少 8 个文件/agent** |
| createEmployee 代码 | ~120 行 | ~30 行 | **减少 75%** |
| 用户操作 | 先部署 → 再选择 → 才能聊天 | 直接选择 → 聊天 | **减少一步** |
| 字段数量 | ~50 (Employee) + ~20 (Preset) | ~30 (Agent) | **减少 57%** |
| 存储冗余 | employees.json 和 agent.yaml 高度重复 | 单一数据源 | **消除双写** |
