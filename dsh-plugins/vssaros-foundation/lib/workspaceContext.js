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
 * P0-1（2026-11-10）：**有序工作区根集**的兼容期地基。
 *
 * 两条口径并存，都必须认：
 *   · 老载荷 `workspaceRoot` + `relatedRoots[]`：**全量含主根**（IDE 侧 `_relatedRoots()` 推的是
 *     `[ws.path, ...relatedFolders]`），字段名"关联根"其实不精确 ⇒ 消费方若自己拼
 *     `[workspaceRoot, ...relatedRoots]` 会把主根算两次 ✗；
 *   · 新载荷 `roots: [{path,name,isPrimary}]`：结构化、带根名、显式主根（兼容期**可选**；
 *     老 IDE / 老 Host 不传 ⇒ 一切行为逐字不变 ✓）。
 *
 * 所有消费方**只读 `deriveWorkspaceRoots()`**，不许自己拼数组。本文件仍不 import cordis ✓。
 */
/** 根条数上限（与 `dshBridgeProtocol.ts` 的 `MAX_WORKSPACE_CONTEXT_ROOTS` 同值；守卫对账 ✓）。 */
export const MAX_WORKSPACE_ROOTS = 64;
/** 单个路径/根名长度上限（与桥侧 `MAX_WORKSPACE_CONTEXT_TEXT` 同值 ✓）。 */
const MAX_WORKSPACE_ROOT_TEXT = 4096;

/** 文本键：`undefined`/空白 ⇒ 没有这一项；非字符串 ⇒ 整份载荷作废（见 normalize 的 ★）。 */
const textOf = value => {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		return INVALID;
	}
	return value.trim() ? value.trim() : undefined;
};

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
	// 结构化根集（兼容期可选）：没给 ⇒ `undefined`；给了但畸形 ⇒ 整份拒收（不静默丢字段 ✓）。
	const roots = normalizeWorkspaceRoots(input.roots);
	if (roots === INVALID) {
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
		// ★ 只有新载荷才带这个键 ⇒ 老载荷的输出（含键顺序）逐字不变，回执/幂等比较都不受影响 ✓
		...(roots === undefined ? {} : { roots }),
		...(windowId === undefined ? {} : { windowId }),
		at,
	};
}

/**
 * 校验并规范化可选的结构化根集。
 * @returns `undefined` = 老载荷没传；`INVALID` = 传了但畸形（整份作废）；数组 = 合法（去重保序 ✓）。
 */
function normalizeWorkspaceRoots(raw) {
	const NUL = String.fromCharCode(0);
	if (raw === undefined) {
		return undefined;
	}
	if (raw === null || !Array.isArray(raw) || raw.length > MAX_WORKSPACE_ROOTS) {
		return INVALID;
	}
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return INVALID;
		}
		const p = typeof item.path === 'string' ? item.path.trim() : '';
		if (!p || p.length > MAX_WORKSPACE_ROOT_TEXT || p.includes(NUL)) {
			return INVALID;
		}
		// 与桥侧 `textOk` 同口径：`undefined` = 没给；`null` 也是畸形（两侧一致才不会"上游放行、真源拒收" ✗）
		if (item.name !== undefined
			&& (typeof item.name !== 'string' || item.name.length > MAX_WORKSPACE_ROOT_TEXT || item.name.includes(NUL))) {
			return INVALID;
		}
		if (item.isPrimary !== undefined && typeof item.isPrimary !== 'boolean') {
			return INVALID;
		}
		if (seen.has(p)) {
			continue; // 重复路径保留首次出现（有序根集的语义不能被重排 ✗）
		}
		seen.add(p);
		const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
		out.push({
			path: p,
			...(name === undefined ? {} : { name }),
			...(typeof item.isPrimary === 'boolean' ? { isPrimary: item.isPrimary } : {}),
		});
	}
	return out;
}


/** 参与"值是否变了"比较的字段（`at` / `windowId` 只是来源标签，不进比较 ✓）。 */
export function sameWorkspaceContext(a, b) {
	if (a === b) { return true; }
	if (!a || !b) { return false; }
	// `roots` 用字符串比：老载荷（undefined）与新载荷（数组）必须判成"变了" ⇒ 会广播一次 ✓；
	// 只改根名 / 主根标记也要广播（P0-2 的提示词 provider 靠它刷新 ✓）。
	const rootsKey = x => (x.roots === undefined ? '-' : JSON.stringify(x.roots));
	return (a.workspaceId ?? '') === (b.workspaceId ?? '')
		&& (a.workspaceRoot ?? '') === (b.workspaceRoot ?? '')
		&& a.relatedRoots.length === b.relatedRoots.length
		&& a.relatedRoots.every((root, i) => root === b.relatedRoots[i])
		&& rootsKey(a) === rootsKey(b);
}

/** 根名兜底：Windows/Posix 分隔符都认（纯字符串，不做 fs 访问 ✓）。 */
function basenameOf(p) {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : p;
}

/**
 * ★ P0-1 唯一读口：把一份（规范化后的）上下文派生成**有序、去重、主根在首位**的根集。
 *
 * 输入可以是老载荷、新载荷或两者的组合；输出形状恒定：
 * `[{ path, name, isPrimary }]`，第一项恒为主根（有根时）；没有根 / 没有上下文 ⇒ `[]`
 * （消费方据此 fail-closed，不猜 ✓）。
 *
 * 纯函数：不读 store、不改入参、无 I/O ⇒ 守卫/探针可直接 import 断言 ✓。
 */
export function deriveWorkspaceRoots(context) {
	if (!context || typeof context !== 'object') {
		return [];
	}
	const structured = Array.isArray(context.roots) ? context.roots : [];
	const named = new Map();
	for (const r of structured) {
		if (r && typeof r.path === 'string' && r.path.trim() && !named.has(r.path.trim())) {
			named.set(r.path.trim(), r);
		}
	}
	const primary = (() => {
		if (typeof context.workspaceRoot === 'string' && context.workspaceRoot.trim()) {
			return context.workspaceRoot.trim();
		}
		const flagged = structured.find(r => r && r.isPrimary === true && typeof r.path === 'string');
		return flagged ? flagged.path.trim() : undefined;
	})();
	const related = Array.isArray(context.relatedRoots) ? context.relatedRoots : [];
	// 老口径：`workspaceRoot` 是主根而 `relatedRoots` **全量含主根** ⇒ 拼起来统一去重即可 ✓
	const paths = [
		...structured.map(r => r?.path),
		...(primary ? [primary] : []),
		...related,
	].filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
	const unique = [...new Set(paths)];
	const primaryPath = (primary && unique.includes(primary)) ? primary : (unique.length ? unique[0] : undefined);
	// 主根必须在首位（结构化与新/老字段混着给时也不会漂 ✗）
	const ordered = primaryPath ? [primaryPath, ...unique.filter(p => p !== primaryPath)] : [];
	return ordered.map(p => ({
		path: p,
		name: (named.get(p)?.name && String(named.get(p).name).trim()) || basenameOf(p),
		isPrimary: p === primaryPath,
	}));
}

/** 查某个根的名字（P0-2 注入提示词时用；不在根集里 ⇒ `undefined`，不猜 ✓）。 */
export function rootNameOf(context, rootPath) {
	return deriveWorkspaceRoots(context).find(r => r.path === rootPath)?.name;
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
