// @vssaros/dsh-agents — grants（Workspace Grant 的 cwd 闸，2026-10-16 二期；
// mockup doc/agents-grants-outbox-mockup.html 拍板点 ①②）。
//
// 语义（每句都要有牙齿）：
//   · agent 没写 workspaces 字段 ⇒ **收紧缺省**：只允许"不显式给 cwd"（= 引擎缺省工作区）；
//     显式给 cwd ⇒ 拒绝，并告诉用户怎么加声明 ✓；
//   · 写了 ⇒ 显式 cwd 必须在 read 清单里（write ⊆ read：写了 write 没写 read ⇒ read 自动含它）；
//   · 词法判定 = 归一化后**按分隔符前缀**（授权到目录 ⇒ 含其子目录 ✓），Windows 大小写/分隔符归一；
//   · **P1-4（2026-11-10）**：词法命中只是快路径，之后还要过 canonical 复核 ——
//     `resolve` 消 `..`、`realpath` 消 symlink / junction / 8.3 别名，再按**路径组件**比较；
//     任何一步失败 ⇒ 拒（fail-closed ✓）。词法命中不再单独构成授权结论。
//
// 强制点（实际两处）：agent_open_session（tools.js）/ 委派创建（assignments.js）。
// ⚠ 群聊派发（rooms.js 的 placeOf / openSession）目前**没有**过这道闸 —— 已知缺口，
//   见本刀交付说明，不在此改动范围内。dsh 原生文件沙箱不动不代理（引擎层的事 ✗）。

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 归一化（与 memory.js 的 samePath 同手法：分隔符 + 尾斜杠 + 大小写）。 */
export function normPath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** agent 的完整读清单（write 自动并入 read ✓；归一化后用于词法快判与错误文案）。 */
export function readScopeOf(agent) {
	const ws = agent?.workspaces;
	if (!ws) {
		return null; // 未声明
	}
	return [...new Set([...(ws.read ?? []), ...(ws.write ?? [])].map(normPath))];
}

/** 声明里的**原始**路径（canonical 复核用；不小写化 ⇒ Linux 大小写敏感不会被抹平 ✓）。 */
export function rawScopeOf(agent) {
	const ws = agent?.workspaces;
	if (!ws) {
		return null;
	}
	return [...new Set([...(ws.read ?? []), ...(ws.write ?? [])]
		.filter(p => typeof p === 'string' && p.trim())
		.map(p => p.trim()))];
}

/**
 * P1-7（2026-11-10）：把群聊 `place` 判成"用户显式 cwd"还是"系统缺省"。
 * `workspaceId`（会话落在 dsh 工作区记录）与 `fallbackCwd`（系统兜底目录）都不是用户
 * 显式指定的 cwd ⇒ 必须与 `checkCwdGrant` 既有口径一致地放行，否则建群会大面积被拒 ✗。
 * @returns 显式 cwd 字符串；否则 `undefined`
 */
export function explicitCwdOf(place, fallbackCwd) {
	const cwd = typeof place?.cwd === 'string' ? place.cwd.trim() : '';
	if (!cwd) { return undefined; }
	const fallback = typeof fallbackCwd === 'string' ? fallbackCwd.trim() : '';
	if (fallback && cwd === fallback) { return undefined; }
	return cwd;
}

/** cwd 是否被清单覆盖（词法快判；按分隔符 ⇒ 兄弟目录不会被误命中 ✓）。 */
export function cwdCoveredBy(scope, cwd) {
	const want = normPath(cwd);
	return scope.some(entry => want === entry || want.startsWith(entry + '/'));
}

/** 按**路径组件**比较包含关系（不是字符串 startsWith）。 */
export function pathContains(root, target) {
	const rel = relative(root, target);
	if (rel === '') { return true; }
	if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) { return false; }
	return true;
}

/** 默认 realpath（注入点：守卫用假实现模拟 symlink，不碰真实文件系统 ✓）。 */
function defaultRealpath(p) {
	return realpathSync.native(p);
}

/** `resolve` 消 `..` + `realpath` 消别名；任一步失败 ⇒ `undefined`（调用方 fail-closed）。 */
export function canonicalPathOf(p, realpath = defaultRealpath) {
	if (typeof p !== 'string' || !p.trim()) { return undefined; }
	try {
		return String(realpath(resolve(p.trim())));
	} catch {
		return undefined;
	}
}

/** canonical 复核：目标与每个声明根都 realpath 后按组件比较；无可用根 / 全不包含 ⇒ 拒。 */
export function canonicalCoveredBy(rawScope, cwd, realpath = defaultRealpath) {
	const target = canonicalPathOf(cwd, realpath);
	if (!target) { return false; }
	for (const entry of Array.isArray(rawScope) ? rawScope : []) {
		const root = canonicalPathOf(entry, realpath);
		if (root && pathContains(root, target)) { return true; }
	}
	return false;
}

/**
 * P1-7：群聊现开会话的 grant 判定（**纯函数**，realpath 可注入 ⇒ 守卫能做行为断言）。
 *
 * 与 `agent_open_session` 的差异（刻意的，见 rooms.js 的注释）：
 *   · `workspaceId` / `fallbackCwd` 是系统兜底 ⇒ 等价"缺省工作区"，放行；
 *   · 群主会话没有对应 .agent.md（agent 为空）⇒ 放行，但调用方要留 warn；
 *   · 默认 bot 未声明 workspaces ⇒ 放行（群聊 cwd 来自 room 定义，不是开会话时的外部输入，
 *     套用"没声明就收紧缺省"会让所有默认 bot 的群聊建不起来 ✗）；
 *   · **声明了 workspaces 的 bot** ⇒ 与其他两处完全同一判据（含 canonical 复核）✓。
 * @returns 拒绝文案；`undefined` = 放行
 */
export function roomSessionGrantRefusal({ agent, place, fallbackCwd, realpath = defaultRealpath }) {
	const explicitCwd = explicitCwdOf(place, fallbackCwd);
	if (!explicitCwd || !agent || !agent.workspaces) { return undefined; }
	return checkCwdGrant(agent, explicitCwd, realpath);
}

/**
 * cwd 闸。返回 undefined = 放行；否则返回**错误文案**（告诉用户怎么修，不只说"不行" ✓）。
 * @param agent core agent（含可选 workspaces）
 * @param cwd 调用方想用的 cwd（undefined/空 = 引擎缺省工作区）
 * @param realpath 注入点（默认真实 fs；守卫/单测可换夹具）
 */
export function checkCwdGrant(agent, cwd, realpath = defaultRealpath) {
	const explicit = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
	if (!explicit) {
		return undefined; // 缺省工作区永远放行 ✓
	}
	// 防御：新的群聊调用面可能传来空 agent ⇒ 明确拒绝，不让它抛 TypeError ✗。
	// 既有两处调用点都保证 agent 非空 ⇒ 行为逐字不变 ✓。
	if (!agent || typeof agent !== 'object') {
		return `Workspace Grant 校验缺少 agent 定义 ⇒ 不能显式指定 cwd（${explicit}）`;
	}
	const scope = readScopeOf(agent);
	if (scope === null) {
		return `${agent.name} 没声明 workspaces ⇒ 收紧缺省生效：只能在缺省工作区开会话，不能显式指定 cwd（${explicit}）。要放开：在它的 .agent.md 里加 workspaces-read: ${explicit}`;
	}
	if (!cwdCoveredBy(scope, explicit)) {
		return `${agent.name} 的 workspaces-read 不覆盖 ${explicit}（已授权：${scope.join('、') || '(空)'}）。要放开：在它的 .agent.md 里补这条`;
	}
	if (!canonicalCoveredBy(rawScopeOf(agent), explicit, realpath)) {
		return `${agent.name} 的 workspaces-read 词法命中 ${explicit}，但 canonical 校验不通过（路径不存在 / 符号链接越界 / 大小写不一致）。请用真实绝对路径声明，或修正 .agent.md 的 workspaces-read`;
	}
	return undefined;
}
