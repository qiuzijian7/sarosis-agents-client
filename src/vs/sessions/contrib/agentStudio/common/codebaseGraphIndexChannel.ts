/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★★★ 2026-09-19（P2-1 Phase 1 边界草案）：**索引编排**跨进程通道的类型契约。
 *
 * ## 为什么要有这个文件
 *
 * 现状：图谱的**索引编排**跑在 renderer 主线程 —— 边匹配（实测 52 万边）、克隆检测、BM25、
 * 制品落盘、SQLite 同步都在这里（解析本身已经在 worker ✓，见 `codebaseGraphParserPool`）。
 * 后果：索引期间**整窗冻结**（本仓多窗口共用一个 renderer 主线程 ✗）。
 *
 * 目标（Phase 1，见 P2-1 清单）：把上面那段编排搬进 **utility process**（平台层已支持：
 * `src/vs/platform/utilityProcess/*`），renderer 只保留门面 + 事件 + 只读消费。
 *
 * ## 为什么先只出契约（本文件不含实现）
 *
 * 边界一旦固化，后面可以**逐块搬**、每搬一块跑一次既有套件；而先改实现再想边界会反复返工 ✗。
 * ⚠ 本文件当前**没有任何实现、也没有被接线** —— 它是 Phase 1 的接口草案（下一步才接宿主与代理）。
 *
 * ## 模板与约束（均已查证）
 *
 * - 模板：`codebaseGraphStoreChannel`（common 契约 + electron-main 宿主 + renderer 代理的三段式 ✓）
 * - 硬约束：`GotoImpl` / `ListMethods` 等**同步**路径仍依赖 renderer 侧内存 store
 *   （见 `codebaseGraphService` 中「SQLite 默认开启后【不】自动释放内存 store」的说明）
 *   ⇒ Phase 1 **不动同步查询路径**，只把「索引编排」搬走 ✓
 * - ⚠ 分层：本文件**只用结构化类型**（不 import renderer 类型）。
 *   ★ 2026-09-19 更正：`codebaseGraphStoreChannel` 的做法是**允许** `import type { GraphNode, … } from '../browser/codebaseGraphService.js'`
 *   —— 其注释写明「类型导入编译期擦除，不会把 renderer 代码打进 main 进程 bundle」✓
 *   ⇒ 后续接线时可改用 `import type` 复用 `GraphNode`/`GraphEdge`（当前用结构化类型不影响契约语义 ✓）。
 *
 * ## 目标进程（2026-09-19 修正）
 *
 * 现有 SQLite 后端常驻 **main 进程**（renderer 经 `mainProcessService.getChannel(...)` 访问 ✓
 * 动机是绕开 renderer 的 V8 4GB 上限）。但**索引编排是 CPU 密集**（52 万边匹配 / 克隆检测 / BM25）
 * ⇒ **不能塞进 main 进程**（它是窗口管理与 IPC 的共享资源，会冻结主进程 ✗）。
 * 正确形态：**channel 范式照抄**（renderer → main 转发），但**宿主放在 utility process**
 * （平台层已支持：`src/vs/platform/utilityProcess/*` ✓）。
 *
 * ### ★★ 2026-09-19 方案修正（读实现后得出，**勿回退到旧方案**）
 *
 * 曾计划「main 进程起 worker 并委托」（方案 A）—— **读 `utilityProcessWorkerMainService.ts` 后否定** ✗：
 * 其 `createWorker(configuration: IUtilityProcessWorkerCreateConfiguration)` 的参数里是
 * `reply: { windowId }` + `process: { moduleId }`，返回的只是**终止信息** ⇒ 它是「服务某个窗口请求的
 * **服务端**」，**不提供 client channel** ✗（硬用要伪造 reply 通道 = 跟框架对着干）。
 *
 * ⇒ 改为 **方案 B（框架既定的客户端用法，与 `watcherClient.ts` 完全一致）**：
 * ```ts
 * const { client } = await utilityProcessWorkerWorkbenchService.createWorker({
 *     moduleId: 'vs/sessions/contrib/agentStudio/node/codebaseGraphIndexWorkerMain',
 *     type: 'codebaseGraphIndex', name: 'codebase-graph-index' });
 * const channel = client.getChannel('index');   // 入口模块注册的就是 'index'
 * ```
 *
 * 连带影响（实施时一并处理，避免留下死代码 ✗）：
 * 1. `electron-main/codebaseGraphIndexChannel.ts`（main 宿主）与 `src/vs/code/electron-main/app.ts`
 *    里的注册**将变为多余 ⇒ 应移除**（它们当前的价值只是"验证过 IPC 链路" ✓）；
 * 2. 本代理（`browser/codebaseGraphIndexProxy.ts`）需改为从 **worker client** 取通道
 *    （而不是 `mainProcessService.getChannel`）——其余（契约/不变量测试）完全可复用 ✓；
 * 3. worker 生命周期**随窗口**（不是"随 app" ✗）：每窗口一个索引进程。对本目标（把 CPU 活赶出
 *    renderer 主线程 ✓）够用；**若将来要求"多窗口共享一份索引"，需作另设计**（勿误以为已实现 ✗）。
 *
 * ### ★ 2026-09-19（Step 3）：上述三条**已实施** ✓
 *
 * - main 宿主 `electron-main/codebaseGraphIndexChannel.ts` **已删除**，`app.ts` 的 import 与
 *   `registerChannel` **已移除**（那条链路的价值只是"验证过 IPC 能通" ✓，现已由 worker 直连取代 ✗）；
 * - renderer 代理 `browser/codebaseGraphIndexProxy.ts` 改为经
 *   `IUtilityProcessWorkerWorkbenchService.createWorker(...)` **直连 worker**：**惰性建进程**
 *   （构造零成本 ✓）+ **失败不进缓存**（允许重试 ✓）+ 非正常退出打 WARN（不静默 ✗）；
 * - worker 身份（moduleId / type / name / 通道名）由本文件的 `CODEBASE_GRAPH_INDEX_WORKER` 单点定义 ✓，
 *   入口模块与代理都从它取，杜绝"两边各写字符串"✗。
 *   ⚠ 框架约束（`IUtilityProcessWorkerWorkbenchService.createWorker` 的文档）：**同一窗口对同一
 *   `moduleId` 重复调用会终止前一个进程** ⇒ 代理里用「单次 promise 缓存」既是性能也是正确性要求 ✗✓。
 *   ⚠ `IUtilityProcessWorkerWorkbenchService` 在**两个 renderer 入口都注册**（`workbench/electron-browser/desktop.main.ts:235`
 *   与 `sessions/electron-browser/sessions.main.ts:244`）⇒ 本仓「入口换子类」的 `AgentLayoutDesktopMain`
 *   （继承 `DesktopMain`）同样有它 ✓。

 * ## 必须随代码一起保持的不变量（8 条契约测试钉住，搬家后要把断言指向新文件）
 * ② FTS 不得整库重复重建；⑤ 载入同步判据要看节点数；⑦ 快照失败必须回退 JSON 并告警；
 * 以及「缺 grammar 必须显式报错」「内存判据为本轮增量」等。
 *
 * ## ★★★ Step 4 侦察结论（2026-09-19，**动手搬编排前必读**）：整体搬迁**不可行**，只能逐块搬
 *
 * 实机验收先通过 ✓：重载后日志出现
 * `[CodebaseGraph] [index-channel] 探活 OK：isRunning=false（P2-1 Step 3：索引 utility process 直连已连通）`
 * （`isRunning` 能拿到返回值 ⇒ 进程确实起来了、`'index'` 通道也通了 ✓，不依赖任何猜测）。
 *
 * 随后的依赖侦察得到**两条硬阻塞**，它们直接改变 Phase 1 的施工方式：
 *
 * ### 阻塞 1：**解析（tree-sitter）搬不走**，除非重写适配层
 * `browser/codebaseGraphParserPool.ts:184-187` 用 `new Blob([workerCode]) + URL.createObjectURL` +
 * CSP 包装 `wrapWorkerUrl` 起 **Web Worker**，`:238` 是 `new Worker(url)`，`:204` 读
 * `navigator.hardwareConcurrency` ⇒ utility process（Node：无 DOM / 无 Blob URL / 无 `navigator`）
 * **跑不了这套实现** ✗。算法主体（`codebaseGraphWorkerCode.ts` 的 `walkAST` 等）与宿主无关、可复用 ✓，
 * 但「起线程 + 喂 wasm」这一层必须改成 `worker_threads` + `fs` 读 wasm（`:150-169` 现在是
 * `FileAccess.asFileUri` + `IFileService`）⇒ 属**独立一块重写**，别指望顺手搬 ✗。
 *
 * ### 阻塞 2：renderer 内存 store 被**同步**消费者依赖
 * `hasGraphData()` / `getClassHierarchy()` / `getNodeReferences()` / `getProjectRoots()` / 同步 `searchGraph()`
 * 全是**同步**读内存 store（调用方见 `browser/codebaseGraphVaxSearch.contribution.ts` 的 GotoImpl / ListMethods 等）
 * ⇒ 只搬编排、不动它们：图**不会消失**（store 仍常驻 ✓）但**也解除不了 renderer 的堆压力** ✗。
 * ⇒ 这正是「路线 A（同步消费者改 async）」被定为**终局唯一前置**的原因（见上文「路线决定」段 ✓）。
 * ⚠ 另有一处非 fs 依赖：`_syncGraphToSqlite` / `_syncIncrementalToSqlite` / `_ensureSqliteFreshness` 走的是
 * 通往 **main 进程**的 SQLite 通道 ⇒ 搬进 utility 后需要**另开一条 worker→main** 的通道，不是"纯计算" ✓。
 *
 * ### ★★ 实测校正（2026-09-19 16:0x，**以日志为准，别按架构直觉排期** ✗✗）
 *
 * 取真机基线（`node .codebuddy/probe-graph-phases.cjs`，dev renderer.log）：
 * ```
 * 增量索引阶段耗时: 获取索引锁=193ms[阻塞41ms] | watcher变更集快路径=1ms | 解析10个文件=795ms[阻塞125ms]
 *   | BM25跳过(FTS5)+checkpoint=0ms | 克隆检测(新节点1306)=12ms | 继承边+使用边匹配=51ms
 *   | SQLite增量补丁=747ms | 合计=1799ms
 * 增量索引阶段耗时: 获取索引锁=158ms[阻塞157ms] | 解析1个文件=8ms | 克隆检测(新节点5)=5ms
 *   | 继承边+使用边匹配=28ms | SQLite增量补丁=23ms | 合计=223ms
 * loadGraphMerge("sarosis-agents-client") 返回 true，耗时 4731ms —— **载入路径的打点其实很完整** ✓（见下面两行）
 * [loadMerge] 解析分解：nodes=944ms〔180035 个（扫描164 / 解析125 / 68 批）〕 / edges=1404ms〔522220 个（扫描193 / 解析122 / 138 批）〕
 * [loadMerge] 阶段耗时：解压制品=537ms[阻塞2999ms] / 解析 JSON=2362ms[阻塞484ms] / 路径迁移=68ms[阻塞18ms]
 *                     / 完整性校验=55ms / 写入内存 store=940ms[阻塞47ms] / BM25=跳过 ｜合计 3962ms
 * ```
 * ⇒ **三条被实测推翻/修正的结论**：
 * 1. ❌「**克隆检测/边匹配是首块**」—— 增量实测仅 **5–51ms** ⇒ 搬进 worker **收益 ≈ 0** ✗（原排序来自架构直觉，非测量）。
 * 2. ❌（**我上一条自己写错的，在此更正** ✗）「载入 4731ms 里有 4.7s 是未打点的黑洞、要先补打点」——
 *    实为**打点齐备** ✓：分项和 3962ms ≈ `merged (3967ms)`，剩余 ~764ms 是合并之后的收尾（不大）。
 *    **真正的大头 = `解析 JSON 2362ms`**（= nodes 944 + edges 1404 ✓，与"主仓 2.5s JSON 解析"的既有结论一致）
 *    ⇒ 最省的解法是**零代码**的：把 `artifactFormat` 切到 `sqlite`，直接不解析 JSON ✓。
 * 3. ❌「**索引锁是阻塞点**」—— ⚠ `[阻塞Nms]` 的语义是「**自上次读取以来**的全局最长主线程占用」
 *    （看门狗 `takeMaxBlockMs()` **读即清零**），**不是"这段代码自己占的"** ✗。而锁获取全是 `IFileService` await
 *    （`_acquireIndexFileLock` 无同步重活）⇒ 那 157ms 很可能是**同期其它子系统**卡的 ⇒ **别据此给锁定罪** ✗。
 *    ★ **而且这条采集口径本身有缺陷，已修** ✓：本仓有**两个**读取者（增量索引的 `_seg` 与
 *    `loadMerge` 的 `timed`）而**没有任何一处清零** ⇒ 第一个读取者会揽下"自上次读取以来"的全部旧账 ✗
 *    —— 证据就是上面那个 `解压制品=537ms[阻塞2999ms]`（段 537ms 却报 2999ms 连续阻塞，**物理上不可能** ✓✓）。
 *    修法：`wsSwitchDiag.resetMaxBlockMs()`（序列开头**丢弃陈旧累积**）+ 两个消费者各调一次
 *    + 不变量 **⑩** 钉住「**有 take 就必须有 reset**」✓（contracts 现 **50 passing**）。
 * 4. ❌（**同日 16:33 实测推翻 —— 也是我自己上一条的错** ✗）「切 `artifactFormat=sqlite` 就能**零代码**打掉 JSON 解析」
 *    —— **只对了一半**：写出侧确实省了 ✓（实测日志 `SQLite 快照制品已写出：graph.db.sqlite（810251 节点 / 254663 边）`
 *    ＋ `跳过 JSON 制品序列化——renderer 不再做全图 gzip+JSON` ✓），但**载入侧仍然解析 JSON** ✗
 *    （切档后重载实测：`[loadMerge] 阶段耗时：解压制品=854ms / 解析 JSON=2984ms[阻塞526ms] / …` ✓）。
 *    **根因**：`loadSnapshotArtifact()` 与 `canSkipArtifactParse()` **只被定义、全 `src/` 零调用者** ✗
 *    （grep 证据：仅本服务的接口签名 / 实现 / 注释）⇒ **P1-1 步骤 3 的"载入侧接线"从未完成** ✗✓。
 *    ⚠ 附带代价：`VACUUM INTO` 产出的是**整库拷贝**，实测 **892MB / folder**（同目录 `graph.db.zst` 仅 **8.18MB**）✗
 *      —— 因为快照含 FTS5 索引。⇒ 在接线之前，切 sqlite 档 = **只付磁盘代价、拿不到载入收益** ✗✓（本轮已回退为 json）。
 *    ⇒ 正确的下一步**不是"切档"**，而是**把载入侧接上**：`artifact.json.format === 'sqlite-snapshot'` 且快照存在 ⇒
 *      `loadSnapshotArtifact(snapPath)`，否则回退 JSON。
 *      ⚠ 还要一并理清触发条件：实测主进程 SQLite **落后于制品**
 *      （`SQLite already has project "…" (167810 nodes)` vs artifact `180115`）⇒ 即便接上，`canSkipArtifactParse`
 *      也会返回 false（它要求 `sqlite ≥ artifact`）✗ ⇒ 「快照档 + 跳过解析」这两条路的判据要一起设计 ✓。
 *
 * ### 建议施工顺序（**按实测重排**；前 3 块都不触碰同步查询路径 ⇒ 每块可独立验证 ✓）
 * 0. **载入路径的 `解析 JSON ≈2.4–4.3s`** —— **不必补打点** ✗（已齐备，见上）；
 *    ⚠ 「切 `artifactFormat=sqlite` 即可零代码解决」**已被实测推翻** ✗（载入侧没接线，见结论 4）
 *    ⇒ 真正的下一步 = **接通载入侧**（`loadSnapshotArtifact` / `canSkipArtifactParse`，即 P1-1 步骤 3 的收尾）；
 *    其次才是 `写 store 940–1388ms` / `解压 537–854ms`；它正是「切工作区 / 开窗口卡死」的主因段 ⇒ **优先级最高** ✓；
 * 1. **SQLite 增量补丁**（实测 **747ms** / 1316 节点 + 1891 边；低变更量时 22–23ms ⇒ 与变更量成正比、方向没错）：
 *    它 await 主进程 SQLite（**不阻塞交互**，但拖长一轮）⇒ 先看 **FTS 逐行写** 与 IPC 往返能否批量化，
 *    而**不是**搬进程（搬进程反而多一跳 ✗）；
 * 2. **解析后"写图"的主线程段**（`解析N个文件=795ms` 里 **阻塞 125ms**）：解析已在 Web Worker ✓，
 *    剩下是主线程写节点/边 ⇒ 用切片 / 批量写削峰（不涉及进程迁移 ✓）；
 * 3. **索引锁 + 扫描/分类**（纯 fs、结果可序列化回传）—— 仍是「utility 能读盘」的最小冒烟，
 *    但**收益需先测量再定** ✗（见上文：`[阻塞Nms]` 不能给它定罪）；
 * 4. **克隆检测 / 边匹配三件套**（`_runSimilarityPass` / `_matchCalls…`）—— 增量路径实测 **5–51ms** ⇒ **暂缓** ✗；
 *    只有**全量索引**（52 万边量级）才可能值钱 ⇒ 想搬必须先测全量路径的分段耗时；
 * 5. **解析适配层重写**（`worker_threads` + fs 喂 wasm）—— 难，但是「把 store 也搬走」的前置；
 * 6. **同步消费者 async 化 + 释放内存 store** —— **收口**：不做它，进程迁移解除不了 renderer 堆压力 ✗。
 *
 * ⚠ 两条搬迁纪律：
 *   · 跨进程后**"早于订阅的进度会丢"**（renderer 现状是同步 fire ✓）⇒ 进度只能**轮询**（见 `getProgress` ✓）；
 *   · 每搬一块都要跑一遍 8+ 条不变量套件，并确认 `[MemSnap]` 的 dom / 堆曲线**没退化** ✓。
 *
 * ## 必须随代码一起保持的不变量（8 条契约测试钉住，搬家后要把断言指向新文件）
 * ② FTS 不得整库重复重建；⑤ 载入同步判据要看节点数；⑦ 快照失败必须回退 JSON 并告警；
 * 以及「缺 grammar 必须显式报错」「内存判据为本轮增量」等。
 */

/**
 * ★ 2026-09-19（Step 3）：索引 **worker 的身份** —— renderer 起进程与入口模块注册通道**共用这一份定义** ✓。
 *
 * ⚠ 曾经的 `CODEBASE_GRAPH_INDEX_CHANNEL = 'vssaros-codebase-graph-index'`（主进程通道名）**已随
 * main 宿主与 `app.ts` 的注册一并删除**（见 header「方案 B · 已实施」）——留着就是死代码 ✗，
 * 而且会误导后人以为还存在一条 renderer → main 的索引路径 ✗。
 */
export const CODEBASE_GRAPH_INDEX_WORKER = {
	/** 入口模块：`src/vs/sessions/contrib/agentStudio/node/codebaseGraphIndexWorkerMain.ts`（无 `.js`，按 `out/` 解析 ✓）。 */
	moduleId: 'vs/sessions/contrib/agentStudio/node/codebaseGraphIndexWorkerMain',
	/** `createWorker` 的进程类型（诊断口径）。 */
	type: 'codebaseGraphIndex',
	/** `createWorker` 的进程名。 */
	name: 'codebase-graph-index',
	/**
	 * 入口模块**注册**的 channel 名；renderer 用 `client.getChannel(...)` 取同一份定义 ✓。
	 * ⚠ 不得两边各写字符串 —— 一旦漂移，取通道会静默拿到 `undefined`（本仓反复踩过"静默"✗）。
	 */
	channel: 'index',
} as const;

/** 一次索引请求（full / incremental 共用）。 */
export interface ICodebaseGraphIndexRunRequest {
	/** 索引根（工作区 folder 的绝对路径）。 */
	readonly rootPath: string;
	/** 目标项目名（**必须与制品 `project`、SQLite `project` 口径一致** —— 曾因口径漂移导致查询反复回退）。 */
	readonly project: string;
	/** `full` = 全量；`incremental` = 增量（需带 `changeSet`）。 */
	readonly mode: 'full' | 'incremental';
	/**
	 * watcher 已算好的变更集（**相对于 root 的路径**，`/` 分隔）—— 提供时走快路径，
	 * 跳过全量扫描（实测：单文件保存若全量扫 6351 文件要 23s ✗）。
	 */
	readonly changeSet?: { readonly added: readonly string[]; readonly modified: readonly string[]; readonly deleted: readonly string[] };
	/** 已生效的排除目录（用户设置 + profile 解析结果），未传则由进程侧解析。 */
	readonly excludeDirs?: readonly string[];
	/** 被 keepDirs 例外保留的目录（与 `excludeDirs` 成对使用）。 */
	readonly keepDirs?: readonly string[];
}

/** 进度事件（复用 renderer 侧已有的 `onDidIndexProgress` 文案口径，避免两套措辞）。 */
export interface ICodebaseGraphIndexProgress {
	/** 阶段名（与 renderer 现状一致，如 `获取索引锁` / `解析15个文件` / `SQLite增量补丁`）。 */
	readonly stage: string;
	/** 人类可读的一行（可直接进 UI 进度条）。 */
	readonly message: string;
	readonly done?: number;
	readonly total?: number;
	/** 阶段耗时（ms），收尾对账用。 */
	readonly elapsedMs?: number;
}

/** 一次索引的结果（与 renderer 侧 `IIndexResult` 的字段保持可映射）。 */
export interface ICodebaseGraphIndexRunResult {
	readonly success: boolean;
	readonly kind: 'full' | 'incremental';
	readonly message: string;
	readonly rootPath?: string;
	/** 本次写入/更新的节点与边数（诊断与「退化可见」判据用）。 */
	readonly nodes?: number;
	readonly edges?: number;
	readonly files?: number;
	readonly elapsedMs?: number;
}

/**
 * 索引通道（Phase 1 目标形态）。
 *
 * ⚠ 刻意用「方法 + 回调注册」而不是 EventEmitter 类型：跨进程传输时不引入额外依赖 ✓。
 * ⚠ `onProgress` 返回**取消函数**（而不是 `IDisposable`）—— 同样为了零 import ✓。
 */
export interface ICodebaseGraphIndexChannel {
	/** 启动一次索引；同一 project 已在跑时，宿主应直接返回「进行中」而不是排队（与现状 `_isIndexing` 语义一致 ✓）。 */
	runIndex(request: ICodebaseGraphIndexRunRequest): Promise<ICodebaseGraphIndexRunResult>;
	/** 取消指定 project 的索引（对应现状的 `CancellationTokenSource` ✓）。 */
	cancel(project: string): Promise<void>;
	/** 查询是否正在索引（现状对应 `_isIndexing` ✓）。 */
	isRunning(project: string): Promise<boolean>;
	/**
	 * 取**最近一次**进度（轮询式，不是推送）。
	 *
	 * ★ 2026-09-19 修正（写代理时踩到）：原草案是 `onProgress(listener)`，但
	 * `ProxyChannel.toService` **只做请求/响应**，不支持宿主主动推送 ✗ ⇒ 那种签名无法被诚实实现
	 * （会变成一个"返回值语义错误的假接口"✗）。改为轮询：宿主保存「最近一条进度」，renderer 按需拉取
	 * （索引进度是秒级变化，低频拉取代价可忽略 ✓）。
	 * ⚠ 若将来确实需要推送，应**另配 event channel**，而不是改本方法语义 ✓。
	 */
	getProgress(project: string): Promise<ICodebaseGraphIndexProgress | undefined>;
}

/**
 * ## 路线决定（2026-09-19，用户拍板）：**走 A —— 同步消费者改 async，renderer 最终不持图**
 *
 * 含义（Phase 1 之后、Phase 3 的终局）：
 * - 索引完成后**只回「完成 + 统计」**，**不把图推回 renderer**（跨进程大对象克隆代价高 ✗）
 * - 渲染进程的图谱查询逐步改走既有 **SQLite / FTS5 通道**（`codebaseGraphStoreChannel` ✓ 它已是真源）
 * - `hasGraphData()` / 同步 `searchGraph()` 的调用方需改为 async —— **施工图（已定位，仅两处）**：
 *   · `browser/codebaseGraphVaxSearch.contribution.ts:355` → `[CodebaseGraph:GotoImpl]`
 *   · `browser/codebaseGraphVaxSearch.contribution.ts:560` → `[CodebaseGraph:ListMethods]`
 *   （依据：`codebaseGraphService.ts:1159` / `:1260` 的既有注释明确点名这两条同步路径依赖内存 store ✓）
 *
 * ⚠ Phase 1 **不动**这两处 —— 先只把「索引编排」搬走（不碰同步查询 ⇒ 零风险 ✓）；
 * Phase 3 再逐个改成 async，并把 renderer 的内存 store 逐步释放（每改一个跑一次 8 条不变量套件 ✓）。
 */
