// @vssaros/dsh-scheduler — 规则解析与「下一次运行时刻」计算（自建调度的纯判据层）。
//
// ★ 为什么自己写：官方 `@deepseek-ai/dsh-schedule` 是 runtime 自带的黑盒（无事件回调、
//   任务只能是"投 prompt"、持久化在会话里）。自建后这层是我们自己的，可单测、可扩展
//   （`kind:'loop'` 直接触发循环）。
//
// ⚠ 刻意不支持 `L` / `W` / `#` / `@` —— 官方迁移校验也拒这些；支持它们的代价是
//    "每月最后一个周五"这类语义要引入月历边界，而我们的场景（工作日、每 N 小时、定点）用不到。
//
// 时区：一律 IANA（`Asia/Shanghai`），用 `Intl` 反解，**绝不自己算固定偏移**（夏令时会错）。

const FIELD_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

function parseField(raw, min, max, label) {
	const text = String(raw ?? '').trim();
	if (text === '') {
		throw new Error(`cron 字段 ${label} 为空`);
	}
	const values = new Set();
	for (const part of text.split(',')) {
		const m = FIELD_RE.exec(part.trim());
		if (!m) {
			throw new Error(`cron 字段 ${label} 不合法：${part}`);
		}
		const [, head, tail, stepText] = m;
		const step = stepText ? Number(stepText) : 1;
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`cron 字段 ${label} 步长不合法：${part}`);
		}
		let from;
		let to;
		if (head === '*') {
			from = min;
			to = tail ? Number(tail) : max;
		} else {
			from = Number(head);
			to = tail ? Number(tail) : (stepText ? max : from);
		}
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
			throw new Error(`cron 字段 ${label} 越界：${part}（允许 ${min}-${max}）`);
		}
		for (let v = from; v <= to; v += step) {
			values.add(v);
		}
	}
	if (values.size === 0) {
		throw new Error(`cron 字段 ${label} 没有取到任何值`);
	}
	return [...values].sort((a, b) => a - b);
}

/** 解析五字段 cron。返回升序取值数组（月份 1-12、星期 0-6 且 0=周日，与标准一致）。 */
export function parseCron(expression) {
	const parts = String(expression ?? '').trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`cron 必须是 5 个字段（分 时 日 月 周），实际 ${parts.length} 个：${JSON.stringify(expression)}`);
	}
	if (/[LW#@]/.test(String(expression))) {
		throw new Error('cron 不支持 L / W / # / @ 扩展语法');
	}
	return {
		minutes: parseField(parts[0], 0, 59, 'minute'),
		hours: parseField(parts[1], 0, 23, 'hour'),
		daysOfMonth: parseField(parts[2], 1, 31, 'dayOfMonth'),
		months: parseField(parts[3], 1, 12, 'month'),
		daysOfWeek: parseField(parts[4], 0, 6, 'dayOfWeek'),
	};
}

/**
 * 时间戳 → 指定 IANA 时区的日历字段。
 * 用 `en-US` + `hour12:false` 拿 24 小时制（注意：部分环境 `hour12:false` 会给 `24` 表示午夜）。
 */
function partsInZone(ms, timeZone) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
	});
	const out = {};
	for (const part of fmt.formatToParts(new Date(ms))) {
		if (part.type !== 'literal') {
			out[part.type] = Number(part.value);
		}
	}
	if (out.hour === 24) { out.hour = 0; }
	return out;
}

/**
 * 时区日历字段 → UTC 时间戳。
 * 做法：先按 UTC 构造，再取该时刻在目标时区的实际偏移修正一次；跨夏令时的那一天
 * 修正一轮即可对齐（两轮是常见做法，这里一轮已经足够：`partsInZone` 拿到的偏移
 * 就是目标时刻真实生效的偏移）。
 */
function zoneToMs(y, mo, d, h, mi, timeZone) {
	const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
	const shown = partsInZone(guess, timeZone);
	const drift = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second ?? 0) - guess;
	return guess - drift;
}

const has = (list, v) => list.includes(v);

/**
 * 某一天是否符合 cron 的日/月/周约束。
 *
 * ★ 标准 cron（Vixie）语义 —— 日与周**都被限定**时取**并集**，不是交集：
 *   `0 9 15 * 1` = 每月 15 日 **或** 每个周一，而不是"既是 15 日又是周一"。
 *   （曾写成交集：`domOk && dowOk`，反向突变没变红才暴露出来 —— 那条用例刚好只覆盖了
 *    "只有周受限"的情形，两种实现等价。）
 */
function dayMatches(cron, y, mo, d) {
	if (!has(cron.months, mo)) { return false; }
	const domAll = cron.daysOfMonth.length === 31;
	const dowAll = cron.daysOfWeek.length === 7;
	if (domAll && dowAll) { return true; }
	const domOk = domAll || has(cron.daysOfMonth, d);
	const dowOk = dowAll || has(cron.daysOfWeek, new Date(Date.UTC(y, mo - 1, d)).getUTCDay());
	if (domAll) { return dowOk; }
	if (dowAll) { return domOk; }
	return domOk || dowOk;
}

/** 当天从 `minH:minM` 起第一个匹配的 时:分，没有则 null。 */
function firstTimeOnDay(cron, minH, minM) {
	for (const h of cron.hours) {
		if (h < minH) { continue; }
		const fromMinute = h === minH ? minM : 0;
		for (const m of cron.minutes) {
			if (m >= fromMinute) { return { h, m }; }
		}
	}
	return null;
}

/**
 * 规则 → 下一次运行时刻（ms）。
 *
 * @returns 毫秒时间戳；`after`/`at` 这类一次性规则若已过期 ⇒ `Infinity`（调用方据此置 ended）。
 */
export function nextRunAtMs(rule, fromMs, timeZone = 'UTC') {
	const raw = rule ?? {};
	const kind = String(raw.kind ?? '').toLowerCase();
	const at = Number.isFinite(fromMs) ? fromMs : Date.now();

	if (kind === 'every') {
		const stepS = Number(raw.everySeconds);
		if (!Number.isInteger(stepS) || stepS < 60) {
			throw new Error(`every 的间隔必须是 ≥60 的整数秒，实际 ${raw.everySeconds}`);
		}
		// 从"创建那一刻"起按固定步长推进，不跟墙上时钟对齐（避免重启后相位漂移）。
		const anchor = Number.isFinite(raw.anchorMs) ? Number(raw.anchorMs) : at;
		const elapsed = at - anchor;
		const steps = Math.max(0, Math.floor(elapsed / (stepS * 1000)) + 1);
		return anchor + steps * stepS * 1000;
	}
	if (kind === 'after') {
		const afterS = Number(raw.afterSeconds);
		if (!Number.isInteger(afterS) || afterS < 1) {
			throw new Error(`after 必须是 ≥1 的整数秒，实际 ${raw.afterSeconds}`);
		}
		const anchor = Number.isFinite(raw.anchorMs) ? Number(raw.anchorMs) : at;
		const target = anchor + afterS * 1000;
		return target > at ? target : Infinity;
	}
	if (kind === 'at') {
		const date = String(raw.at?.date ?? '');
		const time = String(raw.at?.time ?? '');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
			throw new Error(`at 需要 { date: 'YYYY-MM-DD', time: 'HH:MM' }，实际 ${JSON.stringify(raw.at)}`);
		}
		const [y, mo, d] = date.split('-').map(Number);
		const [h, mi] = time.split(':').map(Number);
		const target = zoneToMs(y, mo, d, h, mi, timeZone);
		return target > at ? target : Infinity;
	}

	// daily / weekly / cron 统一走"按天推进"
	const cron = kind === 'cron'
		? parseCron(raw.expression)
		: {
			minutes: [Number(raw.atMinute ?? 0) % 60],
			hours: [Math.trunc(Number(raw.atMinute ?? 0) / 60)],
			daysOfMonth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
			months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			daysOfWeek: kind === 'weekly'
				? (Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays.map(Number) : [1, 2, 3, 4, 5])
				: [0, 1, 2, 3, 4, 5, 6],
		};

	const start = partsInZone(at, timeZone);
	// 最多向前找 366 天（覆盖闰年 + 2 月 29）
	for (let offset = 0; offset <= 366; offset += 1) {
		const probe = Date.UTC(start.year, start.month - 1, start.day + offset);
		const p = partsInZone(probe, timeZone);
		if (!dayMatches(cron, p.year, p.month, p.day)) { continue; }
		const minH = offset === 0 ? start.hour : 0;
		const minM = offset === 0 ? start.minute + (start.second > 0 ? 1 : 0) : 0;
		const hit = firstTimeOnDay(cron, minH, minM);
		if (!hit) { continue; }
		const target = zoneToMs(p.year, p.month, p.day, hit.h, hit.m, timeZone);
		if (target > at) { return target; }
	}
	return Infinity;
}

/** 人能读的规则描述（UI 与通知用）。 */
export function describeRule(rule) {
	const kind = String(rule?.kind ?? '').toLowerCase();
	switch (kind) {
		case 'cron': return `cron ${rule.expression}`;
		case 'daily': {
			const atMinute = Number(rule.atMinute ?? 0);
			return `每天 ${String(Math.trunc(atMinute / 60)).padStart(2, '0')}:${String(atMinute % 60).padStart(2, '0')}`;
		}
		case 'weekly': {
			const names = ['日', '一', '二', '三', '四', '五', '六'];
			const weekdays = (rule.weekdays ?? []).map(d => names[d] ?? String(d));
			return `每週${weekdays.join('/')}`;
		}
		case 'every': return `每 ${Math.round(Number(rule.everySeconds ?? 0) / 60)} 分钟`;
		case 'at': return `${rule.at?.date ?? '?'} ${rule.at?.time ?? '?'}（一次性）`;
		case 'after': return `${rule.afterSeconds ?? '?'}s 后（一次性）`;
		default: return '(未知规则)';
	}
}
