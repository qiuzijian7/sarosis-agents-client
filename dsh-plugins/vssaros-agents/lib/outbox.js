// @vssaros/dsh-agents — outbox（回传/派发的耐久队列，2026-10-16 二期；
// mockup doc/agents-grants-outbox-mockup.html 拍板点 ③④）。
//
// 为什么：relay 的 PENDING 与群聊的 PENDING_DISPATCH 此前都是**内存态**——Host 重启后
// "已发出、等回收"的消息静默丢失（发送方回执里写没写都救不回"忘了等" ✗）。⇒ 落盘
// <数据根>/agent-outbox.json，重启惰性读回；回收判据不变（tracker 按 messageId 验证消费 ✓）。
//
// unknown-outcome 纪律（BotHarness 同款）：投递失败（发送方会话不在运行）⇒ 结果**不确定**
// （消息可能已送达也可能没有）⇒ 条目标 unknown 留在队列，**永不自动重发** ✗；
// 只有人按「手动重发」（API action=retry，页面上带 confirm ✓）。重发用登记时备好的
// resolved 载荷（回复文本 + source），原样再投一次。
//
// 写口判据同 templates/groups/assignments（限尺寸读入 + JSON 自校验 + 串行写队列 ✓）。
// 条目封顶 KEEP_MAX：先裁最旧的已回收/终态，pending/unknown 永不裁 ✓。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './store.js';

/** 队列文件名（数据根下）。 */
const FILE_NAME = 'agent-outbox.json';
/** 条目封顶。 */
export const OUTBOX_KEEP = 100;

/** @type {Map<string, object>} 条目 id → entry（模块级，同 relay PENDING 的判据 ✓） */
const ENTRIES = new Map();
let loadedRoot = null;
let writeQueue = Promise.resolve();

/** 惰性读回（每个数据根一次）。坏文件 ⇒ 空队列（不炸激活 ✓）。 */
export async function ensureOutboxLoaded(config) {
	const root = dataRootOf(config);
	if (loadedRoot === root) {
		return;
	}
	loadedRoot = root;
	try {
		const text = await readFile(join(root, FILE_NAME), 'utf8');
		const parsed = JSON.parse(text);
		ENTRIES.clear();
		for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
			if (e && typeof e.id === 'string') {
				ENTRIES.set(e.id, e);
			}
		}
	} catch {
		/* 没有/坏了 ⇒ 空队列起步 ✓ */
	}
}

function persist(config) {
	const root = dataRootOf(config);
	const entries = [...ENTRIES.values()];
	writeQueue = writeQueue.then(async () => {
		await mkdir(root, { recursive: true });
		const text = JSON.stringify({ version: 1, entries }, null, 2);
		JSON.parse(text); // 自证 ✓
		await writeFile(join(root, FILE_NAME), text, 'utf8');
	}).catch(e => console.warn(`[vssaros-agents] outbox 写盘失败：${String(e?.message ?? e)}`));
	return writeQueue;
}

/** 封顶：先裁最旧的已回收条目（pending/unknown 永不裁）。 */
function trimToCap() {
	if (ENTRIES.size <= OUTBOX_KEEP) {
		return;
	}
	const done = [...ENTRIES.values()].filter(e => e.status !== 'pending' && e.status !== 'unknown')
		.sort((a, b) => a.sentAt - b.sentAt);
	while (ENTRIES.size > OUTBOX_KEEP && done.length) {
		ENTRIES.delete(done.shift().id);
	}
}

/** 登记一条"等回收"（relay 的 notePendingReply 与群聊派发的共同入口）。同步进内存 + 异步写穿。 */
export function outboxNote(config, entry) {
	const full = { id: randomUUID(), status: 'pending', sentAt: Date.now(), ...entry };
	ENTRIES.set(full.id, full);
	trimToCap();
	void persist(config);
	return full;
}

/** 某会话当前的 pending 条目（relay/groups 的 tracker 每回合读它；重启后从盘上读回的也在 ✓）。 */
export function outboxPendingFor(sessionId) {
	return [...ENTRIES.values()].filter(e => e.sessionId === sessionId && e.status === 'pending');
}

/** 回收成功：answeredIds 这些 messageId 的条目标 delivered 并（直接删——产出已在去向落盘 ✓）。 */
export function outboxResolve(config, sessionId, answeredIds) {
	const ids = new Set(answeredIds);
	let dirty = false;
	for (const e of [...ENTRIES.values()]) {
		if (e.sessionId === sessionId && e.status === 'pending' && ids.has(e.messageId)) {
			ENTRIES.delete(e.id);
			dirty = true;
		}
	}
	if (dirty) {
		void persist(config);
	}
}

/**
 * 投递失败 ⇒ 标 unknown（**不删、不重发** ✓）。resolved = 备好的投递载荷（重发用）。
 */
export function outboxMarkUnknown(config, sessionId, messageId, resolved, note) {
	for (const e of ENTRIES.values()) {
		if (e.sessionId === sessionId && e.messageId === messageId && e.status === 'pending') {
			e.status = 'unknown';
			e.resolved = resolved;
			e.note = note;
			e.updatedAt = Date.now();
			void persist(config);
			return e;
		}
	}
	return undefined;
}

/** 队列快照（API/页面共用）：新→旧。 */
export async function outboxList(config) {
	await ensureOutboxLoaded(config);
	return { entries: [...ENTRIES.values()].sort((a, b) => b.sentAt - a.sentAt), keep: OUTBOX_KEEP };
}

/**
 * 手动重发（只接 unknown 的 relay 条目）：发送方在运行 ⇒ 原样再投一次 resolved 载荷并删条目；
 * 不在 ⇒ 409 如实说（条目留着）。**没有自动调用方** ✗。
 */
export async function outboxRetry(config, state, input) {
	await ensureOutboxLoaded(config);
	const id = String(input?.id ?? '').trim();
	const entry = ENTRIES.get(id);
	if (!entry) {
		throw Object.assign(new Error(`没有这条 outbox 条目：${id || '(没给 id)'}`), { httpStatus: 404 });
	}
	if (entry.status !== 'unknown') {
		throw Object.assign(new Error(`只能重发 unknown-outcome 的条目（这条是 ${entry.status}）`), { httpStatus: 409 });
	}
	if (entry.kind !== 'relay' || !entry.resolved) {
		throw Object.assign(new Error('这条条目没有可重发的载荷（群聊回收是直接写 transcript，没有"重发"语义）'), { httpStatus: 400 });
	}
	const sender = entry.from ? state.agents?.get?.(entry.from) : undefined;
	if (!sender || typeof sender.followup !== 'function') {
		throw Object.assign(new Error(`发送方会话不在运行：${entry.from ?? '(无)'}——重发不出去，条目留着`), { httpStatus: 409 });
	}
	sender.followup({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: entry.resolved.text }],
		source: entry.resolved.source,
	});
	ENTRIES.delete(id);
	await persist(config);
	return { retried: true, id };
}

/** 诊断/测试用：清内存 + 复位惰性读标记（下次读盘 = 模拟重启 ✓）。 */
export function resetOutbox() {
	ENTRIES.clear();
	loadedRoot = null;
}
