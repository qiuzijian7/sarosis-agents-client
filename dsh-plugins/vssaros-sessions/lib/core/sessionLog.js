// @vssaros/dsh-sessions — 读 dsh 会话日志里的**用户消息**（会话条目展开详情用）。
//
// 为什么需要：投影缓存（`storages/session_projcache`）只有标题 / 时间 / 状态，**没有消息正文**；
// 正文在 `<dshHome>/sessions/<cwd 编码>/<sessionId>/session.v4.jsonl.zstd`。
//
// ⚠ 两个坑（2026-10-19 实测，改之前先读）：
//   ① 文件是**多帧 zstd 串联**（实测一个会话 1.4 MB / 598 帧），而 `zlib.zstdDecompressSync`
//      只解**第一帧** ⇒ 直接调会只拿到 1 行（`type:'session'`），看着像"日志里没有消息" ✗。
//      必须按魔数切帧、逐帧解（本机 1436 个会话文件实测：bad=0、1050 行全部可 parse ✓）。
//   ② 帧边界靠魔数 `28 B5 2F FD` 猜：若压缩数据内部恰好出现该序列，切出来的两段都解不出
//      ⇒ 把后一段并进来重试（最多 3 次）；仍失败就**丢这一行**（不编造内容 ✓）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压走**异步**（libuv 线程池）：dsh Host 是单线程，同步解 zstd 会把同进程的页面/工具/反向桥
 * 一起卡住（本仓守卫 `dshPluginPackages.test.ts` 的「插件不许用同步解压」钉的就是这条；
 * 2026-10-20 改为异步）。代价如实记：逐帧 await 会比同步略慢（一次往返），换的是主线程不被占。
 */
const zstdDecompressAsync = promisify(zlib.zstdDecompress);

/** 逐帧解压多帧 zstd，返回拼起来的文本（解不出的帧被跳过，不抛错）。 */
export async function decodeZstdFrames(buf, { maxFrames = Infinity } = {}) {
	if (!Buffer.isBuffer(buf) || buf.length === 0) {
		return '';
	}
	const offsets = [];
	let i = 0;
	while ((i = buf.indexOf(ZSTD_MAGIC, i)) >= 0) {
		offsets.push(i);
		i += ZSTD_MAGIC.length;
	}
	if (offsets.length === 0) {
		// 单帧且不含魔数？不合法 ⇒ 当作空（调用方按"读不到"处理 ✓）
		return '';
	}
	if (offsets[0] !== 0) {
		offsets.unshift(0);
	}
	const parts = [];
	const limit = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.min(offsets.length, Math.floor(maxFrames)) : offsets.length;
	for (let k = 0; k < limit; k++) {
		const start = offsets[k];
		let end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
		let done = false;
		for (let tries = 0; tries < 3 && !done; tries++) {
			try {
				parts.push((await zstdDecompressAsync(buf.subarray(start, end))).toString('utf8'));
				done = true;
			} catch {
				const next = k + 2 + tries;
				end = next < offsets.length ? offsets[next] : buf.length;
			}
		}
		// 丢一行不影响整体（日志是只追加的，单帧坏掉不该让详情整块失败 ✗）
	}
	return parts.join('');
}

/** 一段 `data.content` 里的可读文本（文本块拼接；图片/附件给占位说明，不假装是文字 ✓）。 */
function textOfContent(content) {
	if (!Array.isArray(content)) {
		return '';
	}
	const bits = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		if (part.type === 'text' && typeof part.text === 'string') {
			bits.push(part.text);
		} else if (typeof part.type === 'string' && part.type !== 'text') {
			bits.push(`[${part.type}]`);
		}
	}
	return bits.join(' ').trim();
}

/**
 * 从会话日志（JSONL 文本）里取**用户消息**。
 *
 * 只取 `type === 'user/message'` 且来源是人的那些（`data.source.kind === 'user'` 或缺省）——
 * 工具结果 / 系统注入也在日志里，但它们不是"用户说的话"，混进去会误导 ✗。
 *
 * @returns {{time: number|undefined, text: string}[]} 时间正序。
 *   `limit` 默认 **0 = 全部**（2026-10-19 用户要求：展开要看到**每一条**用户输入）；
 *   传正数则取**最后** limit 条（诊断/大日志兜底用）。
 */
export function userMessagesOf(jsonlText, { limit = 0, maxChars = 1200 } = {}) {
	const out = [];
	if (typeof jsonlText !== 'string' || jsonlText.length === 0) {
		return out;
	}
	for (const line of jsonlText.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let evt;
		try {
			evt = JSON.parse(trimmed);
		} catch {
			continue;   // 半行 / 拼接残留 ⇒ 跳过（不猜）
		}
		if (!evt || evt.type !== 'user/message') {
			continue;
		}
		const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
		const kind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
		if (kind !== undefined && kind !== 'user') {
			continue;   // 非人类来源（工具/系统/子代理回填）不算"用户消息" ✓
		}
		const text = textOfContent(data.content);
		if (!text) {
			continue;
		}
		const clipped = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
		out.push({ time: typeof evt.time === 'number' ? evt.time : undefined, text: clipped });
	}
	return limit > 0 ? out.slice(-limit) : out;
}

/** 在 `<sessionsRoot>/<ws>/<sessionId>/session.v4.jsonl.zstd` 里找该会话的日志文件。 */
export function findSessionLog(sessionsRoot, sessionId) {
	if (typeof sessionsRoot !== 'string' || !sessionsRoot || typeof sessionId !== 'string' || !sessionId) {
		return undefined;
	}
	let wsDirs = [];
	try {
		wsDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
	} catch {
		return undefined;
	}
	const fileName = 'session.v4.jsonl.zstd';
	for (const ws of wsDirs) {
		const candidate = path.join(sessionsRoot, ws.name, sessionId, fileName);
		try {
			if (fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch { /* 这个工作区下没有它 ⇒ 继续找 */ }
	}
	return undefined;
}

/**
 * 只取**第一条**用户消息（用于给"未命名会话"当标题）。
 *
 * ⚠ 与 `userMessagesOf` 分开：这里解析到第一条就 `return`，不遍历全文 ⇒ 300 条列表里
 *   给无标题会话补标题时不必把每个 1 MB 日志都解完（配合 `decodeZstdFrames({ maxFrames })` ✓）。
 */
export function firstUserMessageOf(jsonlText, { maxChars = 40 } = {}) {
	if (typeof jsonlText !== 'string' || jsonlText.length === 0) {
		return undefined;
	}
	for (const line of jsonlText.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let evt;
		try {
			evt = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!evt || evt.type !== 'user/message') {
			continue;
		}
		const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
		const kind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
		if (kind !== undefined && kind !== 'user') {
			continue;
		}
		const text = textOfContent(data.content);
		if (!text) {
			continue;
		}
		return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
	}
	return undefined;
}

/**
 * 读某个会话的**首条用户消息**（列表标题兜底用；读不到 ⇒ `undefined`，调用方显示"未命名会话"）。
 *
 * `maxFrames` 默认 24：第一条用户消息通常在会话开头几帧内 —— 不必为了一个标题解完整 1.4 MB 日志。
 */
export async function readFirstPrompt(sessionsRoot, sessionId, { maxChars = 40, maxFrames = 24 } = {}) {
	const file = findSessionLog(sessionsRoot, sessionId);
	if (!file) {
		return undefined;
	}
	try {
		// 读盘也走异步（同步读 1.4 MB 同样是主线程阻塞，与解压同一条纪律）
		const buf = await fs.promises.readFile(file);
		return firstUserMessageOf(await decodeZstdFrames(buf, { maxFrames }), { maxChars });
	} catch {
		return undefined;
	}
}

/**
 * 读某个会话的用户消息（对外唯一入口）。
 *
 * 读不到（文件不存在 / 解压失败 / 没有用户消息）⇒ `[]` —— 调用方据此显示"暂无用户消息"，
 * **不许**编造内容（本仓纪律）✗。
 */
export async function readUserMessages(sessionsRoot, sessionId, options = {}) {
	const file = findSessionLog(sessionsRoot, sessionId);
	if (!file) {
		return { messages: [], reason: 'log-missing' };
	}
	let buf;
	try {
		buf = await fs.promises.readFile(file);
	} catch (e) {
		return { messages: [], reason: 'read-failed: ' + String(e && e.message || e) };
	}
	const messages = userMessagesOf(await decodeZstdFrames(buf), options);
	return { messages, reason: messages.length ? undefined : 'no-user-messages' };
}
