# `new_agent` 工具设计文档

## 1. 概述

### 1.1 目的

让 LLM 在运行时**动态创建持久化 Agent 定义**，供后续任务委派、编排计划复用。

### 1.2 与 `delegate_task` 的区别

| 维度 | `delegate_task` | `new_agent` |
|------|-----------------|-------------|
| 生命周期 | 临时子代理，执行完即销毁 | 持久化定义，保存到 `~/.saros/agents/` |
| 用途 | 一次性任务执行 | 创建可复用的 Agent 角色 |
| 存储 | 仅运行时内存 | 写入 `agent.json` + `.agent.md` |
| 后续可用 | 否 | 是，可被 `delegate_task`、编排计划等复用 |

### 1.3 归属

- **Toolset**: `delegation`（通过 `exactNames` 注册）
- **Security Level**: `Cautious`（有文件系统副作用，但不具破坏性）
- **Category**: `delegation`

### 1.4 命名规则（Slug 化）

Agent 名称自动转换为 **URL 友好的 slug 格式**，确保可读性和可预测性：

| 规则 | 示例 |
|------|------|
| 小写 | `Code Reviewer` → `code-reviewer` |
| 空格/下划线 → 连字符 | `Hello_World` → `hello-world` |
| 移除特殊字符 | `UI/UX Designer` → `uiux-designer` |
| 去重连字符 | `a---b` → `a-b` |
| 去首尾连字符 | `-test-` → `test` |
| 限制 40 字符 | 超长名被截断 |

**Agent id 与 slug 名称一致，不含随机后缀。** 这绕过 `_generateId` 的 `slug-随机后缀` 格式。

---

## 2. 测试用例设计（TDD）

测试文件：`src/vs/sessions/contrib/agentStudio/test/browser/newAgentTool.test.ts`

### 2.1 测试矩阵

| # | 用例名 | 输入 | 期望 |
|---|--------|------|------|
| S1 | slugifyAgentName — 基础转换 | `"Code Reviewer"` | `"code-reviewer"` |
| S2 | slugifyAgentName — 特殊字符 | `"UI/UX Designer"` | `"uiux-designer"` |
| S3 | slugifyAgentName — 去重/去首尾 | `"-a---b--c-"` | `"a-b-c"` |
| S4 | slugifyAgentName — 空/纯特殊字符 | `"!@#$%"` | `""` |
| S5 | slugifyAgentName — 40 字符限制 | 50 字符名 | 结果 ≤ 40 字符 |
| T1 | 基本创建 — slug 化验证 | `{name:"Code Reviewer", role, description}` | name=`"code-reviewer"`, id=`"code-reviewer"` |
| T1.5 | id 无随机后缀 | `{name:"Security Auditor", ...}` | id=`"security-auditor"`（无 `-x7k2m`） |
| T1.6 | 纯特殊字符 name → 空 slug → 错误 | `{name:"!@#$%", ...}` | 失败，error 含 "slug" 和 "empty" |
| T2 | 缺少 name | `{role, description}` | 失败 |
| T3 | 缺少 role | `{name, description}` | 失败 |
| T4 | 缺少 description | `{name, role}` | 失败 |
| T5 | 带 systemPrompt | 含 systemPrompt | createAgent 收到 systemPrompt |
| T6 | 带 model | `{..., model:"gpt-4o"}` | createAgent 收到 model |
| T7 | 带 tools 列表 | `{..., tools: [...]}` | createAgent 收到 tools |
| T8 | 带 skills 列表 | `{..., skills: [...]}` | createAgent 收到 skills |
| T9 | agentType=planner | `{..., agentType:"planner"}` | createAgent 收到 AgentType.Planner |
| T10 | agentType 默认值 | 不传 agentType | createAgent 收到 `undefined`（service 默认 worker） |
| T11 | createAgent 抛异常 | mock reject | 返回错误消息 |
| T12 | 返回格式验证 | 正常输入 | IToolResultContent 格式正确 |
| T13 | category 默认值 | 不传 category | createAgent 收到 `undefined` |
| T14 | icon 默认值 | 不传 icon | createAgent 收到 `undefined` |
| T15 | 所有可选字段同时传递 | 全部可选字段 | 全部传递正确 |
| T16 | 空字符串 name | `{name:"", ...}` | 失败 |
| T17 | 多词 + 下划线 name | `{name:"Senior Backend_Developer",...}` | name=`"senior-backend-developer"` |

### 2.2 Mock 策略

```
MockAgentStudioService:
  - createAgent(data): 记录传入参数，返回构造的 Agent 对象
  - 可配置 throw 来测试异常路径

BuiltinToolProvider:
  - 仅实例化需要的依赖（其余用 null/undefined stub）
  - 直接调用 register 后的 handler
```

### 2.3 测试伪代码

```typescript
suite('new_agent Tool', () => {
    let provider: BuiltinToolProvider;
    let mockStudioService: MockAgentStudioService;

    setup(() => {
        mockStudioService = new MockAgentStudioService();
        // 构造 provider（注入 mock）
        // 从 provider 内部获取 new_agent handler
    });

    test('T1: 创建成功 — 仅必填字段', async () => {
        const result = await handler({ name: 'Coder', role: 'Developer', description: 'Writes code' });
        assert.strictEqual(result[0].type, 'text');
        const parsed = JSON.parse(result[0].text!);
        assert.ok(parsed.id);
        assert.strictEqual(parsed.name, 'Coder');
        assert.strictEqual(parsed.role, 'Developer');
        // createAgent 被调用一次
        assert.strictEqual(mockStudioService.createAgentCalls.length, 1);
    });

    test('T2: 缺少 name → 错误', async () => {
        const result = await handler({ role: 'Developer', description: 'Writes code' });
        const parsed = JSON.parse(result[0].text!);
        assert.strictEqual(parsed.success, false);
        assert.ok(parsed.error.includes('name'));
    });

    // ... 其余用例类似
});
```

---

## 3. 实现方案

### 3.1 工具定义

```typescript
// 在 _registerDelegationTools() 中新增
this.register({
    definition: {
        name: 'new_agent',
        description: [
            'Create a new persistent agent definition that can be reused for future tasks.',
            '',
            'The created agent is saved to ~/.saros/agents/{agentId}/ and becomes available',
            'for delegation (delegate_task), orchestration plans, and manual invocation.',
            '',
            '## When to use:',
            '- You need a specialized agent that does not exist yet',
            '- A task requires a role/toolset combination not covered by existing agents',
            '- You want to create a reusable team member for ongoing work',
            '',
            '## When NOT to use:',
            '- For a one-off task (use delegate_task instead)',
            '- The agent already exists (use delegate_task to invoke it)',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Human-readable agent name (e.g. "Code Reviewer")' },
                role: { type: 'string', description: 'Agent role/specialty (e.g. "Reviewer", "Researcher", "Developer")' },
                description: { type: 'string', description: 'What this agent does and when to use it' },
                systemPrompt: { type: 'string', description: 'Custom system prompt for the agent' },
                model: { type: 'string', description: 'LLM model (default: inherits workspace default)' },
                tools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Enabled tool names (default: all core tools)',
                },
                skills: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Skill names to enable',
                },
                category: { type: 'string', description: 'Category label (default: "General")' },
                agentType: {
                    type: 'string',
                    enum: ['planner', 'worker'],
                    description: 'planner = can orchestrate sub-tasks; worker = executes tasks (default: worker)',
                },
            },
            required: ['name', 'role', 'description'],
        },
        category: 'delegation',
        source: this.id,
        securityLevel: ToolSecurityLevel.Cautious,
    },
    handler: async (args, _signal, _agentId) => {
        // 见 3.2
    },
});
```

### 3.2 Handler 逻辑

```typescript
handler: async (args, _signal, _agentId) => {
    const name = args['name'] as string | undefined;
    const role = args['role'] as string | undefined;
    const description = args['description'] as string | undefined;

    // 1. 验证必填字段
    const missing: string[] = [];
    if (!name) { missing.push('name'); }
    if (!role) { missing.push('role'); }
    if (!description) { missing.push('description'); }
    if (missing.length > 0) {
        return [{ type: 'text', text: JSON.stringify({
            success: false,
            error: `Missing required parameter(s): ${missing.join(', ')}`,
        }) }];
    }

    // 2. 构建 Partial<Agent>
    const agentData: Partial<Agent> = {
        name,
        role,
        description,
        source: 'custom',
    };
    // 可选字段 — 仅在提供时传递，让 createAgent 使用默认值
    if (args['systemPrompt']) { agentData.systemPrompt = args['systemPrompt'] as string; }
    if (args['model']) { agentData.model = args['model'] as string; }
    if (args['tools']) { agentData.tools = args['tools'] as string[]; }
    if (args['skills']) { agentData.skills = args['skills'] as string[]; }
    if (args['category']) { agentData.category = args['category'] as string; }
    if (args['agentType']) {
        agentData.agentType = (args['agentType'] === 'planner')
            ? AgentType.Planner
            : AgentType.Worker;
    }

    // 3. 调用 studioService.createAgent
    try {
        const agent = await this.studioService.createAgent(agentData);
        return [{ type: 'text', text: JSON.stringify({
            success: true,
            id: agent.id,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            agentType: agent.agentType ?? 'worker',
            category: agent.category,
            message: `Agent "${agent.name}" created successfully. Use delegate_task to assign tasks to it.`,
        }) }];
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [{ type: 'text', text: JSON.stringify({
            success: false,
            error: `Failed to create agent: ${msg}`,
        }) }];
    }
}
```

### 3.3 修改文件清单

| 文件 | 改动 |
|------|------|
| `browser/providers/tool/builtinToolProvider.ts` | 在 `_registerDelegationTools()` 中新增 `new_agent` 工具注册 |
| `common/toolsetConfig.ts` | 在 delegation toolset 的 `exactNames` 中添加 `'new_agent'` |
| `test/browser/newAgentTool.test.ts` | 新建测试文件 |

### 3.4 不需要修改的部分

- `IToolDefinition` 接口 — 已有 `securityLevel`、`toolset` 字段，无需改动
- `agentStudioService.ts` — `createAgent` 方法已存在，签名兼容
- `agentOSService.ts` — `_filterToolsForLLM` 通过 toolset 自动过滤，`new_agent` 属于 delegation toolset（High 优先级），会自动包含

### 3.5 Agent 类型导入

需要在 `builtinToolProvider.ts` 中确保导入了 `Agent` 类型和 `AgentType` 枚举：

```typescript
import type { Agent } from '../../../../common/agentStudioTypes.js';
import { AgentType } from '../../../../common/agentStudioTypes.js';
```

（需检查现有 import 是否已包含）
