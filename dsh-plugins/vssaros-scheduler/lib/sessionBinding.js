// @vssaros/dsh-scheduler — 会话绑定归属（★ 2026-11-03「根治」）。
//
// 问题：任务里原先只存一个**裸 sessionId**。dev / 产品版是两套数据根、会话库各管各的，
//   在 dev 里点「用当前会话」写下的 id，到产品版 Host 里根本不存在 ⇒ bridge 抛
//   `session "session-57830003…"`，用户只看到被截断的半截 id，无从下手。
//
// 根治两件事：
//   ① **写入盖章**：绑会话时一并记 `sessionRoot`（当时的数据根）⇒ 跨环境一眼可判；
//   ② **投递前预检**：确认该会话在**当前数据根**里真实存在（会话被删也算）⇒ 不匹配就
//      直接记一条「归属校验未通过」的历史，不再发起注定失败的后台回合。
//
// ⚠ 兼容：旧任务没有 `sessionRoot` ⇒ 跳过「跨环境」判定，仍做存在性检查（照样能拦住）。

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataRootOf } from './store.js';

/** 统一成可比较的形式（Windows 反斜杠 / 大小写 / 尾斜杠都不影响判定）。 */
export function normalizeRoot(value) {
	const text = String(value ?? '').trim();
	// ⚠ 空串必须原样返回：`resolve('')` 会给出**当前工作目录**，那会让「旧任务（没盖过章）」
	//   被误判成 foreign（单测抓到的）。
	if (!text) { return ''; }
	try {
		return resolve(text).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	} catch {
		return '';
	}
}

/** 当前 Host 的数据根。`foundation` 尚未就绪时退回 config / 环境变量，绝不抛。 */
export function currentRoot(config) {
	try {
		const root = dataRootOf(config);
		if (root) { return normalizeRoot(root); }
	} catch { /* 未就绪 */ }
	return normalizeRoot(config?.dataRoot ?? process.env.VSSAROS_DATA_ROOT ?? '');
}

/** 该数据根里会话落盘的目录（`<数据根>/dsh-home/sessions`）。 */
export function sessionsDirOf(root) {
	return join(root, 'dsh-home', 'sessions');
}

/**
 * 会话 id 在指定数据根里是否真的存在。
 * 落盘形态：`<root>/dsh-home/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`。
 * 只扫两层（工作区 → 会话目录），低频调用（投递前 / 列表渲染）可接受。
 */
export function sessionExists(root, sessionId) {
	const id = String(sessionId ?? '').trim();
	if (!root || !id) { return false; }
	const base = sessionsDirOf(root);
	if (!existsSync(base)) { return false; }
	const wanted = id.startsWith('session-') ? id : `session-${id}`;
	let workspaces;
	try { workspaces = readdirSync(base, { withFileTypes: true }); } catch { return false; }
	for (const ws of workspaces) {
		if (!ws.isDirectory()) { continue; }
		const dir = join(base, ws.name);
		let entries;
		try { entries = readdirSync(dir); } catch { continue; }
		if (entries.includes(wanted) || entries.includes(id)) { return true; }
	}
	return false;
}

/**
 * 判定一条任务的会话绑定状态。
 * @returns {{state:'ok'|'unbound'|'foreign'|'missing', message:string, root:string}}
 */
export function bindingOf(task, config) {
	const id = String(task?.sessionId ?? '').trim();
	const cur = currentRoot(config);
	if (!id) {
		return { state: 'unbound', message: '未绑定会话（到点只记历史、不投递）', root: cur };
	}
	const recorded = normalizeRoot(String(task?.sessionRoot ?? ''));
	if (recorded && cur && recorded !== cur) {
		return {
			state: 'foreign',
			message: `会话属于另一个环境（${recorded}），当前是 ${cur || '(未知)'} ⇒ 请打开这条任务点「用当前会话」重新绑定并保存`,
			root: recorded,
		};
	}
	if (cur && !sessionExists(cur, id)) {
		return {
			state: 'missing',
			message: `会话 ${id} 在当前环境不存在（可能已被删除）⇒ 请打开这条任务点「用当前会话」重新绑定并保存`,
			root: cur,
		};
	}
	return { state: 'ok', message: '', root: cur };
}

/**
 * 写入前盖章：`sessionId` 非空 ⇒ 记当前数据根；**解绑（空串）⇒ 一并清掉**，避免旧归属残留。
 * 只在「本次调用真的带了 sessionId 字段」时改，避免只改 status 的 patch 被动重写归属。
 */
export function stampSession(raw, config) {
	if (!raw || !Object.hasOwn(raw, 'sessionId')) { return raw; }
	const id = String(raw.sessionId ?? '').trim();
	return { ...raw, sessionRoot: id ? currentRoot(config) : '' };
}
