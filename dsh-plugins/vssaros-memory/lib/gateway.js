// @vssaros/dsh-memory — gateway 客户端（主机侧 I/O）。
//
// **不猜端口**：VsSaros 侧本来就按 app 形态派生端口（安装版 3111 / dev 3112），并且既存代码自己承认
// "候选地址逐个尝试…只能靠 [3111, 3112] 硬猜"是坏味道（可能连上异己网关）。所以本模块：
//   `config.gatewayUrl`（由 VsSaros 经 `--patch` 注入）→ `VSSAROS_MEMORY_GATEWAY_URL` 环境变量 → **不猜**。
// 没配就是"未配置"：工具明确报错、页面显示怎么配，而不是默默读到别人的库。

/** 超时（网关是本地进程，超过这个时间就是它坏了）。 */
const TIMEOUT_MS = 5000;

export function gatewayUrlOf(config) {
	const configured = typeof config?.gatewayUrl === 'string' ? config.gatewayUrl.trim() : '';
	if (configured) {
		return configured.replace(/\/+$/, '');
	}
	const fromEnv = typeof process.env.VSSAROS_MEMORY_GATEWAY_URL === 'string' ? process.env.VSSAROS_MEMORY_GATEWAY_URL.trim() : '';
	return fromEnv ? fromEnv.replace(/\/+$/, '') : null;
}

async function request(url, init = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { ...init, signal: ctrl.signal });
		const body = await res.text();
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}：${body.slice(0, 200)}`);
		}
		return body ? JSON.parse(body) : null;
	} catch (e) {
		if (e?.name === 'AbortError') {
			throw new Error(`网关 ${TIMEOUT_MS}ms 未响应（${url}）`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

export function requireGateway(config) {
	const base = gatewayUrlOf(config);
	if (!base) {
		throw new Error('记忆网关未配置：需要 config.gatewayUrl（VsSaros 经 --patch 注入）或环境变量 VSSAROS_MEMORY_GATEWAY_URL。'
			+ '不猜端口——猜错会读到另一个网关的库。');
	}
	return base;
}

/** `GET {base}/stats/{agentId}`（已核实端点 ✓，真机 200）。 */
export function stats(base, agentId) {
	return request(`${base}/stats/${encodeURIComponent(agentId)}`);
}

/**
 * provider 平面调用 —— **2026-10-13 真机订正** ✓✗。
 *
 * 真契约（三处独立证据 ✓）：
 *   ① `extensions/agentmemory-memory/src/agentMemoryProviderProxy.ts`
 *      L7-8 原话 "异步方法（`loadContext` / `writeMemory` / `searchMemory` / `getStats` / …）→ HTTP POST `/provider/<method>`" ✓；
 *      L41 `private get _providerBase() { return `${serverBase()}/provider`; }` ✓；
 *      L208 `fetch(`${_providerBase}/${encodeURIComponent(method)}`)`、body `JSON.stringify({ args })` ✓；
 *      L526 "agentId 为首参，对齐 host.mjs 的 `/provider` 路由约定" ✓。
 *      ⇒ **方法名 = `IMemoryProvider` 接口名（camelCase）**，**信封 = `{ args: [...] }` 参数数组** ✓。
 *   ② 真机探针（`127.0.0.1:3112`）：`POST /provider/searchMemory {args:[agentId,""]}` ⇒ **200 ＋ 真条目** ✓；
 *      `POST /provider/loadContext {args:[id,sid,undefined,{tokenBudget:1024}]}` ⇒ 200 ＋ `systemPrompt` ✓。
 *   ③ 反证：先前抄的 `POST {base}/mem::context` / `/mem::remember` / `/mem::core-add` ＋ **对象**信封 ⇒ **全 404** ✗
 *      （`/provider/mem::context` ⇒ `unknown provider method` ✗、根路径 ⇒ `not found` ✗）。
 *      ⚠ `mem::*` 是**另一套主机方法清单**（`core/memory.js` 里那句"取自方法清单" ✗ —— 清单没错，**平面错了** ✗）⇒ 别再照抄 ✗。
 */
export function providerCall(base, method, args) {
	return request(`${base}/provider/${encodeURIComponent(method)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ args: Array.isArray(args) ? args : [args] }),
	});
}

/**
 * 工作记忆文本：`loadContext(agentId, sessionId, query, options)` ⇒ 取 `reply.systemPrompt` ✓。
 *
 * ⚠ 两处**真机钉死**的细节（第三参放错 ⇒ 500 ✗）：
 *   · `query` 必须是 `undefined`（传 `''` 会让策展块整段消失 ✗）；
 *   · `tokenBudget` 在**第四参**的 options 里（`{tokenBudget:1024}` ⇒ 1686 字 ✓，`12` ⇒ 0 字 ✓ 预算真被尊重 ✓）。
 * 返回**纯字符串**（`''` = 没内容）；形状不认识时由调用方按错误处理（不静默 ✓）。
 */
export function workingContext(base, agentId, sessionId, tokenBudget) {
	return providerCall(base, 'loadContext', [agentId, sessionId, undefined, { tokenBudget }])
		.then(reply => (typeof reply?.systemPrompt === 'string' ? reply.systemPrompt : ''));
}

/**
 * 写记忆（`writeMemory(agentId, entry)`）：**类型路由在网关侧**（引擎按 `entry.type` 决定落 core / scope / KV）✓
 * ⇒ 本进程**不再**自己分叉 core-add/remember（那正是先前的坏点之一 ✗）。
 *
 * `entry` 形状照 `IMemoryEntry`（`common/providers.ts:935`）：`{id, type, content, metadata?, timestamp?, importance?}` ——
 * 只抄这一份接口形状（**不抄**引擎内部值形状；字段对不上时网关的第一道守卫会拒 ⇒ 失败可见 ✓）。
 */
export function remember(base, agentId, entry) {
	return providerCall(base, 'writeMemory', [agentId, entry]);
}

/**
 * 检索（`searchMemory(agentId, query, limit)`）——**也走 provider 平面** ✓✗。
 *
 * ⚠ 宿主路由 `POST {base}/search/{agentId}` **不能用**：① 空查询返回 `[]` ✗（而 `searchMemory` 空查询＝**全量列出** ✓，
 * `memory_list` 就靠这条）；② 只给 `[{id,score}]` **没有 content** ✗。真机两种都打过，正是这个差别 ✓。
 */
export function search(base, agentId, query, limit) {
	return providerCall(base, 'searchMemory', [agentId, query, limit]);
}

// ── 2026-10-13 批 1：把 IDE 侧"高级记忆工具"里**单方法**的那几个接上 ───────────────────────
// 形状一律照抄 IDE 调用点（不猜 ✗）：每一行都注了真源行号，改这里时先去那边核 ✓。

/**
 * 软删除 —— **写**（走工具层审批闸 ✓）。真源：IDE `unifiedMemoryTools.ts:162` ✓ ⇒ 引擎 `amFunctions.ts:1050` ✓。
 * ⚠ 引擎签名是 `forgetMemory(kv, agentId, memId)` ⇒ **只认 2 参** ✗：第 3 个 `reason` 会被引擎忽略 ✓
 *   （它只用于**审批文案 + 审计账本** ✓；IDE 也是这么传的 ✓）⇒ 多传一个**无害**，但别指望它进记忆库 ✗。
 * 返回：`Promise<boolean>` ✓（`true` ＝ 已标记 superseded ✓）。
 */
export function forgetMemory(base, agentId, memoryId, reason) {
	return providerCall(base, 'forgetMemory', [agentId, memoryId, reason]);
}

// ── 2026-10-14：**压缩**与**前沿队列**（真机实测确证可用后接入 ✓）─────────────────────────

/**
 * 会话压缩 —— **写，且不可逆** ✗✓。真源 `agentMemoryProviderV2.compressSession` ⇒ `amCompress.ts:112` ✓。
 *
 * ⚠⚠ 三件必须知道的事（源码 + **真机实测**双重确认 ✓）：
 *   ① **它把会话"未压缩的观察"逐条标记 `compressed=true` 写回**（`amCompress.ts:125-128` ✓）
 *      ⇒ 同一会话**第二次调用必然回 `null`**（已经没有"未压缩的"了 ✓）。
 *      ⇒ 真机实测踩到：我第一次调用成功、第二次（只多传了个 `project`）就回 `null`，
 *        **当时误判成"`project` 参数有坑"** ✗✗ —— 其实是第①条 ✓（这正是"先实测"的价值 ✓）。
 *   ② **`null` 有两种含义，而引擎把它们混在一起** ✗：`uncompressed.length === 0`（正常的"无事可做" ✓）
 *      与 `catch`（真失败 ✗）**都 `return null`** ⇒ 调用方**分不开** ⇒ 工具层**必须如实转述两种可能** ✓
 *      （与本仓"引擎回空要如实说、不能美化成成功"同一条纪律 ✓）。
 *   ③ 返回 `SessionSummary`：`{sessionId, project, createdAt, title, narrative, keyDecisions,
 *      filesModified, concepts, observationCount, agentId}` ✓。
 *
 * ⚠ `project` **刻意不暴露**：缺省由引擎取 `existing?.project || 'default'` ✓ 够用；
 *   而暴露它只会让模型有机会传错（上述第①条的迷惑性正是它造成的 ✓）。
 */
export function compressSession(base, agentId, sessionId) {
	return providerCall(base, 'compressSession', [agentId, sessionId]);
}

/**
 * 前沿队列追加 —— **写**。真源 `amRemaining.frontierAdd(agentId, concept, desc?, pri?)` ✓。
 * ⚠ 真机实测**返回完整对象**（`{id, concept, description, priority, sourceIds, createdAt}` ✓）
 *   ⇒ 与 `getTopLessons`/`searchLessons` 那种**恒空桩**不同 ✗，它是真实现且**真的落库** ✓。
 * ⚠ 它是"待探索概念队列"的**入队端** ✓；读取端已有（`frontierGet`/`frontierNext` 在只读白名单里 ✓）。
 * ⚠ 后两个参数**按需补位**：直接传 `undefined` 占位与"不传"在部分引擎实现里不等价 ⇒ 有值才 push ✓。
 */
export function frontierAdd(base, agentId, concept, desc, priority) {
	const args = [agentId, concept];
	if (desc !== undefined || priority !== undefined) { args.push(desc); }
	if (priority !== undefined) { args.push(priority); }
	return providerCall(base, 'frontierAdd', args);
}

/**
 * 触发哨兵 —— **写**（改 `status` → `triggered` + 记 `triggeredAt` ✓）。真源 `amAdvanced.ts:294` ✓。
 *
 * ⚠ 真机实测（2026-10-14）确认的两件事 ✓：
 *   ① **有明确的成功判据**：成功回 `{success:true}` ✓，失败回 `{success:false, error}` ✓
 *      —— 与 `compressSession` 那种"null 混两种含义"不同 ⇒ 这里可以**如实区分** ✓。
 *   ② ⚠⚠ **重复触发会失败**：`{success:false, error:"sentinel already triggered"}` ✓
 *      而 `sentinelList` 里那条的 `status` 已是 `triggered` ✓ ⇒ 那是**幂等保护**、**不是故障** ✗
 *      ⇒ 工具层必须**说清这一点**，否则模型会把它当报错去重试 ✗（真机实测踩到 ✓）。
 * ⚠ `result` 可选：触发时顺带记下当时的上下文 ✓（引擎侧类型是 `Record<string, unknown>` ✓）。
 */
export function sentinelTrigger(base, agentId, sentinelId, result) {
	const args = [agentId, sentinelId];
	if (result !== undefined) { args.push(result); }
	return providerCall(base, 'sentinelTrigger', args);
}

/**
 * 级联修复（把引用该被替代记忆的下游 state 条目标 stale）—— **写**。真源 `advancedMemoryTools.ts:351` ✓。
 * 返回**已核实** ✓（引擎 `amFinal.ts:16-20`）：`{ success: boolean; flagged: number }`；
 * 起点记忆不存在时明确回 `{ success: false, flagged: 0 }` ✓ ⇒ 判据用 `success === true` ✓。
 */
export function cascadeUpdate(base, agentId, memoryId) {
	return providerCall(base, 'cascadeUpdate', [agentId, memoryId]);
}

/**
 * 行动链结晶 —— **写**。真源 `routineCrystalFacetTools.ts:161` ✓。
 * 返回**已核实** ✓（引擎 `amAdvanced.ts:328-333`）：成功回 `Crystal`（含 `id` ✓），
 * **行动链 id 不存在时回 `null`** ✗ ⇒ `null` 是**失败**，不是"空结晶" ✓。
 */
export function crystallize(base, agentId, actionId) {
	return providerCall(base, 'crystallize', [agentId, actionId]);
}

/**
 * 多策略召回（`recallFormatted(agentId, query, strategy, limit)`）—— **只读** ✓。
 * 真源 `unifiedMemoryTools.ts:58-61` ✓：provider 不支持该方法时**回退 `searchMemory`** ✓（我们在工具层照做 ✓）。
 */
export function recallFormatted(base, agentId, query, strategy, limit) {
	return providerCall(base, 'recallFormatted', [agentId, query, strategy, limit]);
}

// ── 批 2c：治理（governance）／团队池（team）／联邦（mesh）／哨兵（sentinel）──────────
// 真源：`advancedMemoryTools.ts:48-300` ✓；形状从引擎源码取实 ✓（`amExtras.ts` / `amFinal.ts` / `amRemaining.ts` / `amAdvanced.ts` ✓）。

/** 按 id 精确删除 —— **写**。⇒ `{ deleted: number }` ✓（`amExtras.ts:118` ✓）。 */
export function governanceDelete(base, agentId, memoryIds) {
	return providerCall(base, 'governanceDelete', [agentId, memoryIds]);
}

/** 按条件批量删除 —— **写**（但 `filters.dryRun !== false` 时**只出计划** ✓）。⇒ `{deleted, matched, scanned, dryRun}` ✓（`amExtras.ts:132` ✓）。 */
export function governanceBulkDelete(base, agentId, filters) {
	return providerCall(base, 'governanceBulkDelete', [agentId, filters]);
}

/** 治理审计查询 —— **只读**。⇒ `Array<Record<string,unknown>>` ✓（`amFinal.ts:51` ✓）。 */
export function governanceAuditQuery(base, agentId, filter) {
	return providerCall(base, 'governanceAuditQuery', [agentId, filter]);
}

/** 共享到团队池 —— **写**。`teamShare(agentId, itemId, itemType, project?)` ⇒ `{success,item?,error?}` ✓（`amRemaining.ts:145` ✓）。 */
export function teamShare(base, agentId, itemId, itemType, project) {
	return providerCall(base, 'teamShare', [agentId, itemId, itemType, project]);
}

/** 查团队池 —— **只读**。`teamQuery(agentId, query?, teamId='default')` ⇒ items ✓（`amRemaining.ts:163` ✓）。 */
export function teamQuery(base, agentId, query) {
	return providerCall(base, 'teamQuery', [agentId, query]);
}

/** 加入联邦 peer —— **写**。`meshJoin(agentId, name, url, scopes)` ⇒ `MeshPeer` ✓（`amRemaining.ts:173` ✓）。 */
export function meshJoin(base, agentId, name, url, scopes) {
	return providerCall(base, 'meshJoin', [agentId, name, url, scopes]);
}

/** 列 peer —— **只读**。⇒ `MeshPeer[]` ✓（`amRemaining.ts:182` ✓）。 */
export function meshList(base, agentId) {
	return providerCall(base, 'meshList', [agentId]);
}

/** peer 下线 —— **写**。⇒ `boolean` ✓（`amRemaining.ts:187` ✓）。 */
export function meshLeave(base, agentId, peerId) {
	return providerCall(base, 'meshLeave', [agentId, peerId]);
}

/** 与 peer 同步 —— **写**。`meshSync(agentId, {peerId?,scopes?,direction?})` ⇒ `{success, results?, error?}` ✓（`amRemaining.ts:372` ✓）。 */
export function meshSync(base, agentId, options) {
	return providerCall(base, 'meshSync', [agentId, options]);
}

/** 建哨兵 —— **写**。`sentinelCreate(agentId, name, condition, type='threshold')` ⇒ `Sentinel` ✓（`amAdvanced.ts:133` ✓）。 */
export function sentinelCreate(base, agentId, name, condition, type) {
	return providerCall(base, 'sentinelCreate', [agentId, name, condition, type]);
}

/** 列哨兵 —— **只读**。⇒ `Sentinel[]` ✓（`amAdvanced.ts:138` ✓）。 */
export function sentinelList(base, agentId) {
	return providerCall(base, 'sentinelList', [agentId]);
}

/** 立即评估哨兵 —— **写**（可能触发 ✓）。⇒ `SentinelCheckResult` ✓（`amAdvanced.ts:224` ✓）。 */
export function sentinelCheck(base, agentId) {
	return providerCall(base, 'sentinelCheck', [agentId]);
}

/** 取消哨兵 —— **写**。⇒ `{success, error?}` ✓（`amAdvanced.ts:303` ✓）。 */
export function sentinelCancel(base, agentId, sentinelId) {
	return providerCall(base, 'sentinelCancel', [agentId, sentinelId]);
}

/** 导出 Obsidian 兼容 Markdown（`obsidianExport(agentId)`）—— **只读**（只返回文本 ✓，落盘由调用方决定 ✓）。真源 `advancedMemoryTools.ts:314` ✓。 */
export function obsidianExport(base, agentId) {
	return providerCall(base, 'obsidianExport', [agentId]);
}

// ── 批 2a：例程（routine）＋ 改进（improve）────────────────────────────────
// 参数位逐个照抄 IDE（`routineCrystalFacetTools.ts:78-128` ✓ / `unifiedMemoryTools.ts:106-127` ✓）；
// 返回形状逐个从**引擎源码**取实 ✓（`amRemaining.ts` / `amReplication.ts` / `amFunctions.ts` ✓）—— 不猜 ✗。

/**
 * 建例程 —— **写**。⚠ 首参是**对象**（provider 侧 `createRoutine(data)` ⇒ `rem.routineCreate(kv, data.agentId, data)` ✓，
 * 见 `agentMemoryProviderV2.ts:584` ✓）⇒ 这里必须包成 `[{ agentId, name, description, steps }]` ✓。
 * 返回 `Routine`（含 `id` ✓）。
 */
export function createRoutine(base, agentId, payload) {
	return providerCall(base, 'createRoutine', [{ agentId, ...payload }]);
}

/** 列例程 —— **只读**。`getRoutines(agentId)` ⇒ `Routine[]` ✓（`agentMemoryProviderV2.ts:585` ✓）。 */
export function getRoutines(base, agentId) {
	return providerCall(base, 'getRoutines', [agentId]);
}

/** 取单个例程 —— **只读**。`getRoutine(agentId, routineId)` ⇒ `Routine | null` ✓。 */
export function getRoutine(base, agentId, routineId) {
	return providerCall(base, 'getRoutine', [agentId, routineId]);
}

/** 起一次运行 —— **写**。`runRoutine(agentId, routineId)` ⇒ `RoutineRun`（含 `id` ✓；例程不存在时由引擎抛/回空 ✓）。 */
export function runRoutine(base, agentId, routineId) {
	return providerCall(base, 'runRoutine', [agentId, routineId]);
}

/** 回报一步 —— **写**。`routineStepUpdate(kv, agentId, runId, stepOrder, status, result?, error?)` ✓（`amRemaining.ts:102` ✓）。 */
export function routineStepUpdate(base, agentId, runId, stepOrder, stepStatus, result, error) {
	return providerCall(base, 'routineStepUpdate', [agentId, runId, stepOrder, stepStatus, result, error]);
}

/** 查运行状态 —— **只读**。`routineStatus(...)` ⇒ `RoutineStatusResult`，**失败时回 `{success:false,error:'run not found'}`** ✓（`amReplication.ts:248` ✓）。 */
export function routineStatus(base, agentId, runId) {
	return providerCall(base, 'routineStatus', [agentId, runId]);
}

/** 冻结/解冻 —— **写**。⇒ `{ success, routine?, error? }` ✓（`amReplication.ts:268` ✓）。 */
export function routineFreeze(base, agentId, routineId, frozen) {
	return providerCall(base, 'routineFreeze', [agentId, routineId, frozen]);
}

/** 删例程（连带它的运行）—— **写**。⇒ `boolean` ✓（`amRemaining.ts:132` ✓；例程不存在 ⇒ `false` ✓）。 */
export function routineDelete(base, agentId, routineId) {
	return providerCall(base, 'routineDelete', [agentId, routineId]);
}

// ── 批 2b：结晶（crystal 的 list/get/auto）＋ 多维标签（facet 6 action）──────────
// 真源：`routineCrystalFacetTools.ts:140-280` ✓；形状从引擎源码取实 ✓（`amAdvanced.ts` / `amFinal.ts` ✓）。

/** 列结晶 —— **只读**。`crystalList(agentId)` ⇒ `Crystal[]` ✓（`amAdvanced.ts:335` ✓）。 */
export function crystalList(base, agentId) {
	return providerCall(base, 'crystalList', [agentId]);
}

/** 取单个结晶 —— **只读**。⇒ `Crystal | null` ✓（`amFinal.ts:96` ✓）。 */
export function crystalGet(base, agentId, crystalId) {
	return providerCall(base, 'crystalGet', [agentId, crystalId]);
}

/** 自动结晶（把高强度记忆转成结晶）—— **写**。⇒ **`number`**（新建了几条 ✓；`amFinal.ts:100` ✓）。 */
export function autoCrystallize(base, agentId) {
	return providerCall(base, 'autoCrystallize', [agentId]);
}

/** 打标签 —— **写**。`facetTag(kv, agentId, targetId, targetType, dimension, value)` ⇒ `FacetRecord` ✓（`amAdvanced.ts:339` ✓）。 */
export function facetTag(base, agentId, targetId, targetType, dimension, value) {
	return providerCall(base, 'facetTag', [agentId, targetId, targetType, dimension, value]);
}

/** 按维度查标签 —— **只读**。`facetQuery(agentId, dimension, value?)` ⇒ `FacetRecord[]` ✓（`amAdvanced.ts:343` ✓）。 */
export function facetQuery(base, agentId, dimension, value) {
	return providerCall(base, 'facetQuery', [agentId, dimension, value]);
}

/**
 * 取某目标在某维度上的标签 —— **只读**。
 * ⚠ 形状已核实 ✓（`amFinal.ts:147`）：⇒ **数组** `Array<Record<string, unknown>>` ✗（不是记录或 `null` ✗）——
 * 真源 IDE 那句 `f ? … : 'No facet'` 对**空数组**也成立（空数组是 truthy ✗）⇒ 它的"没有"分支其实永不触发 ✓✗。
 * 我们按**诚实口径**处理：空数组 ＝ 没有标签 ✓（见工具的 render ✓）。
 */
export function facetGet(base, agentId, targetId, dimension) {
	return providerCall(base, 'facetGet', [agentId, targetId, dimension]);
}

/** 去掉标签 —— **写**。⇒ `boolean` ✓。 */
export function facetUntag(base, agentId, targetId, dimension) {
	return providerCall(base, 'facetUntag', [agentId, targetId, dimension]);
}

/** 维度统计 —— **只读**。⇒ `Record<string, number>` ✓（`amFinal.ts:118` ✓）。 */
export function facetStats(base, agentId) {
	return providerCall(base, 'facetStats', [agentId]);
}

/** 列出所有维度 —— **只读**。⇒ `string[]` ✓（`amFinal.ts:129` ✓）。 */
export function facetDimensions(base, agentId) {
	return providerCall(base, 'facetDimensions', [agentId]);
}

/**
 * 强化记忆（提升 `strength`）—— **写**。⇒ `boolean` ✓（`amFunctions.ts:1060` ✓：**记忆不存在 ⇒ `false`** ✓）。
 * ⚠ IDE 真源在"provider 没有这个方法"时会**回退成 `writeMemory` 写一条 `(reinforced)`** ✗（`unifiedMemoryTools.ts:112-118` ✓）——
 *   本模块**刻意不做**那条回退 ✗：它会**覆盖/新增一条假内容**，代价远大于"这次没强化成功" ✓（如实报错更划算 ✓）。
 */
export function reinforceMemory(base, agentId, memoryId) {
	return providerCall(base, 'reinforceMemory', [agentId, memoryId]);
}
