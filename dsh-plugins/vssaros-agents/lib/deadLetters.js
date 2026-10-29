// @vssaros/dsh-agents — 入站"死信"（**OpenClaw `channels dead-letters` 同构**，2026-10-27）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 入站被拒/失败目前只有一行日志（`[vssaros-agents][im] 入站被拒（feishu:oc_x）：sender`）。
// 用户的实际问题永远是"**我发了消息，bot 没反应**"—— 而答案分散在两个地方：
//   · 日志（要去翻宿主输出，多数人拿不到）
//   · 脑子里（"是不是白名单没加我？"）
// 落盘 + 界面列出之后，这个问题变成一行字：`sender · 张三 · 3 分钟前`。
//
// ── 记什么 / 不记什么（这个边界很重要）────────────────────────────────────
// 记：`unbound` / `sender` / `no-whitelist` / `no-mention` / `room-not-allowlisted` /
//     `dm-disabled` / `group-disabled` / `direction` / `loop` / `dispatch-error` / `disabled`
// **不记**：
//   · `duplicate` —— 正常去重（飞书会重投事件），记进来会瞬间刷满
//   · `pairing-required` —— 那不是失败，是**挂起等批准**（有它自己的待批准列表）
//   · `ok` / `from-app` —— 正常路径
//
// ── 存储 ────────────────────────────────────────────────────────────────────
//   `<dataRoot>/agent-im-deadletters.json`，**有界 FIFO（200 条）**，原子写 + 0600。
//   ⚠ 正文**截断到 400 字**：这里会落外部用户的消息内容，没理由整段留着。
import { renameWithRetry } from './atomicWrite.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';

/** 保留多少条（FIFO）。够看"最近发生了什么"，又不会变成日志黑洞。 */
export const DEAD_LETTER_CAP = 200;
/** 正文最多留多少字（含省略号）。 */
export const DEAD_LETTER_TEXT_MAX = 400;

const FILE_NAME = 'agent-im-deadletters.json';

/** 该记的 reason（其余一律不记 —— 见文件头）。 */
export const DEAD_LETTER_REASONS = new Set([
	'unbound', 'sender', 'no-whitelist', 'no-mention', 'room-not-allowlisted',
	'dm-disabled', 'group-disabled', 'direction', 'loop', 'dispatch-error', 'disabled',
]);

export function deadLettersPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 正文截断（不整段留外部用户内容）。 */
export function clipText(text, max = DEAD_LETTER_TEXT_MAX) {
	const s = String(text ?? '').replace(/\s+/g, ' ').trim();
	return s.length <= max ? s : s.slice(0, max) + '…';
}

async function readAll(config) {
	try {
		const body = JSON.parse(await readFile(deadLettersPathOf(config), 'utf8'));
		return Array.isArray(body?.items) ? body.items : [];
	} catch {
		return [];
	}
}

async function writeAll(config, items) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, items }, null, 2);
	const target = deadLettersPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
	await renameWithRetry(tmp, target);
	try { await chmod(target, 0o600); } catch { /* Windows 上 chmod 无意义 */ }
}

/**
 * 记一条（不该记的 reason 会被静默跳过，返回 `{ skipped: true }`）。
 * ⚠ 任何异常都**不能**影响入站流程：调用方拿到的失败只应体现为"没记上"。
 */
export async function recordDeadLetter(config, entry, deps = {}) {
	const reason = String(entry?.reason ?? '').trim();
	if (!DEAD_LETTER_REASONS.has(reason)) {
		return { skipped: true, reason };
	}
	const now = deps.now ? deps.now() : Date.now();
	const item = {
		id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		at: now,
		reason,
		platform: String(entry?.platform ?? ''),
		chatId: String(entry?.chatId ?? ''),
		chatType: String(entry?.chatType ?? ''),
		userId: String(entry?.userId ?? ''),
		userName: String(entry?.userName ?? ''),
		messageId: String(entry?.messageId ?? ''),
		text: clipText(entry?.text),
		...(entry?.detail ? { detail: clipText(entry.detail, 200) } : {}),
	};

	const items = await readAll(config);
	items.push(item);
	while (items.length > DEAD_LETTER_CAP) { items.shift(); }
	await writeAll(config, items);
	return { recorded: true, item };
}

/** 最近的若干条（新的在前）。 */
export async function listDeadLetters(config, options = {}) {
	const limit = Math.max(1, Math.min(Number(options.limit) || 20, DEAD_LETTER_CAP));
	const items = await readAll(config);
	const filtered = options.reason
		? items.filter((x) => String(x.reason) === String(options.reason))
		: items;
	return {
		total: filtered.length,
		cap: DEAD_LETTER_CAP,
		items: filtered.slice(-limit).reverse(),
	};
}

/** 清空（运维动作；OpenClaw 是 `dead-letters clear`）。 */
export async function clearDeadLetters(config) {
	const items = await readAll(config);
	await writeAll(config, []);
	return { cleared: items.length };
}

/**
 * 删掉一条（"'我已经处理了'的语义"）。
 *
 * 用在「把发送者加进白名单」之后：那条记录已经没用了，继续挂在「最近失败」里
 * 只会让人以为问题还在（与 `clear` 的区别是它**只删指定的那条**）。
 */
export async function removeDeadLetter(config, id) {
	const key = String(id ?? '').trim();
	if (!key) { return { removed: 0 }; }
	const items = await readAll(config);
	const out = items.filter((x) => String(x.id) !== key);
	if (out.length === items.length) { return { removed: 0 }; }
	await writeAll(config, out);
	return { removed: items.length - out.length };
}
