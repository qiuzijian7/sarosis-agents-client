// @vssaros/dsh-agents — grants（Workspace Grant 的 cwd 闸，2026-10-16 二期；
// mockup doc/agents-grants-outbox-mockup.html 拍板点 ①②）。
//
// 语义（每句都要有牙齿）：
//   · agent 没写 workspaces 字段 ⇒ **收紧缺省**：只允许"不显式给 cwd"（= 引擎缺省工作区）；
//     显式给 cwd ⇒ 拒绝，并告诉用户怎么加声明 ✓；
//   · 写了 ⇒ 显式 cwd 必须在 read 清单里（write ⊆ read：写了 write 没写 read ⇒ read 自动含它）；
//   · 路径判定 = 归一化后**前缀匹配**（授权到目录 ⇒ 含其子目录 ✓），Windows 大小写/分隔符归一。
//
// 强制点（本闸被这三处调用，少一处都是漏）：agent_open_session（tools.js）/ 委派创建（assignments.js）
// / 群聊派发的现开会话（groups.js）。dsh 原生文件沙箱不动不代理（引擎层的事 ✗）。

/** 归一化（与 memory.js 的 samePath 同手法：分隔符 + 尾斜杠 + 大小写）。 */
export function normPath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** agent 的完整读清单（write 自动并入 read ✓）。 */
export function readScopeOf(agent) {
	const ws = agent?.workspaces;
	if (!ws) {
		return null; // 未声明
	}
	return [...new Set([...(ws.read ?? []), ...(ws.write ?? [])].map(normPath))];
}

/** cwd 是否被清单覆盖（前缀匹配 = 授权到目录含子目录 ✓）。 */
export function cwdCoveredBy(scope, cwd) {
	const want = normPath(cwd);
	return scope.some(entry => want === entry || want.startsWith(entry + '/'));
}

/**
 * cwd 闸。返回 undefined = 放行；否则返回**错误文案**（告诉用户怎么修，不只说"不行" ✓）。
 * @param agent core agent（含可选 workspaces）
 * @param cwd 调用方想用的 cwd（undefined/空 = 引擎缺省工作区）
 */
export function checkCwdGrant(agent, cwd) {
	const explicit = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
	if (!explicit) {
		return undefined; // 缺省工作区永远放行 ✓
	}
	const scope = readScopeOf(agent);
	if (scope === null) {
		return `${agent.name} 没声明 workspaces ⇒ 收紧缺省生效：只能在缺省工作区开会话，不能显式指定 cwd（${explicit}）。要放开：在它的 .agent.md 里加 workspaces-read: ${explicit}`;
	}
	if (!cwdCoveredBy(scope, explicit)) {
		return `${agent.name} 的 workspaces-read 不覆盖 ${explicit}（已授权：${scope.join('、') || '(空)'}）。要放开：在它的 .agent.md 里补这条`;
	}
	return undefined;
}
