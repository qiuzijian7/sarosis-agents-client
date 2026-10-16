// @vssaros/dsh-sessions — store（主机侧 I/O）：读 dsh 自己的会话投影缓存。**只读**，不声明 `owns`。
//
// 位置：`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（dsh 自己的投影 checkpoint 缓存）。
// DSH_HOME 的取法：`config.dshHome` → 环境变量 `DSH_HOME`（VsSaros 启动 Host 时就会设）→ `~/.dsh`。
// 读不到就是"没有数据"（带 note），不报错——这个缓存是 dsh 的可选项，缺它不影响插件激活。
//
// 与 `vssaros-dashboard/lib/store.js` 的关系：同一条 DSH_HOME 链、同一个缓存目录，
// `dshHomeOf` / `projCacheDirOf` **逐字同形**（改一处必须同步另一处；守卫 `check:dsh-plugins` 会断言）。

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSessionCache } from './core/sessionList.js';

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

/**
 * 读全部会话缓存。
 * 返回 `{ sessions, errors, dir, missing, truncated, remaining }`：
 * 坏文件带原因进 errors，**不丢其它会话**（一个坏文件不能让整个列表消失 ✗）。
 *
 * ⚠ 与 dashboard 的 `readSessions` 是同一套纪律（单文件 4MB 上限、坏值只丢自己），
 * 但本插件**只取会话列表要用的字段**（见 sessionFromCacheRows 的注释）。
 */
export async function readSessionCaches(config, { limit = 300 } = {}) {
	const dir = projCacheDirOf(config);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { sessions: [], errors: [], dir, missing: dir, truncated: false, remaining: 0 };
		}
		throw new Error(`投影缓存目录读取失败（${dir}）：${e?.message ?? e}`);
	}
	const sessions = [];
	const errors = [];
	const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
	for (const file of files) {
		if (sessions.length >= limit) {
			break;
		}
		const path = join(dir, file);
		let text;
		try {
			const info = await stat(path);
			if (info.size > 4_000_000) {
				errors.push(`${file}：文件过大（${info.size} 字节），跳过`);
				continue;
			}
			text = await readFile(path, { encoding: 'utf8' });
		} catch {
			errors.push(`${file}：读取失败`);
			continue;
		}
		const parsed = parseSessionCache(text, { id: file.replace(/\.json$/, '') });
		if (parsed.error) {
			errors.push(`${file}：${parsed.error}`);
			continue;
		}
		sessions.push(parsed.session);
	}
	// 「还有多少没列出来」按**目录里的文件数**算：两个字段从同一个数派生 ⇒ 不可能各说各话。
	const remaining = Math.max(0, files.length - sessions.length - errors.length);
	return { sessions, errors, dir, missing: null, truncated: remaining > 0, remaining };
}
