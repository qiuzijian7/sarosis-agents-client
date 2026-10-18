// @vssaros/dsh-foundation — 运行期「工作区上下文」（2026-10-17）。
//
// ## 为什么要有它
// VsSaros 的工作区上下文（Agent Studio 的 `workspaceId`、工作区根、关联根）此前**只在 Host 启动时**
// 经 `--patch` 注入一次（`config.workspaceId` / `config.workspaceRoot` / `config.relatedRoots`）⇒
// 切工作区**必须重启 Host** 才能让新值生效，而重启会连正在跑的会话一起杀掉（用户 2026-10-17 的诉求：
// "我不想切换工作区就要重启"）。
// 这里把这三项变成**可以随时改的运行期真源**：IDE 切工作区时经控制桥推一份新的
// （`workspace.context`，见 `src/.../common/dshBridgeProtocol.ts`），消费插件每次用时读它 ✓。
//
// ## 三条纪律（改动前先看这三条）
//   ① **有上下文就以它为准**（不是"空值才回落"）—— 否则切到"没有关联根 / 没有活动工作区"的目标时
//      会把**旧工作区的值留着**，那正是"卡片静默写进旧工作区"的老病 ✗（比没有更糟：看起来正常 ✓）。
//   ② **没有上下文 ⇒ 逐字回落到 `config.<key>`**：老 Host（不认识这条方法）、探针（假 ctx）、
//      从未推过 —— 三种情形的行为都必须与"这条能力不存在"时**完全一致** ✓。
//   ③ 单值、**最后推的胜出**（Host 是被多窗口共享的；与从前"重启后那份 config 来自触发者"同语义 ✓）。
//      推的是谁记在 `windowId` / `at` 里，只作诊断展示，不参与解析 ✓。
//
// ⚠ 本文件**不 import cordis**（纯内存 + 一个回调集合）⇒ 探针/单测可以直接
// `createWorkspaceContextStore()` 建一个来验，不必起 Host ✓。

/** "这个键给了、但给错了类型"的哨兵（不是合法值 ⇒ 整份载荷作废 ✓）。 */
const INVALID = Symbol('vssaros.workspaceContext.invalid');

/**
 * 规范化一份上下文载荷。
 *
 * 返回值的**形状稳定**：`relatedRoots` 永远是数组（可能是空数组 ✓ —— 它表达"权威的空"，
 * 而不是"没给"；两者的区别正是纪律 ① 的落点）、另两个字段**缺就是缺**（`undefined`）。
 *
 * ★ **畸形一律拒收**（返回 `undefined`，调用方据此保留旧值）—— 不是"把坏字段悄悄丢掉留下其余的" ✗：
 *   静默丢字段会让"推了但没生效"伪装成成功（`applied:true` 而 workspaceId 其实是空的 ⇒
 *   用户以为切过去了、实际还在旧工作区写 ✗✗），所以下面每个已知键都做**类型校验**。
 *   空白串（`'  '`）例外：它按"没有这一项"处理 —— 它表达的正是"当前没有活动工作区"，
 *   消费方据此 fail-closed（不是拿一个空串当 id 用 ✓）。
 *
 * @param {unknown} input - IDE 推来的载荷（或探针自造的夹具）。
 * @returns {{workspaceId?: string, workspaceRoot?: string, relatedRoots: string[],
 *   windowId?: number, at: number} | undefined} `undefined` = 载荷不可用（不是对象 / 有非法类型的键）。
 */
export function normalizeWorkspaceContext(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	/** 文本键：`undefined`/空白 ⇒ 没有这一项；非字符串 ⇒ 整份载荷作废（见上面 ★）。 */
	const textOf = value => {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== 'string') {
			return INVALID;
		}
		return value.trim() ? value.trim() : undefined;
	};
	const workspaceId = textOf(input.workspaceId);
	const workspaceRoot = textOf(input.workspaceRoot);
	// 去重 + 去空白（顺序保持）——与相关根的消费口径一致 ✓
	let relatedRoots = [];
	if (input.relatedRoots !== undefined && input.relatedRoots !== null) {
		if (!Array.isArray(input.relatedRoots)) {
			return undefined;
		}
		const cleaned = [];
		for (const item of input.relatedRoots) {
			const text = textOf(item);
			if (text === INVALID) {
				return undefined;
			}
			if (text !== undefined) {
				cleaned.push(text);
			}
		}
		relatedRoots = [...new Set(cleaned)];
	}
	if (workspaceId === INVALID || workspaceRoot === INVALID) {
		return undefined;
	}
	if (input.windowId !== undefined && input.windowId !== null && !Number.isInteger(input.windowId)) {
		return undefined;
	}
	if (input.at !== undefined && input.at !== null && !Number.isFinite(input.at)) {
		return undefined;
	}
	const windowId = Number.isInteger(input.windowId) ? input.windowId : undefined;
	const at = Number.isFinite(input.at) ? Number(input.at) : Date.now();
	return {
		...(workspaceId === undefined ? {} : { workspaceId }),
		...(workspaceRoot === undefined ? {} : { workspaceRoot }),
		relatedRoots,
		...(windowId === undefined ? {} : { windowId }),
		at,
	};
}


/** 参与"值是否变了"比较的字段（`at` / `windowId` 只是来源标签，不进比较 ✓）。 */
export function sameWorkspaceContext(a, b) {
	if (a === b) { return true; }
	if (!a || !b) { return false; }
	return (a.workspaceId ?? '') === (b.workspaceId ?? '')
		&& (a.workspaceRoot ?? '') === (b.workspaceRoot ?? '')
		&& a.relatedRoots.length === b.relatedRoots.length
		&& a.relatedRoots.every((root, i) => root === b.relatedRoots[i]);
}

/**
 * 上下文仓库：内存单值 + 变更通知。
 *
 * 读侧：`get()` —— 消费插件每次解析时调（同步、零 I/O ✓，所以放进工具/页面的热路径没问题 ✓）。
 * 写侧：`set()` —— 由 `@vssaros/dsh-bridge` 收到 `workspace.context` 时调；探针也可以直接调 ✓。
 * 通知：`onDidChange(fn)` —— 需要在值变化时重算的东西用（例：看板 runner 的 cwd 解析）。
 */
export function createWorkspaceContextStore() {
	let current;
	const listeners = new Set();
	const notify = () => {
		for (const fn of [...listeners]) {
			try {
				fn(current);
			} catch {
				// 单个监听者炸了不能影响别人（也不能让桥的响应失败 ✗）
			}
		}
	};
	return {
		/** 当前上下文；`undefined` = 从未推过（或已被 `clear()`）⇒ 消费方回落到 config ✓。 */
		get() {
			return current;
		},
		/**
		 * 收一份新上下文。
		 * @returns 生效后的上下文；载荷畸形时返回 `undefined` 且**保留旧值**（不静默清空 ✓）。
		 */
		set(input) {
			const next = normalizeWorkspaceContext(input);
			if (!next) {
				return undefined;
			}
			// 值没变就**不广播**（IDE 每次连上都推一份 ⇒ 否则 runner 之类会白重算一轮 ✗）；
			// 但来源标签照更新（"最后推的是谁"要如实 ✓）。
			if (current && sameWorkspaceContext(current, next)) {
				current = next;
				return current;
			}
			current = next;
			notify();
			return current;
		},
		/** 清空（测试/诊断用；生产路径上没人调 —— 切"没有活动工作区"是推一份空值走 `set()` ✓）。 */
		clear() {
			if (!current) { return; }
			current = undefined;
			notify();
		},
		/** @returns 退订函数。 */
		onDidChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
}
