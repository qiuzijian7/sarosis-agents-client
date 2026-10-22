/*---------------------------------------------------------------------------------------------
 *  「清空所有会话」的**范围计算**（纯逻辑，无 DOM / 无服务）
 *
 *  为什么单独抽出来（2026-10-19）：这是侧栏里唯一一个**破坏性且批量**的动作 ——
 *  "到底会删掉哪几条"必须能被单测钉住，而不是埋在视图方法里靠肉眼看。
 *  视图（`browser/sessionHistoryView.ts`）只负责按这份计划渲染与逐条执行。
 *
 *  ⚠ 语义（改这里 = 改用户看到的文案，两边必须一起动）：
 *    · 范围只认 **agent 筛选**：搜索是"找东西"，不是"定义范围" ⇒ 把"清空所有会话"
 *      变成"清空搜索结果"会让按钮名字与结果对不上 ✗。
 *    · 三类跳过：**运行中/等待中**（默认）、**已固定**（默认）、**聊天区已打开**（无开关）。
 *      打开中的一律跳过：既有 `deleteAgentSession` 只删数据、不关编辑器 ⇒
 *      删掉会让聊天区指着一条已不存在的会话 ✗（想删它请先关掉那个页签）。
 *    · 一个会话同时命中多类时**只计一次**（顺序：运行中 → 已固定 → 已打开）。
 *--------------------------------------------------------------------------------------------*/

/** 参与范围计算所需的最小会话形状（视图里的 `SessionData` 超集）。 */
export interface IClearAllSessionLike {
	readonly agentId: string;
	readonly sessionId: string;
	readonly pinned?: boolean;
	readonly chatOpen?: boolean;
}

export interface IClearAllPlan {
	/** 真正会被删除的那些（按入参顺序）。 */
	readonly targets: readonly IClearAllSessionLike[];
	readonly skippedRunning: number;
	readonly skippedPinned: number;
	readonly skippedOpen: number;
	/** 运行中 / 等待中的**总数**（与开关无关 ⇒ 面板上那个数字不随勾选跳变 ✓）。 */
	readonly runningCount: number;
	readonly pinnedCount: number;
}

/**
 * 计算这次「清空」的范围。
 *
 * @param agentFilter 当前 agent 筛选（空串 = All Agents）。搜索词**不参与**（见文件头）。
 * @param isActive    该会话是否"正在运行 / 等待用户"（视图侧由 `_runPhases` 判定 ⇒ 这里注入）。
 */
export function planClearAll(opts: {
	readonly sessions: readonly IClearAllSessionLike[];
	readonly agentFilter: string;
	readonly skipRunning: boolean;
	readonly skipPinned: boolean;
	readonly isActive: (s: IClearAllSessionLike) => boolean;
}): IClearAllPlan {
	const { sessions, agentFilter, skipRunning, skipPinned, isActive } = opts;
	const scope = sessions.filter(s => !agentFilter || s.agentId === agentFilter);

	const targets: IClearAllSessionLike[] = [];
	let skippedRunning = 0;
	let skippedPinned = 0;
	let skippedOpen = 0;
	let runningCount = 0;
	let pinnedCount = 0;

	for (const s of scope) {
		const active = isActive(s);
		if (active) { runningCount++; }
		if (s.pinned) { pinnedCount++; }
		// ⚠ 顺序即优先级：一个会话只进一个桶 ⇒ 三类计数相加不会超过总数 ✓
		if (skipRunning && active) { skippedRunning++; continue; }
		if (skipPinned && s.pinned) { skippedPinned++; continue; }
		if (s.chatOpen) { skippedOpen++; continue; }
		targets.push(s);
	}

	return { targets, skippedRunning, skippedPinned, skippedOpen, runningCount, pinnedCount };
}
