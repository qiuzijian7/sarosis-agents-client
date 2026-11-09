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
| `owner` | 可选 | `bot:<id>`：该技能是某个 Bot 在团队工单里沉淀、经人批准的经验。**归属标记，不是作用域**——别人的技能不会串进别的 agent 的 `<available_skills>`（2026-11-08 起由 provider 隔离）。分工见 §9 |
| `tier` | 可选 | `core` / `extended`（P2 分级，未上线时写了也不会被过滤） |

## 3. 正文怎么写

- **只写"怎么做"**，不写"这个技能存在"（模型已经看到 name/description 了）。
- 步骤要可执行：说清输入、产出、失败怎么办；不要用"适当处理"这类无法验证的话。
- 支持文件用**相对路径**写在正文里（`references/api.md`），执行时由宿主给出技能目录的绝对路径。
- 不要复述通用纪律（绝对路径、产出物落哪、不要假设 PATH）——那部分由**宿主统一追加**（见 §5）。
- 一个技能只做一件事；"顺便还能…"的能力放另一个技能（路由靠 description，混在一起就都不准）。

## 4. activation 的真实语义（2026-11-08 P0 后）

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
- [ ] `node dsh-plugins/check-agent-skills.mjs`：`skills[]` 名字真实、绑定生效、一份清单、always 摘要不超预算
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

## 9. `skills:[]` 与 `owner: bot:<id>` 的分工（2026-11-08 P0）

两者都写在声明式文件里，但**解决的不是同一个问题**，别混用：

| | `skills:[]`（`.agent.md`） | `owner: bot:<id>`（`SKILL.md`） |
|---|---|---|
| 语义 | **作用域**：这个 agent 能看见哪些技能 | **归属**：这条经验是谁沉淀的 |
| 谁读 | `vssaros-skills/lib/core/agentSkills.js` 的 `skillSubsetFor()`，在 provider `list()` 内、`toCandidate()` 之前生效 | `vssaros-agents/lib/stepMemory.js` 的 `ownerOf()`，只在该 bot 的人设段列「## 你的技能」 |
| 未写时 | 全量可见（provider 缺省语义不变） | 无归属，所有 agent 都能看见 |
| 写了之后 | 只保留列出的技能；**别人 `owner` 的技能一律不出现** | 只在归属 bot 的清单里；同时被别的 agent 隔离 |
| 会不会让技能「注册不到」 | 不会，只收窄可见集合 | 不会，技能仍由 `vssaros-skills` 注册给所有会话 |

为什么「## 你的技能」不是第二份技能列表：它在 `systemPrompt.section` 里，内容是**归属说明**（哪些经验是你沉淀的、遇到同类任务去读哪个），不是可调用技能的目录；`<available_skills>` 才是每轮唯一的一份清单。

`activation: always` 的承接：清单里该技能有一行带「常驻·每轮生效」标记的摘要（不是全文），全文由 `skill_context` / `read_skill` 取用。摘要行与目录合并在**同一条 `agent/pre-step` user 消息**里——这是 dsh 的硬约束（`role: 'system'` 必须在打开的 step 内、`role: 'developer'` 会被 \`withoutDeveloperMessages()\` 剔除），见 `vssaros-agents/lib/core/persona.js` 头注释。预算常量与降级说明在 `vssaros-skills/lib/core/skillBudget.js`（IDE 侧退役的 `skillInjectionBudget.ts` 不参与运行，只是算法同形）。

## 10. P2 分级与治理（2026-11-08）

**tier**：随包 174 个技能 frontmatter 都带 `tier: core|extended`。规则：`activation: always|auto` ⇒ core（40 条），
其余 ⇒ extended（134 条）。`<available_skills>` 每轮只列 core（上限 40），extended 折叠成一行提示；
**不是删除**——`skill_search` 的 BM25 语料同时包含用户技能与随包技能，检索命中后照样能取全文。
agent 在 `.agent.md` 的 `skills:[]` 里**显式点名**的技能绕过 tier（绑定优先于分级）。没写 tier 的老技能按 core（零回归）。

**override**：随包技能想覆盖同名用户技能，必须显式写 `override: true`；用户技能不许声明。
裁决真源是 `skillRoots.ts` 的 `SKILL_ROOT_SPECS` 顺序（first-wins），不硬编码 rank 550/600。
纯逻辑在 `vssaros-skills/lib/core/overridePolicy.js`，守卫 `check-skill-bundle.mjs` 钉住契约。

**脚本路径**：官方 `resourceBase` 是技能目录**绝对路径**，进程 cwd 是会话工作区。
正文里写 `python3 scripts/x.py` 照抄必翻车 ⇒ 用 `skill_search` 返回的 `skillDir` 拼绝对路径。
现有 67 处历史写法登记在 `dsh-plugins/scripts/skill-script-refs.baseline.json`，新增一处即判红。

**owner**：沉淀技能的 `owner: bot:<id>` 在 promote 时校验 bot 真实存在
（真源 `<dataRoot>/agents/<id>/.agent.md`），防止技能挂到幽灵 Bot 后既看不见也改不了。

新增守卫：`check-skill-tier.mjs`（分级/可达性/覆盖/基线/owner + 反向突变）。

## 10.x GRBug 修复专家（2026-11-09）

新增第 174 个随包技能 `grbug-fix-expert`（`tier: extended`，不占常驻 40 条 core 预算；
其它 agent 仍可经 `capability_search` / `read_skill` 取用）。**已显式挂到 `saroasis-studio`**
（TAPD 数据专员，原本就挂 `tapd-skill`）：在 `builtinAgents.ts` 的 `skills:` 点名，
并在 `resources/.agents/agents/saroasis-studio/.agent.md` 产物里同步 —— 点名会进
`partitionCatalog` 的 `pinned` 桶，绕过 tier 进该 agent 的常驻目录。改任一侧都要
跑 `node dsh-plugins/scripts/gen-builtin-agent-md.mjs --check`（单源测试逐字段比对）。
它是一个**编排型技能**：把已有的
`tapd-skill` CLI、guarded P4 CLI 与四个随包脚本串成一条 GR/TAPD 缺陷单修复流程：

| 阶段 | 产物 | 说明 |
|---|---|---|
| ① 取单 + 解析「复制源码关键字」 | `keyword.json` | 保留 `--bug=` / `--user=` 关联串，生成 CL 描述 |
| ② 证据下载 | `grbug-evidence/bug-<id>/` | 日志 / 附件 / `.utrace` 落会话工作区，记录 sha256 |
| ③ 根因分析 | 报告字段 `analysis` | Crash 看堆栈签名；性能问题必须有 trace 才下结论 |
| ④ 修复与验证 | 改动文件列表 | 未验证就写「未验证」 |
| ⑤ HTML 报告 | `reports/grbug-<id>.html` | 自包含 UTF-8，含「已知限制」 |
| ⑥ P4 new pending CL | `p4 change -i` + `p4 edit -c` | 描述 = ①的关键字文本；**绝不 submit** |

技能正文明确写出能力边界：仓库里**没有** CrashSight 客户端、minidump/pdb 符号解析、
通用 `.utrace`/`.etl` 分析器，也没有模型级 `tapd_get_bug` / `p4_new_cl` 工具；
这些环节是人工步骤或外部工具，不得伪造。守卫 `check-grbug-expert.mjs` 真跑四个脚本
并做反向突变，防止流程被悄悄改回「只写文档、没有可执行的脚本」。

## 11. 能力库与按 Agent 收窄（2026-11-08，换架构）

**这一节取代 §10 里「`<available_skills>` 由 `ensureSkillCatalog` 收窄」的描述。** 调研 30+ 个
dsh / Claude 系开源项目后确认：官方 `dsh-tool-skill` 才是目录的唯一发布方
（`snapshot() → filter(isModelInvocable) → catalogSourceEntries → renderCatalogMessage`），
而 `dsh-skill` 的 `collectFresh()` 会把 **global 层无条件并进每个 agent 的候选集**。
所以任何「渲染期过滤 / 改写官方消息」都治标不治本，且要处理 `deepFreeze`、digest 自洽、
waterfall 顺序三处硬约束。

**现在的架构**（参考 DS Bot 的 capability library + attach，但修掉它「attach 只做加法、
不裁剪公共目录」的缺陷）：

| 层 | 真源 | 职责 |
|---|---|---|
| L0 能力库 | `vssaros-skills/lib/core/capabilityLibrary.js` | `name → { tier, path, description }`，由随包 tier 索引派生，不复制身份状态 |
| L1 绑定 | `<dataRoot>/agents/<id>/.agent.md` 的 `capabilities: []` / `skills: []` | 能力包名（pack 展开）+ 显式点名；**未声明 ⇒ 只挂 `core` 包（40 条），不是全量** |
| L2 挂载 | `vssaros-skills/lib/core/bundledProvider.js` | 一个 global provider，在 `list(options)` 内按 `options.scope` 给未 attach 的技能标 `modelInvocable:false`；官方 `collect()` 缓存键含 `scopeChainOf(scope)` ⇒ 每个 agent 天然隔离，不需要 `agent/created` |
| L3 发现 | `skill_search` / `read_skill` | 检索能力库全量（含未 attach），命中后按 id 读全文 |

**为什么用 `modelInvocable:false` 而不是删 candidate**：`ctx.skills.get(name)` 走
`collect().entries.get(name)`，删了会让原生 `skill` 工具报 "unknown"、`/name` 手势失效。
标记只影响官方目录的 `filter(isModelInvocable)` ⇒ 目录收窄但 174 个技能全文全部可达
（`readBundledSkillBody` 覆盖率守卫逐条验证）。

**必须停用的行**：`vssaros-skill-bundle/cordis.patch.yml` 里的
`- id: vssaros-skill-bundle-fs`（官方 filesystem provider，host 平面 = global 层）。
它由新 provider 接管，providerName 仍为 `vssaros-bundled`、rank 仍 600 ⇒ 同名裁决语义不变。
preset 基座的 `tool-skill` / `skill-filesystem` 两行**保持启用**（原生 `skill` 工具、
`/name` 手势、目录发布都在那儿，`REQUIRED_BASE_ROW_IDS` 也钉着）。

**一键回退**：给 `vssaros-skills` 插件 config 设 `skillScopeMode: legacy`
⇒ provider 对全部 174 个返回 `modelInvocable:true`，行为回到旧全量目录；
或恢复 patch 里那行（两种回退都无需回滚其它代码）。

**给某个 agent 扩能力**（写进运行时 `<dataRoot>/agents/<id>/.agent.md`，不是仓库产物）：

```yaml
capabilities: [core, office]     # pack 名，展开成技能名；只加不减
skills: [act-on-feedback]        # 显式点名，绕过 tier，永远可见
```

内置包：`core`（40 条）、`all`（174 条）、`office`、`engineering`。
未知包名 / 幽灵技能名会在 Host 日志里报 `[capabilities]` 警告，并由守卫判红。

**验收判据（换掉错误的那个）**：`catalog-fallback` 是**兜底日志**，官方目录正常时本就
不该出现，不能用来验收。用 `scripts/verify-catalog-runtime.mjs` 多帧解压
`session.v4.jsonl.zstd`，断言：最后一个 `<available_skills>` 块 ≤ 40 行、不含未 attach
的 extended 技能名、不同 agent 的目录内容确实不同。离线等价判据在
`dsh-plugins/check-skill-scope.mjs`：真跑 `provider.list({scope})` 并按官方
`toSummary + filter(isModelInvocable)` 语义计算，得到 40 条且 `hasExtended=false`。

## 12. L3 能力工具与 MCP 状态（2026-11-08）

### 能力发现 / 临时挂载

| 工具 | 作用 | 约束 |
|---|---|---|
| `capability_search(query, limit)` | 检索**能力库全量**（含目录未列出的 extended），返回 name / tier / attached / description | 有界 20 条 + `…另有 N 条`；空查询返回全部但仍有界 |
| `capability_attach(name)` | 把某个技能**临时挂到本会话**，让它出现在下一步的 `<available_skills>` | 每会话上限 40；不写 `.agent.md`、不落盘、不跨会话、重启即失效；包名不能挂（要写 `capabilities:`） |
| `read_skill(skill_id)` | 按 id 读完整正文 | 覆盖 174 个随包 + 用户技能，不管有没有 attach |

分工：`skill_search` 是 BM25「找最相关几条」；`capability_search` 是带状态的有界清单。
`capability_attach` 只改内存中的会话 attach 集，随后调 `control.invalidate()` 让官方
registry 重新 `collect()` ⇒ digest 变化 ⇒ 官方 `dsh-tool-skill` 自己重发目录，**我们不改任何消息**。

### MCP 能力状态（双侧同形）

`parseMcpServers()` 的 `skipped[]` 现在带结构化 `state`：

| state | 含义 |
|---|---|
| `needs-approval` | stdio 配置合法，但缺 `approved: true`，等用户批准（**不是配置错误**） |
| `error` | 配置错（占位符未解析、缺 command、sse 不支持…），缺省值 |
| `disabled` | 显式关闭 |
| `ready` | 会被挂载（在 `servers[]` 里） |

`mcpStateView(parsed)` 汇总 `{ rows, counts, pendingApproval }`，插件侧
`vssaros-mcp/lib/core/mcpConfig.js` 与 IDE 侧 `dshMcpConfig.ts` 逐条同形
（`check-capability-tools.mjs` ④ + TS 测试钉住）。连接期的 connecting/ready/error
属于运行时 `dsh-mcp-client`，这里不伪造。

### 工具快照

新增工具会让 `tools-snapshot.json` 漂移。全量 `--write` 在离线环境会卡在别的插件
起 MCP / 恢复飞书入站 ⇒ 用局部生成：

```
node dsh-plugins/tools-snapshot.mjs --only vssaros-skills --write
node dsh-plugins/tools-snapshot.mjs --only vssaros-skills      # 校验
```

同一套 fake ctx / entryOf / descriptionHash，只收窄范围，不绕过校验。
守卫：`check-capability-tools.mjs`（L3 工具 + MCP 状态 + 反向突变）。

## 13. 21 个内置 agent 的能力包配置（2026-11-08）

**唯一真源**：`src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts` 的
`BUILTIN_AGENT_CAPABILITIES` 映射表（20 条；2026-11-09 删除通用主助理后从 21 条减少），由 `getBuiltinAgents()` 循环注入
`capabilities`。改完必须重生成产物：

```
node dsh-plugins/scripts/gen-builtin-agent-md.mjs          # 写 20 份 .agent.md
node dsh-plugins/scripts/gen-builtin-agent-md.mjs --check  # 比 6 字段（含 capabilities）
```

Host 启动时 `dshHostSupervisor._writeBuiltinAgentsDir()` 把
`resources/.agents/agents/` 原样复制到 `${runDir}/agents-builtin/`，
再由 `vssarosAgents.attachmentsOf(preset)` 读给技能侧 ⇒ **改完要重启 Host** 才生效。

### 两套包共用一个字段

`.agent.md` 的 `capabilities:` 同时被两个消费方解释，键集合必须完全相等
（`check-agent-capabilities.mjs` ② 钉住）：

| 消费方 | 表 | 展开成什么 |
|---|---|---|
| `vssaros-agents/lib/core/packs.js` | `PACKS` | 工具 allowlist（`core/fs/web/skills/team` 有工具，领域包为空） |
| `vssaros-skills/lib/core/capabilityLibrary.js` | `CAPABILITY_PACKS` | 可见技能名（`core/all` 按 tier，领域包按 names，工具专属包为空） |

同名不同义：`core` 在工具侧是 5 个基础工具、在技能侧是 40 个常驻技能。
写任一边独有的名字而另一边没登记 ⇒ 报「未知能力包」，所以新增包必须**两边同时加**。

### 包目录

- `core` = 40 个 tier:core 常驻技能；`all` = 全量 174（只给通用主助理 `saros-claw`）。
- 领域包 10 个：`code / git / qa / docs / research / design / knowledge / media / platform / planning`，
  主要覆盖 134 个 extended。包里的技能名必须真实存在（守卫 ③ 逐名校验，防再配出空包）。
- 工具专属 `fs / web / skills / team`：对技能面无贡献。

### 分配原则

每个 agent 至少带 `core`（≥40 条常驻）+ 按职责 1–3 个领域包，典型可见集 49–77 条
（原全量 230 行）。显式 `skills:[]` 绕过 tier 永远可见，不受包影响。

**给某个 agent 调整能力**：改映射表对应一行 → 重生成 → 重启 Host。
临时需要某个未列技能：`capability_search` 查名字 → `capability_attach` 挂到本会话
（重启失效），或 `read_skill` 直接取正文。要全量：把该 agent 的包写成 `['all']`。

守卫：`check-agent-capabilities.mjs`（21 个全覆盖、真源↔产物一致、两表键集合、
幽灵技能名、双侧 unknown、可见集不缩水、declared 语义、反向突变）。

## 14. 通用主助理 saros-claw 已删除（2026-11-09）

内置 agent 从 **21 → 20**，`USER_FACING_BUILTIN_AGENT_IDS` 从 5 → 4，
`resources/.agents/agents/saros-claw/` 与真源对象字面量、能力表条目一并移除。

**画布 Run / 默认选中**：`constants.ts` 的 `SAROS_CLAW_AGENT_ID` 改为
`DEFAULT_WORKFLOW_AGENT_ID = 'workflow-agent'`；`nativeChatEditorPane` 的默认选中
不再做 `claw` 模糊匹配（否则会误命中 `mediaclawer`），改为精确匹配 `workflow-agent` → `agents[0]`。
看板抓取的 sessionId 常量改名为 `DEFAULT_SCRAPE_SESSION_ID`，**字面值保留 `'saros-claw'`**
——那是 Playwright 页面跟踪的分区键，不是 agent id；改值会让存量看板数据失联。

**存量数据兼容：不做**（2026-11-09 用户决策）。曾短暂加过
`vssaros-agents/lib/core/legacyClawAlias.js` 与 `__legacy:*` 隐藏别名 preset，
现已整体删除：不注册别名、不做旧 preset id 归一化、不保留该模块文件。
代价是会话头仍指向 `vssaros-saros-claw` / `vssaros-kb-expert` 的存量会话
resume 会报 `Unknown agent preset` —— 用户明确接受，需要时各自新建会话。
`HIDDEN_AGENT_IDS` 里只留 `saros-claw`（2026-10-19「移除助理」的展示层需求，
与兼容层无关）。

**能力归属**：主助理独占的「游戏拆解 + 读图 + 抽帧 + 建库」不随删除消失——
`kb-game-teardown` 是 `activation: auto` + `tier: core`（任意 agent 都能触发），
工具面由 `knowledge-base-expert` 承接；`builtinSkillContracts.test.ts` 的两条断言已按此改写。

**守卫**：`check-agent-capabilities.mjs` 反向钉住「真源 / 白名单 / 产物目录里都不再有
saros-claw」「没有 agent 拿 all 包」「兼容层已删除且注册层无别名」「画布 Run 已改指」。

## 15. 运行时依赖树完整性（2026-11-09 事故归档）

**症状**：IDE 发消息报 `client api: session/prompt failed: Failed to fetch (gateway/internal)`，
网页服务 `ECONNREFUSED`；Host 日志里 4 个模块 `failed to import: Cannot find module './accept'`。

**根因**：`compression@1.8.2` 的嵌套 `negotiator` 缺 `lib/accept.js`（顶层 `negotiator` 有）。
`charset.js` 的 `require('./accept')` 抛错 ⇒ `compression` 加载失败 ⇒ `webserver` /
`web-startup` / `web-runtime` / `directory-picker` 起不来 ⇒ 9282 不监听 ⇒ 客户端 fetch 失败。
**重启 Host 修不好**（文件不在盘上），HMR 也不监听 `node_modules`，必须补文件。

**一条命令修复**：

```
npm run repair:runtime-deps                                  # 检查并自动补齐全部依赖树
node dsh-plugins/scripts/runtime-deps.mjs --check --json     # 只检查，缺件 exit 1
```

脚本扫描 `~/.vssaros-dev`（及 `~/.vssaros`）下所有 profile 与 dsh-runtime 版本的
`node_modules`，按 `scripts/runtime-deps.mjs` 的 `DEP_RULES` 检查；缺件时从**同树顶层**
同名文件复制并校验 MD5，避免跨版本混装。补齐后**仍需重启 Host**（进程缓存了失败的模块状态）。
本机没有开发环境时脚本优雅跳过，不误报。

**守卫**：`check-runtime-deps.mjs` 已接入 `check:dsh-plugins` 根链，用临时目录反向验证
「缺件判红 / 自动补齐 / hash 不一致 / 顶层也缺」四种情形，并核查真实环境依赖树。
规则与修复共用一份真源（脚本导出的 `DEP_RULES` / `checkTree` / `repairTree`），不各写一份。

## 16. 真机技能目录验收的正确口径（2026-11-09）

「换架构是否生效」的唯一可信判据是 `npm run verify:skill-catalog`，
**不是** `catalog-fallback` 日志（那是兜底日志，官方目录正常时本就不出现）。

验收脚本读会话的多帧 zstd，只认 `data.source.kind === 'skill-catalog'`
且 `<available_skills>…</available_skills>` **成对闭合**的事件。原因：
`request/header` 事件的工具描述里也会出现这个标签字符串（例如 `capability_attach`
的说明），旧实现按行找标签会把它当成最后一份目录，误报「技能全丢」。

三条判据（只作用于本轮 `vssaros-*` 会话）：

| 判据 | 口径 |
|---|---|
| 随包技能条数 ≤ 40 | **只算随包 core + extended**；用户技能来自其它根，单独计为 `other` 且不计入预算 |
| 常驻目录不含 extended | `tier: extended` 的 134 个不该进常驻目录（未 attach） |
| 40 个 core 全覆盖 | 正向证据：provider 被 skip ⇒ 目录只剩用户技能甚至 0 行，这里判红 |

**两类会话不套用收窄判据**（否则误报）：

- 历史 durable 目录：官方 `catalogHistory` 按 digest 判重，重启后不重发旧目录。
  脚本按 **catalog 事件时间**（不是文件 mtime，心跳也会更新 mtime）划分 current / legacy，
  默认只验收最新事件前后 15 分钟；`--since` / `--recent N` / `--all-history` 可调整。
- 非 `vssaros-*` preset：`dsh-superagent-router` 等按设计**不收窄**
  （`attachmentsForAgent` 对非 vssaros agent 返回 `names: null`），232 行全量是预期。
  preset 从会话全部事件里的 `agentPreset` 字段读（catalog 事件本身不带）。

真机实测（2026-11-09 09:55 重启后）：
`vssaros-standard` 新会话 `rows=80 = 40 core + 40 用户技能`、`extended=0`、
`core=40/40` ⇒ `✓ 真机目录验收通过`；同窗口的 `dsh-superagent-router` 为 232 行全量，
单独归类报告。两者目录**确实不同**，正是按 scope 收窄生效的证据。

`node dsh-plugins/scripts/verify-catalog-runtime.mjs --self-test` 用合成事件验证解析口径
（真 catalog / 工具描述假标签 / 未闭合块 / 混合事件），已由 `check-catalog-verifier.mjs`
接入根链并做反向突变（去掉 kind 过滤 / 闭合校验 / 预算口径 / preset 区分 / core 判据）。
