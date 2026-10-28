// @vssaros/dsh-agents — IM 入站幂等（跨 Host 重启）
//
// ── 为什么必须落盘 ──────────────────────────────────────────────────────────
// 飞书对未及时 ACK 的事件会**重投**，Host 重启后更是从零开始。内存去重只在单进程内有效，
// 于是"同一条消息被处理两次"会在重启后稳定复现 —— 表现是 bot 回两遍，且看起来像
// "重复 bot"（用户最初报的那个现象其实也可能是它）。
//
// ── 形状 ────────────────────────────────────────────────────────────────────
// `<dataRoot>/agent-im-seen.json`：`{ version:1, keys:[ ... ] }`，**FIFO 有界**（默认 2000）。
// 写入是**去抖**的（默认 2s）：入站是低频操作，但每条都同步写盘没有必要；
// Host 退出前会 `flush`（见 apply 里的 disposal）。
import { renameWithRetry } from './atomicWrite.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';

const FILE_NAME = 'agent-im-seen.json';
export const SEEN_CAP = 2000;

let cache = null;            // 惰性加载的键列表（FIFO：最旧在前）
let cacheRoot = '';          // 这份 cache 属于哪个 dataRoot
let pending = 0;
let timer = null;

/** 文件路径（单测直接用）。 */
export function seenPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

async function load(config) {
	const root = dataRootOf(config);
	if (cache && cacheRoot === root) {
		return cache;
	}
	cacheRoot = root;
	try {
		const body = JSON.parse(await readFile(seenPathOf(config), 'utf8'));
		cache = Array.isArray(body?.keys) ? body.keys.map(String) : [];
	} catch {
		cache = [];
	}
	return cache;
}

async function writeNow(config) {
	if (!cache) {
		return;
	}
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, keys: cache }, null, 2);
	const target = seenPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, 'utf8');
	await renameWithRetry(tmp, target);
}

function scheduleFlush(config) {
	pending += 1;
	if (timer) {
		return;
	}
	timer = setTimeout(() => {
		timer = null;
		if (!pending) {
			return;
		}
		pending = 0;
		void writeNow(config).catch(() => undefined);
	}, 2000);
	if (typeof timer?.unref === 'function') {
		timer.unref();
	}
}

/**
 * 标记一个入站键。返回 `true` = **第一次见**（应当处理）；`false` = 重复（应当丢弃）。
 *
 * ⚠ 有一个刻意的取舍：**先记后处理**。如果处理途中进程崩了，这条消息会被永久丢弃
 *   （而不是重放）。对"群里发消息"这个场景，丢一条比重复回两遍更容易被接受；
 *   要反过来也很简单（把 mark 挪到处理之后），但那样崩溃时会重复。
 */
export async function markInboundSeen(config, key) {
	const k = String(key ?? '').trim();
	if (!k) {
		return true;
	}
	const keys = await load(config);
	if (keys.includes(k)) {
		return false;
	}
	keys.push(k);
	while (keys.length > SEEN_CAP) {
		keys.shift();
	}
	scheduleFlush(config);
	return true;
}

/** 立即落盘（Host 退出 / 单测收尾）。 */
export async function flushInboundSeen(config) {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	pending = 0;
	await writeNow(config).catch(() => undefined);
}

/** 仅测试：清内存（不删文件）。 */
export function resetInboundSeenCache() {
	cache = null;
	cacheRoot = '';
	pending = 0;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
