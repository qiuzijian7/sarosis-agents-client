// @vssaros/dsh-agents — live（主机侧 I/O）：读 dsh 的会话投影缓存，出"瘦会话行"。只读，不声明 `owns`。
//
// 位置：`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（dsh 自己的投影 checkpoint 缓存）。
// ⚠ `dshHomeOf` / `projCacheDirOf` 与 vssaros-dashboard/lib/store.js、vssaros-sessions/lib/store.js
//   **逐字同形**——同一条链（`config.dshHome` → `DSH_HOME` → `~/.dsh`），check-host-config 的
//   dshHome 契约盯着；改了这里就要一起改。
//
// 为什么读缓存而不是服务：`sessionProjections` 要活 Session 对象；花名册页的价值在"回看全部会话"。
// 读不到目录 = "没有数据"（missing），不抛——缓存是 dsh 的可选物，缺它不影响插件激活。

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionRowOf } from './core/live.js';

export function dshHomeOf(config) {
	const configured = typeof config?.dshHome === 'string' ? config.dshHome.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
	return fromEnv || join(homedir(), '.dsh');
}

/** 投影缓存目录。 */
export function projCacheDirOf(config) {
	return join(dshHomeOf(config), 'storages', 'session_projcache', 'sessions');
}

/** 单文件上限（与 dashboard 同口径）：超限大概率不是投影缓存，跳过并记 errors。 */
const MAX_FILE_BYTES = 4_000_000;

/**
 * 读**一个**会话的瘦行（O(1)：会话 id 就是缓存文件名，与 dashboard 的 readSession 同一发现 ✓）。
 * 供 `agent_message` 解析"发送者是谁"——不整目录扫描。
 * 读不到 ⇒ 返回 `{ error }`（如实区分"没有这条缓存"与"这条缓存坏了"），不抛。
 */
export async function readLiveSession(config, sessionId) {
	const dir = projCacheDirOf(config);
	const id = String(sessionId ?? '').trim();
	if (!id) {
		return { error: 'readLiveSession 需要会话 id' };
	}
	const path = join(dir, `${id}.json`);
	let text;
	let mtimeMs = null;
	try {
		const info = await stat(path);
		if (info.size > MAX_FILE_BYTES) {
			return { error: `${id}：缓存文件过大（${info.size} 字节）` };
		}
		mtimeMs = info.mtimeMs;
		text = await readFile(path, { encoding: 'utf8' });
	} catch {
		return { error: `没有这个会话的投影缓存：${id}` };
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return { error: `${id}：JSON 解析失败` };
	}
	return sessionRowOf(json, id, mtimeMs);
}

/**
 * 最近活跃的 N 个会话用的 preset id（★ 2026-10-29，lazy 注册用）。
 *
 * lazy 模式启动时只注册少量 preset；桌面窗口一启动就会**恢复上次的会话** ⇒ 那个会话的 preset
 * 必须在第一批里，否则恢复失败。这里只 stat 全部缓存文件、按 mtime 取最新 `limit` 个再解析
 * ⇒ 比 `readLiveSessions`（逐个解析最多 500 个）便宜得多，适合放在启动路径上。
 * 任何错误都返回空数组（拿不到就退回"只按委派清单 + 扫描顺序"，不阻塞启动）。
 */
export async function recentSessionPresetIds(config, { limit = 8 } = {}) {
	const dir = projCacheDirOf(config);
	let names;
	try {
		names = (await readdir(dir, { withFileTypes: true }))
			.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
			.map(entry => entry.name);
	} catch {
		return [];
	}
	const stamped = [];
	for (const name of names) {
		try {
			const info = await stat(join(dir, name));
			if (info.size <= MAX_FILE_BYTES) {
				stamped.push({ name, mtimeMs: info.mtimeMs });
			}
		} catch { /* 并发删除等：跳过 */ }
	}
	stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const out = [];
	for (const { name, mtimeMs } of stamped.slice(0, Math.max(0, limit))) {
		try {
			const parsed = sessionRowOf(JSON.parse(await readFile(join(dir, name), 'utf8')), name.replace(/\.json$/, ''), mtimeMs);
			const presetId = parsed?.row?.presetId;
			if (presetId && !out.includes(presetId)) {
				out.push(presetId);
			}
		} catch { /* 坏文件：跳过 */ }
	}
	return out;
}

/**
 * 读全部会话缓存的**瘦行**（只取 preset / title / persona / tokens / turns 五样，见 core/live.js）。
 * 返回 `{ rows, errors, dir, missing?, truncated }`：坏文件带原因进 errors，**不丢其它会话**。
 * `truncated` 按目录文件数算（与 dashboard 修法同源：被 limit 截过的数组不能用来判断"还有没有"）。
 */
export async function readLiveSessions(config, { limit = 500 } = {}) {
	const dir = projCacheDirOf(config);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { rows: [], errors: [], dir, missing: dir, truncated: false };
		}
		throw new Error(`投影缓存目录读取失败（${dir}）：${e?.message ?? e}`);
	}
	const rows = [];
	const errors = [];
	const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
	for (const file of files) {
		if (rows.length >= limit) {
			break;
		}
		const path = join(dir, file);
		const id = file.replace(/\.json$/, '');
		let text;
		let mtimeMs = null;
		try {
			const info = await stat(path);
			if (info.size > MAX_FILE_BYTES) {
				errors.push(`${file}：文件过大（${info.size} 字节），跳过`);
				continue;
			}
			mtimeMs = info.mtimeMs;
			text = await readFile(path, { encoding: 'utf8' });
		} catch {
			errors.push(`${file}：读取失败`);
			continue;
		}
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			errors.push(`${file}：JSON 解析失败`);
			continue;
		}
		const parsed = sessionRowOf(json, id, mtimeMs);
		if (parsed.error) {
			errors.push(`${file}：${parsed.error}`);
			continue;
		}
		rows.push(parsed.row);
	}
	return { rows, errors, dir, truncated: rows.length + errors.length < files.length };
}
