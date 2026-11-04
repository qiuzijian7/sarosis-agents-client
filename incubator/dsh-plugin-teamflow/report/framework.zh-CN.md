# TeamFlow 复刻与 VsSaros 兼容框架说明

> 上游：`G:\CustomWorkspaces\AIProjects\dsh-plugin-teamflow` · commit `89aec4b094d0450b37c54d65f5dea469e0c01f02` · v0.3.3 · MIT · 干净工作树
> 落点：`g:\SarosWorkspace\sarosis-agents-client\incubator\dsh-plugin-teamflow\`
> 宿主：bundled runtime `0.2.1-rc.2`（`dsh-plugins/dsh-compat.json`）；dev Host 实测 `0.2.1-alpha.3`
> 工作台规范版本：`0.3.26/566e1673`（`x-workbench-guide-version`）
> 状态：2026-11-04，P0–P3 已完成，外部包工作台 `dsh-teamflow-workbench@0.2.4` 已装 dev profile 并通过真机验收
> 配套：[使用报告 HTML](./usage-report.html)

---

## 1. 为什么不直接搬进 `dsh-plugins/`

`scripts/prepack-dsh-runtime.mjs` 会把 `dsh-plugins/` 下每个带 `package.json` 的目录当作**随包插件**打进用户 profile 种子，属于不可逆动作。直接放进去会同时撞上四条硬约束：

| 上游形态 | 本仓要求 |
|---|---|
| `name: dsh-plugin-teamflow` | 随包必须 `@vssaros/*` |
| `dsh.bundle.patch` 是字符串 | 必须是数组 |
| `files: ["lib"]` | 必须逐文件枚举 |
| `engines.dsh: ">=0.2.1-rc.5 <0.3.0"` | bundled 固定 `0.2.1-rc.2`，`rc.4` 实测启动即崩；装载期会被兼容性闸门直接 skip |

因此采取**不升运行时、换宿主胶水**的路线：源码镜像进 `incubator/`，纯逻辑机械 JS 化，宿主侧按本仓 seam 重写，先以**外部包工作台**形态装机验证。`incubator/dsh-superagent/` 是同款先例。

镜像时排除 `.git` / `node_modules` / `lib`（构建产物），共 **240 文件 / 7.02 MB**，关键文件 SHA256 前后一致；唯一本仓改动是 `.eslint-ignore` 增加一行 `**/incubator/**`，让上游 TS/TSX 不进全量 ESLint。

---

## 2. 分层

| 层 | 产物 | 职责 | 是否碰宿主 |
|---|---|---|---|
| **P0 镜像** | `incubator/dsh-plugin-teamflow/**`（上游逐字） | 保留真源、锁定 commit | 否 |
| **P1 内核** | `port/port-core.mjs`、`port/mirror/**.js`、`test/port-*.test.js`、`port/manifest.json`、`port/run-check.mjs`、`port/bridge-ledger.mjs` | 用 Node 内置 `module.stripTypeScriptTypes` 机械剥离类型，生成同构 JS 内核；建立漂移守卫 | 否 |
| **P2 外部包** | `workbench/`（`@0.2.4`） | 12 个模型工具、`/x/teamflow/api/*`、注册式 React 工作台、数据根与账本 | 仅 profile 安装 |
| **P3 装机/真机** | dev profile 的 `file:` 依赖 + `cordis.patch.yml` insert 行 | 干跑 → 官方通道安装 → 重启 → 界面与执行链取证 | 是（dev profile only） |
| **交付文档** | `report/` | 本文件与 HTML 使用报告 | 否 |

**一处真源原则**：`workbench/lib/core/` 的 17 个内核文件由 `port-core.mjs` 从 `port/mirror/` 自动同步，`run-check.mjs` 逐字节钉住副本哈希；禁止手改副本。

---

## 3. 目录结构（本仓新增部分）

```text
incubator/dsh-plugin-teamflow/
├── (上游 240 文件，逐字镜像)
├── port/
│   ├── port-core.mjs           # 生成 mirror + 测试副本 + workbench/lib/core 副本 + manifest
│   ├── manifest.json           # 上游 commit、源/产物/副本 SHA256、清单
│   ├── run-check.mjs           # 5 组守卫：哈希漂移 / 零宿主依赖 / 14 组等价 / 状态机复用 / 副本一致
│   ├── bridge-ledger.mjs       # P1 语义探针（相对 import 本仓 workitem，仅验证用）
│   ├── run-bridge-check.mjs    # 23 条状态机映射自测
│   └── mirror/**.js            # 17 个机械剥离后的 JS 内核
├── workbench/                  # 外部包 dsh-teamflow-workbench
│   ├── package.json            # 0.2.4 / exports["./client"] / dsh.bundle.patch / dsh.client.inject
│   ├── cordis.patch.yml        # insert 行：root / allowTools / timeoutMs
│   ├── lib/
│   │   ├── index.js            # Host 半：12 工具 + 审批闸 + 9 个 HTTP 端点 + 可选注入
│   │   ├── pipeline.js         # 阶段编排、独立 verifier、QA 回环、断点续跑
│   │   ├── store.js            # 数据根、原子写、纯读列表、启动时崩溃归正
│   │   ├── stateMachine.js     # journal 阶段 → vssarosWorkItems 账本（cordis 服务版）
│   │   ├── client.js           # 客户端入口（只装载子块，不写 chunk:）
│   │   ├── client.teamflow.js  # React 面板（wb-* 原语 / @container / data-* 锚点）
│   │   └── core/**             # P1 内核副本（17 文件，自动生成）
│   └── test/
│       ├── run-teamflow-check.mjs   # 86 条包内自检（伪 ctx 真跑 apply）
│       └── dry-run.mjs              # 与安装同源的结构干跑，不写盘
└── report/
    ├── framework.zh-CN.md
    ├── usage-report.html
    └── assets/teamflow-workbench.png
```

---

## 4. 兼容性映射（上游 → 本仓 seam）

| 上游 | 本仓 | 处置 |
|---|---|---|
| `ctx.typert.register` + client `ctx.remote.$mount` | 无自研 Remote | `descriptors.ts` 降级为方法签名表；Host→页面统一 `webServer.register({kind:'prefix', path:'/x/teamflow'})` + 同源 fetch |
| `ctx.subagents.startActivation` / `SubagentRun.dispose()` | `vssarosRuns.run/cancel`（`vssaros-bridge/lib/runs.js`） | 会话 id `tf-<runId>-<phase>`；`approval.allow` **缺省全拒**，必须显式配工具白名单 |
| 12 个 `teamflow_*` 工具（`parameterSchemaSpecToJsonSchema` from `@deepseek-ai/dsh-tools`） | `ctx.effect(() => ctx.tools.register({...}))` | `output.render` 必须是函数；`additionalProperties` 只能布尔；写类工具挂 `tools/pre-execute` 的 `{kind:'ask'}` |
| `$DSH_HOME/teamflow/<product>/` | `!!js dshHomePath('dsh-teamflow-workbench')` | 数据落在数据根而非用户项目；`store.js` 自己实现原子写与 `.bak` 自愈 |
| TS/TSX + tsdown → `lib/*.mjs` | 纯 JS chunk + `window.__ModuleLoader__.load` | `stripTypeScriptTypes` 机械剥离；入口不写 `chunk:`，子块才写 |
| `sessionStats` / token 计量 | `vssarosRuns.run` 回执不含 usage | 计量**不接**，不伪造 |
| 48 个 `node:test` | 本仓守卫链 | 14 组纯逻辑测试做等价基线（856 断言）；包内自检 86 条 |

**关键约束**：插件之间在 profile 里没有跨包解析路径，所以 `stateMachine.js` 不 import 本仓 `vssaros-workitem`，而是从 `ctx.inject(['vssarosWorkItems'], ...)` 拿服务（用时读 `deps`，不做值快照）。P1 的 `bridge-ledger.mjs` 用相对 import 只用于语义验证，不能带进随包插件。

---

## 5. 运行期数据流

```text
工作台「启动流水线」/ teamflow_start
        │
        ▼
triage()  ── suggestMode（确定性 5 档）──► resolveStages（阶段集）
        │
        ▼
journal 原子落盘 <数据根>/dsh-teamflow-workbench/runs/<id>.json
        │
        ▼
drive() 逐阶段：
   vssarosRuns.run({sessionId:`tf-<id>-<phase>`, cwd, prompt, approval})
        │  返回 finalText
        ├── extractVerificationEvidence  → 证据块（命令 + 退出码 + 断言数）
        ├── parseDefectRows（QA）        → P0–P2 缺陷 → qaFix + 复验，≤2 轮，超限 needs-human
        └── acceptance：parseAcceptanceVerdict(worker)
                        + 另一条会话 `tf-<id>-verify` 自己重跑检查
                        → 两边 accepted 且 verifier 有证据才 done
        │
        ▼
syncJournalStages → vssarosWorkItems 账本 <数据根>/.../ledger.json
        │
        ▼
/x/teamflow/api/list · /api/status → React 面板（运行记录 / 阶段状态 / needs-human）
```

**状态机**：复用 `vssaros-workitem` 的 ledger 状态机（`markDone/markFailed/markBlocked/recoverOnStart/skipReasonOf`），没有造第四套 run 状态。同步按「状态 + marker」幂等，避免重复写把 `attempts` 刷爆。

---

## 6. 六条不变量

1. **验收者独立于实现者**：不同 `sessionId`，`selfReported:false`，自己跑检查，不读 worker handoff。
2. **只认字面量结论行**：`parseAcceptanceVerdict`，缺失/无证据即停线转 `needs-human`，不伪装完成。
3. **QA 回环有界**：`QA_REWORK_LIMIT=2`，超限停线，不再取新阶段。
4. **提交闸不给 agent**：`teamflow_merge` 明确返回 `blocked`，把 run 标为需人工审核。
5. **工具白名单 deny-by-default**：`cordis.patch.yml` 的 `allowTools` 是显式数组、无通配符；缺省 `[]` = 子会话写工具全拒。真机验证期间曾临时放行 6 个工具，`0.2.4` 已恢复 `[]`（fail-closed）。
6. **崩溃归正只在加载时一次**：`loadJournals()` 是纯读；`recoverStaleJournals()` 只在 `createController` 初始化调用，避免 `list()` 请求误伤运行中的 run。

---

## 7. 工具、路由与数据

### 12 个模型侧工具

| 工具 | 读/写 | 作用 |
|---|---|---|
| `teamflow_start` | 写·ask | 启动流水线（分诊 → 后台驱动阶段） |
| `teamflow_triage` | 读 | 只做分诊预览，返回档位/理由/阶段集 |
| `teamflow_status` | 读 | 阶段状态、证据、验收结论、独立验收结论 |
| `teamflow_backlog` | 读 | backlog 条目 |
| `teamflow_claim` | 写·ask | 认领（置 `doing` + owner） |
| `teamflow_update` | 写·ask | 人工流转 `todo/doing/blocked/done` |
| `teamflow_assign` | 写·ask | 指派 owner（不改状态） |
| `teamflow_cancel` | 写·ask | 取消 run 并尽力取消活动会话 |
| `teamflow_resume` | 写·ask | 断点续跑，跳过已完成阶段 |
| `teamflow_pause` | 写·ask | 会话级暂停，不再触发 `teamflow_start` |
| `teamflow_resume_session` | 写·ask | 解除会话级暂停 |
| `teamflow_merge` | 写·ask | **明确拒绝**自动合并，转人工审核 |

### HTTP 端点（同源、经 `connection.requestRejection`）

`GET /x/teamflow/?format=json`（兼容）、`GET /api/list`、`GET /api/status`、`GET /api/backlog`、`POST /api/triage`、`POST /api/start`、`POST /api/cancel`、`POST /api/resume`、`POST /api/answer`。

工具与路由共用同一个 `controller`，不重算判定。

### 数据落盘

```text
<数据根>/dsh-teamflow-workbench/
├── runs/<runId>.json       # journal（含 .bak 备份）
├── ledger.json             # workitem 账本
└── backlog.json            # 需求/缺陷条目
```

`serializeJournal` 是上游白名单投影；`store.saveJournal` 用「原 journal + 规整结果 + stages 逐项合并」保留 P2 自定义字段（`cwd`/`mode`/`reworkRounds`/`needsHuman`/`independent` 等）。

---

## 8. 验证矩阵

| 项 | 结果 |
|---|---|
| 上游 240 文件逐字镜像 | `MIRROR_MISMATCH=0` |
| P1 内核 JS 化 | 17 模块、0 个需 `transform`、0 个 `@deepseek-ai/*` 运行时 import |
| 移植等价守卫 | `14/14` 组、上游 `856` 断言 / JS 化 `856` 断言、漂移 0 |
| 状态机语义探针 | `23/23` |
| 包内自检 | `91/91`（含 9 条回归与 fail-closed 守卫） |
| 安装前干跑 | `ok:true`，身份 `local:dsh-teamflow-workbench`，0 error / 0 warning |
| 本仓守卫 | `check-plugin-files 104/104`、`check-host-config 24 项契约 0 违规` |
| 界面真机取证 | `wb-*` 15 类、工具栏锚点恰好 1、`container-type:inline-size`、零 iframe、桌面与 500px 窄窗口 `overflowX=0`、`wb-split` 折叠 `1fr`、按钮无裁切、JS 错误 `[]` |
| 执行链真机 | `tf-mw1jte1l-qbvv` → `completed`，5 阶段全 done |
| 独立验收 | `tf-tf-mw1jte1l-qbvv-verify` → `accepted`、`selfReported:false`、2 条命令 exit 0、4 断言全 PASS |

---

## 9. 已知边界（P4 候选）

- 阶段 prompt 是精简自写版；上游完整 `host/prompts/index.js` 已随内核带进包但未接线。
- 分诊用确定性 `suggestMode`，未接模型驱动的 `runTriage`。
- `tokenUsage` / `sessionStats` 未接（回执无 usage），不伪造。
- 数据根用 `dshHomePath`；随包化时若走 `foundation().dataRootOf(config)`，需同步 `check-host-config.mjs` 的 `foundationRef` 份数。
- ~~`dev.outcome` 残留~~ **已在 `0.2.4` 修复**：`resume()`/`answer()` 重跑前用 `resetStageResult()` 清上一轮结果字段，`runStage()` 成功回合把 `outcome` 置 `null`；新增 4 条回归断言覆盖落盘与 `status()` 一致性。
- QA 回环上限逻辑只在包内自检触发过，真机 `defects=0` 未走到。
- 明暗主题切换未单独真机验证（CSS 无裸色、全走 `var(--)`）。
- 生产 profile 未安装；随包化（`@vssaros/*` + 三清单 + codicon）与外部包形态**互斥**，不能并行，否则同名工作台会出现重复入口。

---

## 10. 事故与修复记录

| 现象 | 根因 | 修复 |
|---|---|---|
| `status()` 读盘后丢 `independent`/`qaRounds`/`needsHuman` | 上游 `serializeJournal` 是白名单投影 | `saveJournal` 通用合并补回自定义字段 |
| `qaRounds` 落盘变成 `[]` | 与上游「逐轮缺陷集合数组」字段撞名 | 改名 `reworkRounds` |
| 运行中 run 被标 `interrupted`、qa 被改写 | `loadJournals()` 每次 `list()` 都做崩溃归正并回写磁盘 | 拆成纯读 `loadJournals()` + 加载时一次 `recoverStaleJournals()` |
| dev 失败仍继续跑 QA/验收，白烧额度 | `drive` 未处理普通 `failed` | 立即 `needs-human` + `break` |
| 改已装 `cordis.patch.yml` 不生效（`approval.allow` 仍 `[]`） | bundle 内 `config` 只在组装时读，HMR 不重读 | 改仓库源 → bump → `pnpm pack` → **新暂存目录** → `dsh plugin add`（spec 变化触发重新组装） |
| `plugin add` 后 `require('compression')` 失败 | pnpm 删掉嵌套 `negotiator/lib/accept.js` | 同版本从顶层复制补回 + touch profile manifest 触发 HMR 自愈 |
| 「日志里没有 teamflow」被误判为没加载 | 本插件 `apply()` 不打日志（与 workitem/loop 同） | 改用数据根落盘、路由 200、`__vssarosWb_teamflow`、注册快照取证 |
| Host 反复孤儿退出 | dev app 残留僵尸实例占 profile 锁，`HANDOFF-ZOMBIE` | `taskkill /F /IM "VsSaros Dev.exe"` + `node scripts/start-dev-app.mjs` |
| 流水线多次停在 dev/qa | Host 停机、模型会话无响应、外部 `cancelled` | 环境稳定后真机跑到 `completed` |

---

## 11. 命令速查

```powershell
$mir = 'g:\SarosWorkspace\sarosis-agents-client\incubator\dsh-plugin-teamflow'
$wb  = Join-Path $mir 'workbench'
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

node (Join-Path $mir 'port\port-core.mjs')          # 重放 JS 化 + 同步内核副本
node (Join-Path $mir 'port\run-check.mjs')          # P1/P2 统一守卫
node (Join-Path $mir 'port\run-bridge-check.mjs')   # 状态机语义探针

cd $wb
node test/run-teamflow-check.mjs                    # 包内自检
pnpm pack                                           # 产出 .tgz
node test/dry-run.mjs <.tgz 绝对路径>               # 安装前干跑（不写盘）
```

```powershell
# 官方安装通道（spec 必须变化，否则 pnpm 不替换）
$env:DSH_HOME = "$env:USERPROFILE\.vssaros-dev\dsh-home"
node "$env:USERPROFILE\.vssaros-dev\dsh-runtime\0.2.1-alpha.3\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile vssaros add file:<新暂存目录>
```

```powershell
# 本仓既有守卫
node dsh-plugins/check-plugin-files.mjs
node dsh-plugins/check-host-config.mjs
```

---

下一步若要随包化，正确顺序是：先从 dev profile `remove` 外部包 → 改名 `@vssaros/*` → 三清单与 codicon 登记 → `check-workbench-style` 白名单 → 重建 profile 种子 → `npm run check:dsh-plugins` 全链 → 真机验证。不能与外部包形态并行。
