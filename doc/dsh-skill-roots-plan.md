# dsh 技能发现根：纳回官方目录的方案稿（2026-10-13）

> 状态：**P0 与 P1 均已实施**（2026-10-13）。低风险的"执行侧绝对路径纪律"已于同日落地（`@vssaros/dsh-skills` 0.3.9）；
> P0 = 决策三的顺序/告警 ✓；P1 = 项目级根 + Workspace Trust 门控 + 根清单收成**单一真源** ✓（见 §7）。
> **唯一仍未定**：`~/.dsh/skills`（官方用户级 rank 400）要不要支持 —— 等用户拍板（其余部分不受它影响 ✓）。
> 相关代码：`src/vs/sessions/contrib/dshHarness/common/dshSkillDirs.ts`（覆盖层渲染）、
> `electron-browser/dshHarnessService.ts` 的 `_skillDirs()`、`agentStudio/browser/skillRegistryService.ts`（IDE 侧注册表）、
> `agentStudio/common/skillEcosystemDirs.ts`（当前刻意置空的生态目录清单）。

## 1. 背景：现状与官方口径的差距

**官方（一手：`@deepseek-ai/dsh-skill-filesystem/lib/index.js` 的常量 + 官方文档，本地源码与文档口径逐条一致 ✓）**：

| rank | 目录 | 归属 | 我们当前 |
|---|---|---|---|
| 100 | `<项目根>/.dsh/skills` | 项目级（最高） | ✗ 不生效 |
| 200 | `<项目根>/.agents/skills` | 项目级（通用） | ✗ 不生效 |
| 300 | `customSkillDirs` | 部署方注入 | ✓ 我们只注入了 2 个根 |
| 400 | `<DSH_HOME>/skills`（≈`~/.dsh/skills`） | 用户级 | ✗ 不生效 |
| 500 | `~/.agents/skills` | 用户级（跨 agent） | ✗ 不生效 |
| 600 | bundled | 随包 | —（由 dsh 自管） |

**我们现状**：`renderSkillsOverlay` 只发一行 `customSkillDirs`（`includeDefaultRoots: false`），内容是
`[内置 resources/.agents/skills, <数据根>/skills]`（`dshSkillDirs.ts` / `dshHarnessService._skillDirs()`）。

**由此产生的三类实际问题**：
1. 用户照**官方文档**把技能放进 `.dsh/skills` ⇒ 我们这儿**看不见**；用 `dsh-movein` 从 Claude Code 迁进来的技能（默认落到官方目录）同样**看不见** ✗。
2. 内置与用户级被塞进**同一个 `customSkillDirs`** ⇒ 两者**同 rank 300**，且内置在前 ⇒ **内置压用户**（用户改了同名技能不生效，且无任何提示 ✗）。
3. 引擎一致性：IDE 侧注册表与 dsh 侧覆盖层各自拼目录 ⇒ 一旦两边不同源，就是"IDE 看得见、聊天框看不见"这类最难查的不一致 ✗（`skillEcosystemDirs.ts` 已经把这条写在头上 ✓）。

**官方合并语义（决定我们还要不要自己做去重）**：
> "A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate name outright,
> and the rank order decides duplicates only within one layer."（`@deepseek-ai/dsh-skill/lib/index.js`）

⇒ dsh 侧同名技能是 **rank 静默裁决**（不翻倍、不告警 ✓）；我们已知的"31 行无信息量告警"是 **IDE 侧自己**打的
（`skillRegistryService._setSkillWithPriority`），**不是 dsh 的行为** ⇒ 降噪必须做在 IDE 侧 ✓。

## 2. 不变量（改之前先钉住，四条都要守）

1. **两引擎同源**：IDE 注册表与 dsh 覆盖层读**同一份**根清单（含顺序与来源标记），守卫测试兜住 ✓。
2. **不把仓库内容送进上下文**：工作区级目录 = 提示词注入面 ⇒ **未通过 Workspace Trust 之前一律不注入** ✓。
3. **不刷无信息量日志**：同名同内容静默裁决；仅在"同名不同内容"这种**需要人判断**的情形留一行告警 ✓。
4. **可一键回滚**：一个设置项关掉新增的根（回到今天的行为）✓。

## 3. 三个待拍板点

### 决策一：项目级根（100 / 200）要不要进？

| 选项 | 做法 | 代价 / 风险 |
|---|---|---|
| A. 全开 | `includeDefaultRoots: true` | 官方六级全生效 ✓，但**项目级根随会话 cwd 自动生效** ⇒ 未信任仓库的 `.dsh/skills` 直接进模型上下文 ✗✗（`skillEcosystemDirs.ts` 明确警告的注入面） |
| B. 暂不开（**推荐，P1 再议**） | 保持 `false`，只纳回用户级 | 缺"项目内自带技能"这一档 ✗；但零注入面风险 ✓。后续要和 trust 门控一起做（见 P1） |
| C. 显式模拟项目级 | 把 `<工作区>/.dsh/skills` 加进 `customSkillDirs`，**仅在 trusted 时加** | 可控 ✓；但它落在 rank 300（不是 100），且 dsh 官方那两档仍不生效 ⇒ **两套项目级语义并存**，容易误解 ✗ |

> 推荐 **B**：先把"用户级三根 + 优先级纠正"做扎实，项目级与 trust 一起进 P1（那时要么用 A + trust 前置检查，要么明确写"我们不支持项目级技能"）。

**→ P1 已定（2026-10-13 用户点头"继续"）：取 C（可门控），并说明为什么放弃 A**：

| 结论 | 理由 |
|---|---|
| **取 C**：把 `<工作区>/.dsh/skills`、`<工作区>/.agents/skills` 显式并入 `customSkillDirs`，**只在 `isWorkspaceTrusted()` 时加** | 只有这条路能守住不变量 2 ✓ |
| **弃 A**（`includeDefaultRoots: true`） | 那会让 dsh **自己按会话 cwd** 扫项目目录 ⇒ **我们无法门控 trust** ✗✗（未信任仓库的 `.dsh/skills` 直接进上下文） |
| 已知语义差（照实记） | 官方项目级 rank = **100/200**，我们只能落 **rank 300** ⇒ 配置层显示的 rank 与官方不完全一致；实际影响：项目级**仍可发现**，且在我们这一行内**优先级最高** ✓。两套项目级语义并存这件事写在这里，避免后来人误判 ✗ |
| IDE 侧 rank 表 | 新增 `project` 档且**高于** user（原值整体上移一位，只比相对大小）⇒ 否则项目级 rank=0 会被内置静默压掉 ✗ |

### 决策二：用户级生态根要不要纳回（`~/.dsh/skills`、`~/.agents/skills`）？—— **已定（2026-10-13 用户拍板）**

**决定：不纳回。用户级根只有 `~/.vssaros(-dev)/skills`（本产品自己的数据根）✓。**

拍板依据（同日实测 `~/.agents`）：

| 证据 | 读数 |
|---|---|
| `~/.agents/.skill-lock.json`（v3，15KB）= 该目录的**来源账本** | 条目形如 `{"source":"m1heng/clawdbot-feishu","sourceType":"github","sourceUrl":"https://github.com/…","installedAt":"2026-03-30T07:27:36Z"}`、`{"source":"open.feishu.cn","sourceType":"well-known","wellKnownDigest":"sha256:62d1cae7…"}` |
| 目录性质 | `~/.agents` 创建于 **2026-03-30**、**非联接**；条目是真目录（`agent-reach` / `web-access` 的 `LinkType` 为空）；每个技能目录里**只有 `SKILL.md`**（脚本/资源不在本机该目录）|
| 与别家目录的关系 | `~/.agents/skills` **31** 条、`~/.claude/skills` **35** 条，两者中 `agent-reach/SKILL.md` 哈希**逐字节相同**（`A4C003DE…`）；而 `~/.vssaros-dev/skills`（17 条）里**没有**它 ⇒ 生态目录 = **别的工具链**装进来的共享区 ✗ |

⇒ 结论：`~/.agents/skills` 是 **`agentskills.io` 约定的跨 agent 共享目录**，由**其它工具/产品**安装与维护（来源混杂：个人 GitHub 仓库、飞书官方 well-known 分发），**不是我们的数据面** ✗ ⇒
① 依赖它 = 把"用户技能可见性"绑在别人产品的安装行为上 ✗；② 同名同内容 31 份要靠去重兜住 ✗（收益小、噪音大）。**用 `~/.vssaros(-dev)/skills` 即可** ✓ —— 这也是 `skillEcosystemDirs.ts` 2026-10-12 停扫决定的强化 ✓。

**顺带记一条可复用的先例（不属于本决策）**：`.skill-lock.json` 里飞书那条展示了 **well-known 分发 + `sha256` digest** 的形态
（`https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/<id>.tar.gz`）✓ —— 我们的技能 hub（`BUILTIN_SKILL_HUBS` 现为 github/git/url/local）可增加 `well-known` 类型 + 内容 digest 校验 ✗（当前只有 8 位 `stringHash`），列入 P2 ✓。

**→ 已定（2026-10-13 用户拍板"支持"）：纳回官方用户级根** ✓（见 §7 的 P1.1）：

| 要点 | 结论 |
|---|---|
| 目录 | `<DSH_HOME>/skills`（官方 rank 400）。**在我们产品里它是哪个目录取决于运行形态** ✗ ⇒ 按 `effectiveDshHome` 的口径给**三个候选**：① 用户配的 `sessions.dshHarness.dshHome` ② dev 默认 `<数据根>/dsh-home`（`dshHarnessChannel` 的 `defaultDshHome`）③ 打包版回落 `~/.dsh`（= 官方文档那个位置 ✓）。三者可能重合 ⇒ 按路径去重 ✓；不存在的由各侧过滤 ✓ |
| 信任门控 | **不需要** ✗ —— 它在**用户主目录**下，信任级别与我们自己的 `~/.vssaros/skills` 完全相同 ✓；"要 trust"只适用于**工作区**目录（注入面 ✓） |
| 开关 | 与项目级**独立**：`agentStudio.skills.officialUserRoot`（默认 `true`）⇒ 关掉回滚到"自营用户库 + 内置" ✓ |
| 与生态目录的区别（决策二仍成立） | `~/.agents/skills` 等**仍不纳入** ✗：那是**别的工具链**安装维护的共享区（来源混杂、31 份同名）✗；而 `~/.dsh/skills` 是**官方文档的标准位置** ✓ —— 这正是当初把它单列"待定"的原因 ✓ |

### 决策三：怎么修"内置压用户"的优先级错位？

问题：内置（应最低）与用户（应更高）挤在同一个 `customSkillDirs`（rank 300）里，且内置在数组前面 ✗。

| 选项 | 做法 | 评价 |
|---|---|---|
| A. 只调数组顺序 | 用户根放前、内置放后 | 一行改动 ✓；但语义仍是"同权、靠顺序" ✗，且会让**内置被用户覆盖**（多数场景合理 ✓，但内置是随产品发布的"官方流程"，被静默顶掉需要留痕 ✗） |
| B. 内置走 bundled 语义 | 让内置技能由"随包分发的 provider"提供（rank 600 ✓ 与官方一致） | 语义最正 ✓；但要确认覆盖层能否给我们这行指定 rank（当前只发 `customSkillDirs` ✗）⇒ 需要查 provider 配置面或改造 |
| C. 顺其自然 | 保持现状（内置优先） | 零改动；但"用户改了同名内置技能不生效"且**无提示** ✗ = 静默失效 |
| **推荐** | **A + 一条告警**：数组顺序改为「用户级 → 内置」，并在**同名不同内容**时留一行告警（指明"内置技能 X 被用户技能覆盖" ✓） | 成本最低、风险可控，且不再静默 ✓；B 作为 P2 的语义收敛 |

**→ 已实施（2026-10-13 用户点头"执行"）**：
- dsh 侧顺序：`dshHarnessService._skillDirs()` 改为**先用户级、后内置** ✓（含"同 rank ⇒ 顺序即优先级"的依据注释 ✓）。
- IDE 侧降噪：`skillRegistryService._setSkillWithPriority()` 同级来源**先比 `computeSkillContentHash(prompt)`** ⇒ 一致静默 ✓、不同才 **一行** WARN（消息里写明"内容不同"+ 两侧路径 ✓）。
- 守卫：dsh 侧顺序守卫（index 比较，可反向突变 ✓）在 `dshHarness/test/common/dshSkillDirs.test.ts` ✓；
  IDE 侧告警纪律守卫（"先比内容 ⇒ 先 return ⇒ 才 warn"的顺序断言 + 旧文案不得复活 ✓）在新文件
  `agentStudio/test/browser/skillRegistryDuplicateNoise.test.ts` ✓（并注明：若要把判定抽成 `common/` 纯函数以增强守卫，是后续项 ✓）。
- 未动：`~/.dsh/skills`（仍待定 ✓）；生态共享目录**仍然不纳入** ✓（既有守卫 `skillEcosystemDirs.test.ts` 已覆盖"必须为空"✓）。

## 4. 目标形态（若按推荐执行）

**根清单（单一真源，扩展 `skillEcosystemDirs.ts` 为"技能根总表"）—— 按决策二的拍板收口**：

```ts
// 顺序即优先级（同 rank 内 first-wins）；trust 列决定是否受工作区信任约束
{ rel: '<数据根>/skills',            scope: 'user',     trust: false }   // 用户级：**唯一**（决策二）
{ rel: 'resources/.agents/skills',   scope: 'builtin',  trust: false }   // 内置（顺序待决策三）
// 生态共享目录（~/.agents/skills、~/.claude/skills、~/.copilot/skills）**明确不纳入** ✗（决策二）
// 官方用户目录 ~/.dsh/skills 待单独拍板（不影响本清单的其余部分 ✓）
```
- 覆盖层仍是**一行** `customSkillDirs`（`includeDefaultRoots: false` ✓ 项目级本轮不开）
- 存在性过滤在两侧各做一次（缺失是正常情况，不报错 ✓）
- 去重：路径去重（`~/.dsh/skills` 与 `<数据根>/skills` 在用户把两者配成同一个目录时会出现重复 ✓）+ 同名同内容静默 ✓

**IDE 侧注册表的降噪规则**（改造 `_setSkillWithPriority` 的调用点）：
1. 同名 **且内容哈希相同**（`SKILL.md` 逐字节）⇒ 取优先级高者，**不打日志** ✓；
2. 同名 **内容不同** ⇒ 取优先级高者，**一行 WARN**：`技能 X 有两份不同实现，已用 <高优先路径>（忽略 <低优先路径>）` ✓；
3. 同一轮 reload 内相同告警**只打一次**（按 id+两边路径去重）✓；
4. 集合指纹未变时整轮不重打（沿用现有 `fingerprintOf` 思路 ✓）。

## 5. 开关与回滚

- 新增设置项（建议名）：`sessions.dshHarness.skillRoots`（枚举：`'vssaros' | 'official-user' | 'all'`，默认 `'official-user'`）
  —— `'vssaros'` = 回到今天的行为（只 2 根）✓；改后**下次 Host 启动生效**（覆盖层随启动重建 ✓，与 `skillDirs` 的既有语义一致 ✓）。
- 回滚验证：切到 `'vssaros'` ⇒ 日志里 `skills overlay: 2 dir(s)` ✓，生态技能从两侧同时消失（与今天的已知代价一致 ✓）。

## 6. 验证计划

| 层 | 判据 |
|---|---|
| 单测 | 根清单渲染（顺序/去重/存在性过滤）✓；同名同内容**不产生**日志、同名不同内容**产生一行** ✓（现成范式：`skillEcosystemDirs.test.ts` 的守卫形态） |
| 探针 | 真机 `--patch ... --dump-config` 确认覆盖层行只有一行且 `customSkillDirs` 四项有序 ✓（历史上行 id 撞名是静默事故 ✗：`dshSkillDirs.ts:29-33`） |
| 真机 | ① 把技能放进 `~/.dsh/skills/x` ⇒ **IDE 与 dsh 两侧都能检索到** ✓；② 同名技能各放一份（内容不同）⇒ 出一行 WARN 且取用户那份 ✓；③ 关开关 ⇒ 回到 2 根 ✓ |

## 7. 分期

- **P0 —— 已完成（2026-10-13）**：决策三的顺序/告警已落地 ✓（见 §3）；"生态共享目录不纳入"由既有守卫
  `skillEcosystemDirs.test.ts`（要求清单为空 ✓）持续防回归 ✓。原计划的"纳回生态根 + 31 份同名降噪"**取消** ✓（决策二）。
  - 仍未做：把根清单收成**单一真源模块**（当前两处各自拼"内置 + 用户"，只有顺序与来源语义靠注释+守卫对齐 ✓）
    —— 属于 P1 的顺手项；`~/.dsh/skills` 的取舍仍待拍板 ✓。
- **P1 —— 已完成（2026-10-13）**：项目级根 + Workspace Trust 门控 + 单一真源 + 一键回滚开关。
  - **单一真源**：新 `src/vs/sessions/contrib/agentStudio/common/skillRoots.ts`（纯函数、不碰文件系统）——
    根清单（顺序 = 优先级：项目级 `.dsh/skills` → 项目级 `.agents/skills` → 用户级 → 内置 → 生态）、scope、
    trust 门控、路径去重（Windows 大小写不敏感）全在这一处 ✓；两侧只算**基址**（IDE 侧内置三条候选 / dsh 侧一条）。
  - **dsh 侧** `dshHarnessService._skillDirs()`：注入 `IWorkspaceTrustManagementService`，读开关 + trust 后交给真源；
    信任变化 ⇒ 只在技能根集合**真的变了**时 `restart()`（`_lastSkillDirs` 比对；**取消信任方向也必须重启** ✗ 否则
    那个 Host 一直带着未信任仓库的技能跑）。日志：`skills roots: N 个（project > user > builtin）`。
  - **IDE 侧** `skillRegistryService._doReload()`：内置候选只算不扫，全部根交由真源派发（`_scanRootIfPresent`
    统一"存在就扫、不存在只打 debug"）；注入 trust + 通知；`onDidChangeTrust` ⇒ `reload()`；
    **未信任且项目目录确实存在**时给用户**一次**通知（`_untrustedSkillsNotified` 去重 ✓）。
  - **开关**：`agentStudio.skills.projectRoots`（默认 `true`，声明在 `agentStudio.contribution.ts`）⇒ 关掉即回滚到
    "只有用户级 + 内置"，且不再产生未信任提示 ✓。
  - **守卫**：新 `agentStudio/test/common/skillRoots.test.ts`（13 例：顺序 / 门控 / 回滚 / 多根 / 去重 / 分隔符 +
    两侧真接线 / trust 真读 / 开关真读 / rank 高于 user / 声明与常量同键）✓；
    ⚠ `dshHarness/test/common/dshSkillDirs.test.ts` 的"顺序"守卫**改盯真源**（老写法是对 dshHarnessService 做
    `indexOf` 两个字面量，重构后返回 -1 会**静默失效** ✗ —— 已顺手改成读清单 + 钉"dsh 侧真的调 resolveSkillRoots"）。
  - ~~仍未定：`~/.dsh/skills`~~ ⇒ 已于同日拍板"支持"并入 P1.1（见下）✓。

- **P1.1 —— 已完成（2026-10-13，用户拍板"支持"）**：官方用户级根（`<DSH_HOME>/skills`，官方 rank 400）。
  - 真源里新增一条：`{ base: 'officialUser', rel: '', scope: 'user', requiresTrust: false, gatedBy: 'officialUserRoot' }`，
    摆在**自营用户库之后、内置之前**（官方 rank 400 在 bundled 600 之前 ✓，只是绝对 rank 被这一行拉到 300 ✓）。
  - **路径公式也收进真源**：`officialUserSkillRootCandidates({ dshHome, dataRoot, userHome })` ⇒ 三个候选与去重只有一份实现 ✓
    （两侧都调它 ✓，守卫钉住"两侧都调用" ✓）。
  - 门控机制泛化：`ISkillRootSpec.gatedBy: 'projectRoots' | 'officialUserRoot'` ⇒ 每族根各挂一个开关，
    **关掉 = 该族不纳入且不产生"未信任"提示** ✓（用户主动关的，不是被挡的 ✓）。
  - 开关：`agentStudio.skills.officialUserRoot`（默认 `true`，声明在 `agentStudio.contribution.ts`）；
    ⚠ 这与 §5 早先设想的**枚举** `sessions.dshHarness.skillRoots: 'vssaros' | 'official-user' | 'all'` **不同** ✓：
    改成"每族一个布尔"是因为项目级根与官方用户级的**门控理由完全不同**（注入面 vs 无风险 ✗），
    塞进一个枚举会让"关项目级"和"关官方用户级"变成同一个动作 ✗。
  - 真机核对（`poc/dsh-p0/.out/probe-skill-roots.mjs` ✓，跑的是编译产物）：四种情形（全开 / 未信任 / 关官方用户级 / 关项目级）
    的根清单与覆盖层都对 ✓；路径公式三个候选 + `dshHome=~/.dsh` 去重成一个 ✓。
  - 守卫：`skillRoots.test.ts` 扩到 **19 例**（新增：顺序含官方用户级、未信任时它**仍在**、两个开关互不影响、
    候选公式三例、`DshHome` 设置键两侧同值、两个设置键的声明与默认值 ✓）。
- **P2 —— 部分完成（2026-10-13）**：

  **P2.1 内置 → 官方 `bundled`（rank 600）：已做 ✓**
  - 依据（依赖源码）：`@deepseek-ai/dsh-skill-filesystem/lib/index.js` 的配置里有 `bundledSkillDir: z.string()`
    ⇒ 推入 `{ source: 'bundled', rank: BUNDLED_SKILL_RANK(600), trustedHost: true }`；而 `customSkillDirs` 的
    `CUSTOM_RANK = 300` 是**常量**、配置里没有 rank/priority/layer 字段 ⇒ 想对齐只能换字段 ✗。
  - 改动：内置从 `customSkillDirs` **摘出来**，单列 `bundledSkillDir` —— 链路是
    `dshHarnessService._skillDirs()`（按 scope 切两块：`dirs` + `bundledDir`）→ `IDshHostStartOptions.bundledSkillDir`
    → 主进程 `existsSync` 过滤 → `IDshHostConfig.bundledSkillDir` → `renderSkillsOverlay(dirs, bundledDir)`。
    同一轮补上：`sameStartOptions` 参与比较（否则 dev↔打包切换时不重启 ⇒ 扫的还是旧内置目录 ✗）、
    中立配置的 `serialize`/`parse` 两个名单（漏了就被**静默丢掉** ✗ —— `dshHostConfig.test.ts` 的往返守卫当场抓到 ✓）。
  - 效果：内置从"与用户根同档 300、只靠数组顺序分先后"变成**严格低于**用户/项目根（官方语义 ✓）；
    真机探针 `poc/dsh-p0/.out/probe-skill-roots.mjs` 复核：5 条 `customSkillDirs` + 1 条 `bundledSkillDir` ✓、单 insert 块 ✓。
  - 守卫：`dshSkillDirs.test.ts` 新增"内置不许再出现在 customSkillDirs 里"+"只有内置时也挂覆盖层"+接线守卫 ✓；
    `dshHarnessOptions.test.ts` 新增 `bundledSkillDir` 参与比较 ✓。

  **P2.2 重复来源的收口：查清了，但**刻意不收口**（并补了守卫 ✓）**
  - 事实更正：重叠**不在内置目录**上 ✗ —— `@vssaros/dsh-skills` 只扫 `<数据根>/skills`（`VSAROS_SKILL_RANK = 600`），
    而我们的覆盖层行**也**含 `<数据根>/skills`（rank 300）⇒ 同一目录被两个 provider 扫。dsh 同层 first-wins ⇒
    我们那行胜出，插件候选被丢并各打一条 `ignored because a higher-priority skill already exists`（**catalog 无重复、无报错** ✓）。
  - 为什么不收口成一个：① 插件的 provider 是**独立 dsh 部署**（没有 VsSaros 覆盖层）时用户技能的唯一来源 ✗；
    ② 它带"指纹变了就 invalidate"的实时刷新，而覆盖层那条路径没有等价能力 ⇒ 先收口会让"启动后才建技能目录"看不见 ✗
    （`poc/dsh-p0/README.md` §5.87 早已记为**有意重叠**，前提是先把 watcher 补齐 ✓）。
  - 本轮做了守卫（`dshSkillDirs.test.ts` 的"有意重叠"用例）：钉住**两侧目录同源** + 插件 rank 600 + 我们那行仍含
    `<数据根>/skills` ⇒ 任何一边换目录或让 rank 反转，测试就红（否则重叠方向静默反转、用户库以副本为准 ✗）。

  **P2.3 技能 hub 的 `well-known` 源 + 内容 digest：仍未做** ✗（先例见 §3 决策二那张表：飞书的
  `https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/<id>.tar.gz` + `sha256` digest；
  我们现在的 `skills/.hub/lock.json` 只有 8 位 `stringHash` ✗）。

## 8. 风险清单

1. **上下文膨胀**：随决策二**基本消失** ✓（生态共享目录不纳入 ⇒ 每会话注入的技能数不变 ✓）。仅在 P1 打开项目级根时才需要重新评估（那时才谈按 `whenToUse/activation` 过滤 ✓）。
2. **同名覆盖**：生态技能顶掉内置（顺序改动后）⇒ 必须留痕（决策三的告警 ✓），否则就是"官方流程被第三方静默替换" ✗✗。
3. **信任边界**：本轮不开项目级根 ⇒ 注入面不变 ✓；P1 若开，必须先有 trust 门控与"用户可见的解释" ✓。
4. **两引擎漂移**：任何一边单独加目录都会造成"一边看得见" ✗ ⇒ 由单一真源 + 守卫测试兜住 ✓。
