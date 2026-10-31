// @vssaros/dsh-agents — 群聊里的「活（work item）」（2026-10-31，对齐 `vssaros-loop` 的能力）。
//
// 判据真源在 `@vssaros/dsh-workitem`（cordis 服务 `vssarosWorkItems`）：账本去重 / 退避 /
// 完成契约 / `#task` 标签 / 风暴预算 / 回环闸门 —— **与 loop 共用同一份**，不可能分叉。
//
// ★ 接线是**增量式**的：没有 `#task:` 标签的消息 ⇒ `dispatch=true` ⇒ 行为与从前逐字一致。
//   只有人显式标了活，才走进"去重 / 预算 / 记账"这套。这样改动不会伤到现有群聊。
//
// 为什么账本单独存一个文件（而不是塞进 transcript）：transcript 封顶 200 条、超出裁最旧
// ⇒ 拿它当账本，做过的事实会被裁掉，去重就失效了。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renameWithRetry } from './atomicWrite.js';
import { dataRootOf } from './store.js';
import { workItems } from './workItemRef.js';

/** 群活账本文件名（数据根下）。 */
export const FILE_NAME = 'agent-group-tasks.json';
/** 读入口径（与 groups/templates 同款自卫）：文件超过这个尺寸就不读。 */
const FILE_MAX = 2 * 1024 * 1024;

/** 默认策略：与 loop 的默认同量级（每条活最多试 2 次、退避 30 分钟）。 */
export const DEFAULT_POLICY = { maxItemsPerRound: 5, maxAttempts: 2, retryBackoffS: 1800 };

export function tasksPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 读（坏文件 ⇒ 空账本 + 说明，不抛：读不懂账本不该让群聊挂掉）。 */
export async function readTasks(config) {
	const file = tasksPathOf(config);
	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return { tasks: emptyTasks(), note: '' };
	}
	if (raw.length > FILE_MAX) {
		return { tasks: emptyTasks(), note: `${FILE_NAME} 超过 ${FILE_MAX} 字节，已按空账本处理` };
	}
	try {
		const parsed = JSON.parse(raw);
		const wi = workItems();
		const { ledger, warning } = wi.normalizeLedger(parsed?.ledger ?? {});
		const events = Array.isArray(parsed?.events) ? parsed.events.filter(at => Number.isFinite(at)) : [];
		const inflight = parsed?.inflight && typeof parsed.inflight === 'object' && !Array.isArray(parsed.inflight)
			? parsed.inflight
			: {};
		return { tasks: { version: 1, ledger, events, inflight }, note: warning };
	} catch (error) {
		return { tasks: emptyTasks(), note: `${FILE_NAME} 解析失败：${String(error?.message ?? error)}` };
	}
}

export function emptyTasks() {
	const wi = workItems();
	return { version: 1, ledger: wi.createLedger(), events: [], inflight: {} };
}

/** 这条会话正在跑哪些活（回收时按 sessionId 结算）。 */
export const inflightOf = (tasks, sessionId) => {
	const value = tasks?.inflight?.[String(sessionId ?? '')];
	return Array.isArray(value) ? value.filter(key => typeof key === 'string') : [];
};

/** 登记"这条会话在跑这些活"。 */
export function holdInflight(tasks, sessionId, keys) {
	if (!Array.isArray(keys) || keys.length === 0) {
		return tasks;
	}
	tasks.inflight = { ...(tasks.inflight ?? {}), [String(sessionId)]: [...keys] };
	return tasks;
}

/** 结算完就放掉（同一会话的下一次派发会重新登记）。 */
export function releaseInflight(tasks, sessionId) {
	if (tasks?.inflight) {
		delete tasks.inflight[String(sessionId)];
	}
	return tasks;
}

/** 写（tmp + rename，与群定义同一套原子写）。 */
export async function writeTasks(config, tasks) {
	const file = tasksPathOf(config);
	await mkdir(dataRootOf(config), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
	await renameWithRetry(tmp, file);
	return file;
}

/**
 * 派发前的闸门。
 *
 * @returns `{ dispatch, keys, excluded, reason }`
 *   · `dispatch=false` ⇒ 这条消息**不派发**，把 `reason` 写进 transcript 给人看；
 *   · `keys` = 这次会真正推进的活（空数组 = 这条消息不带活 ⇒ 维持现状，正常派发）。
 */
export function planGroupDispatch({ text = '', message = null, tasks, policy = DEFAULT_POLICY, nowMs = Date.now() }) {
	const wi = workItems();
	// ① 回环闸门（必须在 @ 解析**之前**判 —— 调用方负责顺序，这里只做判定）
	if (wi.isSystemMessage(message)) {
		return { dispatch: false, keys: [], excluded: [], reason: 'system-message（系统消息不参与派发，防回环）' };
	}
	// ② 没有 `#task` ⇒ 这条消息"不是活" ⇒ 与从前逐字一致地正常派发
	const tags = wi.parseTaskTags(text);
	if (tags.length === 0) {
		return { dispatch: true, keys: [], excluded: [], reason: '' };
	}
	// ③ 风暴预算
	const verdict = wi.budgetVerdict(tasks?.events ?? [], nowMs, policy?.budget);
	if (!verdict.allowed) {
		return { dispatch: false, keys: [], excluded: tags.map(t => t.key), reason: verdict.reason };
	}
	// ④ 账本去重（与 loop 同一份判据）
	const picked = wi.pickItems({ rows: tags, keyOf: t => t.key, ledger: tasks?.ledger, policy, nowMs });
	if (picked.picked.length === 0) {
		const why = picked.excluded.map(entry => `${entry.key}：${entry.reason}`).join('；');
		return {
			dispatch: false,
			keys: [],
			excluded: picked.excluded.map(entry => entry.key),
			reason: `这些活都不用再派（${why}）`,
		};
	}
	return {
		dispatch: true,
		keys: picked.picked.map(entry => entry.key),
		excluded: picked.excluded.map(entry => entry.key),
		reason: '',
	};
}

/** 派发后登记：这些活进入 running，并记一次派发事件（供预算用）。 */
export function noteDispatch(tasks, { keys = [], nowMs = Date.now() } = {}) {
	const wi = workItems();
	for (const key of keys) {
		wi.markRunning(tasks.ledger, key, { source: 'group' }, nowMs);
	}
	tasks.events = wi.pruneEvents([...(tasks.events ?? []), nowMs], nowMs);
	return tasks;
}

/**
 * 回复回收：把成员回的执行结果折算成账本终态。
 * 缺 `[item:...]` 标记 ⇒ 按 failed（与 loop 同一条：没签字不算成功）。
 */
export function settleGroupReply({ keys = [], finalText = '', stopReason = '', completion } = {}) {
	const wi = workItems();
	const outcome = wi.outcomeOf({ finalText, stopReason, completion });
	return { status: outcome.status, reason: outcome.reason, marker: outcome.marker, keys };
}

/** 把结算写进账本。 */
export function settleIntoLedger(tasks, { keys = [], status = 'failed', reason = '', marker = '', sessionId = '', nowMs = Date.now() } = {}) {
	const wi = workItems();
	for (const key of keys) {
		const patch = { source: 'group', reason, marker, sessionId };
		if (status === 'done') {
			wi.markDone(tasks.ledger, key, patch, nowMs);
		} else if (status === 'blocked') {
			wi.markBlocked(tasks.ledger, key, patch, nowMs);
		} else {
			wi.markFailed(tasks.ledger, key, patch, nowMs);
		}
	}
	return tasks;
}
