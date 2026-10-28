// @vssaros/dsh-agents — seen（主机侧）：每个 Agent 的「上次查看时间」与未读推导。
//
// 2026-10-17，方案 A 收尾项「未读数」（侧栏消息列表的红色角标）。
//
// 口径（如实，别往外吹）：
//   · 「已读」= 用户在侧栏/编辑区**点开过**这个 Agent（点开即记 lastSeen = now）；
//   · 「未读数」= 该 Agent 名下 lastActiveAt 晚于 lastSeen 的**会话条数**（不是消息数——
//     projcache 只有会话级的时间戳，没有逐条已读状态 ✗ 不编）。
// 存储：{dataRoot}/agents-seen.json（很小，debounce 500ms 落盘；写失败只记日志式 error，不炸路由）。
// 容错：文件坏了 ⇒ 当作「都没看过」（角标会偏多，比「全静默清零」更不误导 ✓）。

import { renameWithRetry } from './atomicWrite.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './store.js';
import { presetIdOf } from './core/agents.js';

const FILE = 'agents-seen.json';
const DEBOUNCE_MS = 500;

let cache = null;          // { [agentId]: ms }
let writeTimer = null;

async function loadSeen(config) {
	if (cache) { return cache; }
	const file = join(dataRootOf(config), FILE);
	let parsed = {};
	try {
		const raw = await readFile(file, 'utf8');
		const j = JSON.parse(raw);
		if (j && typeof j === 'object') {
			for (const [k, v] of Object.entries(j)) {
				if (Number.isFinite(v)) { parsed[k] = v; }
			}
		}
	} catch { /* 没有文件/坏了 ⇒ 空（都没看过） */ }
	cache = parsed;
	return cache;
}

function persistSoon(config) {
	if (writeTimer) { clearTimeout(writeTimer); }
	writeTimer = setTimeout(() => {
		writeTimer = null;
		const file = join(dataRootOf(config), FILE);
		const tmp = file + '.tmp';
		// tmp + rename：写一半崩了也不留半截 JSON ✓
		mkdir(dataRootOf(config), { recursive: true })
			.then(() => writeFile(tmp, JSON.stringify(cache ?? {}), 'utf8'))
			.then(() => renameWithRetry(tmp, file))
			.catch(() => { /* 落盘失败：本次内存态仍生效，下轮再写 */ });
	}, DEBOUNCE_MS);
	if (typeof writeTimer.unref === 'function') { writeTimer.unref(); }
}

/** 点开一个 Agent ⇒ 记「看到了此刻」。返回更新后的表。 */
export async function markSeen(config, agentId) {
	const seen = await loadSeen(config);
	seen[String(agentId ?? '')] = Date.now();
	persistSoon(config);
	return seen;
}

/**
 * 未读推导：逐条会话行（live.rows，presetId + lastActiveAt）× seen 表
 * ⇒ `{ [agentId]: n }`（n = 上次查看后有活动的会话条数；只含名册里的 agent；
 * 官方 preset / (none) 桶不进——它们不是某个 agent ✓）。
 */
export function unreadCounts(sessionRows, agents, seen) {
	const out = {};
	for (const a of agents ?? []) {
		const preset = presetIdOf(a.id);
		const seenMs = Number.isFinite(seen?.[a.id]) ? seen[a.id] : 0;
		let n = 0;
		for (const row of sessionRows ?? []) {
			if (row?.presetId === preset && Number.isFinite(row.lastActiveAt) && row.lastActiveAt > seenMs) {
				n++;
			}
		}
		if (n > 0) { out[a.id] = n; }
	}
	return out;
}

/** 页面轮询用：给定 config，一次性算出当前 counts（projcache 只读 + seen 表）。 */
export async function unreadSnapshot(config, agents, readRows) {
	const seen = await loadSeen(config);
	return unreadCounts(readRows, agents, seen);
}

// 仅测试用（resetSeenCache：进程内探针跨夹具要清掉模块级缓存 ✗ 不然上一个夹具的 seen 串到下一个）
export const __test = { FILE, loadSeen, resetSeenCache: () => { cache = null; if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } } };
