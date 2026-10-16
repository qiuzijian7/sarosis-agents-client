// @vssaros/dsh-dashboard — store（主机侧 I/O）：读 dsh 的会话投影缓存。只读，不声明 `owns`。
//
// 位置：`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（dsh 自己的投影 checkpoint 缓存）。
// DSH_HOME 的取法：`config.dshHome` → 环境变量 `DSH_HOME`（VsSaros 启动 Host 时就会设）→ `~/.dsh`。
// 读不到就是"没有数据"（带 note），不报错——这个缓存是 dsh 的可选项，缺它不影响插件激活。
//
// 为什么读缓存而不是只读服务：服务端 `sessionProjections.snapshot()` 需要**活的 Session 对象**，
// 已结束的会话只能走 checkpoint；而 Dashboard 的价值恰恰在"回看历史"。因此缓存是主路径，
// 活会话由 index.js 的 live 路径覆盖（页面上标出来源）。

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSessionCache } from './core/dashboard.js';

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
 * 返回 `{ sessions, errors, dir, missing }`：坏文件带原因进 errors，**不丢其它会话**。
 */
export async function readSessions(config, { limit = 200 } = {}) {
	const dir = projCacheDirOf(config);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { sessions: [], errors: [], dir, missing: dir };
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
	// 「还有多少没列出来」按**目录里的文件数**算 ✓ —— 页面原先拿 `summary.sorted.length > PAGE_LIMIT` 判这句，
	// 可那个数组**已经被 limit 截到 PAGE_LIMIT 了** ⇒ 条件恒假、那句话**永远不显示** ✗（p3-09 新断言抓到的：
	// `truncated=true` 而"另有 N 个"从不出现 ✓）。两个字段**从同一个数派生** ⇒ 不可能各说各话 ✓。
	const remaining = Math.max(0, files.length - sessions.length - errors.length);
	return { sessions, errors, dir, truncated: remaining > 0, remaining };
}

/** 读一个会话（Dashboard 单会话工具用）。 */
export async function readSession(config, sessionId) {
	// **O(1)**：会话 id **就是**缓存文件名（本文件的 `readSessions` 里 `id: file.replace(/\.json$/, '')` ✓）
	// ⇒ 直接拼路径 ✓。原来这里是 `readSessions({limit:1000})` + `find()` ✗，两个问题：
	//   ① 每次都要把**整个目录**读一遍（上千个文件、逐个 `await readFile`，全在 Host 主线程上 ✗）；
	//   ② `limit` 之外的会话会被判成**"不存在"** ✗ —— 真机会话数过千时这就是一个**静默的错答案** ✗。
	// 见 `doc/dsh-modules-conformance.html` §5-6。错误文案保持不变（"没有这个会话的投影缓存：…" ✓）。
	const dir = projCacheDirOf(config);
	const path = join(dir, `${sessionId}.json`);
	let text;
	try {
		text = await readFile(path, { encoding: 'utf8' });
	} catch {
		return { error: `没有这个会话的投影缓存：${sessionId}（目录 ${dir}）` };
	}
	const parsed = parseSessionCache(text, { id: sessionId });
	if (parsed.error) {
		// 文件在但读不动：与目录扫描口径一致 —— 如实说是"这个文件的问题" ✓，不伪装成"没有这个会话" ✗
		return { error: `${sessionId}：${parsed.error}` };
	}
	return { session: parsed.session };
}
