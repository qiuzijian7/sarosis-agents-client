# dsh 无人值守循环（loop）落地方案

> 目标：把 bunnyseek 的「循环任务」能力落到 dsh 侧 —— 让 agent 能 7×24 按单挑活、
> 不重复做、失败了退避重试、跑完发通知。
> 状态：**P1（引擎内核）已落地并通过守卫**；P1.5（工作台 UI）与 P2（业务工具）未开始。
> 代码：`dsh-plugins/vssaros-loop/`；单测：`node dsh-plugins/vssaros-loop/test/run-loop-check.mjs`。

## 1. 结论先行

| 能力 | bunnyseek | 我们（改造前） | 改造后 |
|---|---|---|---|
| 定时触发 | 自研 `every`/`daily` | 官方 schedule（cron/interval/one-shot）+ 投 prompt | 不变（**不重复造**） |
| 按单挑活 | harvest → select → work 回调 | 无 | `loop.json` 的 `harvest.command` + 框架挑单 |
| 去重账本 | `ledger.json`，done 永久 | 无 | ✅ 同语义 |
| 无人值守护栏 | 8 项 + 硬上限 | 无 | ✅ 同语义（两处收紧） |
| 每条独立上下文 | 独立 `Agent` | 无 | ✅ 独立会话（`vssarosRuns`） |
| 干跑（不花 token） | 有 | 无 | ✅ `loop_dry_run` |
| 崩溃恢复 | running → failed | 无 | ✅ 读路径上做，且**不补跑** |

**关键取舍**：触发权留在 loop 自己（30s ticker），**不寄生**官方 schedule。
官方 schedule 只会"往会话投一条 prompt"，拿它当哨兵等于让内部逻辑靠解析自己发出的
prompt 触发 —— 这类耦合在排查时几乎无法证伪。schedule 保留它本来的职责（人看的任务
列表 + 投递历史），两者在 UI 上互链即可。

## 2. 数据契约

数据根沿用兄弟插件的链：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`
（委托给 `@vssaros/dsh-foundation`，`check-host-config` 会拒绝第三份实现）。

```
<dataRoot>/loops/
  <名字>/                 ← 目录名就是 loop 的身份
    loop.json             ← 元数据（下面的示例）
    ledger.json           ← 账本（框架写，不要手改）
    state.json            ← 上一轮时间/结果/连续失败数
```

```json
{
  "title": "TAPD Bug 自动修复",
  "schedule": "every 4h",
  "quietHours": "23:00-07:00",
  "maxItemsPerRound": 1,
  "itemTurnCap": 60,
  "itemTimeout": "45m",
  "retryBackoff": "30m",
  "maxAttempts": 2,
  "roundCostCeiling": 2.0,
  "onAsk": "block",
  "identityFields": ["id"],
  "harvest": { "command": "node bug-report.mjs --open-only --json" },
  "work": {
    "taskHeader": "单号 {id}（优先级 {priority}）",
    "prompt": "按 game-bug-fix 模板处理这张单……",
    "allowedTools": ["file_read", "terminal", "patch"]
  },
  "notify": ["web"]
}
```

`harvest.command` 的 stdout 必须是 **JSON 数组**（或 `{rows:[...]}`）；每个元素是一行"活"，
必须有 `identityFields` 里的字段。这条边界刻意与 bunnyseek 对齐：采集归采集（脚本、不花
token），判断归框架（去重 + 上限），干活归模型。

账本条目：`{status, attempts, sessionId, lastError, firstSeenAt, updatedAt, marker}`；
`status ∈ done | failed | blocked | running`，`done` 永久不再跑。

## 3. 护栏（与 bunnyseek 的差异只有两处，其余照抄）

| 参数 | 默认 | 硬上限 | 说明 |
|---|---|---|---|
| `maxItemsPerRound` | 3（bunnyseek 5） | 20 | 单次模型调用更贵，收紧 |
| `itemTurnCap` | 60 | 500（bunnyseek 2000） | 防止一条 item 烧一整夜 |
| `itemTimeout` | 45m（bunnyseek 2h） | 6h | 墙钟兜底，靠 abort |
| `maxAttempts` / `retryBackoff` | 2 / 30m | 5 / 24h | 指数退避未做，先按固定退避 |
| `consecutiveFailureLimit` | 3 | 10 | **粘性熔断**：只能人工恢复 |
| `roundCostCeiling` | 0（关） | — | 建议生产能力上填一个正数 |
| 最小轮间隔 | 120s | — | 写 `every 1s` 直接报错（不夹紧） |
| `quietHours` | off | — | 本地时间，支持跨午夜 |

越过硬上限一律**报错而不是夹紧**：夹紧会让"我写了 500 轮"静默变成 60 轮。

## 4. 执行语义

1. ticker 每 30s 醒一次，逐个 loop 判断 `now >= nextDueAt`（`every` 从**本轮开始时间**
   起算，不是结束时间 —— 否则一个跑 40 分钟的 item 会把 `every 30m` 变成 70 分钟一轮）。
2. 采集 → 挑单（去重 → 退避 → attempts → 本轮上限），**被跳过的每一条都给出原因**。
3. 每条 item：`vssarosRuns.run({sessionId, cwd, prompt, timeoutMs, approval})` 驱动一条
   **独立会话**；会话 id = `loop:<loop>:<key 的 sha1 前 12 位>`（重跑复用同一条历史）。
4. 完成契约：最后一行必须是 `[item:done]` / `[item:failed:<原因>]` / `[item:blocked:<原因>]`。
   **没签字默认算失败**（`onMissingMarker=failed`）—— 把"没签字"当成功是无人值守里最常见的假绿。
5. 每次状态变化立刻落盘（原子写 tmp→rename）；重启时残留 `running` 归正为 `failed` 并保留
   `attempts`，**错过的轮次不补跑**（补跑会在"睡了一夜"后一次性放出 N 轮）。

## 5. 工具面（5 个，进 `tools-snapshot`）

| 工具 | 用途 |
|---|---|
| `loop_list` | 列表 + 调度 + 账本计数 + 下次到期 + 是否熔断 + 配置错误 |
| `loop_show` | 单个 loop 的护栏 + 账本明细（含每条为什么被跳过） |
| `loop_dry_run` | **干跑**：真采集，列出会做哪些/其余为何排除，不建会话不花 token |
| `loop_run` | 立刻跑一轮（runs 服务不可用时**明确报错**，不假装跑了） |
| `loop_answer` | 把 `blocked` 的条目放回队列（`onAsk=block` 的人机回路） |

## 6. 部署与开关

```yaml
# cordis.patch.yml（仓库已是这样）
- insert:
    - id: vssaros-loop
      name: '@vssaros/dsh-loop'
      config: {}
```

| 配置 | 默认 | 含义 |
|---|---|---|
| `allowCommands` | `false` | **`harvest.command` 会执行本机命令**，属代码执行；pull 别人的 loop 不该自动跑 shell |
| `cwd` | `process.cwd()` | item 会话的工作目录 |
| `allowTools` | `[]` | item 会话允许的工具（后台回合没人审批 ⇒ 默认全拒，对齐 kanban runner） |
| `dataRoot` | 见 §2 | |

`vssarosRuns`（bridge）不在时：ticker 不启动、`loop_run` 报错，但 `loop_list` / `loop_show` /
`loop_dry_run` 照常可用。

## 7. 本期验证记录（2026-10-30）

| 项 | 结果 |
|---|---|
| 纯判据单测 `test/run-loop-check.mjs` | **80/80 通过**（spec 解析 / 账本去重与恢复 / 排期 / 挑单 / 完成契约） |
| 反向突变（删终态判定、去掉 attempts 累加、关掉退避） | **3/3 单测立即变红**，源码逐字还原 |
| `check-plugin-files` | vssaros-loop 4 项全绿（files 8 项无死链、覆盖运行时文件、入口可 import） |
| `check-host-config` | **0 违规**（foundationRef 15 份同形、dataRootOf 12 份委托 + 1 真源） |
| `check-tool-definitions` | 126 个工具定义、**0 问题**（新增 5 个） |
| 真机（Host 加载 + 跑一轮） | **未做** —— 需装到两套 profile 并重启 Host |

## 8. 未落地（按优先级）

1. **P1.5 工作台 UI**（`vssaros/dsh-loop`）：列表/干跑结果/立即运行/暂停/回答阻塞项。
   要做就得登记两份清单（主页卡片 + route 白名单）+ `check-workbench-style` 的
   `desktopWorkbenches.register` —— 本期刻意不做，避免半成品 UI 与官方 schedule 抢概念。
2. **P2 业务工具**：把 bunnyseek 的 `tapd_*` / `p4_*` / `perfdog_case` / `ds_log_download`
   包成 stdio MCP server（它们的 schema 已经是 JSON Schema，转换是机械活），走 `vssaros-mcp` 挂载。
   这也是**另外 8 个技能**能装上的前提（见 §9）。
3. **通知**：`notify` 字段目前只是记录，未接 channels；接的时候不要新造一套消息总线。

## 9. 技能迁移（已完成，2026-10-30）

迁移器 `dsh-plugins/scripts/import-bunnyseek-skills.mjs`（默认 **dry-run**，`--apply` 才写）：

- **落点 = 内置 `resources/.agents/skills/<id>/SKILL.md`**（2026-10-30 用户拍板，覆盖我最初"放用户库"的判断）。
  我最开始的理由是"正文写满特定 UE 项目内容 + 随包会让所有用户的技能索引多十几行"，用户的取舍是
  "团队每个人都要拿到这套 UE 能力" ⇒ 进内置。**代价如实留在下面**（审计数据），不再靠"放用户库"绕开。
- 内置技能必须**全在顶层**（`builtinSkillContracts` 守卫断言"不得有嵌套 SKILL.md"）⇒ 不能用
  `skills/bunnyseek-ue/<name>/` 这种容器目录分组；10 个 id 与现有 156 个无重名。
- 工具名改写走 `dsh-plugins/scripts/skill-tool-map.mjs` 的**唯一映射表**
  （`read_file→file_read`、`bash/pwsh→terminal`、`grep/glob/ls→search_files`、
  `edit_file/multi_edit→patch`、`python_repl→execute_code`、`web_fetch→web_extract`、
  `ask→clarify`、`task→delegate_task`、`run_skill/read_skill→skill_view`、
  `unreal_cpp_build→unreal_build`；`tapd_*/p4_*/perfdog/trace_*/unreal_screenshot` 映射为 `null`）。
- 顺带补 `displayName`（技能页对缺它的技能会逐条提示，装 10 个就刷 10 行）。

实测结果：**18 个技能 / 可装 10 / 跳过 8**（缺 `tapd_bug_view`、`p4_workspace_check`、
`trace_*`、`perfdog_case`、`unreal_screenshot`、`unreal_log`、`unreal_gm_find`）。
这 10 个已进内置（`resources/.agents/skills/`，167 个目录 / 166 个可解析技能）；
曾短暂装进 `~/.vssaros-dev/skills` 的那份已**逐字比对一致后撤出**（用户库剩 19 个）。

### 审计：这 10 份里到底有多少"项目专属"（可迁移性的真实代价）

45 个 md、230 行命中，分类：**项目/引擎代号 195**（`S1Game` `S1Editor` `S1AbilitySystemComponent`
`UGFUnluaHelper` `GameScript` `UGit` `pbr.LOG_*` `RUSH_01_Main` `NordLand`）、内网系统 21（P4/P4V/P4CONFIG）、
本机假设 14（`client=1/2`、`GRGAME_COOKIE`）、绝对路径 10（`D:\GRMain\S1Game`、`D:\GRMain\UE5EA`、`C:\UGit\…`）、
专属地图 9、日志标记 4、真实人名 **0**（真名在 `loops/*/loop.py` 的 `EXCLUDE_OWNERS`）。

- 完全通用 2 份：`reflection`、`ue-material-editor`。
- 轻度绑定 5 份：`ue-blueprint-graph`（桥名）、`ue-gameplay-tags`（桥名 + `GameScript.bunnyseek_bridge`）、
  `ue-blueprint-components`（1 处）、`screenshot`（路径 + `unreal_screenshot`）、
  `ue-gameplay-effect-inspect`（2 行依赖 `tapd_bug_history`/P4）。
- 深度绑定 8 份：`rush-hero`（`S1SkillTalentTagSettings.h` 全路径）、`ue-cpp-python-bridge`（S1Editor 桥 + Live Coding 约束）、
  `ue-python-api-gotchas`（`D:\S1Game` 实例）、`pie-br-autoflow` / `pie-rush-autoflow` / `ue-pie-repro`
  （`GameScript.ueflow` + 地图 + GM）、`pie-visual-evidence`（20.6 万 Actor 实测值）、`trace-perf-analysis`。

⚠ 两个"不在技能里"的硬编码层（以后找 TAPD 字段/真名别翻技能）：`custom_field_7`、`workspace_id`、
`EXCLUDE_OWNERS={郝旻小昕,苏斌,麦嘉铭}`、`EXCLUDE_STATUSES` 都在 `templates/tapd-bug-report/bug_report.py`
与 `loops/tapd-*/loop.py`；`SetPerfTestLocAndRot` / `S1Scalability` 在 `templates/engine-scene-fix-loop.md`
与 `loops/tapd-engine-fix/loop.py`。

⚠ 搬迁时顺手对齐了一处：`rush-hero/SKILL.md` 的 `name: rush-hero-skill-talent` 与目录名不一致，已改成 `rush-hero`。
⚠ 既存遗留（非本次）：`resources/.agents/skills/knowledge-base-expert/` 曾经是**误提交的 gitlink**（已删，见 §10 末）。

## 10. 群聊对齐 loop：共享内核 `@vssaros/dsh-workitem`（2026-10-31）

**用户拍板三项**：① 内核**新建独立插件** `@vssaros/dsh-workitem`（不塞进 foundation）；
② 群聊的“活”用**显式 `#task:<key>` 标签**（不用隐式文本指纹）；③ 通知走**内部 Agents 群**（不走外部 IM）。

**Why 独立插件**：插件之间不能互相 import（profile 无跨包解析路径），复制一份必然分叉 ——
“loop 说做过了、群聊说没做过”没有任何报错，只会变成重复劳动。foundation 是“数据根/写锁/页面壳”
这类基础设施，work item 是业务语义，混进去会让底座变成业务服务。

**已落地（P0）**：

| 文件 | 内容 |
|---|---|
| `lib/core/ledger.js` | 账本状态机（去重 / 退避 / attempts / 崩溃恢复 / `source` 标记） |
| `lib/core/pick.js` | 挑单（**`keyOf` 由调用方注入**）+ 完成契约 `[item:...]` |
| `lib/core/taskTag.js` | `#task:` 解析（key 归一化小写 ⇒ 大小写绕不过去重） |
| `lib/core/budget.js` | 窗口预算（防风暴，默认 20 事件 / 60s / 冷却 60s，对齐 `channelPolicy`） |
| `lib/core/systemMessage.js` | 回环闸门：系统消息**不参与** @ 解析与派发 |
| `lib/index.js` | `createWorkItemService()` + `ctx.provide('vssarosWorkItems')` |
| `lib/workItemRef.js` | 绑定层（消费插件复制，与 `foundationRef` 同形态） |

`vssaros-loop` 的 `core/ledger.js`、`core/plan.js` 已改为**委托**（调用方签名不变），
`lib/index.js` 在 apply 里 `ctx.inject(['vssarosWorkItems'], …)` 绑定。**未绑上不降级**：抛带指引的错 ——
静默回退本地实现正是“两份判定”复活的入口。

**验证**：内核 57/57、loop 80/80；**反向突变 4/4**（改内核 ⇒ workitem 与 loop 单测**一起变红**，
证明委托真生效，不是复制）；`check-plugin-files` / `check-host-config` 全绿。

**群聊接线已落地（P1，2026-10-31）** —— 增量式：**没有 `#task` 的消息 ⇒ 行为与从前逐字一致**。

| 位置 | 改动 |
|---|---|
| `lib/groupTasks.js`（新） | 账本读写（`<数据根>/agent-group-tasks.json`，与 transcript 分开）+ 派发闸门 + 结算 |
| `lib/groups.js` `postGroupMessage` | 派发**之前**过闸门：`dispatch=false` 时往 transcript 写一条系统说明并 return；派发后记 `running` 与 `inflight`（会话 → 正在跑的活） |
| `lib/groups.js` `installGroupTracker` | 回合结束（turn-stopping）按 sessionId 取出活、解析 `[item:...]` 写终态、写一条系统说明 |
| `lib/index.js` | apply 里 `ctx.inject(['vssarosWorkItems'], …)` 绑定内核（在 persona/toolsOnly 分支之前） |

单侧 `test/run-group-tasks-check.mjs` **21/21**，第一条断言就是"无标签 ⇒ 照旧派发"。

**装机登记已落地（A2）**：`common/dshHarness.ts` 加 `DSH_WORKITEM_PLUGIN_NAME` / `DSH_LOOP_PLUGIN_NAME`；
`dshHostSupervisor.ts` 加 `workItemPluginDir` / `loopPluginDir` 两个 opts + 伴生安装清单两行
（**workitem 排在 loop 之前**：loop 用 `ctx.inject` 等它）；`dshHarnessChannel.ts` 解析两个目录。
**`tsgo --project ./src/tsconfig.json --noEmit` 0 错误**。
ℹ 打包无需改：`build/prepack-dsh-runtime.mjs` 的 `discoverRepoPluginDirs` 按包名 `@vssaros/*` **自动发现**，新目录自动进包。

**真机验证已通过（2026-10-31 14:27）** —— 证据不是日志而是落盘事实：

- dev profile 里 `@vssaros/dsh-workitem` **0.1.0**、`@vssaros/dsh-loop` **0.1.0** 都装上了
  ⇒ **伴生路径登记真的生效**（此前 `listBundledPlugins` 认不出它们）。
- Host 里的 loop 引擎对示例 loop 跑了第一轮，`<数据根>/loops/example/state.json` 写着：
  `lastResult:"harvest-failed"`、`lastError:"harvest 未执行：config.allowCommands=false"`、
  `totalRounds:1` ⇒ **spec 解析、ticker、round、state 落盘全通**，且**安全默认值真生效**
  （没开 `allowCommands` 就不执行命令 —— 这正是"pull 别人的 loop 不该自动跑 shell"那道闸）。
- agents 已装副本包含 `lib/groupTasks.js` ⇒ `check-plugin-files` 的"已装副本"断言转绿。

**待办**：
1. **群聊 `#task` 的真机验证**：判据与单测都过了，但要在群里真发一条 `#task:xxx`、
   看它是否只派一次、回复后是否记成 done/failed（这一步只能你在界面上做）。
2. **生产数据根（`~/.vssaros`）未同步**：本次只动了 dev profile。
3. loop 通知进群（`notifyPayload` → 群 transcript）与 `blocked` 在群里问人 —— 判据在内核，接线未做。
4. 既有失败（非本次）：`check-plugin-files` 的 `vssaros-kb` files 覆盖、`check-dsh-plugin-sync` 的 48 项
   （`vssaros-agents` 版本漂移）都要在发版前清掉。

守卫 `dsh-plugins/check-skill-tool-refs.mjs`（已接进 `check:dsh-plugins` 链）：

- 判据窄到零假阳性：只把**出现在工具清单里**的、反引号包裹的标识符算作工具引用
  （清单 = `resources/.agents/tools/*.json` + `tools-snapshot.json` + bunnyseek 旧名表）。
- **不带下划线的旧名单字不判**（`evidence`/`memory`/`task` 与普通英文词无法区分，实测误报过）。
- 扫描面：随包顶层 `<name>/SKILL.md` + 两套数据根的 `<id>/SKILL.md`（dsh 的 provider 只认顶层）。
- 假绿防线：一个技能都没扫到 ⇒ 直接红。
- 反向突变：塞一个引用 `read_file` 的临时技能 ⇒ 立刻红并点名；删掉 ⇒ 恢复绿。

## 9. 风险

1. **`loop.mjs`（脚本回调）未实现**：本期只支持 `harvest.command` 声明式采集。真需要复杂
   挑单逻辑时再加，且必须与 `allowCommands` 同等级显式开启（等于代码执行）。
2. **`approval.allow` 是全局白名单**，不是按 loop 的：给某个 loop 放开写权限，等于对所有
   loop 放开。要按 loop 区分得改 `runs.run` 的参数面（P2 再谈）。
3. **成本上限字段只是记录**，尚未接入实际的限流/停机（`roundCostCeiling`）。
4. **未真机验证**：Host 是否真加载、`ctx.inject(['vssarosRuns'])` 是否真拿到服务，
   都必须装机后看 `~/.vssaros-dev/dsh-run/host-*.log` 才能确认。
