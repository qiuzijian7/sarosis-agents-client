# Sarosis Agents Client — Skill 系统分析

> 分析日期：2026-05-18
> 涉及模块：Agent Studio SkillRegistry

---

## 一、总体架构

项目存在 **一套 Skill 系统**，服务于多 Agent 工作台场景，使用 `SKILL.md` 文件格式约定：

| 子系统 | 核心位置 | 用途 |
|--------|----------|------|
| **Sarosis Agent Studio** | `src/vs/sessions/contrib/agentStudio/` | 多 Agent 工作台内的 Skill 注册/激活/注入 |

架构分层：

```
┌───────────────────────────────────────────────────────────────────┐
│  Agent Studio 业务层 (Sarosis 专属)                               │
│     ISkillRegistry / SkillRegistry / ISkillDefinition             │
│     SkillsViewPane (UI) / EmployeeSkill                          │
└───────────────────────────────────────────────────────────────────┘
```

---

## 二、Skill 路径体系

### 2.1 Agent Studio Skill 路径

Skill 文件按以下四级优先级加载（后注册的同名 skill 覆盖前者）：

```
优先级（低→高）：
  1. 内置常量    BUILTIN_SKILLS 硬编码数组（随产品发布，零 IO 开销）
  2. 用户全局    <userRoamingDataHome>/sarosis/skills/<id>/SKILL.md
  3. 工作区      <workspaceFolder>/.sarosisworkspace/agents/<agentDir>/skills/<id>/SKILL.md
  4. 运行时注入  扩展通过 ISkillRegistry.registerSkill() 注册的内存 skill
```

> 每个技能分布在各个 agent 实例中，基于当前使用的不同 agent 来区分。`<agentDir>` 对应 `Employee.agentDir` 字段。

**关键源码**：`src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts`

```typescript
// reload() 方法中的加载顺序
async reload(agentId?: string): Promise<void> {
    this._skills.clear();
    this._loadBuiltins();                         // 1. 内置
    const userDir = URI.joinPath(                 // 2. 用户全局
        this.environmentService.userRoamingDataHome, 'sarosis', 'skills');
    await this._scanFolder(userDir, 'user');
    for (const f of wsFolders) {                  // 3. 工作区（按 agent 实例隔离）
        if (agentId) {
            await this._scanAgentSkills(f.uri, agentId);    // 指定 agent
        } else {
            await this._scanAllAgentSkills(f.uri);          // 所有 agent
        }
    }
    for (const [id, skill] of this._runtimeSkills) { // 4. 运行时
        this._skills.set(id, skill);
    }
}
```

常量定义：

```typescript
const SKILL_DIR_NAME = 'skills';  // 相对于 agents/<agentDir>/ 目录
// 完整路径 = <workspaceFolder>/.sarosisworkspace/agents/<agentDir>/skills/<id>/SKILL.md
```

### 2.2 扩展插件 Skill 路径

扩展插件提供 skill：

```
extensions/knot-agui/plugin/skills/knot-agui/SKILL.md
```

---

## 三、Skill 文件格式 — SKILL.md

### 3.1 Agent Studio 格式

```markdown
---
name: code-review
description: 对当前 diff/文件进行快速代码评审
activation: auto
match: [review, code review, 评审, 审查代码, code-review]
category: code
recommended_tools: [file_read, shell_exec]
---
<skill body in markdown>
```

**Frontmatter 字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | **是** | Skill 名称，同时用于生成 id（`name.toLowerCase().replace(/\s+/g, '-')`) |
| `description` | string | 否 | Skill 描述 |
| `activation` | `'manual' \| 'auto' \| 'always'` | 否 | 触发模式，默认 `manual` |
| `match` | string[] | 否 | auto 模式关键词列表 |
| `category` | string | 否 | 分类标签，如 "code", "review", "docs" |
| `recommended_tools` | string[] | 否 | 推荐 tool 名集合 |
| `recommendedTools` | string[] | 否 | 同上（camelCase 别名） |

Frontmatter 使用极简 YAML 解析器（不依赖第三方库），支持：
- `key: value` 标量
- `key: [a, b, c]` 一行内联数组
- `key:` 后跟 `  - item` 缩进数组

---

## 四、Skill 注册机制

### 4.1 Agent Studio 注册流程

```
┌──────────────────────────────────────────────────────────────┐
│                    应用启动                                    │
│                         │                                     │
│           ┌─────────────▼──────────────┐                     │
│           │  agentStudio.contribution  │                     │
│           │  registerSingleton(        │                     │
│           │    ISkillRegistry,         │                     │
│           │    SkillRegistry,          │                     │
│           │    Delayed                 │                     │
│           │  )                         │                     │
│           └─────────────┬──────────────┘                     │
│                         │                                     │
│           ┌─────────────▼──────────────┐                     │
│           │  SkillRegistry 构造函数      │                     │
│           │  1. _loadBuiltins()        │ ← 硬编码内置 skill   │
│           │  2. reload() (async)       │ ← 文件扫描           │
│           └─────────────┬──────────────┘                     │
│                         │                                     │
│           ┌─────────────▼──────────────┐                     │
│           │  BuiltinCapabilityContribution │                  │
│           │  触发 ISkillRegistry 单例创建    │ ← DI 触发       │
│           └─────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

**DI 注册**（`agentStudio.contribution.ts:595`）：

```typescript
registerSingleton(ISkillRegistry, SkillRegistry, InstantiationType.Delayed);
```

**单例触发**（`agentStudio.contribution.ts:612`）：

```typescript
class BuiltinCapabilityContribution extends Disposable implements IWorkbenchContribution {
    constructor(
        // Touch ISkillRegistry so the singleton is created and starts
        // its filesystem scan early
        @ISkillRegistry _skillRegistry: ISkillRegistry,
    ) { ... }
}
```

### 4.2 文件扫描注册

`SkillRegistry._scanFolder()` 方法扫描指定目录下的子文件夹，每个子文件夹中查找 `SKILL.md`：

```typescript
private async _scanFolder(dir: URI, source: 'user' | 'workspace'): Promise<void> {
    const stat = await this.fileService.resolve(dir);
    for (const child of stat.children) {
        if (!child.isDirectory) continue;
        const skillFile = URI.joinPath(child.resource, 'SKILL.md');
        const content = await this.fileService.readFile(skillFile);
        const skill = this._parseSkillFile(child.resource, text, source);
        if (skill) {
            this._skills.set(skill.id, skill);  // 同 id 覆盖
        }
    }
}
```

**目录结构约定**：

```
<skills-root>/
├── code-review/
│   └── SKILL.md        ← 必须名为 SKILL.md
├── commit-message/
│   └── SKILL.md
└── my-custom-skill/
    └── SKILL.md
```

### 4.3 运行时注册（扩展注入）

扩展通过 `ISkillRegistry.registerSkill()` 在运行时注入 skill：

```typescript
registerSkill(skill: ISkillDefinition): IDisposable {
    const id = skill.id;
    this._runtimeSkills.set(id, { ...skill, source: skill.source ?? 'memory' });
    this._skills.set(id, this._runtimeSkills.get(id)!);
    this._onDidChangeSkills.fire();
    return toDisposable(() => {
        this._runtimeSkills.delete(id);
        this.reload();  // 重新加载，让被覆盖的 skill 回来
    });
}
```

返回 `IDisposable`，dispose 时从运行时表中移除并重新加载文件 skill。

---

## 五、Skill 激活与注入

### 5.1 Agent Studio 激活逻辑

`ISkillRegistry.resolveActivations()` 决定每轮 turn 注入哪些 skill：

```typescript
resolveActivations(context: ISkillActivationContext): Promise<readonly ISkillInjection[]> {
    for (const skill of this._skills.values()) {
        if (skill.enabled === false) continue;        // 跳过禁用

        let take = false;
        if (skill.activation === 'always') {           // always → 每次都注入
            take = true;
        } else if (explicit.has(skill.id.toLowerCase())) {  // 显式 /skill <id>
            take = true;
        } else if (skill.activation === 'auto' && skill.match) {  // 关键词匹配
            take = skill.match.some(kw => userMsg.includes(kw.toLowerCase()));
        }

        if (take) {
            out.push({
                skill,
                placement: skill.activation === 'always' ? 'system' : 'user',
                content: this._renderInjection(skill),
            });
        }
    }
}
```

**三种激活模式**：

| 模式 | 触发条件 | 注入位置 |
|------|----------|----------|
| `always` | 每轮 turn 自动注入 | `system`（合并到 system prompt） |
| `auto` | 用户消息匹配 `match` 关键词 | `user`（独立 user message） |
| `manual` | 仅通过 `/skill <id>` 显式激活 | `user`（独立 user message） |

### 5.2 注入渲染

注入时将 skill 内容包装为结构化文本：

```typescript
private _renderInjection(skill: ISkillDefinition): string {
    return [
        `### Skill activated: ${skill.name}`,
        skill.description ? `_${skill.description}_` : '',
        '',
        skill.prompt,
    ].filter(Boolean).join('\n');
}
```

### 5.3 技能自动匹配（autoSkill）

每个 Agent 实例通过 `Employee.autoSkill` 字段控制技能自动匹配行为：

```typescript
// src/vs/sessions/common/agentStudioTypes.ts
export interface Employee {
    // ...
    /**
     * 技能自动匹配开关（默认 true）：
     * - true: agent 可从内置和全局 skill 中搜索匹配的技能，自动复制到 agent 实例的 skills 目录
     * - false: 仅允许使用 agent 实例 skills 目录下已有的技能
     */
    autoSkill?: boolean;
}
```

**autoSkill = true（默认）**：
1. `resolveActivations()` 从所有来源（内置、全局、工作区）匹配 skill
2. 匹配到的非工作区 skill 自动「采纳」到 agent 实例的 skills 目录
3. 采纳 = 在 `.sarosisworkspace/agents/{agentDir}/skills/{id}/` 下创建 `SKILL.md`（不覆盖已有）

**autoSkill = false**：
1. `resolveActivations()` 仅返回 `source === 'workspace'` 的 skill
2. 不进行自动采纳
3. agent 只能使用自己 skills 目录下已有的技能

**采纳流程**（`adoptSkillToAgent`）：

```typescript
async adoptSkillToAgent(agentId: string, skillId: string): Promise<void> {
    // 1. 解析 agent 的 workspace + agentDir
    // 2. 检查 skills/{id}/SKILL.md 是否已存在 → 存在则跳过
    // 3. 创建目录并写入 SKILL.md（从 ISkillDefinition 序列化）
}
```

> 采纳是异步的，不阻塞 `resolveActivations()` 的返回。匹配到的 skill 在当前 turn 立即生效（来自内存注册表），同时异步写入磁盘供后续 turn 使用。

### 5.4 Skill 启用/禁用

UI 层通过 `enableSkill(id)` / `disableSkill(id)` 控制：

```typescript
enableSkill(id: string): void {
    const skill = this._skills.get(id);
    if (skill) {
        (skill as { enabled: boolean }).enabled = true;
        this._onDidChangeSkills.fire();
    }
}
```

---

## 六、Skill 与 Agent 的关联

### 6.1 EmployeeSkill 类型

Agent（Employee）实例通过 `EmployeeSkill` 关联 skill：

```typescript
// src/vs/sessions/common/agentStudioTypes.ts
export interface EmployeeSkill {
    readonly id: string;
    name: string;
    enabled: boolean;
    description?: string;
}

export interface Employee {
    // ...
    skills?: EmployeeSkill[];   // Agent 关联的 skill 列表
    autoSkill?: boolean;        // 技能自动匹配开关（默认 true）
}
```

### 6.2 内置 Skill 清单

Agent Studio 随产品发布的 4 个内置 skill：

| ID | 名称 | 激活模式 | 分类 | 说明 |
|----|------|----------|------|------|
| `code-review` | Code Review | auto | code | 代码评审 |
| `commit-message` | Commit Message | manual | git | 生成 Conventional Commits |
| `be-concise` | Be Concise | always | meta | 保持简短回答 |
| `plan-then-act` | Plan then Act | auto | meta | 复杂任务先规划后执行 |

---

## 七、Skill UI — SkillsViewPane

**源码**：`src/vs/sessions/contrib/agentStudio/browser/views/skillsView.ts`

SkillsViewPane 是 Agent Studio 侧边栏的 Skills 面板，职责：
1. 从 `ISkillRegistry` 拉取 skill 列表
2. 按 category 过滤展示
3. 提供启用/禁用开关
4. 显示激活模式、来源标签

注册方式（`agentStudio.contribution.ts:1218-1225`）：

```typescript
// 4. Skills (order: 30)
this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
    id: 'agentStudio.skills',
    title: localize2('agentStudio.skills.title', "Skills"),
    icon: skillsIcon,
    viewId: AGENT_STUDIO_SKILLS_VIEW_ID,
    order: 30,
    viewCtor: SkillsViewPane,
});
```

---

## 八、扩展如何注册自定义 Skill

### 方式一：文件系统放置

将 `SKILL.md` 放入指定目录即可自动发现：

```
# 用户全局 skill
<userRoamingDataHome>/sarosis/skills/my-skill/SKILL.md

# 工作区 skill（按 agent 实例隔离）
<workspace>/.sarosisworkspace/agents/<agentDir>/skills/my-skill/SKILL.md
```

### 方式二：运行时注册

扩展通过 DI 获取 `ISkillRegistry`，调用 `registerSkill()`：

```typescript
class MyExtensionPlugin implements IAgentCapabilityPlugin {
    activate(context: IAgentOSPluginContext): void {
        const skillRegistry = context.instantiationService.getService(ISkillRegistry);
        const disposable = skillRegistry.registerSkill({
            id: 'my-custom-skill',
            name: 'My Custom Skill',
            description: '...',
            activation: 'auto',
            match: ['custom', '自定义'],
            category: 'custom',
            prompt: '...',
            source: 'extension',
            enabled: true,
        });
    }
}
```

---

## 九、关键源码索引

| 文件 | 说明 |
|------|------|
| `src/vs/sessions/contrib/agentStudio/common/skills.ts` | ISkillDefinition、ISkillRegistry 接口定义 |
| `src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts` | SkillRegistry 实现（加载、扫描、注册、激活） |
| `src/vs/sessions/contrib/agentStudio/browser/views/skillsView.ts` | SkillsViewPane UI 组件 |
| `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` | DI 注册、Contribution 注册 |
| `src/vs/sessions/common/agentStudioTypes.ts` | EmployeeSkill 类型定义 |
