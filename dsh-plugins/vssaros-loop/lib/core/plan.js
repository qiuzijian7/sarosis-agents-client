// 纯模块：跑不跑（due 计算）、做什么（挑选 + 排除原因）、做完了吗（完成标记）。
// 零 I/O、零时钟（now 一律由调用方传入）⇒ 干跑与单测走的是同一份判断。

import { quietHoursContains } from './spec.js';
import { workItems } from '../workItemRef.js';

const DAY_MS = 86400_000;

/**
 * item 的身份 key（= ledger 的键）。
 *
 * 与 bunnyseek 同口径：key 必须对**同一件活**稳定，否则去重就失效。默认取 `row.id`；
 * 配了 `identityFields` 就按顺序拼（`["bugId","gameid"]` → `loop/bug/123/gameid=778`）。
 * 前缀带上 loop 名：两个 loop 处理同一个 id 时账本不互相污染。
 */
export function identityOf(spec, row) {
	const fields = spec?.harvest?.identityFields?.length ? spec.harvest.identityFields : ['id'];
	const parts = [];
	for (const field of fields) {
		const value = row?.[field];
		if (value === undefined || value === null || String(value).trim() === '') {
			return { error: `missing field ${JSON.stringify(field)}` };
		}
		parts.push(String(value).trim());
	}
	return { key: `${spec?.name ?? 'loop'}/${parts.join('/')}` };
}

/** 本地时间的"当天第几分钟"。 */
export function minuteOfDay(nowMs) {
	const d = new Date(nowMs);
	return d.getHours() * 60 + d.getMinutes();
}

/**
 * 下一轮应该在什么时候开始（毫秒时间戳）。`Infinity` = 不会自动跑（manual）。
 *
 * `state.lastRoundStartedAt` 用**这一轮的开始时间**而不是结束时间：否则一个跑 40 分钟的
 * item 会把 `every 30m` 变成实际 70 分钟一轮（bunnyseek 的 scheduler 也是这个口径）。
 */
export function nextDueAtMs(spec, state = {}, nowMs = Date.now()) {
	const lastStarted = state?.lastRoundStartedAt ? Date.parse(state.lastRoundStartedAt) : NaN;
	const hasLast = Number.isFinite(lastStarted);
	const schedule = spec?.schedule ?? { kind: 'manual' };

	if (schedule.kind === 'manual') {
		return Infinity;
	}
	if (schedule.kind === 'every') {
		return hasLast ? lastStarted + schedule.intervalS * 1000 : nowMs;
	}
	// daily HH:MM（本地时间）：
	//   · 有 last 且今天这个时刻**早于**上次开始 ⇒ 那轮已经覆盖过它，跳到明天；
	//   · 没有 last 且今天这个时刻已过 ⇒ 明天（启动瞬间不补跑）；
	//   · 其余（含"睡过头"的过去时刻）⇒ 原样返回，调用方看到 now >= due 会立刻跑一轮。
	const midnight = new Date(nowMs);
	midnight.setHours(0, 0, 0, 0);
	let at = midnight.getTime() + schedule.atMinute * 60_000;
	if (hasLast ? at <= lastStarted : at <= nowMs) {
		at += DAY_MS;
	}
	return at;
}

/**
 * 安静时段的剩余毫秒（0 = 不在安静时段）。跨午夜时给出到结束的时长，至少 1 分钟
 * ——调用方 sleep 这个值时不会变成自旋。
 */
export function quietDelayMs(spec, nowMs = Date.now()) {
	const quiet = spec?.quietHours;
	if (!quiet?.active) {
		return 0;
	}
	const minute = minuteOfDay(nowMs);
	if (!quietHoursContains(quiet, minute)) {
		return 0;
	}
	const delta = (quiet.endMinute - minute + 24 * 60) % (24 * 60);
	return (delta > 0 ? delta : 1) * 60_000;
}

/**
 * 从 harvest 的行里挑出这一轮要做的 item。
 *
 * 委托内核 `@vssaros/dsh-workitem` 的 `pickItems`（真源唯一 ⇒ 与群聊共用同一套去重语义）；
 * 差别只有"key 怎么来"：loop 用 `identityFields` 派生（群聊用 `#task` 标签），
 * 所以这里把 `keyOf` 注入进去，`reason` 文案沿用本插件的口径。
 *
 * 返回 `excluded` 而不是静默丢弃 —— 干跑的价值全在这张表上（"其余每条为什么被排除"）。
 */
export function pickItems({ spec, rows, ledger, nowMs = Date.now() }) {
	const keyOf = row => {
		const identity = identityOf(spec, row);
		return identity.error ? null : identity.key;
	};
	const result = workItems().pickItems({ rows, keyOf, ledger, policy: spec, nowMs });
	// 内核不知道"harvest"这回事，把它的通用文案换成 loop 口径（群聊那份仍显示"候选"）。
	const excluded = result.excluded.map(entry => (
		entry.reason === '候选不是数组'
			? { ...entry, reason: 'harvest 返回的不是数组' }
			: entry
	));
	return { picked: result.picked, excluded, total: result.total };
}

// ⚠ 旧的内联判定已**整体删除**（不是注释掉）：留着就会有人改它，于是"真源"又变回两份。

/**
 * 解析 item 的完成标记（末行的契约）。与 `[plan:ready]` 是**不同命名空间**，
 * 两个解析器永远不会读到对方（bunnyseek 也是这么分的，否则计划模式的信号会误判 item 完成）。
 *
 * 契约：`[item:done]` / `[item:failed:<原因>]` / `[item:blocked:<原因>]`
 */
export function parseItemMarker(raw) {
	return workItems().parseItemMarker(raw);
}

/**
 * 把回合结果折算成 ledger 的终态。
 *
 * `onMissingMarker='failed'`（默认）的意义：模型没按契约签字就**不算成功**，让它重试；
 * 反过来把"没签字"当 done，是无人值守循环里最常见的假绿。
 */
export function outcomeOf({ finalText, stopReason, completion }) {
	return workItems().outcomeOf({ finalText, stopReason, completion });
}
