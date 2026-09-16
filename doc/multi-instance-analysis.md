# VsSaros 多实例运行机制：现状分析、横向对比与优化方案

> 状态：**分析 + 设计**；**§6.2 P3-2 已于 2026-09-15 实施「阶段 1」**（见文末 §9 实施记录）
> 日期：2026-09-12（§9 实施记录追加于 2026-09-15）
> 方法：全部结论基于**本仓代码实证**（含行号）；外部项目部分标注为「公开资料 + 通用认知」，与代码实证区分。

---

## 0. 摘要（TL;DR）

| 结论 | 说明 |
|---|---|
| 本项目 = **多实例（多进程）+ 共享 user-data-dir** | 与 VSCode 原生的「单实例 + IPC 转发」相反；用 `--instance <id>` 让每个实例拿到独立的 IPC 管道名，从而并存 |
| `--instance` 改造**极其克制** | 只改了 6 处路径计算（handle / lockfile / logs / Backups / globalStorage / workspaceStorage），且**默认实例行为完全不变**（向后兼容） |
| **根本矛盾：共享面 ≫ 拆分面** | `--instance` 只覆盖「VSCode 核心可变状态」；**Agent Studio 的全部数据**（agents / skills / chat-history / checkpoints / media / kb / graph / workspaces.json / settings.json）都落在共享的 `userDataPath` 下，**未纳入** `instanceStateHome` |
| **共享 ≠ 只读，但代码按「共享即可无保护」假设写的** | VSCode 的共享数据（settings/extensions）是低频只读；而 Agent Studio 的共享数据是**高频写**的 → 并发写无保护 |
| 并发保护**不一致** | SQLite 有的补了 WAL+busy_timeout（kb/graph），有的没补（media.db）；JSON 几乎全裸写（非原子、无锁、无版本检查） |
| 优化方向 | **不能简单「全拆」**（多开共享 agents/skills 是产品需求）→ 应按**可变性分层**：只读类保持共享、高频写类加锁或拆分、SQLite 统一 PRAGMA |

---

## 1. 三种基本模型（先建立坐标系）

多实例/多窗口问题，本质是**「一份用户数据」与「多个运行体」的映射关系**。业界只有三种解法：

| 模型 | 代表 | 机制 | 代价 |
|---|---|---|---|
| **A. 单实例 + 多窗口** | VSCode 原生、Zed | 一个主进程持有数据，开多个 BrowserWindow | 崩溃影响全部窗口；无法并行跑重负载 |
| **B. 单实例 + 工作区锁** | Eclipse、Chrome | 数据目录加 `.lock`，第二个进程被拒绝或转为「请求转发」 | 无法真正多开；锁残留需人工清理 |
| **C. 多实例 + 共享数据** | **本项目**、JetBrains | 多个独立进程并存，按「可变 / 静态」拆分数据目录 | **跨进程并发写协调**（本项目的核心问题） |

本项目选的是 **C**，这也解释了为什么它必须自己解决并发问题——VSCode 上游代码**从不为跨进程并发写做保护**（它假设模型 A）。

---

## 2. VSCode 原生机制（对比基准）

### 2.1 单实例是如何实现的

`src/vs/code/electron-main/main.ts:133-136`：

```ts
// Create the main IPC server by trying to be the server
// If this throws an error it means we are not the first
// instance of VS Code running and so we would quit.
const mainProcessNodeIpcServer = await this.claimInstance(...);
```

`main.ts:316-370` 的完整逻辑：

1. `nodeIPCServe(mainIPCHandle)` —— 尝试**独占**这个命名管道
2. 成功 → 我是首个实例，继续启动
3. 失败（`EADDRINUSE`）→ **已有实例在跑** → `nodeIPCConnect(mainIPCHandle)` 把命令行参数（要打开的文件/文件夹）转发过去 → **本进程退出**

管道名的构成（`src/vs/base/parts/ipc/node/ipc.net.ts:908-915`）：

```ts
export function createStaticIPCHandle(directoryPath: string, type: string, version: string): string {
	const scope = createHash('sha256').update(directoryPath).digest('hex');
	const scopeForSocket = scope.substr(0, 8);
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\${scopeForSocket}-${version}-${type}-sock`;
	}
	...
}
```

→ 管道名 = **`sha256(userDataPath)` 前 8 位** + version + **type**。默认 `type = 'main'`。

**关键点**：管道名由 `userDataPath` 决定 → **同一个 user-data-dir 只能有一个主进程**。想多开就得换 `--user-data-dir`（等于放弃共享数据）。

另有一个 `mainLockfile`（`{userDataPath}/code.lock`，内容为 PID，`main.ts:140-142` 写、`:148-152` 退出时删），用于**崩溃后识别陈旧实例**（VSCode #127861）。

### 2.2 多窗口 ≠ 多实例

VSCode 的「New Window」是**同进程内新建 BrowserWindow**（`windowsMainService.openEmptyWindow`），所有窗口共享：主进程、状态存储（`state.vscdb`）、备份、日志。所以：

- 用户看到的「多开」= 多窗口（进程管理器里只有 1 个 main + N 个 renderer）
- 真正的多进程在 VSCode 里**不被鼓励**（要换 user-data-dir，数据就不共享了）

---

## 3. 本项目的改造与现状

### 3.1 `--instance` 的完整作用链

**声明**（`src/vs/platform/environment/common/argv.ts:60-66`，CLI 注册在 `node/argv.ts:116`）：

```ts
/**
 * 多开实例 ID（如 `--instance 2`）。同一数据目录（user-data-dir）下允许多个
 * 独立进程运行：IPC handle / lockfile / 可变状态（globalStorage、workspaceStorage、
 * backups、logs）按实例拆分，而 agents/skills/settings/extensions 等静态数据共享。
 * 未指定时为默认单实例行为。
 */
instance?: string;
```

**解析**（`src/vs/platform/environment/common/environmentService.ts:76-97`）：

```ts
@memoize
get instanceId(): string | undefined {
	const raw = this.args['instance'];
	if (typeof raw === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(raw)) { return raw; }
	return undefined;      // 非法/缺失 → 视为默认单实例
}

@memoize
get instanceStateHome(): URI {
	const id = this.instanceId;
	return id ? joinPath(this.appSettingsHome, 'instances', id) : this.appSettingsHome;
}
```

**6 处被拆分的路径**：

| 目标 | 位置 | 表达式 |
|---|---|---|
| IPC handle | `environmentMainService.ts:83-90` | `channel = instanceId ? \`${instanceId}-main\` : 'main'` |
| lockfile | `environmentMainService.ts:92-96` | `instanceId ? 'code-{id}.lock' : 'code.lock'` |
| Backups | `environmentMainService.ts:50-55` | `Backups/instances/{id}` |
| logs | `environmentMainService.ts:73-81` | `logs/instances/{id}/{ts}/` |
| globalStorage（含 `state.vscdb`） | `userDataProfile.ts:346-355` | `{instanceStateHome}/globalStorage` |
| workspaceStorage | `environmentService.ts:126-127` | `{instanceStateHome}/workspaceStorage` |

**这个改造的巧妙之处**（值得肯定）：

- 只动 `type` 参数（`'main'` → `'{id}-main'`）就让管道名不同 → `claimInstance` 认为「管道空闲」→ 允许第二进程 ✓
- `instanceId` 有**白名单校验**（`/^[a-zA-Z0-9_-]{1,32}$/`），避免注入到管道名/路径 ✓
- **默认实例（无 `--instance`）的 handle 与改造前逐字节一致** → 既有的「转发给已运行实例」逻辑完全不受影响 ✓

**启动入口**（`src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts:438-471` + `scripts/new-window.ps1`）：
任务栏 jump list 的 "New Window" 走 PowerShell 脚本，每次生成唯一 id（时间戳 + 随机后缀）并以 `--instance=<id>` 启动**独立进程**（而非转发）。dev 下额外传 `-Dev`（补 `VSCODE_DEV=1`，否则新进程被误判为 built）与 `-UserDataDir`。

### 3.2 拆分 vs 共享的边界

`--instance` 覆盖了「VSCode 核心可变状态」，但 **Agent Studio 的数据全部在共享侧**（路径常量见 `src/vs/sessions/contrib/agentStudio/common/sarosPaths.ts:26-57`）：

| 数据 | 路径（均在共享的 `userDataPath` 下） | 可变性 |
|---|---|---|
| `agents/`（含 `.agent.md`、`agent-bindings.json`） | `~/.vssaros-dev/agents/` | 低频写 |
| `skills/` | `~/.vssaros-dev/skills/` | 低频写 |
| `User/settings.json` | `~/.vssaros-dev/User/settings.json` | **中频写**（改设置即写） |
| `workspaces.json` | `~/.vssaros-dev/workspaces.json` | 中频写 |
| **会话历史** | `~/.vssaros-dev/chat-history/{agentId}/sessions/*.json` | **高频写**（每轮对话） |
| **检查点** | `{workspace}/.sarosworkspace/checkpoints/...`（回退时 `~/.vssaros-dev/.sarosworkspace/`） | **高频写**（每次编辑） |
| `media/`（`media.db` + 图片） | `~/.vssaros-dev/media/` | 中频写 |
| `kb-sqlite/kb.db`、`codebase-graph/graph.db` | `~/.vssaros-dev/` | 中高频写 |
| `workflows/`、`dashboard/`、`context-storage/`、`mcp.json` | `~/.vssaros-dev/` | 低频写 |

> **根因**：`--instance` 的拆分逻辑建立在 VSCode 的假设上——「共享的是**静态**数据（settings/extensions 极少变），可变状态已按实例拆走」。而 Agent Studio 的数据**既非纯静态也非纯可变**，被整体归入「静态共享」，于是「共享」这个决定**从未配套并发保护**。

### 3.3 并发保护现状（严重不一致）

| 存储 | 保护 | 证据 |
|---|---|---|
| `kb.db` | ✅ WAL + `busy_timeout=5000` + 事务 | `kbSqliteStore.ts:90-94,117-132` |
| `graph.db` | ✅ WAL + `busy_timeout=5000` + `wal_checkpoint(TRUNCATE)` | `codebaseGraphSqliteStore.ts:308-316,519-526` |
| **`media.db`** | ❌ **无 WAL、无 busy_timeout** | `mediaStore.ts:97-105`（仅 `new Database(path)`） |
| `state.vscdb`（profile/workspace） | ⚠️ 无 WAL/busy_timeout，但**路径已按实例隔离** → 不冲突 | `storageMain.ts:306-308`、`userDataProfile.ts:346-355` |
| 会话 JSON | ⚠️ 自定义会话锁（JSON + 30s 心跳 + 2min 过期接管），但**fail-open** | `agentChatService.ts:535-606`（锁）、`:581-582`（异常放行） |
| `settings.json` | ❌ 仅**进程内** `Queue`，无跨进程锁 | `configurationService.ts:202-228` |
| `workspaces.json` / `agents/*` / `skills/*` / 检查点 | ❌ **无锁、无版本检查** | `agentStudioService.ts:482-487`、`checkpointService.ts:314-341` |
| 所有 JSON 写入 | ❌ **非原子**（框架支持但调用方未启用） | `diskFileSystemProvider.ts:244-250`（需传 `atomic.postfix` 才走 temp+rename） |
| 日志 | ✅ 天然隔离（`logs/instances/{id}/`） | `environmentMainService.ts:73-81` |

**两套已有的锁基建**（可复用，见 `codebaseIndexLock.ts:37-63`）：会话锁（`chat-history/.../sessions/{id}.lock`）与代码图谱索引锁（`<root>/.codebase-memory/index.lock`），模式一致——JSON 内容 + mtime 心跳 + 过期接管 + token 归属校验。

---

## 4. 横向对比

| 项目 | 模型 | 数据共享策略 | 并发保护 | 与本项目的可比性 |
|---|---|---|---|---|
| **VSCode 原生** | A（单实例多窗口） | 全共享（同 user-data-dir 单进程） | 不需要（单进程） | 本项目的基础；**上游代码不提供跨进程保护** |
| **JetBrains** | C（多实例） | 配置/缓存/索引在 `~/.cache/JetBrains/<product>` 共享；项目级 `.idea/` 共享 | 部分：索引/缓存有内部锁；**`.idea/workspace.xml` 多实例写会冲突/覆盖**（公开资料） | **最像本项目**——同样踩「共享面含高频写」的坑 |
| **Eclipse** | B（工作区锁） | 单工作区独占（`.metadata/.lock`） | 强（第二个实例被拒："workspace is in use"） | 反向参考：用「拒绝多开」换一致性 |
| **Chrome** | B（profile 锁） | 单 profile 独占（`SingletonLock`） | 强 | 同上，但锁是 symlink+hostname+pid，可自愈 |
| **Emacs** | A'（server + client） | 单 server 持状态，`emacsclient` 多客户端 | 天然（单进程） | 「多客户端共享一个状态持有者」是另一种解法 |
| **Sublime Text** | C（多实例） | 会话文件共享（`Session.sublime_session`） | 弱（last-write-wins） | 与本项目相近，同样存在丢更新 |
| **Zed** | A（多窗口）+ SQLite | 单进程 + SQLite | SQLite 事务 | 用「放弃多进程」规避问题 |

**规律**：模型 C（多实例 + 共享）**必然**要面对跨进程并发；凡是踩住的项目，要么给共享数据加锁，要么接受 last-write-wins。**没有项目能靠「假设共享数据不会并发写」蒙混过关**——这正是本项目当前的状态。

---

## 5. 优缺点分析

### 5.1 多实例（模型 C）的优点

| 优点 | 具体收益 |
|---|---|
| **崩溃隔离** | 一个实例的 renderer/扩展宿主崩溃或 OOM，不影响其它窗口（本项目扩展宿主较重，收益明显） |
| **并行跑 agent 任务** | 多实例可各自跑长任务，互不阻塞事件循环（单实例多窗口共享同一扩展宿主，一个卡住全卡） |
| **数据目录共享** | agents / skills / settings 一次配置处处可用，符合用户直觉 |
| **按实例隔离易崩溃的 DB** | `state.vscdb` 等按实例拆分，规避了 SQLite 多进程写（该 DB 未启用 WAL，隔离是**唯一**让它安全的手段） |

### 5.2 缺点与风险（按严重度排序）

| # | 风险 | 机制 | 后果 |
|---|---|---|---|
| **R1** | **共享 JSON 丢更新** | `settings.json` / `workspaces.json` / `agents/*` 是「读-改-写」，无跨进程锁、非原子 | 两实例同时改 → 后写覆盖先写，用户配置静默丢失 |
| **R2** | **文件半写** | 非原子写（`IFileService.writeFile` 未传 `atomic.postfix`），进程被 kill / 断电时留下截断 JSON | 文件损坏 → 启动解析失败（且 `sarosPaths` 下多为**启动即读**的关键文件） |
| **R3** | **`media.db` 并发竞争** | 无 WAL、无 `busy_timeout`（与 kb/graph 不一致） | `SQLITE_BUSY` 报错，甚至库损坏 |
| **R4** | **会话/检查点交叉写** | 会话锁**自愿且 fail-open**；检查点目录**完全无锁** | 两实例开同一 agent 会话 → 对话历史/快照互相覆盖，回退行为不可预测 |
| **R5** | **用户认知混乱** | 多实例无任何「我是哪个实例」的可视标识 | 用户以为在操作同一个窗口，实际是两个独立实例，状态不同步 |
| **R6** | **无实例生命周期协调** | 各实例独立启停，无「谁在跑任务」的全局视图 | 关闭一个实例可能中断其正在跑的 agent 任务（且用户不知道） |

### 5.3 设计层面的评价

**做得好的**：
- `--instance` 的改造**最小且向后兼容**——默认实例行为逐字节不变，风险可控
- `instanceId` 有白名单校验，未引入注入面
- 启动链路（jump list → ps1 → 独立进程）考虑了 dev/built 差异与 `VSCODE_DEV` 继承问题（注释里记录了踩坑，见 `workspacesHistoryMainService.ts:444-447`）
- 已有两套可复用的锁基建（会话锁 / 图谱锁），模式统一

**做得不足的**：
- **共享策略是隐式的**：没有任何一处代码或文档集中声明「哪些数据共享、为什么、靠什么保护」。新加一个存储（如 media.db）时，作者不会意识到「它落在共享侧且裸写」
- **保护是「按需零散补」的**：kb/graph 补了 PRAGMA，media 没补——说明当时是「遇到问题才修」，缺乏统一策略
- **锁语义不统一**：会话锁 fail-open（异常时静默放行），而图谱锁有接管逻辑；两者都是自定义实现，未抽象为公共服务

---

## 6. 优化方案

### 6.0 设计原则

1. **「共享」必须显式且配套保护**——凡落在共享侧的数据，必须声明其并发策略（锁 / 原子写 / 拆分 / 只读）
2. **不能一刀切全拆**——多开共享 agents/skills/settings 是产品需求；全拆等于放弃多实例的核心卖点
3. **按可变性分层**，而非按模块归属
4. **失败要可见**——并发冲突不能静默降级（当前会话锁 fail-open 就是反例）
5. **复用已有基建**，不新造轮子

### 6.1 分层策略（核心设计）

| 层 | 数据 | 策略 |
|---|---|---|
| **L1 只读为主** | `skills/`、`agents/`（定义文件） | 保持共享；写入走**原子写 + mtime 乐观检查**（冲突则提示「已被其它实例修改」） |
| **L2 低频可变、需合并** | `User/settings.json`、`workspaces.json`、`mcp.json` | 保持共享；**跨进程锁 + 原子写**（读-改-写在锁内完成） |
| **L3 高频可变、需强一致** | 会话历史、检查点、`dashboard/` | **纳入会话锁**（含检查点目录）；或改为**按实例拆分**（若产品可接受「各实例独立会话」） |
| **L4 数据库** | `media.db`、`kb.db`、`graph.db` | 统一 `journal_mode=WAL` + `busy_timeout` + 事务（kb/graph 已达标，media 待补） |
| **L5 天然隔离** | `state.vscdb`、`workspaceStorage`、`Backups`、`logs` | 维持现状（已按实例拆分） |

> **L3 的关键决策点**：会话历史/检查点**要不要共享**？两种取向：
> - **共享**（当前）：多开同一 agent 可续接对话 → 但需要强锁 + 明确的「只读占用」提示
> - **按实例拆分**：每实例独立会话 → 实现简单、天然无冲突，但用户「换窗口继续对话」的期望落空
>
> 建议：**默认共享 + 锁保护**，并提供设置项 `sessions.agentStudio.multiInstance.sessionScope = 'shared' | 'perInstance'` 让用户选。

### 6.2 分阶段实施

#### P0 —— 正确性（低成本、高收益，建议优先）

| 项 | 动作 | 位置 |
|---|---|---|
| **P0-1** | `media.db` 补 `PRAGMA journal_mode=WAL` + `busy_timeout=5000`，与 kb/graph 对齐 | `mediaStore.ts:97-105` |
| **P0-2** | 共享 JSON 写入统一走**原子写**：给 `IFileService.writeFile` 传 `atomic: { postfix: '~' }`（框架已支持 temp+rename） | `agentChatService.ts:1183`、`agentStudioService.ts:482`、`configurationService.ts:228`、`checkpointService.ts` |
| **P0-3** | 会话锁的 **fail-open 改为 fail-visible**：获取锁异常时不再静默放行，而是降级为只读 + 通知用户 | `agentChatService.ts:581-582` |

> P0-2 是**单点改动、全局受益**：原子写同时消除 R2（半写），且不影响单实例场景。

#### P1 —— 一致性

| 项 | 动作 |
|---|---|
| **P1-1** | 抽 `crossProcessFileLock` 通用服务（把 `codebaseIndexLock.ts` + 会话锁的模式统一为：acquire/release/heartbeat/staleTakeover），供 settings / workspaces / checkpoints 复用 |
| **P1-2** | 检查点写入纳入会话锁（当前 `checkpointService` 完全无锁，且与会话同源） |
| **P1-3** | L2 层（settings / workspaces / mcp.json）的读-改-写全部在跨进程锁内完成 |

#### P2 —— 体验

| 项 | 动作 |
|---|---|
| **P2-1** | 实例标识可视化：标题栏/状态栏显示实例 ID（仅在 `--instance` 存在时），消除 R5 |
| **P2-2** | 「会话被其它实例占用」明确提示（当前只有内部 `_sessionReadOnly` 标志，无 UI） |
| **P2-3** | 实例生命周期视图：列出运行中的实例与各自正在跑的任务（可选，需跨实例 IPC 或共享注册表） |

#### P3 —— 架构治理

| 项 | 动作 |
|---|---|
| **P3-1** | 在 `sarosPaths.ts` 把 6.1 的分层表**写成代码常量 + 注释**（每个路径标注 `scope: 'shared' \| 'perInstance'` 与 `protection: 'lock' \| 'atomic' \| 'sqlite-wal' \| 'none'`），新增存储时强制声明 |
| **P3-2** | 评估「单实例多窗口」（模型 A）作为长期替代：能天然消除全部跨进程问题，代价是失去崩溃隔离与并行能力。建议先做完 P0/P1，再据实际痛点决策 |

### 6.3 不建议做的事

- ❌ **给所有共享文件加一把全局大锁**——会把多实例的并行优势变成串行，且锁粒度粗易死锁
- ❌ **把 Agent Studio 数据全按实例拆分**——直接违背「多开共享 agents/skills」的产品设计
- ❌ **引入外部数据库/协调服务**——为一个桌面应用引入跨进程协调中间件，复杂度收益比过低

---

## 7. 验证方案

| 层 | 验证方式 |
|---|---|
| 单元 | `crossProcessFileLock` 的 acquire/stale-takeover/token 校验（纯逻辑可测，参考现有 `codebaseIndexLock` 测试） |
| 集成 | 起两个实例（`--instance a` / `--instance b`），并发 `updateValue` 改 settings → 断言无丢更新（P0/P1 前后对比） |
| 集成 | 并发写 `media.db` → 断言无 `SQLITE_BUSY`（P0-1 前后对比） |
| 故障注入 | 写入过程中 kill 进程 → 断言 JSON 仍可解析（验证原子写生效） |
| 回归 | 默认实例（无 `--instance`）行为逐字节不变：IPC handle / lockfile / 路径 |

---

## 8. 附录：证据索引

| 主题 | 位置 |
|---|---|
| `--instance` 声明 / CLI 注册 | `src/vs/platform/environment/common/argv.ts:60-66`、`node/argv.ts:116` |
| `instanceId` / `instanceStateHome` 解析 | `src/vs/platform/environment/common/environmentService.ts:76-97,126-127` |
| 按实例拆分的 6 处路径 | `src/vs/platform/environment/electron-main/environmentMainService.ts:50-55,73-81,83-90,92-96`、`userDataProfile.ts:346-355` |
| 单实例锁 / 转发 | `src/vs/code/electron-main/main.ts:133-152,316-370` |
| 管道名构成 | `src/vs/base/parts/ipc/node/ipc.net.ts:908-915` |
| 多开启动入口 | `src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts:438-471`、`scripts/new-window.ps1` |
| 共享路径常量 | `src/vs/sessions/contrib/agentStudio/common/sarosPaths.ts:26-57` |
| SQLite PRAGMA 现状 | `kbSqliteStore.ts:90-94`、`codebaseGraphSqliteStore.ts:308-316`、`mediaStore.ts:97-105` |
| 锁基建 | `codebaseIndexLock.ts:37-63`、`agentChatService.ts:535-606` |
| 原子写能力 | `diskFileSystemProvider.ts:244-250,271-305` |
| 会话/检查点写入 | `agentChatService.ts:1183-1186`、`checkpointService.ts:276-341` |
| 设置写入 | `configurationService.ts:202-228` |

---

## 9. 实施记录：阶段 1（2026-09-15）

### 9.1 决策
**默认切回模型 A（同进程内开新窗口）**，保留模型 C 作为可选逃生门。
依据即本文 §3.2「共享面 ≫ 拆分面」+ §6.2 P3-2；用户 2026-09-15 裁决「开始执行」。

### 9.2 已实施（4 处改动，全部可回滚）
| # | 位置 | 改动 |
|---|---|---|
| 1 | `platform/workspaces/electron-main/workspacesHistoryMainService.ts` | 注入 `IConfigurationService`（该服务由 `app.ts` 的 `SyncDescriptor` 注册，无显式 `new` ⇒ 加 DI 参数安全）；Tasks 按模式分支 |
| 2 | 同上 | 新增 `getNewWindowMode()`：**仅显式 `'instance'` 才多开**；读配置异常一律回落 `'window'`（不能因读配置失败开不出窗口） |
| 3 | 同上 | 在 `handleWindowsJumpList()` 内监听 `onDidChangeConfiguration` ⇒ **改设置即时重建跳转列表**（无需重启） |
| 4 | `sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` | 注册 `saros.window.newWindowMode`（`window` \| `instance`，默认 `window`），置于既有 `id: 'sessions'`（`ConfigurationScope.MACHINE`）块 |
| — | `scripts/new-window.ps1` | **保留**（仅 `'instance'` 模式使用） |

- `'window'` = 上游原形：`program: process.execPath` + `args: '--new-window'` ⇒ 单实例 IPC 转发 ⇒ 已运行实例内开新窗口。
- `'instance'` = 旧行为（PowerShell 脚本 + 唯一 `--instance <id>`）—— **逃生门**。
- 测试：`platform/workspaces/test/electron-main/newWindowMode.test.ts`（5 例，钉住默认形态、异常回落、逃生门保留、设置默认值、监听位置）。

### 9.2.1 实施补充（2026-09-15 自查发现，必读）
**dev（未 built）下原生模式的参数不能照抄上游**：
- 打包版：`process.execPath --new-window` 就够 —— exe 的默认数据目录就是运行中实例所用者，
  单实例管道 scope（`sha256(userDataPath)`）一致 ⇒ 转发成功 ✓；
- **dev**：任务栏项由 explorer 拉起，**不继承** `code.bat` 设的 `VSCODE_DEV=1` ⇒ 新进程会把数据目录
  算成 `~/.vssaros`（built 形态），而运行中的 dev 实例用 `~/.vssaros-dev` ⇒ **管道名对不上 ⇒ 不转发**，
  反而**另起一个数据目录不同的实例**（用户视角："任务栏开的窗口里没有我的 agent / 设置 / 工作区"）✗；
  且 dev 下 electron 二进制需要 **app 路径作为第一个参数**。
  ⇒ dev 必须传 `"<appPath>" --new-window --user-data-dir "<运行中实例的 userDataPath>"`
  （实现：`getNativeNewWindowArgs()`）。
- 顺带确认**无需** `--agents`：`code/electron-main/main.ts:108` **无条件**设
  `process.isEmbeddedApp = true`，而 `windowsMainService.isSessionsWindow` 就取它
  ⇒ **任何窗口都是 sessions 窗口**（加载 `sessions.html` / `sessions.desktop.main.js`）✓，
  所以「同进程新窗口会不会退化成标准编辑器窗口」这个担心**不成立**。

### 9.2.2 实施事故与修复：**agents 窗口把「开新窗」意图替换成「记住的工作区」**（2026-09-16）

现象：切到模型 A 后，任务栏 jump list 的 New Window **点了没反应** ✗（用户报）。
证据（`main.log`，三条新 diag 一次命中）：
```
ensureAgentsWindow | cli._=[] | cli.new-window=true | forceNewWindow=true | forceEmpty=true | urisToOpen=[]
agents window reopening remembered workspace: …S1Game.code-workspace          ← 意图被替换
open() after ensureAgentsWindow | forceNewWindow=true | forceEmpty=**false** | urisToOpen=["…S1Game.code-workspace"]
[launch][diag] open(forceNewWindow+forceEmpty) returned **1** window(s)       ← 只返回了已有窗口
```
根因链：① `launchMainService` 为「无位置参数 + `--new-window`」构造
`open({ forceNewWindow: true, forceEmpty: true })`（= 原生「新的空窗口」语义）；
② `ensureAgentsWindow()` 的 case ③（复用「记住的工作区」）**替换**配置并**丢掉 `forceEmpty`**；
③ `open()` 里上游的 `if (windowsOnWorkspace.some(...)) { continue; /* ignore folders that are already open */ }`
⇒ 该工作区已打开 ⇒ **跳过开窗** ⇒ 返回已有窗口 ⇒ 用户看到「没反应」。

修：`ensureAgentsWindow` 顶部**早退**——显式 `--new-window` 且无显式工作区/文件夹请求时**原样放行**
（`forceEmpty` + 空 `urisToOpen` ⇒ `getPathsToOpen` 走 `EMPTY_WINDOW` ⇒ `doOpenEmpty(..., true, …)` ⇒ 真开新窗 ✓）。
启动路径不受影响（此时 `cli.new-window=false`、`forceNewWindow=false`）✓。
契约测试：`platform/workspaces/test/electron-main/newWindowMode.test.ts`（7 例）。

> ★ 教训：**「默认路径」也要在真机上验一次** —— 这条路径（`--new-window` → agents 窗口）此前从未被走到过，
> 而它恰好被 fork 的 `ensureAgentsWindow` 覆盖了调用方意图。切换任何入口/默认值后，
> 必须**按新路径实际点一次**，而不是只看代码/单测通过。

### 9.3 ★★ 关键澄清：**渲染层单例在两种模型下都是「每窗口一份」**

分析时一度把 ②③⑤（会话锁 / 跨窗口静态注册表 / 图谱服务）列为迁移风险，**这个判断需要修正**：
本文 §2.2 已说明「进程管理器里只有 1 个 main + **N 个 renderer**」——**每个浏览器窗口 = 独立的 renderer 进程**，
因此 **renderer 侧的模块级静态量与 DI 单例（`AgentChatService`/`CodebaseGraphService`/各类 Registry）
在模型 A 与模型 C 下同样是「每窗口一份」**，不会因为「同进程」而共享。于是：

| 项 | 模型 A vs C | 结论 |
|---|---|---|
| ② 会话/检查点锁 | 渲染层**仍是两个服务实例** ⇒ 仍靠**文件锁**仲裁（JSON + 心跳 + 过期接管） | **不受模型影响**；`fail-open`（P0-3）是既有稳健性项，与本次迁移无关 |
| ③ 跨窗口静态注册表（`agentStudioWebviewController` 的实例集合等） | 模块静态量属各自 renderer ⇒ **无跨窗口泄漏** | **非风险** |
| ⑤ CodebaseGraph（窗口内单例 + 主进程共享 SQLite） | 两模型下都是「每窗口一份服务 + 共享主进程 SQLite」 | **不受模型影响**（身份判据已统一到窗口身份） |

**模型 A 真正改变的面**（精确清单）：
1. **主进程 / shared process / 扩展宿主**：由「每实例一份」变为「全局一份」⇒ 代价=失去崩溃隔离与 ext-host 并行；收益=上游大量「单进程假设」重新成立；
2. **`state.vscdb` / `globalStorage` / `workspaceStorage` / `Backups` / `logs` / lockfile / IPC handle**：回到上游**默认路径**（不再 `User/instances/<id>/`…）⇒ 这才使 `settings.json` 的**进程内写队列**从"只在单实例内有效"变成**全局有效**（R1 系统性消失）；
3. 主进程侧的其它单例（`WorkspacesHistoryMainService` 等）恢复「全窗口唯一」⇒ 跳转列表等全局状态不再多份竞争。

### 9.4 审计结论（阶段 1 落地前的两项前置检查）
- **① globalState 跨窗口广播 = 干净**：sessions 侧仅 2 处 `onDidChangeValue` —— 一处是 **PROFILE** 作用域的侧栏固定项（本就全窗口共享且带校验回退）；一处是 `nativeChatEditorPane`（**APPLICATION** 作用域 + `e.external` 过滤，注释已明写「变更来自另一个窗口 / B 窗口」）。APPLICATION 作用域的所有写入均为「本就全局」的数据（token / kb vaults / editorFontInfo / first-run 标记 / marketplace）。
- **④ 固定端口 = 干净**：`5600`（ConfigHtml）是**外部**服务，应用只探测 URL 不占端口；`3111`（agentmemory）由**主进程** spawn ⇒ 一进程一个。

### 9.5 验证
`tsgo` 0 错 ✓；`transpile-client` ✓；产物含新分支 ✓；新增 5 例测试 ✓；既有 8 套件全绿
（`codebaseGraphContracts` 33 / `codebaseToolsEntry` 38 / `workspaceFolderWriters` 52 /
`guardrailWiring` 35 / `graphFailureSkip` 10 / `codebaseGraphPersistence` 11 /
`codebaseGraphWatcher` 15 / `kbGraph` 19）✓。

### 9.6 回滚与残余
- **回滚**：设置 `saros.window.newWindowMode` = `'instance'` ⇒ 即时生效（无需重新编译）。

#### 9.6.1 P0-1 已实施（2026-09-15）
`mediaStore._applyPragmas()`：打开 `media.db` 后补 `PRAGMA journal_mode = WAL` + `PRAGMA busy_timeout = 5000`
（与 `kbSqliteStore` / `codebaseGraphSqliteStore` 对齐）；新增测试断言两条 PRAGMA 生效
（必须用**文件库**，`:memory:` 不支持 WAL）。
> ★ **结论修正**：本文 §6.1 把 L4（数据库 PRAGMA）归为「多实例并发」问题，**不准确**——
> **每个窗口是独立 renderer** ⇒ 同一个 `media.db` **永远存在多个连接**（`kb.db`/`graph.db` 同理），
> 因此 WAL + busy_timeout 是**结构性必需**，与选模型 A 还是 C 无关。（这也是 §9.3 那条澄清的直接推论。）

#### 9.6.3 P0-2 已实施（2026-09-15）
新增共享 helper `sessions/contrib/agentStudio/common/atomicWrite.ts`：`writeFileAtomicSafe(fileService, uri, buf)`
——**先探 `FileSystemProviderCapabilities.FileAtomicWrite`**，支持则
`writeFile(..., { atomic: { postfix: '.vsctmp' } })`（temp + rename），否则**退回普通写**。
并让下列**启动即读**的关键 JSON 全部改走它（此前只有 `_writeSessionIndex` 一处做了这件事）：

| 写入点 | 数据 |
|---|---|
| `agentChatService._persistToSessionFile` | **会话本体**（高频覆盖写；此前反而没保护） |
| `agentChatService._writeSessionIndex` | 会话索引（改为复用 helper，去掉内联写法） |
| `checkpointService._writeIndex` / `_writeSnapshot` | 检查点索引 / 快照 |
| `agentStudioService._writeJsonFile` | `workspaces.json` / agents 绑定等 |

**勘察时识别的两个风险，落地时的处理**：
① *能力不足会 throw* ⇒ 由 helper 统一 `hasCapability` 判断，不支持就退回普通写（**绝不因加保护而写失败**）✓；
② *临时文件会被 watcher 看到* ⇒ 采用 `.vsctmp`（与仓库既有集成测试同后缀），存活时间极短且在 rename 后即不存在；
   已知 watcher（图谱只认源码扩展名、检查点/会话按目录监听）不受影响 ✓。
③ *额外发现的取舍（已写入 helper 注释）*：rename 会替换 inode ⇒ 若目标本身是符号链接/硬链接会被打断（Windows 上极少见）；
   因此**未**对用户源码文件（如检查点回退时写回的用户文件、`settings.json`）启用原子写 ——
   前者有 symlink/权限归属风险，后者属上游行为且模型 A 下已有进程内写队列串行化。
`settings.json`（`configurationService.ts`）**刻意不改**，理由同上（上游行为 + 层级跨越 + symlink 风险）。

测试 `test/common/atomicWrite.test.ts`（4 例）：支持能力 ⇒ 必须带 `atomic.postfix`；不支持 ⇒ 必须退回普通写
（**传 atomic 会 throw**）；探的必须是 `FileAtomicWrite`；三个服务的写入点必须都走 helper 且不再内联 postfix。

#### 9.6.4 P0-3 已实施（2026-09-15，fail-open → **fail-visible**）
会话锁（`agentChatService.tryAcquireSessionLock` / 心跳）原先有两个**静默失败**点：
1. **加锁抛错** ⇒ `logService.warn('…(fail-open)')` + `return { acquired: true };` ——
   即「加锁失败就当作拿到了锁，且**不告诉任何人**」✗ ⇒ 用户以为会话受互斥保护，
   实际两个窗口可能同时写同一份对话历史（表现为「消息莫名少了 / 被回退」，无从归因）；
2. **锁心跳失败** ⇒ `catch(() => {})` 完全静默 ✗ ⇒ 连续 2min（`SESSION_LOCK_STALE_MS`）不刷新后
   别的窗口即可接管，而本窗口**仍在编辑** ⇒ 退化成「双方都以为持有锁」。

**改法（保留可用性，把"没有互斥"这件事显式暴露）**：
- 接口（`common/agentStudioService.ts`）补 `degraded?: boolean` 语义；
- 加锁失败 ⇒ 返回 `{ acquired: true, degraded: true }` + 日志标明 `fail-visible`；
- 心跳失败 ⇒ **只提示一次**的 warn（避免每 30s 刷屏）；
- 上层 `nativeChatEditorPane._updateSessionLock()` 消费 `degraded` ⇒ 弹 **Warning 通知**
  （「本会话未能加锁（文件系统异常）……对话历史可能互相覆盖」）。

> ★ **刻意没有改成「直接降级只读」**（本文 §6.2 的原建议）：① 此处失败多为瞬时/权限类抖动，
> 而若连锁目录都写不进去，会话文件大概率也写不进去（保存时会报错，用户能看到）；
> ② 会话写入已走原子写（§9.6.3）⇒ 最坏结果是**「丢更新」而非「文件损坏」**。
> **要点是"可见"，不是"禁止"** —— 这条偏离已在代码注释中写明理由，供后续按痛点再收紧。

#### 9.6.5 残余
P0-1 / P0-2 / P0-3 **均已实施** ✓。剩下的是观察期结论：
- 用 `'instance'` 逃生门时仍会承受跨进程面（该模式下 P0 三项的价值反而更高，已具备 ✓）；
- 遗留目录/锁文件清理（`User/instances/*` 等，属用户数据，需用户确认）；
- §9.3 提到的代价需在真实使用中确认可接受（崩溃隔离 / ext-host 并行）。
- **测试基建（本轮顺带发现并修）**：`betterSqlite3` 顶层 `createRequire(import.meta.url)` 在 esbuild CJS
  bundle 下抛 `ERR_INVALID_ARG_VALUE` ⇒ `workflowComfyMediaStore.test.ts` **长期无法在任何 node runner 下运行**
  （已改为惰性 + cwd 回退，与该仓 `codebaseGraphSqliteStore.ts:79-80` 同范式）。
  修好后该套件第一次真正跑起来，随即暴露一个坏死用例：分页测试用 `http://h/...`（主机不可解析）
  而 `importAsset` 对 http ref **会真的发起下载** ⇒ 悬挂 10s 超时（已改为 `127.0.0.1:1` 立即 ECONNREFUSED）。
  ⚠ 同类隐患：`http://localhost:8188` 若本机正好跑着 ComfyUI，会真的下载并**改变**那条
  「URL 引用仅索引，不落盘」断言的语义 ⇒ 建议此类用例统一改用立即失败的地址。
- **待清理**：`User/instances/*`（4 个，均为 08-09 遗留）、`logs|Backups/instances/*`、`code-w-*.lock`、
  `code-wtest000.lock` —— 属用户数据，需用户确认后再删（未自动清理）。
