# Sarosis-Agents-Client 内置 Goal 工作流设计方案

## 1. 背景

参考 Hermes-Agent 的 goal 实现方案，我们需要在 vssaros-agents-client 项目中实现一个内置的 goal 工作流功能。

**Hermes-Agent Goal 核心机制回顾：**
- 用户设置一个目标（goal）
- 每轮完成后，通过辅助模型（judge）评估目标是否达成
- 未达成则自动继续工作，直到达成/预算用尽/用户暂停
- 持久化存储于 SessionDB 的 `state_meta` 表

**本项目差异：**
- 本项目使用工作流（Workflow）系统，而非简单的循环 + judge 调用
- 工作流由节点图（ReactFlow）定义，支持复杂的分支/循环逻辑
- 需要设计一个**内置的、可复用的工作流模板**

---

## 2. 内置工作流存储路径方案对比

### 方案 A：存储在 `resources/.agents/builtin-workflows/` （推荐）

**路径：** `resources/.agents/builtin-workflows/goal-workflow.json`

**优点：**
1. **与产品一同发布** - 内置工作流作为产品资源文件发布，用户无需额外安装
2. **版本化管理** - 随产品版本迭代，可通过 Git 追踪变更
3. **用户可引用/复制** - 高级用户可以查看、复制、修改该模板
4. **与现有模式一致** - `resources/.agents/` 下已有 `knot-skills-market.json`、`mcp.json` 等配置文件
5. **运行时加载** - 可通过 `FileAccess.asFileUri()` 读取（符合关键约定 0）
6. **分离关注点** - 与用户工作区的工作流（`.sarosworkspace/workflows/`）明确分离

**缺点：**
1. **需要加载逻辑** - 需编写代码在运行时加载该 JSON 文件
2. **文件缺失兜底** - 需考虑文件丢失/损坏时的 fallback 机制
3. **路径依赖** - 依赖 `resources/` 目录的正确打包和分发

**适用场景：**
- 需要随产品发布的内置模板
- 希望用户能看到、参考甚至复制修改
- 需要版本管理和 Git 追踪

---

### 方案 B：存储在源码目录 `src/vs/sessions/contrib/agentStudio/common/builtin-workflows/`

**路径：** `src/vs/sessions/contrib/agentStudio/common/builtin-workflows/goal.ts` (或 `goal.json`)

**优点：**
1. **与代码共存** - 内置工作流定义与 Agent Studio 代码放在同一目录，逻辑上紧密关联
2. **TypeScript 类型安全** - 如果用 `.ts` 定义，可享受类型检查
3. **直接导入** - 可通过 `import` 直接引用，无需文件 I/O
4. **编译时检查** - 构建时即可发现语法错误

**缺点：**
1. **混合源码** - 工作流定义文件与业务逻辑代码混在一起
2. **不可直接查看** - 编译后难以直接检查 JSON 结构
3. **用户不可见** - 用户无法轻松查看或引用该模板
4. **打包依赖** - 需确保该文件被正确打包到产品中

**适用场景：**
- 工作流非常简单，不需要用户查看
- 希望享受 TypeScript 类型安全
- 不介意与源码混合

---

### 方案 C：硬编码在 TypeScript 代码中（无独立文件）

**路径：** 直接在 `agentGoalService.ts` 中用代码定义工作流结构

**优点：**
1. **简单直接** - 无需文件 I/O，直接在内存在构造工作流对象
2. **始终可用** - 不依赖外部文件，不会因文件缺失而失败
3. **类型安全** - 享受完整的 TypeScript 类型检查

**缺点：**
1. **不可定制** - 用户无法查看或修改工作流结构（除非重新编译）
2. **难以维护** - 工作流逻辑嵌入代码中，修改需重新编译
3. **难以版本对比** - JSON 结构在代码中，Git diff 不直观
4. **不符合开放原则** - 内置功能应对用户透明，硬编码违背此原则

**适用场景：**
- 快速原型验证
- 工作流极其简单且永不改变
- 不打算让用户了解内部实现

---

### 方案 D：存储在用户数据目录 `~/.saros/workflow-templates/`

**路径：** `~/.saros/workflow-templates/goal-workflow.json` (用户数据目录）

**优点：**
1. **运行时可写** - 产品可在首次运行时生成/更新模板
2. **用户可修改** - 用户可编辑该文件自定义 goal 行为
3. **不占用产品空间** - 不在产品安装目录中

**缺点：**
1. **不在产品中** - 模板不随产品发布，需运行时生成
2. **版本管理困难** - 产品更新时如何同步更新用户目录中的模板？
3. **首次运行依赖** - 需确保目录和文件在首次使用前已生成
4. **不符合"内置"语义** - "内置"应随产品发布，而非运行时生成

**适用场景：**
- 需要运行时动态生成/更新模板
- 用户自定义优先级高于产品默认
- 不要求"内置"语义

---

### 方案 E：存储在 `resources/.agents/templates/` （模板语义）

**路径：** `resources/.agents/templates/goal-workflow.json`

**优点：**
1. **"模板"语义清晰** - 目录名 `templates/` 明确表示这是可实例化的模板
2. **与产品一同发布** - 同方案 A
3. **用户可实例化** - UI 可以提供"从模板创建"功能
4. **多模板管理** - 未来可添加更多内置模板到同一目录

**缺点：**
1. **需要模板实例化 UI** - 需开发"从模板创建"的用户界面和逻辑
2. **与方案 A 类似** - 本质上与方案 A 相同，只是目录名不同

**适用场景：**
- 希望提供"模板库"功能，用户可浏览和选择模板
- 未来会有多个内置模板
- 愿意投入 UI 开发成本

---

## 3. 推荐方案：**方案 A**（`resources/.agents/builtin-workflows/goal-workflow.json`）

### 推荐理由：

1. **符合现有架构模式** - `resources/.agents/` 已用于存放 agent 相关配置（`knot-skills-market.json`、`mcp.json`）
2. **"内置"语义明确** - `builtin-workflows/` 目录名清晰表达"内置工作流"概念
3. **与用户工作区隔离** - 不混淆内置模板和用户自定义工作流（后者在 `.sarosworkspace/workflows/`）
4. **可版本化** - Git 追踪，Code Review 可行
5. **用户可参考** - 高级用户可查看 JSON 了解 goal 工作原理
6. **运行时加载灵活** - 可加载、可缓存、可 fallback

### 实现要点：

#### 1. 文件结构
```
resources/
  .agents/
    builtin-workflows/
      goal-workflow.json       # Goal 工作流定义
      README.md               # 内置工作流说明文档
    knot-skills-market.json
    mcp.json
```

#### 2. 加载逻辑
```typescript
// src/vs/sessions/contrib/agentStudio/common/goalWorkflowService.ts

import { FileAccess } from '../../../../platform/workspace/electron-main/fileAccess.js';

class GoalWorkflowService {
  private static readonly BUILTIN_GOAL_WORKFLOW_PATH =
    'vs/../../resources/.agents/builtin-workflows/goal-workflow.json';

  async loadBuiltinGoalWorkflow(): Promise<IStoredWorkflow> {
    try {
      const uri = FileAccess.asFileUri(GoalWorkflowService.BUILTIN_GOAL_WORKFLOW_PATH);
      const content = await this.fileService.readFile(uri);
      return JSON.parse(content.value.toString());
    } catch (err) {
      // Fallback: return hardcoded workflow
      return this.getHardcodedGoalWorkflow();
    }
  }

  private getHardcodedGoalWorkflow(): IStoredWorkflow {
    // Hardcoded fallback if builtin file missing
    return { /* ... */ };
  }
}
```

#### 3. Fallback 机制
- **优先：** 从 `resources/.agents/builtin-workflows/goal-workflow.json` 加载
- **兜底：** 如果文件缺失/损坏，使用代码中硬编码的工作流定义
- **日志：** 记录加载失败警告，但不阻断功能

#### 4. 用户实例化
当用户激活 goal 功能时：
1. 加载内置 goal 工作流模板
2. 实例化到用户工作区的 `.sarosworkspace/workflows/goal-<uuid>.json`
3. 用户可在 Workflow Editor 中查看/修改该实例

---

## 4. Goal 工作流设计（概要）

### 4.1 工作流节点图

```
[Start]
   |
   v
[Prompt: "执行目标: {goal}"]
   |
   v
[Agent: 主执行 Agent]
   |
   v
[IfElse: Judge 评估]
   |-- done --> [End: 目标达成]
   |-- continue --> [Prompt: "继续工作"]
   |              |
   |              v
   |          [Agent: 主执行 Agent] (循环)
   |              |
   |              v
   |          [IfElse: 轮次预算检查]
   |              |-- 未超限 --> [IfElse: Judge 评估] (循环)
   |              |-- 已超限 --> [End: 预算用尽]
```

### 4.2 关键节点定义

#### Node 1: Start
- **类型：** `start`
- **作用：** 工作流入口

#### Node 2: Prompt (初始提示)
- **类型：** `prompt`
- **Prompt:** `执行目标: {{goal}}\n\n请开始工作以实现该目标。`
- **变量：** `goal` (从用户输入获取）

#### Node 3: Agent (主执行器)
- **类型：** `agent`
- **AgentId:** `goal-executor` (专用 goal 执行 agent)
- **作用：** 执行具体工作

#### Node 4: IfElse (Judge 评估)
- **类型：** `ifElse`
- **评估目标：** `lastAgentResponse` (上一个 Agent 节点的输出）
- **分支：**
  - **done:** Judge 认为目标已达成
  - **continue:** Judge 认为需继续
  - **budget_exhausted:** 轮次预算用尽

#### Node 5: Prompt (继续提示)
- **类型：** `prompt`
- **Prompt:** `目标未达成，继续工作。\n上次 Judge 理由: {{judgeReason}}`
- **作用：** 驱动 Agent 继续下一轮

#### Node 6: End (目标达成)
- **类型：** `end`
- **作用：** 工作流正常结束

#### Node 7: End (预算用尽)
- **类型：** `end`
- **作用：** 工作流因预算用尽而结束

### 4.3 工作流 JSON 结构（简化）

```json
{
  "id": "builtin-goal-workflow",
  "name": "Goal Execution (Built-in)",
  "description": "内置 Goal 执行工作流，自动循环直到目标达成或预算用尽",
  "presetId": "goal-executor",
  "nodes": [
    {
      "id": "start-1",
      "type": "start",
      "name": "Start",
      "position": { "x": 100, "y": 100 }
    },
    {
      "id": "prompt-1",
      "type": "prompt",
      "name": "Initial Prompt",
      "position": { "x": 300, "y": 100 },
      "data": {
        "prompt": "执行目标: {{goal}}\n\n请开始工作以实现该目标。",
        "variables": { "goal": "" }
      }
    },
    {
      "id": "agent-1",
      "type": "agent",
      "name": "Goal Executor",
      "position": { "x": 500, "y": 100 },
      "data": {
        "agentId": "goal-executor",
        "contextScope": "session"
      }
    },
    {
      "id": "ifelse-1",
      "type": "ifElse",
      "name": "Judge Evaluation",
      "position": { "x": 700, "y": 100 },
      "data": {
        "evaluationTarget": "lastAgentResponse",
        "branches": [
          { "id": "done", "label": "Done", "condition": "judgeOutput.done === true" },
          { "id": "continue", "label": "Continue", "condition": "judgeOutput.done === false" }
        ]
      }
    },
    {
      "id": "prompt-2",
      "type": "prompt",
      "name": "Continue Prompt",
      "position": { "x": 900, "y": 50 },
      "data": {
        "prompt": "目标未达成，继续工作。\n上次 Judge 理由: {{judgeReason}}"
      }
    },
    {
      "id": "end-1",
      "type": "end",
      "name": "Goal Achieved",
      "position": { "x": 700, "y": 250 }
    }
  ],
  "connections": [
    { "id": "c1", "from": "start-1", "to": "prompt-1" },
    { "id": "c2", "from": "prompt-1", "to": "agent-1" },
    { "id": "c3", "from": "agent-1", "to": "ifelse-1" },
    { "id": "c4", "from": "ifelse-1", "to": "end-1", "fromPort": "done" },
    { "id": "c5", "from": "ifelse-1", "to": "prompt-2", "fromPort": "continue" },
    { "id": "c6", "from": "prompt-2", "to": "agent-1" }
  ],
  "createdAt": "2026-06-15T08:00:00.000Z",
  "updatedAt": "2026-06-15T08:00:00.000Z"
}
```

---

## 5. 方案对比总结表

| 对比维度 | 方案 A (`resources/.agents/builtin-workflows/`) | 方案 B (`src/.../builtin-workflows/`) | 方案 C (硬编码) | 方案 D (`~/.saros/workflow-templates/`) | 方案 E (`resources/.agents/templates/`) |
|---------|------|------|------|------|------|
| **随产品发布** | ✅ 是 | ✅ 是 | ✅ 是 | ❌ 否 (运行时生成) | ✅ 是 |
| **用户可查看** | ✅ 是 | ⚠️ 编译后不可见 | ❌ 否 | ✅ 是 | ✅ 是 |
| **用户可修改** | ⚠️ 需复制实例 | ❌ 否 | ❌ 否 | ✅ 是 | ⚠️ 需复制实例 |
| **版本化管理** | ✅ Git 追踪 | ✅ Git 追踪 | ⚠️ 代码中 | ❌ 不在 Git | ✅ Git 追踪 |
| **类型安全** | ⚠️ 运行时检查 | ✅ TypeScript | ✅ TypeScript | ⚠️ 运行时检查 | ⚠️ 运行时检查 |
| **实现复杂度** | 中 (需加载逻辑) | 低 (直接导入) | 最低 (无文件 I/O) | 高 (需生成逻辑) | 中 (需加载+实例化 UI) |
| **符合"内置"语义** | ✅ 是 | ✅ 是 | ✅ 是 | ❌ 否 | ✅ 是 |
| **与用户工作流隔离** | ✅ 是 | ✅ 是 | ✅ 是 | ✅ 是 | ✅ 是 |
| **推荐指数** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |

---

## 6. 下一步行动

1. **确认存储方案** - 与团队讨论，确认选择方案 A
2. **创建目录和文件** - 在 `resources/.agents/builtin-workflows/` 下创建 `goal-workflow.json`
3. **实现加载逻辑** - 编写 `GoalWorkflowService.loadBuiltinGoalWorkflow()`
4. **设计 Judge 节点** - 详细设计 Judge 评估节点的实现（可能需调用辅助模型）
5. **实现 Goal 激活 UI** - 在 Chat 界面添加 `/goal` 命令或按钮
6. **测试验证** - 创建测试用例验证 goal 工作流正确性

---

**文档版本：** v1.0
**创建时间：** 2026-06-15
**作者：** AI Assistant (基于 Hermes-Agent goal 分析)
