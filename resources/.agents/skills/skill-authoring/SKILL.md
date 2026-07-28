---
name: skill-authoring
description: 如何创建和维护技能（SKILL.md）。包含：何时创建技能、何时用 edit vs patch、SKILL.md 结构模板、命名规范、验证规则。当需要沉淀知识为技能时使用。
activation: manual
category: development
---

# 技能创作指南 (Skill Authoring)

## 概述

技能是存储在 `~/.vssaros/saros/skills/<name>/SKILL.md` 的可复用程序化知识。
由 Agent 通过 `skill_create` / `skill_manage` 工具创建和维护，也可通过 UI「沉淀技能」按钮手动创建。

## 何时创建技能

触发以下任一条件时创建：

- 复杂任务成功完成（5+ 次工具调用），且方法可复用
- 遇到并克服了非平凡错误，值得记录
- 用户纠正了你的方法，修正后的版本值得保存
- 发现了一个非平凡的工作流，能帮助未来的类似任务
- 用户明确要求记住或创建一个流程/技能

**不要创建技能的场景**：
- 简单的一次性查询（如"现在几点"、"文件大小是多少"）
- 工具参数本身的说明（由运行时 `## Available Tools` 注入）
- 仅改一行配置或一条命令

创建前**必须向用户确认**（`skill_create` 工具说明中有要求）。

## 何时用 edit vs patch

| 场景 | 使用 |
|------|------|
| 小修改：修正一个步骤、更新描述、添加一个陷阱 | `skill_manage(action="patch")` |
| 大改动：重写整个技能、重组结构、大幅扩展 | `skill_manage(action="edit")` |
| 全新技能 | `skill_create` 或 `skill_manage(action="create")` |

`patch` 的 `old_string` 必须精匹配（包括空白和换行），且默认要求唯一（除非 `replace_all=true`）。

## SKILL.md 结构模板

```markdown
---
name: my-skill-name              # 必填，slug 格式（小写字母/数字/连字符/下划线/点，≤64字符）
description: 使用时机与用途。     # 必填，明确说明"何时使用该技能"，≤1024字符
activation: manual               # manual | auto | always
match: [keyword1, keyword2]      # auto 模式触发关键词
category: code                   # 可选分类
recommended_tools: [tool1]       # 推荐工具
tags: [tag1, tag2]               # 标签
related_skills: [other-skill]    # 关联技能
version: 1.0.0
---

# <技能标题>

## 概述
一到两段：做什么、为什么需要这个技能。

## 使用时机
- 触发条件 1
- 触发条件 2
- 不要用于：反例

## 执行步骤
1. 步骤一：具体命令或操作
2. 步骤二：
   ```bash
   确切的命令
   ```
3. 步骤三：验证方法

## 常见陷阱
1. **陷阱描述**：原因 + 如何避免
2. ...

## 验证方法
如何确认技能执行成功（检查点、预期输出）
```

## 结构原则

1. **使用时机在前**：让 Agent 快速判断是否应该激活该技能
2. **步骤编号**：可执行的命令和检查点，不写"尝试 X"这种模糊指令
3. **陷阱必须有**：记录了至少一个实际遇到过的错误
4. **参考现有技能**：以 `gr-gc-expert` 为例——使用时机→概述→详细步骤→陷阱→参考案例
5. **领域知识外置**：GC 阶段/配置项/阈值等细节知识放技能 body，不在 Agent prompt 中重复

## 验证规则（`skillManagerTool.ts` 强制）

- `name` 必填，slug 格式 `/^[a-z0-9][a-z0-9._-]*$/`，≤64 字符
- `description` 必填，≤1024 字符
- YAML frontmatter 必须以 `---` 开头并闭合
- Body 不能为空
- 全文件 ≤100,000 字符（~36k tokens）

## 常见陷阱

1. **description 写成了内容概述而非使用时机**：description 应回答"什么时候用"，不是"内容是什么"
2. **patch 的 old_string 含不可见字符**：确保复制的是文件中精确的文本（包括换行符 `\n`）
3. **知识性内容放入 Agent prompt 而非技能**：prompt 保持简洁（身份+思考流程+工具指引），领域知识放技能 body
4. **忘记写验证方法**：没有验证步骤的技能在使用后无法确认是否生效
