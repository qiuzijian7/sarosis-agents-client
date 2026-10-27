/*---------------------------------------------------------------------------------------------
 *  core/scope.js — **记忆作用域**的解析（★ 2026-10-27，跨进程真源）
 *
 * ## 为什么需要这个文件（两套口径的由来）
 * 同一台机器上，记忆引擎里的分区名有两套：
 *   · 工作区派生的 `ws-<workspaceId>`（本插件的 `partitionOf` 拼的）
 *   · 会话真实 agent / persona（`gr` / `default` / `knowledge-base-expert` …）
 * ⇒ **写 A 读 B** ⇒ 用户永远"没有记忆"（实测：`ws-*` 四层全 0，persona 分区有数千条）✗✗
 *
 * 渲染侧（IDE 注入/写入）已经统一到 `scopedMemoryAgentId()`，但它读的是
 * **宿主注入的 `globalThis.__SAROS_AGENTMEMORY_SCOPE_ALIAS__`** ——
 * 本插件跑在**另一个进程**，读不到那个全局对象 ✗
 * ⇒ 只注入全局 ⇒ 插件仍按自己的规则解析 ⇒ **两套口径会再次分叉** ✗✗
 *
 * ## 解法：真源落文件，三方共用
 *   `~/.vssaros-dev/memory-scope.json` = `{ from: 'ws-<wsId>', to: '<persona>', updatedAt, source }`
 *     · 写者：**网关**（渲染进程没有 fs ⇒ 它通过 `setScopeAlias` 委托网关写）
 *     · 读者 A：渲染侧（仍走 globalThis，零成本；两者由同一处写入 ⇒ 天然一致）
 *     · 读者 B：**本插件**（通过下面的 `readScopeSync` / `resolveMemoryScope`）
 *
 * ## 规则（与引擎 `scopedMemoryAgentId()` **必须一致**，由 `test/scopeParity.test.mjs` 双向对齐）
 *   ① 命中别名（`id === from`，或 `ws-` / `wa-` 变体）⇒ 用 `to`
 *   ② 否则有人设（persona）⇒ 用人设（本插件独有：dsh 会话知道自己的 preset 人设）
 *   ③ 否则原样返回（**不做任何猜测性映射** ⇒ 有数据的分区行为完全不变）
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataRootOf } from '../audit.js';

/** 作用域文件名（与网关 `_scopeFilePath()` 同根同名 ⇒ 两边指向同一个文件）。 */
export const SCOPE_FILE_NAME = 'memory-scope.json';

/**
 * 作用域文件的绝对路径（推导规则与 `lib/audit.js` 的账本目录**逐字节同形**）。
 * @returns 路径；无法定位数据根时返回 `''`（调用方按"没有别名"处理）
 */
export function scopeFilePath(config) {
	try {
		const root = dataRootOf(config);
		return root ? join(root, SCOPE_FILE_NAME) : '';
	} catch {
		return '';
	}
}

/**
 * mtime 缓存：`resolveMemoryScope` 在**回合钩子里同步调用**，
 * 不能每次 `readFileSync + JSON.parse`（回合是热路径）。
 * ⚠ 缓存键必须含 **mtimeMs**（宿主改别名时会重写文件 ⇒ mtime 变 ⇒ 自动失效 ✓）；
 *   文件被删除/不可读时缓存 `undefined`，不会复用旧别名 ✗
 */
let cache = { file: '', mtimeMs: 0, value: undefined };

/**
 * 同步读作用域文件（带 mtime 缓存）。
 * @returns `{ from, to, updatedAt }`；缺失/坏 JSON/字段不全/`from === to` 都返回 `undefined`
 */
export function readScopeSync(config) {
	const file = scopeFilePath(config);
	if (!file) { return undefined; }
	try {
		const st = statSync(file);
		if (cache.file === file && cache.mtimeMs === st.mtimeMs) { return cache.value; }
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		const from = typeof raw?.from === 'string' ? raw.from.trim() : '';
		const to = typeof raw?.to === 'string' ? raw.to.trim() : '';
		const value = from && to && from !== to
			? { from, to, updatedAt: Number(raw?.updatedAt) || 0 }
			: undefined;
		cache = { file, mtimeMs: st.mtimeMs, value };
		return value;
	} catch {
		// 文件不存在 / 坏 JSON / 权限问题 ⇒ 一律当作"没有别名"（**绝不能**因此抛到回合里 ✗）
		cache = { file, mtimeMs: 0, value: undefined };
		return undefined;
	}
}

/**
 * agentId 是否命中作用域别名的 `from`（含 `ws-` / `wa-` 变体）。
 * ⚠ 与引擎 `scopedMemoryAgentId()` 的命中规则**完全一致** —— 改这里必须同步改那边。
 */
export function matchesScope(agentId, scope) {
	if (!scope || typeof scope.from !== 'string' || !scope.from) { return false; }
	const id = String(agentId ?? '');
	if (!id) { return false; }
	return id === scope.from || id === `ws-${scope.from}` || id === `wa-${scope.from}`;
}

/**
 * 把"想写的分区 + 会话人设"解析成**实际写入/读取的分区**（纯函数，便于单测）。
 *
 * @param {object} input
 * @param {string} input.agentId 主分区（本插件通常给 `ws-<workspaceId>`）
 * @param {string} [input.persona] 会话人设（`personaIdOf(...)`；没有就传空）
 * @param {{from:string,to:string}|undefined} [input.scope] `readScopeSync()` 的结果
 * @returns {string} 实际作用域（恒为非空字符串；入参全空时返回 `''`）
 */
export function resolveMemoryScope(input) {
	const agentId = String(input?.agentId ?? '');
	const scope = input?.scope;
	// ① 有跨进程别名且命中 ⇒ 用别名的目标（**与渲染侧同一个答案** ✓）
	if (matchesScope(agentId, scope)) { return scope.to; }
	// ② 有会话人设 ⇒ 用人设（dsh 侧独有信息：它知道本会话选的是哪个 preset）
	const persona = typeof input?.persona === 'string' ? input.persona.trim() : '';
	if (persona) { return persona; }
	// ③ 都没有 ⇒ 原样（不乱猜）
	return agentId;
}
