# 技能制作规范（VsSaros / dsh）

版本：2026-11-02 · 面向 **Agent 与技能作者**。工作台规范见
[`workbench-development-standard.md`](./workbench-development-standard.md)；本文只管"技能怎么写、怎么被看见、怎么验证"。

## 1. 一个技能是什么

一个目录 + 一个 `SKILL.md`：

```
<技能根>/<id>/
├── SKILL.md          必需：frontmatter + 正文
├── references/*.md   可选：细则（正文里用相对路径指向它）
└── scripts/*          可选：脚本（模型用 shell 执行）
```

**技能根（按优先级从高到低，同层由 rank 决定）**：

| 根 | 位置 | 门控 |
|---|---|---|
| 项目级 | `<项目根>/.dsh/skills`、`<项目根>/.agents/skills` | 需要**工作区受信任** |
| 用户级 | `<数据根>/skills` | 无 |
| 官方用户级 | `<DSH_HOME>/skills`（打包版回落 `~/.dsh/skills`） | 无 |
| 内置 | `resources/.agents/skills` | 无 |

⚠ **dsh 侧的 provider 只扫技能根的第一层**（单层 `readdir`）：技能必须直接在根下，
不能塞进 `容器/skill-a/` 这类嵌套目录 —— 否则 IDE 侧看得见、dsh 侧看不见。
守卫：`agentStudio` 的 `builtinSkillContracts`（内置技能必须全在顶层）。

## 2. frontmatter

| 字段 | 级别 | 说明 |
|---|---|---|
| `name` | 必需 | kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`）；与目录名一致最省事 |
| `description` | **必需** | dsh 用它做路由；**缺了会被直接跳过**（不是"显示为空"，是整个技能不存在） |
| `whenToUse` | 建议 | 一句"什么时候该想到我"；比 description 更口语 |
| `activation` | 建议 | `manual`（默认）/ `auto` / `always`，语义见 §4 |
| `match` | 可选 | `auto` 的关键词表（逗号分隔） |
| `category` | 可选 | 分类；工作台类写 `workbench`（会拿到宿主追加的规范地址） |
| `version` | 可选 | 技能自己的版本（与商城包版本是两回事） |
| `storeId` | 只读 | 商城安装时自动回写，**不要手填**（它把本地技能与商品关联起来） |

## 3. 正文怎么写

- **只写"怎么做"**，不写"这个技能存在"（模型已经看到 name/description 了）。
- 步骤要可执行：说清输入、产出、失败怎么办；不要用"适当处理"这类无法验证的话。
- 支持文件用**相对路径**写在正文里（`references/api.md`），执行时由宿主给出技能目录的绝对路径。
- 不要复述通用纪律（绝对路径、产出物落哪、不要假设 PATH）——那部分由**宿主统一追加**（见 §5）。
- 一个技能只做一件事；"顺便还能…"的能力放另一个技能（路由靠 description，混在一起就都不准）。

## 4. activation 的真实语义（别照字面理解）

| 值 | IDE 侧 legacy 聊天栈 | dsh 侧 |
|---|---|---|
| `manual` | 只有用户显式调用 | 同左（`userInvocable`） |
| `auto` | 关键词命中自动注入 | **可被模型取用**，但不会自动注入 |
| `always` | 每轮注入 | **可被模型取用**，但不会自动注入 |

**原因**：dsh 的技能接口只有"提供候选 + 按需 `get()`"，没有"每轮自动注入"这一层。
所以对 `always`/`auto` 技能，dsh 侧的承接者是 **`skill_context` 工具**：

```
skill_context()            // 取回全部 always 技能正文
skill_context({ include: ['always','auto'] })  // 连 auto 一起
```

用法约定：**接任务时先调一次**，把返回内容当作本回合必须遵守的约束。
⚠ 不要在任何文档/文案里把这条说成"自动注入"——它不是。

## 5. 宿主统一追加的执行纪律

`@vssaros/dsh-skills` 在 `get()` 返回正文时，会在**末尾**追加一段 `## 本机执行约定（宿主追加）`：
脚本路径用绝对路径、产出物写会话工作区、不要假设命令行工具在 PATH、长任务先说明耗时、
有副作用的动作先说明影响范围；`category: workbench` 的技能还会拿到随包规范地址。

⇒ 所以**不要**在自己的 SKILL.md 里重抄这些。写一遍会在每个技能里各写一遍，
真源一改就有 N-1 份是错的。要加新纪律就改宿主那一段（`dsh-plugins/vssaros-skills/lib/core/skills.js`）。

## 6. 脚本

- **用绝对路径调用**（宿主会在 `read_skill` / `skill_search` 的回执里给 `skillDir`）；
  写相对路径必翻车 —— cwd 是会话工作区，不是技能目录。
- 产出物写会话工作区；**不要**写进技能目录（升级/重装会把它们带走）。
- 脚本要可重入：同名输出目录先清或加时间戳，不要假设上次没跑过。
- 依赖要自带或先探测：缺 Python/Node 时如实报"缺什么"，不要静默降级。

## 7. 验收清单

- [ ] `SKILL.md` frontmatter 有 `name` + `description`，name 是 kebab-case
- [ ] 技能目录**直接在技能根下**（不嵌套）
- [ ] 正文里的支持文件路径都存在（相对技能目录）
- [ ] 脚本用绝对路径、产出物落工作区（按 §6 自查）
- [ ] `node dsh-plugins/check-skill-tool-refs.mjs`：正文里引用的工具名都在真实工具清单里
- [ ] `node dsh-plugins/check-agent-tools.mjs`：若某 agent 把该技能写进 `skills[]`，它必须真实可见
- [ ] 内置技能还要过 `builtinSkillContracts`（顶层 / id 唯一 / frontmatter 合法）
- [ ] 若同时维护两份文档（内置技能 + `.codebuddy/skills/` 姊妹篇），**同批改**，不要让两边漂移

## 8. 反例

- ❌ 缺 `description` ⇒ 技能被静默跳过，用户以为"没生效"。
- ❌ 把技能塞进 `容器/` 目录 ⇒ dsh 侧完全看不见。
- ❌ 正文里写"运行 `scripts/foo.py`"（相对路径）⇒ 在会话 cwd 下找不到。
- ❌ 把"绝对路径 / 产出物位置"这类通用纪律抄进每个技能 ⇒ 真源一改就集体过期。
- ❌ 用 `activation: always` 期待"每轮自动生效" ⇒ dsh 侧不成立，要用 `skill_context`。
- ❌ 手写 `storeId` / `version` 冒充商城商品 ⇒ 安装记录与商品对不上。

## 参考

- 技能根与 rank 的实现：`src/vs/sessions/contrib/agentStudio/common/skillRoots.ts`（单一真源）
- dsh 侧 provider：`dsh-plugins/vssaros-skills/lib/core/skills.js`
- 内置技能库：`resources/.agents/skills/`（全部在顶层，数量以目录为准）
