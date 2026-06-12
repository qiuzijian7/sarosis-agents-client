# Superpowers → Sarosis Workflow 融合兼容方案

> 分析日期：2026-06-12  
> Superpowers v5.1.0 → Sarosis Agents Client (VS Code fork, v2.1.0)

---

## 一、两项目架构对比

| 维度 | Superpowers | Sarosis Workflow |
|------|-------------|------------------|
| **本质定位** | AI 编码代理的"方法论操作系统"（纯 Markdown 技能文件） | 可视化工作流编排 + 图节点执行引擎 |
| **技能格式** | YAML Frontmatter + Markdown 正文 (SKILL.md) | `ISkillDefinition` 接口（id/name/prompt/activation/match/category） |
| **触发机制** | Hook 注入（SessionStart）→ Agent 自检相关技能 | SkillRegistry.resolveActivations() 关键词匹配 + 显式 `/skill` 命令 |
| **执行方式** | Agent 读取 SKILL.md → 按指令执行子代理 | 图节点递归遍历（Start → Node1 → Node2 → ... → End） |
| **子代理系统** | 按任务派遣 fresh subagent + 两阶段审查 Pipeline | AgentChatService 子代理卡片 + trace 事件（无审查 Pipeline） |
| **工作流管道** | 6 阶段线性管道 (brainstorming → ... → finish) | DAG 图执行（支持条件分支 IfElse/Switch + 并行） |
| **代码审查** | 规格合规性 → 代码质量 两阶段审查 | 无专用审查节点（可用 Agent 节点模拟） |
| **TDD** | 强制 RED-GREEN-REFACTOR 循环 | 无 TDD 专用节点（可用 Prompt 节点注入指令） |
| **模型选择** | 按任务复杂度分三档（机械/标准/架构） | 无模型选择策略（使用 workflow 绑定的 agent） |
| **平台支持** | Claude Code / Cursor / Gemini CLI / OpenCode / Copilot CLI / Codex / Factory Droid | VS Code 内嵌（Electron + WebView） |

### 核心结论

Superpowers 提供的是**方法论内容**（WHAT to do），Sarosis 提供的是**执行基础设施**（HOW to execute）。两者**不是竞争关系，而是内容与容器的关系**。融合的本质是：**将 Superpowers 的 SKILL.md 方法论标准化为 Sarosis 的可执行工作流节点图**。

---

## 二、数据模型映射

### 2.1 Superpowers SKILL.md → Sarosis ISkillDefinition

```
Superpowers SKILL.md                    Sarosis ISkillDefinition
────────────────────────────────────    ────────────────────────────────
YAML name            ──────────────→    id + name
YAML description     ──────────────→    description
正文 (Markdown)       ──────────────→    prompt
触发方式 (auto/manual) ──────────────→   activation
自动化关键词(隐含)     ──────────────→   match[]
无                   ──────────────→    category: "superpowers"
无                   ──────────────→    source: "extension"
无                   ──────────────→    contentHash (自动计算)
无                   ──────────────→    enabled: true
```

**兼容性**: ★★★★★ 完美匹配。Superpowers SKILL.md 的 YAML frontmatter 结构可以直接映射到 `ISkillDefinition`，无需修改数据模型。

### 2.2 Superpowers 工作流管道 → Sarosis 工作流节点图

```
Superpowers Pipeline                     Sarosis Node Graph
──────────────────────────────           ──────────────────────────
brainstorming                            [Start]
    ↓                                    [Skill: brainstorming]
using-git-worktrees                      [Skill: using-git-worktrees]
    ↓                                    [Agent: 执行 worktree 创建]
writing-plans                            [Skill: writing-plans]
    ↓                                    [Agent: 生成计划]
subagent-driven-development              [Group: 子代理执行]
    ├─ implementer subagent              ├─ [Agent: implementer]
    ├─ spec-reviewer subagent            ├─ [Agent: spec-reviewer]
    └─ code-quality-reviewer subagent    └─ [Agent: code-quality-reviewer]
    ↓                                    [IfElse: 审查通过?]
test-driven-development                  [Skill: test-driven-development]
    ↓                                    [Agent: 执行 TDD]
requesting-code-review                   [Skill: requesting-code-review]
    ↓                                    [Agent: 代码审查]
finishing-a-development-branch           [Skill: finishing-a-development-branch]
                                         [End]
```

**兼容性**: ★★★★☆ 高度兼容。Superpowers 的线性管道可表示为 Sarosis 的链式节点图。Superpowers 的并行子代理可映射到 Sarosis 的并行 Agent 节点。

### 2.3 子代理审查 Pipeline → Sarosis 节点嵌套

Superpowers 的两阶段审查是**目前 Sarosis 没有直接对应项的**。需要扩展：

| Superpowers 概念 | Sarosis 对应方案 |
|------------------|------------------|
| implementer subagent | `Agent` 节点 + 特定的 implementer Agent 绑定 |
| spec-reviewer subagent | `Agent` 节点 + 特定的 reviewer Agent 绑定 |
| code-quality-reviewer subagent | `Agent` 节点 + 特定的 reviewer Agent 绑定 |
| 审查失败 → 修复 → 重新审查 | `IfElse` 节点 + 回环边（需要执行引擎支持循环） |
| DONE / DONE_WITH_CONCERNS / BLOCKED | 节点 output 状态码 |

**⚠️ 当前限制**: Sarosis 的执行引擎目前是 **DAG（无环图）**，不支持回环边。Superpowers 的"修复 → 重新审查"需要循环，需要执行引擎扩展 `Loop` 节点类型或支持重试计数。

---

## 三、分阶段融合方案

### Phase 1 — Skill Library Import（技能库导入）⭐⭐ 优先级最高

**目标**: 将 Superpowers 15 个 SKILL.md 文件导入为 Sarosis 的 Skill，可在 Skill 节点中使用。

**工作量**: 1-2 天

**实施步骤**:

1. **编写导入脚本**（`scripts/import-superpowers-skills.ts`）
   - 读取 `superpowers/skills/*/SKILL.md`
   - 解析 YAML frontmatter
   - 生成 `ISkillDefinition` 对象
   - 写入 `resources/.agents/skills/superpowers/` 目录

2. **元数据映射规则**:
   ```typescript
   // SKILL.md frontmatter → ISkillDefinition
   {
     id: `superpowers.${name}`,
     name: frontmatter.name,
     description: frontmatter.description,
     activation: inferActivation(name),  // 推断规则见下表
     match: inferMatchKeywords(name),
     category: 'superpowers',
     prompt: markdownBody,
     source: 'builtin',
     enabled: true,
   }
   ```

3. **激活模式推断**:
   | Superpowers Skill | Sarosis Activation | 理由 |
   |-------------------|-------------------|------|
   | using-superpowers | `always` | 引导技能，每次 turn 注入 |
   | test-driven-development | `auto` | 匹配关键词 "test", "TDD" |
   | systematic-debugging | `auto` | 匹配关键词 "bug", "fix", "debug" |
   | verification-before-completion | `always` | 完成前必须验证 |
   | subagent-driven-development | `manual` | 用户显式选择 |
   | brainstorming | `manual` | 用户显式选择 |
   | writing-plans | `manual` | 用户显式选择 |
   | executing-plans | `manual` | 用户显式选择 |
   | requesting-code-review | `manual` | 用户显式选择 |
   | receiving-code-review | `manual` | 用户显式选择 |
   | using-git-worktrees | `auto` | 匹配关键词 "worktree", "branch" |
   | finishing-a-development-branch | `manual` | 用户显式选择 |
   | dispatching-parallel-agents | `auto` | 匹配关键词 "parallel" |
   | writing-skills | `manual` | 用户显式选择 |

4. **确保 SkillRegistry 扫描该目录**: 已有 `_resolveSkillsTargetDir` 使用 `FileAccess.asFileUri` 扫描 `resources/.agents/skills/`，新增 `superpowers/` 子目录自动被覆盖。

**Phase 1 交付物**:
- `resources/.agents/skills/superpowers/{skill-name}/SKILL.md` × 15
- `scripts/import-superpowers-skills.ts` 导入脚本
- Skill 节点可选择 `superpowers.*` 技能

---

### Phase 2 — Workflow Templates（工作流模板）⭐⭐⭐

**目标**: 将 Superpowers 的标准工作流管道转化为 Sarosis 的预置工作流模板（`.json` 文件）。

**工作量**: 2-3 天

**模板清单**:

#### Template A: "Superpowers 全流程" (Full Pipeline)
```
Start
  → [Skill: brainstorming]      → [Agent: 需求分析]
  → [Skill: using-git-worktrees] → [Agent: 创建 worktree]
  → [Skill: writing-plans]      → [Agent: 生成实施计划]
  → [Group: 子代理执行]
      ├─ [Agent: implementer]    → [Agent: spec-reviewer]
      └─ [Agent: code-quality-reviewer]
  → [IfElse: 审查通过?]
      ├─ True → [Skill: test-driven-development] → [Agent: 执行 TDD]
      └─ False → [Agent: 修复] → 回到审查
  → [Skill: requesting-code-review] → [Agent: 代码审查]
  → [Skill: finishing-a-development-branch]
  → End
```

#### Template B: "Bug 修复流程" (Bug Fix Pipeline)
```
Start
  → [Skill: systematic-debugging] → [Agent: 根因分析]
  → [Skill: test-driven-development] → [Agent: RED 阶段]
  → [Agent: GREEN 阶段]
  → [Agent: REFACTOR 阶段]
  → [Skill: verification-before-completion]
  → End
```

#### Template C: "功能开发" (Feature Development)
```
Start
  → [Skill: brainstorming] → [Agent: 设计分析]
  → [Skill: writing-plans] → [Agent: 生成实施计划]
  → [Skill: subagent-driven-development]
  → [IfElse: 需要代码审查?]
      ├─ True → [Skill: requesting-code-review]
      └─ False → [Skill: finishing-a-development-branch]
  → End
```

**实施步骤**:

1. 创建 `resources/.agents/workflow-templates/superpowers/` 目录
2. 用 Sarosis 工作流编辑器手动构建模板 → 导出 JSON
3. 或编写模板生成脚本
4. 在 WebView `WorkflowListPanel` 中添加 "从模板创建" 按钮

**Phase 2 交付物**:
- `resources/.agents/workflow-templates/superpowers/full-pipeline.json`
- `resources/.agents/workflow-templates/superpowers/bug-fix.json`
- `resources/.agents/workflow-templates/superpowers/feature-dev.json`
- WebView UI: "新建 → 从模板" 入口

---

### Phase 3 — Review Pipeline Node（审查流水线节点）⭐⭐⭐

**目标**: 实现 Superpowers 的两阶段审查机制（规格审查 + 代码质量审查）。

**工作量**: 3-4 天

**方案 A（推荐）: 新增 `Review` 节点类型**

```typescript
// 新增 WorkflowNodeType.Review
export const enum WorkflowNodeType {
    // ... 现有
    Review = 'review',  // 审查节点：触发两阶段审查
}

// 审查节点数据
interface WorkflowReviewNodeData extends WorkflowNodeData {
    reviewType: 'spec' | 'code-quality' | 'both';  // 审查类型
    reviewerAgentId: string;                        // 审查 agent
    implementerAgentId: string;                     // 实施 agent (用于修复)
    maxRetries: number;                             // 最大重试次数
    specChecklist?: string[];                       // 规格检查清单
    qualityChecklist?: string[];                    // 质量检查清单
}
```

**执行逻辑**:
```typescript
private async _executeReviewNode(
    executionState: IWorkflowExecutionState,
    node: WorkflowGraphNode,
    adj: Map<string, ...>,
): Promise<string[]> {
    const data = node.data as WorkflowReviewNodeData;
    
    // Stage 1: Spec Compliance Review
    const specResult = await this._dispatchReviewer(
        executionState, data.reviewerAgentId,
        data.specChecklist, 'spec'
    );
    
    if (!specResult.passed && retries < data.maxRetries) {
        await this._requestFixes(executionState, data.implementerAgentId, specResult.issues);
        // 重新审查
    }
    
    // Stage 2: Code Quality Review
    const qualityResult = await this._dispatchReviewer(
        executionState, data.reviewerAgentId,
        data.qualityChecklist, 'code-quality'
    );
    
    if (!qualityResult.passed && retries < data.maxRetries) {
        await this._requestFixes(executionState, data.implementerAgentId, qualityResult.issues);
    }
    
    // 根据审查结果返回不同的下游节点
    return specResult.passed && qualityResult.passed
        ? this._getNextNodes(node.id, adj)  // 通过，继续
        : [];  // 失败，终止
}
```

**方案 B（更轻量）: 使用现有 Agent 节点组合**

不新增节点类型，而是创建专用的 reviewer agent 绑定：
- "Superpowers Spec Reviewer" agent（system prompt = spec-reviewer-prompt.md）
- "Superpowers Code Quality Reviewer" agent（system prompt = code-quality-reviewer-prompt.md）

用户在工作流编辑器中手动串联 Agent 节点实现审查 Pipeline。

**推荐**: 先实施方案 B 作为快速验证，再根据需求决定是否实施 A。

---

### Phase 4 — Model Selection Strategy（模型选择策略）⭐⭐

**目标**: 让工作流节点能根据任务复杂度自动选择模型。

**工作量**: 1-2 天

**Superpowers 的三档策略**:
| 档位 | 适用场景 | 模型要求 |
|------|---------|---------|
| 机械实现 | 1-2 文件，明确规格 | 最快最便宜 |
| 集成判断 | 多文件协调 | 标准模型 |
| 架构设计 | 架构/设计/审查 | 最强大模型 |

**Sarosis 实施方案**:

在 `Agent` 节点 data 中新增 `modelTier` 字段：
```typescript
interface WorkflowAgentNodeData {
    // ... 现有字段
    modelTier?: 'fast' | 'standard' | 'powerful';  // 模型档位
}
```

执行时根据 `modelTier` 选择对应的模型：
```typescript
private _resolveModelForTier(tier?: string): string {
    switch (tier) {
        case 'fast': return this._config.fastModelId;
        case 'standard': return this._config.standardModelId;
        case 'powerful': return this._config.powerfulModelId;
        default: return this._config.defaultModelId;
    }
}
```

配置来源: `product.json` 或 workspace-level settings。

---

### Phase 5 — Deep Integration（深度集成）⭐

这一阶段是将 Superpowers 的**工程哲学**深度嵌入 Sarosis 操作系统的能力槽位。

#### 5.1 TDD 执行模式

为 `Agent` 节点新增 `executionMode` 字段：
```typescript
type AgentExecutionMode = 'freeform' | 'tdd';
```

当 `executionMode = 'tdd'` 时，Agent Driver 自动插入 RED-GREEN-REFACTOR 循环指令，并在每阶段完成后验证。

#### 5.2 系统化调试流程

Superpowers 的 `systematic-debugging` 有详细的 4 阶段流程图。可将其转化为 Sarosis 的 sub-flow：
```
[Agent: 根因调查] → [IfElse: 找到根因?]
  → True → [Agent: 模式分析] → [Agent: 假设验证] → [Agent: 实施修复]
  → False → [AskUser: 需要更多信息] → 回到根因调查
```

#### 5.3 Git Worktree 自动化

Superpowers 的 `using-git-worktrees` 提供了一套完整的 worktree 管理流程。Sarosis 已有 `IWorkspaceRegistry` 和 `IAgentBinding.worktreePath`，可进一步集成：
- 工作流触发时自动创建 worktree
- 工作流完成后自动清理 worktree
- Worktree 路径注入到 Agent 节点的执行上下文

---

## 四、兼容性风险评估

| 风险项 | 等级 | 说明 | 缓解措施 |
|--------|------|------|---------|
| 循环执行 | 🔴 高 | Sarosis 执行引擎是 DAG，Superpowers 有回环（修复→重新审查） | Phase 3 需要扩展引擎支持 `Loop` 节点或重试计数 |
| SKILL.md 格式差异 | 🟡 中 | Superpowers 的 Graphviz DOT 流程图、子代理 prompt 模板引用（`./implementer-prompt.md`）不是标准 Markdown | 在导入时做格式转换或直接保留原始格式 |
| 子代理上下文隔离 | 🟡 中 | Superpowers 要求 fresh subagent per task（完全干净上下文）；Sarosis agent session 默认共享上下文 | 在执行 Review 节点时使用 `createAgentSession` + clean context |
| 多平台适配 | 🟢 低 | Superpowers 支持 7+ 平台，但与 Sarosis 的 VS Code 环境天然不同 | Superpowers 的跨平台代码（hook 脚本、polyglot .cmd）不需要迁移 |
| ISkillDefinition 字段 | 🟢 低 | Sarosis ISkillDefinition 已有 activation/match/category 等字段，可直接承载 Superpowers 元数据 | 无需修改接口 |
| 版本管理 | 🟢 低 | Superpowers v5.1.0 通过 `package.json` + `.version-bump.json` 管理版本；Sarosis 有独立版本管理策略 B | 导入时记录 Superpowers 版本到 skill metadata |

---

## 五、推荐实施路线图

```
Week 1 ─  Phase 1: Skill Library Import
         ├─ 导入 15 个 Superpowers SKILL.md
         ├─ 配置 activation 模式 + 关键词匹配
         └─ 验证: Skill 节点可选择 superpowers.* 技能

Week 2 ─  Phase 2: Workflow Templates
         ├─ 创建 3-5 个预置工作流模板
         ├─ WebView UI: "从模板创建"
         └─ 验证: 一键生成完整的 Superpowers 工作流

Week 3 ─  Phase 3: Review Pipeline（方案 B 先行）
         ├─ 创建 reviewer agent 绑定
         ├─ 构建审查工作流模板
         └─ 验证: 两阶段审查可正常运行

Week 4 ─  Phase 4: Model Selection Strategy
         ├─ Agent 节点新增 modelTier 字段
         ├─ WebView UI: 模型档位选择器
         └─ 验证: 不同节点使用不同档位模型

Week 5+ ─ Phase 5: Deep Integration（按需）
         ├─ TDD 执行模式
         ├─ 系统化调试子流程
         └─ Git Worktree 自动化
```

---

## 六、关键设计决策

### 决策 1: 导入后是否需要修改 Superpowers 的 SKILL.md 正文？

**推荐: 不修改。** Superpowers 的 SKILL.md 正文包含 Graphviz DOT 图、对 `./implementer-prompt.md` 等文件的引用。Sarosis 的 Skill 执行方式是将 prompt 注入为 user message，Agent 不需要能渲染 DOT 图或访问文件，只需要理解指令即可。DOT 图的文本描述 + 步骤编号在纯文本上下文中仍然可读。

### 决策 2: 是否需要创建 `Loop` 节点？

**推荐: 先不用。** Phase 3 的审查 Pipeline 可以通过在 Agent 节点内实现 `maxRetries` 参数来解决"修复→重新审查"需求。如果后续出现更需要通用循环的场景（如系统化调试的"回到根因调查"），再设计 `Loop` 节点。

### 决策 3: Superpowers 技能是 "builtin" 还是 "extension" 来源？

**推荐: `builtin`。** 导入后的 Superpowers 技能文件放在 `resources/.agents/skills/superpowers/`，属于随产品发布的 builtin 资源。用户可通过 SkillRegistry 的 enable/disable 控制启用状态。

---

## 七、总结

**融合的本质**: Superpowers 是一套**经过实战验证的软件工程方法论**，Sarosis 是一个**可视化的 AI Agent 工作流编排平台**。融合将 Superpowers 的"智慧"注入 Sarosis 的"身体"，让 Sarosis 用户可以直接运行符合 Superpowers 工程哲学的结构化工作流。

**最大价值**: 
1. Sarosis 获得了一套经过社区大量验证的最佳实践工作流
2. 用户无需学习 Superpowers 的命令行交互方式，可直接在可视化界面中使用
3. 为 Sarosis 的 Skill/Workflow/Agent 节点系统提供了高质量的"内容填充"

**不兼容的核心问题**: Superpowers 要求 Agent 是"自驱动的"（Agent 读取技能后自己做决策），而 Sarosis 是"编排驱动的"（执行引擎按节点图严格推进）。在融合时需要保留 Superpowers 技能的**自决策空间**（如子代理驱动开发中 Agent 自行决定何时派遣子代理），同时提供 **Sarosis 的可视化监控**（通过 trace 事件实时反映子代理状态）。
