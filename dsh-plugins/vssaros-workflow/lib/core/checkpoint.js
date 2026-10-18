// @vssaros/dsh-workflow — 工作流断点（checkpoint）的存取契约与崩溃一致性判定。
//
// 逐字移植自 `src/vs/sessions/contrib/agentStudio/common/workflowCheckpoint.ts`（TS → JS，
// 纯函数零依赖，逻辑一字未改 ✓）。两份的**行为一致性**由对账探针钉住（p3-103）——
// 改了一边没改另一边 ⇒ 探针红 ✓。

// ─── ① 写出 ────────────────────────────────────────────────────────────────

/** 单个 context 值的安全序列化（循环引用 / BigInt / 函数 → 退化为 String）。 */
function sanitizeContextValue(value) {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/**
 * 构造 checkpoint 对象（**写出格式的唯一真源**）。
 * 与 `parseWorkflowCheckpoint` 成对：两者的往返由测试保证（round-trip）。
 */
export function buildWorkflowCheckpoint(input) {
	const nodeStates = {};
	for (const [nodeId, ns] of input.nodeStates) {
		nodeStates[nodeId] = {
			status: ns.status,
			output: ns.output ?? null,
			error: ns.error ?? null,
			startTime: ns.startTime ?? null,
			endTime: ns.endTime ?? null,
		};
	}
	const context = {};
	for (const [key, value] of Object.entries(input.context ?? {})) {
		context[key] = sanitizeContextValue(value);
	}
	return {
		executionId: input.executionId,
		workflowId: input.workflowId,
		status: input.status,
		timestamp: input.timestamp ?? new Date().toISOString(),
		nodeStates,
		context,
		sharedMemory: [...(input.sharedMemory ?? [])].map(([k, v]) => [k, v]),
	};
}

// ─── ② 读入校验 ────────────────────────────────────────────────────────────

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value) {
	return typeof value === 'string' ? value : undefined;
}

/**
 * 解析并校验 checkpoint（磁盘内容不可信：手改、旧版本、写入被中断）。
 *
 * 校验原则：**结构性字段缺失即失败**（executionId / workflowId / nodeStates），
 * 其余字段**尽力归一**（缺失 → 缺省；类型不符 → 丢弃该字段），避免一个坏字段
 * 让整次恢复不可用。
 */
export function parseWorkflowCheckpoint(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `checkpoint JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: 'checkpoint 不是对象' };
	}
	const executionId = asOptionalString(parsed.executionId);
	const workflowId = asOptionalString(parsed.workflowId);
	if (!executionId) { return { ok: false, error: 'checkpoint 缺少 executionId' }; }
	if (!workflowId) { return { ok: false, error: 'checkpoint 缺少 workflowId' }; }
	if (!isRecord(parsed.nodeStates)) { return { ok: false, error: 'checkpoint 缺少 nodeStates' }; }

	const nodeStates = {};
	for (const [nodeId, rawState] of Object.entries(parsed.nodeStates)) {
		if (!isRecord(rawState)) { continue; }
		const status = asOptionalString(rawState.status);
		if (!status) { continue; } // 无状态的条目无意义 → 丢弃（该节点会被判为「需重跑」）
		nodeStates[nodeId] = {
			status,
			output: asOptionalString(rawState.output) ?? null,
			error: asOptionalString(rawState.error) ?? null,
			startTime: asOptionalString(rawState.startTime) ?? null,
			endTime: asOptionalString(rawState.endTime) ?? null,
		};
	}

	const context = {};
	if (isRecord(parsed.context)) {
		for (const [key, value] of Object.entries(parsed.context)) {
			const str = asOptionalString(value);
			if (str !== undefined) { context[key] = str; }
		}
	}

	const sharedMemory = [];
	if (Array.isArray(parsed.sharedMemory)) {
		for (const entry of parsed.sharedMemory) {
			if (!Array.isArray(entry) || entry.length < 2) { continue; }
			const [k, v] = entry;
			if (typeof k === 'string' && typeof v === 'string') { sharedMemory.push([k, v]); }
		}
	}

	return {
		ok: true,
		checkpoint: {
			executionId,
			workflowId,
			status: asOptionalString(parsed.status),
			timestamp: asOptionalString(parsed.timestamp),
			nodeStates,
			context,
			sharedMemory,
		},
	};
}

// ─── ③ 崩溃一致性判定 ──────────────────────────────────────────────────────

/**
 * 依据 checkpoint 判定「哪些节点可复用、哪些必须重跑」。
 *
 * @param checkpoint 已校验的 checkpoint
 * @param nodeIds    当前工作流的节点 id（**按执行顺序**；与 checkpoint 可能不同 —— 图被改过）
 */
export function planWorkflowResume(checkpoint, nodeIds) {
	const reusable = [];
	const toRun = [];
	const reasons = {};
	const added = [];

	for (const nodeId of nodeIds) {
		const state = checkpoint.nodeStates[nodeId];
		if (!state) {
			// 图在崩溃后被改过（新增节点）→ 必须执行
			toRun.push(nodeId);
			reasons[nodeId] = 'pending';
			added.push(nodeId);
			continue;
		}
		if (state.status === 'completed') {
			reusable.push(state.output != null ? { nodeId, output: state.output } : { nodeId });
			continue;
		}
		toRun.push(nodeId);
		reasons[nodeId] = toRerunReason(state.status);
	}

	const summary = `断点恢复：可复用 ${reusable.length} 个已完成节点，需重跑 ${toRun.length} 个`
		+ (added.length > 0 ? `（其中 ${added.length} 个为 checkpoint 之后新增的节点）` : '');

	return { reusable, toRun, reasons, added, summary };
}

function toRerunReason(status) {
	switch (status) {
		case 'running': return 'running';
		case 'failed': return 'failed';
		case 'cancelled': return 'cancelled';
		case 'skipped': return 'skipped';
		case 'pending': return 'pending';
		default: return 'unknown';
	}
}
