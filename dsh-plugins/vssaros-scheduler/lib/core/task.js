// @vssaros/dsh-scheduler — 任务模型（自建调度的纯判据层，与 loop 的 `core/spec.js` 同款纪律）。
//
// ★ 与官方 `@deepseek-ai/dsh-schedule` 的关键差异都在这个文件里：
//   1. `kind` 有三型 —— `prompt`（往会话投一句话，官方只有这一种）/ `loop`（触发循环）/ `action`（调服务）；
//   2. `workItem` —— 每次触发可映射成一条 work item，复用 `@vssaros/dsh-workitem` 内核
//      ⇒ 定时任务也能"今天做过了就不再做 / 失败退避 / [item:done] 完成契约"；
//   3. 任务存我们自己的文件（`<数据根>/scheduler/tasks.json`），不寄生会话。

import { describeRule, nextRunAtMs } from './cron.js';

export const TASK_KINDS = ['prompt', 'loop', 'action'];
export const TASK_STATUSES = ['active', 'paused', 'ended'];
export const RULE_KINDS = ['cron', 'daily', 'weekly', 'every', 'at', 'after'];
export const DEDUPE_MODES = ['forever', 'per-day', 'off'];
/** `every` 的最小间隔（秒）。官方下限是 60s，我们取同值以免用户困惑。 */
export const MIN_EVERY_SECONDS = 60;
export const DEFAULT_TIME_ZONE = 'UTC';

export class TaskError extends Error {
	constructor(field, message) {
		super(`${field}: ${message}`);
		this.name = 'TaskError';
		this.field = field;
	}
}

const str = v => (typeof v === 'string' ? v.trim() : '');

/** 校验并归一化一条任务。越界一律**报错**，不做夹紧（夹紧会让人以为写的值生效了）。 */
export function normalizeTask(raw, { nowMs = Date.now(), timeZone = DEFAULT_TIME_ZONE } = {}) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new TaskError('task', '任务必须是对象');
	}
	const id = str(raw.id);
	if (!id) {
		throw new TaskError('id', '任务必须有 id');
	}

	const kind = str(raw.kind).toLowerCase() || 'prompt';
	if (!TASK_KINDS.includes(kind)) {
		throw new TaskError('kind', `必须是 ${TASK_KINDS.join(' / ')}，实际 ${JSON.stringify(raw.kind)}`);
	}

	const status = str(raw.status).toLowerCase() || 'active';
	if (!TASK_STATUSES.includes(status)) {
		throw new TaskError('status', `必须是 ${TASK_STATUSES.join(' / ')}，实际 ${JSON.stringify(raw.status)}`);
	}

	// ── 规则：用 nextRunAtMs 试算一次，解析不了就在这里炸（不要等到引擎跑起来才发现）
	const ruleRaw = raw.rule ?? {};
	const ruleKind = str(ruleRaw.kind).toLowerCase();
	if (!RULE_KINDS.includes(ruleKind)) {
		throw new TaskError('rule.kind', `必须是 ${RULE_KINDS.join(' / ')}，实际 ${JSON.stringify(ruleRaw.kind)}`);
	}
	const anchorMs = Number.isFinite(raw.createdAtMs) ? Number(raw.createdAtMs) : nowMs;
	const rule = {
		kind: ruleKind,
		timeZone: str(ruleRaw.timeZone) || timeZone,
		anchorMs,
	};
	if (ruleKind === 'cron') {
		rule.expression = str(ruleRaw.expression);
	} else if (ruleKind === 'daily' || ruleKind === 'weekly') {
		const atMinute = Number(ruleRaw.atMinute);
		if (!Number.isInteger(atMinute) || atMinute < 0 || atMinute >= 24 * 60) {
			throw new TaskError('rule.atMinute', `必须是 0-${24 * 60 - 1} 的整数分钟，实际 ${ruleRaw.atMinute}`);
		}
		rule.atMinute = atMinute;
		if (ruleKind === 'weekly') {
			const weekdays = Array.isArray(ruleRaw.weekdays) ? ruleRaw.weekdays.map(Number).filter(Number.isInteger) : [];
			if (!weekdays.length || weekdays.some(d => d < 0 || d > 6)) {
				throw new TaskError('rule.weekdays', '必须给出 0-6（0=周日）的星期列表');
			}
			rule.weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
		}
	} else if (ruleKind === 'every') {
		const everySeconds = Number(ruleRaw.everySeconds);
		if (!Number.isInteger(everySeconds) || everySeconds < MIN_EVERY_SECONDS) {
			throw new TaskError('rule.everySeconds', `必须是 ≥${MIN_EVERY_SECONDS} 的整数秒，实际 ${ruleRaw.everySeconds}`);
		}
		rule.everySeconds = everySeconds;
	} else if (ruleKind === 'after') {
		const afterSeconds = Number(ruleRaw.afterSeconds);
		if (!Number.isInteger(afterSeconds) || afterSeconds < 1) {
			throw new TaskError('rule.afterSeconds', '必须是 ≥1 的整数秒');
		}
		rule.afterSeconds = afterSeconds;
	} else {
		// at
		rule.at = { date: str(ruleRaw.at?.date), time: str(ruleRaw.at?.time) };
	}
	// 试算（解析失败会抛 TaskError）
	let next = Infinity;
	try {
		next = nextRunAtMs(rule, nowMs, rule.timeZone);
	} catch (error) {
		throw new TaskError('rule', String(error?.message ?? error));
	}

	// ── 各类 kind 的必填字段
	const payload = {};
	if (kind === 'prompt') {
		payload.prompt = str(raw.prompt);
		if (!payload.prompt) {
			throw new TaskError('prompt', 'kind=prompt 必须有 prompt');
		}
		payload.sessionId = str(raw.sessionId);
	} else if (kind === 'loop') {
		payload.loopName = str(raw.loopName);
		if (!payload.loopName) {
			throw new TaskError('loopName', 'kind=loop 必须有 loopName');
		}
	} else {
		const service = str(raw.action?.service);
		if (!service) {
			throw new TaskError('action.service', 'kind=action 必须给出服务名');
		}
		const method = str(raw.action?.method);
		if (!method) {
			throw new TaskError('action.method', 'kind=action 必须给出方法名');
		}
		payload.action = { service, method, args: raw.action?.args ?? {} };
	}

	const dedupe = str(raw.workItem?.dedupe).toLowerCase() || (kind === 'loop' ? 'per-day' : 'off');
	if (!DEDUPE_MODES.includes(dedupe)) {
		throw new TaskError('workItem.dedupe', `必须是 ${DEDUPE_MODES.join(' / ')}`);
	}

	// ★ 2026-10-31（编辑弹窗「有效期 / 消息推送」）：
	//   · expiresAt —— 到期自动停用（编辑弹窗的「有效期：长期有效 / 30 天 / 90 天 / 到指定日期」
	//     在保存时折算成这个绝对时刻）；空 = 长期有效。
	//   · notify —— 消息推送标记（编辑弹窗的企微开关）；真正推送由 Host 侧的
	//     `config.notifyWebhook` 决定：没配 webhook 就只记录，不假装推送。
	let expiresAt = null;
	const expiryRaw = str(raw.expiresAt);
	if (expiryRaw) {
		const at = Date.parse(expiryRaw);
		if (!Number.isFinite(at)) {
			throw new TaskError('expiresAt', `不是合法日期：${expiryRaw}`);
		}
		expiresAt = new Date(at).toISOString();
	}
	const notify = raw.notify === true;

	return {
		id,
		title: str(raw.title) || '未命名任务',
		kind,
		status,
		rule,
		expiresAt,
		notify,
		workItem: {
			dedupe,
			keyTemplate: str(raw.workItem?.keyTemplate) || `sched-${id}-${dedupe === 'per-day' ? '{date}' : '{seq}'}`,
		},
		...payload,
		createdAtMs: anchorMs,
		next: { target: Number.isFinite(next) ? next : null },
		lastRun: raw.lastRun ?? { at: 0, ok: null, error: '', seq: 0 },
	};
}

/** 是否到点（一次性规则算完即 ended 由调用方置）。 */
export const isDue = (task, nowMs) => task?.status === 'active'
	&& Number.isFinite(task?.next?.target)
	&& nowMs >= task.next.target;

/** 触发后推进：seq +1、记 lastRun、算下一次。一次性规则 ⇒ status 置 ended。 */
export function markFired(task, { atMs = Date.now(), ok = true, error = '' } = {}) {
	const seq = Number(task?.lastRun?.seq ?? 0) + 1;
	const next = nextRunAtMs(task.rule, atMs, task.rule.timeZone);
	const oneShot = task.rule.kind === 'at' || task.rule.kind === 'after';
	return {
		...task,
		status: (oneShot || !Number.isFinite(next)) ? 'ended' : task.status,
		lastRun: { at: atMs, ok, error: String(error ?? ''), seq },
		next: { target: Number.isFinite(next) ? next : null },
	};
}

/**
 * 由触发事件生成 work item 的 key（`{date}` / `{seq}` 占位符替换）。
 * 日期按**任务时区**算 —— 否则"每天一次"在跨时区机器上会一天算两次或零次。
 */
export function workItemKeyOf(task, { atMs = Date.now() } = {}) {
	const template = task?.workItem?.keyTemplate || `sched-${task?.id}-{seq}`;
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: task?.rule?.timeZone || DEFAULT_TIME_ZONE,
		year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(new Date(atMs));
	const get = type => parts.find(p => p.type === type)?.value ?? '';
	const date = `${get('year')}-${get('month')}-${get('day')}`;
	return template
		.replace('{date}', date)
		.replace('{seq}', String(Number(task?.lastRun?.seq ?? 0) + 1))
		.replace('{id}', String(task?.id ?? ''));
}

/**
 * 官方 `ScheduleCreateRequest` 的规则字段 → **自建 rule**。
 *
 * 为什么要有这一层：旧表单（0.3.1）与 legacy 迁移提交的是官方形状（`daily:{time,time_zone}`），
 * 而自建引擎认的是 `{kind:'daily', atMinute, timeZone}`。过渡期两种都要吃；
 * UI 换成自建之后，`buildCreateRule` 与这个函数可以一起删掉。
 *
 * ⚠ 放在 core 而不是 index.js：index.js（API）与 migrate.js（legacy 迁移）都要用，
 *   两份实现迟早分叉（这是本项目反复踩到的一类坑）。
 */
export function officialToSelfRule(request) {
	const zone = request?.time_zone ?? request?.daily?.time_zone ?? request?.weekly?.time_zone
		?? request?.at?.time_zone ?? request?.cron?.time_zone ?? 'UTC';
	const minuteOf = clock => {
		const m = /^(\d{2}):(\d{2})/.exec(String(clock ?? ''));
		return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
	};
	if (request?.daily) { return { kind: 'daily', atMinute: minuteOf(request.daily.time), timeZone: zone }; }
	if (request?.weekly) {
		// 官方 weekdays 是 ISO（周一 1 … 周日 7），自建用 JS 约定（0=周日）⇒ 7 → 0
		const weekdays = (request.weekly.weekdays ?? []).map(d => (Number(d) % 7));
		return { kind: 'weekly', atMinute: minuteOf(request.weekly.time), weekdays: [...new Set(weekdays)].sort((a, b) => a - b), timeZone: zone };
	}
	if (request?.every_seconds) { return { kind: 'every', everySeconds: Number(request.every_seconds), timeZone: zone }; }
	if (request?.at) { return { kind: 'at', at: { date: request.at.date, time: String(request.at.time ?? '').slice(0, 5) }, timeZone: zone }; }
	if (request?.cron) { return { kind: 'cron', expression: request.cron.expression, timeZone: zone }; }
	return undefined;
}

export { describeRule, nextRunAtMs };
