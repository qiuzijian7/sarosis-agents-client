// @vssaros/dsh-agents — 「一条 IM 绑定 ⇄ 一条 dsh 会话」的映射（2026-10-29）
//
// ── 为什么需要它（真机事故）──────────────────────────────────────────────────
// `dispatchImToAgent` 原来每次走"该 preset **最近活跃**的会话，没有就现开一条"。
// 2026-10-29 真机：飞书里 @ 机器人能收到完整答复（说明入站/派发/出站全通），
// 但 Bots 页与工作区会话列表里只看到一串「(未命名会话)」——
//   · 用户认不出哪条是飞书来的
//   · 同一绑定的上下文飘（换会话就换上下文）
// ⇒ 每条绑定**固定一条会话**（这里记），会话失效（被归档/删/Host 重启后不活）才重建，
//   建好后顺手起名（`飞书 · VsSaros知识库`），列表里一眼可认。
//
// ── 为什么单独一个文件（不塞进 binding）──────────────────────────────────────
// `normalizeBinding()` 只保留白名单字段 ⇒ 在绑定对象上加 `sessionId` 会被下一次
// update（改白名单/方向）静默抹掉。运行期状态表放独立文件，语义也清楚。
//
// ── 存储 ────────────────────────────────────────────────────────────────────
//   `<dataRoot>/agent-im-sessions.json`
//   { "version": 1, "map": { "<bindingId>": "<sessionId>" } }
//   原子写 + 0600；坏 JSON ⇒ 空表（最多是"下次重建一条会话"，不该因此起不来）。
import { renameWithRetry } from './atomicWrite.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';

const FILE_NAME = 'agent-im-sessions.json';

export function imSessionsPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

async function readAll(config) {
	try {
		const body = JSON.parse(await readFile(imSessionsPathOf(config), 'utf8'));
		return body && typeof body.map === 'object' && body.map ? body.map : {};
	} catch {
		return {};
	}
}

async function writeAll(config, map) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const target = imSessionsPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, JSON.stringify({ version: 1, map }, null, 2), { encoding: 'utf8', mode: 0o600 });
	await renameWithRetry(tmp, target);
	try { await chmod(target, 0o600); } catch { /* Windows 上 chmod 无意义 */ }
}

/** 该绑定记住的会话 id（没有 ⇒ 空串）。 */
export async function getImSession(config, bindingId) {
	const key = String(bindingId ?? '').trim();
	if (!key) { return ''; }
	const map = await readAll(config);
	return String(map[key] || '');
}

/** 记住（覆盖）。 */
export async function setImSession(config, bindingId, sessionId) {
	const key = String(bindingId ?? '').trim();
	const sid = String(sessionId ?? '').trim();
	if (!key || !sid) { return { ok: false }; }
	const map = await readAll(config);
	map[key] = sid;
	await writeAll(config, map);
	return { ok: true, sessionId: sid };
}

/** 忘掉（解绑 / 会话已失效时用）。 */
export async function clearImSession(config, bindingId) {
	const key = String(bindingId ?? '').trim();
	if (!key) { return { removed: 0 }; }
	const map = await readAll(config);
	if (!(key in map)) { return { removed: 0 }; }
	delete map[key];
	await writeAll(config, map);
	return { removed: 1 };
}
