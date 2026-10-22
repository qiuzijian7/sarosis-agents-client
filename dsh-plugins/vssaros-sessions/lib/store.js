// @vssaros/dsh-sessions — store（主机侧 I/O）：读 dsh 自己的会话投影缓存。**只读**，不声明 `owns`。
//
// 位置：`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（dsh 自己的投影 checkpoint 缓存）。
// DSH_HOME 的取法：`config.dshHome` → 环境变量 `DSH_HOME`（VsSaros 启动 Host 时就会设）→ `~/.dsh`。
// 读不到就是"没有数据"（带 note），不报错——这个缓存是 dsh 的可选项，缺它不影响插件激活。
//
// 与 `vssaros-dashboard/lib/store.js` 的关系：同一条 DSH_HOME 链、同一个缓存目录，
// `dshHomeOf` / `projCacheDirOf` **逐字同形**（改一处必须同步另一处；守卫 `check:dsh-plugins` 会断言）。

import { readFile, readdir, stat } from 'node:fs/promises';
import { foundation } from './foundationRef.js';
import { homedir } from 'node:os';

import { join } from 'node:path';

import { parseSessionCache } from './core/sessionList.js';


export function dshHomeOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dshHomeOf(config);
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
	const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
	// ★★ 2026-10-19（用户报障「新建会话后找不到之前的会话 item」）：
	//   从前这里按**文件名**排序再截 `limit` 条 —— 文件名就是会话 id（`session-<uuid>`），
	//   字典序与"最近用过"**毫无关系** ⇒ 截出来的是"字母序最前的 300 条"。
	//   实测（本机 1684 个缓存文件）：页面只列出 `session-0044…`、`session-005f…` 这一批，
	//   刚新建的 `session-1a3b…` 连这 300 条都进不去 ⇒ 用户看到"之前的会话不见了" ✗。
	//   ⇒ 改成按 **mtime 倒序**取前 limit 条（最近有活动的会话优先），stat 顺手把大小带上，
	//     下面的循环不再重复 stat（1684 次 stat 并行，实测可接受）。
	const stats = await Promise.all(files.map(async name => {
		try {
			const info = await stat(join(dir, name));
			return { name, mtime: info.mtimeMs ?? 0, size: info.size ?? 0 };
		} catch {
			return { name, mtime: 0, size: -1 };   // stat 失败：排最后，循环里按"读取失败"记一笔
		}
	}));
	stats.sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const file of stats) {
		if (sessions.length >= limit) {
			break;
		}
		const path = join(dir, file.name);
		let text;
		try {
			if (file.size < 0) {
				throw new Error('stat failed');
			}
			if (file.size > 4_000_000) {
				errors.push(`${file.name}：文件过大（${file.size} 字节），跳过`);
				continue;
			}
			text = await readFile(path, { encoding: 'utf8' });
		} catch {
			errors.push(`${file.name}：读取失败`);
			continue;
		}
		const parsed = parseSessionCache(text, { id: file.name.replace(/\.json$/, '') });
		if (parsed.error) {
			errors.push(`${file.name}：${parsed.error}`);
			continue;
		}
		sessions.push(parsed.session);
	}
	// 「还有多少没列出来」按**目录里的文件数**算：两个字段从同一个数派生 ⇒ 不可能各说各话。
	const remaining = Math.max(0, stats.length - sessions.length - errors.length);
	return { sessions, errors, dir, missing: null, truncated: remaining > 0, remaining };
}
