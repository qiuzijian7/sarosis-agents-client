// @vssaros/dsh-bridge — P1-6（2026-11-10）：会话创建时的**根集快照**。
//
// ⚠ 只作诊断 / 校验，**不作授权**：会话的写权限仍完全由官方沙箱与 foundation 的运行期根集
//   决定（P0-3）。这里只是让"切了工作区、但正在跑的会话其实创建于另一个根集"这类静默错
//   在 Host 日志里可见，并给出明确指引（新开会话才生效）。
//
// 为什么不放进 foundation：foundation 是全局单值（多窗口共享、最后推的胜出），没有会话 id；
//   两条信息的交汇点在 bridge —— `session.start` 知道 sessionId，`workspace.context` 知道根集变更。
//   本文件不 import cordis / 不碰 fs ⇒ 守卫可直接 import 做行为断言 ✓。

/** 把根集（字符串或 `{path}` 对象数组）压成可比较的签名。 */
export function pathsOf(roots) {
	return (Array.isArray(roots) ? roots : [])
		.map(r => (typeof r === 'string' ? r : (r && typeof r.path === 'string' ? r.path : '')))
		.filter(p => typeof p === 'string' && p.trim())
		.map(p => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
}

/** 有序根集的签名（顺序不同 ⇒ 签名不同；大小写/分隔符/尾斜杠归一 ✓）。 */
export function signatureOf(roots) {
	return pathsOf(roots).join('|');
}

export function sameRootSet(a, b) {
	return signatureOf(a) === signatureOf(b);
}

/** 给日志用的变更摘要（只列路径，不列根名 ⇒ 日志稳定）。 */
export function describeRootChange(from, to) {
	const before = pathsOf(from);
	const after = pathsOf(to);
	return {
		added: after.filter(p => !before.includes(p)),
		removed: before.filter(p => !after.includes(p)),
	};
}

/**
 * 会话 id → 创建时根集签名 的内存表。
 * ⚠ 不持久化：Host 重启后 IDE 会重新推 `workspace.context` 并重新 `session.start`（幂等接管），
 *   快照由新请求重建 ⇒ 不隐式复活旧授权（与 ACP v2「resume 必须显式重传」同口径 ✓）。
 */
export function createSessionRootBindings() {
	const bound = new Map();
	/** 最近一次运行期根集（只给日志算 added/removed，不参与授权 ✓）。 */
	let previousRoots = [];
	return {
		/** 绑定 / 重新绑定（幂等接管同一 sessionId 时以这次为准 ✓）。 */
		bind(sessionId, roots) {
			if (typeof sessionId !== 'string' || !sessionId.trim()) { return; }
			bound.set(sessionId.trim(), signatureOf(roots));
		},
		/** 当前根集下，创建于**别的**根集的会话 id 列表（只报不改 ✓）。 */
		mismatches(roots) {
			const now = signatureOf(roots);
			return [...bound.entries()].filter(([, sig]) => sig !== now).map(([sid]) => sid);
		},
		signatureOf: sessionId => bound.get(sessionId),
		/** 最近一次运行期根集（供 `describeRootChange` 算摘要 ✓）。 */
		note(roots) { previousRoots = pathsOf(roots); },
		previous() { return [...previousRoots]; },
		clear(sessionId) { bound.delete(sessionId); },
		size() { return bound.size; },
	};
}
