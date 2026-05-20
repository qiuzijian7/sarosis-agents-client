# Skill 系统改进：借鉴 OpenClaw 轻量目录 + 按需加载模式

## 变更日期
2025-05-20

## 改进动机

之前的实现将 **92 个 skill 的完整列表**（name + description + activation + source）逐行注入到 systemPrompt 中，导致：
- 每次 turn 都消耗大量 token（仅技能清单就可能超过 5000 token）
- 所有 `always` 类型 skill 的完整 prompt 全量注入 systemPrompt，进一步膨胀
- 无预算控制，skill 数量增长时 prompt 无限膨胀

**OpenClaw 的核心设计哲学**：System Prompt 中只放**轻量级目录**（name + description + id），技能全文通过 `read` 工具**按需加载**。

## 改进内容

### 1. 轻量 XML 目录替代全量列表

**文件**: `agentDriverService.ts` Step 3a

**之前**：
```
## Installed Skills
- **Code Review**: 对当前 diff/文件进行快速代码评审... [auto] (source: builtin)
- **commit-message**: 自动生成语义化的 git commit 消息... [auto] (source: builtin)
... (92行)
```

**现在**（OpenClaw 风格 XML）：
```xml
## Skills

Scan <available_skills> below. If one clearly applies to the user's task,
use the `read_skill` tool with the skill id to load its full instructions.

<available_skills>
  <skill>
    <name>Code Review</name>
    <description>对当前 diff/文件进行快速代码评审</description>
    <id>code-review</id>
    <activation>auto</activation>
  </skill>
  ...
</available_skills>

(92 skills total)
```

### 2. `read_skill` 工具 —— 按需加载完整内容

**文件**: `builtinToolProvider.ts`

注册了两个新工具：

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `read_skill` | 按 id 读取 skill 的完整 prompt 指令 | `skill_id` (required) |
| `list_skills` | 列出/搜索已安装 skill | `filter`, `category` (optional) |

模型在看到 `<available_skills>` 目录后，自主决定是否需要调用 `read_skill` 获取完整指令。

### 3. 预算控制 + Compact 降级

| 参数 | 值 | 说明 |
|------|-----|------|
| MAX_SKILLS_IN_PROMPT | 150 | 目录最多展示的 skill 数 |
| MAX_SKILLS_PROMPT_CHARS | 18,000 | XML 目录字符上限 |

降级策略（与 OpenClaw 一致）：
1. **完整格式**：name + description + id + activation
2. **Compact 格式**：去除 description，仅保留 name + id + activation
3. **二分截断**：如果 compact 仍超限，二分搜索找到最大可容纳数量

### 4. `always` 类型 Skill 智能注入

| 条件 | 策略 |
|------|------|
| prompt < 500 chars | 直接内联注入全文（行为指南型） |
| prompt >= 500 chars | 只放摘要 + 引导 `read_skill` |

## Token 节约估算

假设 92 个 skill：
- **旧方案**：每个 skill 一行列表 ≈ 50-100 chars → 总计 ~5000-9000 chars
- **新方案**：XML 目录每个 skill ≈ 5 行 × 40 chars = 200 chars → 总计 ~18000 chars（上限）
- **但**：旧方案中 `always` skill 全文注入可达 10000+ chars，新方案长 skill 改为摘要 ~100 chars
- **净效果**：当 skill 数量多或有长 always skill 时，总 token 减少 30-60%

## 文件变更清单

1. `src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts`
   - Step 3a: 技能清单改为 XML 轻量目录 + 预算控制
   - Step 3b: always skill 注入改为短内联 / 长摘要

2. `src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts`
   - 新增 `ISkillRegistry` 依赖注入
   - 新增 `_registerSkillTools()` 方法
   - 注册 `read_skill` 和 `list_skills` 工具

## 向后兼容性

- `auto` 和 `manual` 类型 skill 的 user-message 注入逻辑不变
- `ISkillRegistry` 接口无变更
- 已有的 `/skill <name>` 命令仍正常工作
- 模型能力降级优雅：即使模型不调用 `read_skill`，XML 目录中已包含足够信息让模型知道哪些 skill 可用
