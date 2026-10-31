// 纯模块：loop 元数据的解析、默认值与护栏校验。零 I/O、零时钟 ⇒ 可被单测与干跑直接调用。
//
// 口径照抄 bunnyseek `bunnyseek/loop/spec.py`（它是这套语义的参考实现，坑都在它的注释里）：
//   · schedule 只有 three shapes —— `every <dur>` / `daily HH:MM` / `manual`，刻意不做 cron
//     （cron 要时区故事，而 `every` 已经覆盖"每 N 分钟看一眼"这类真实需求）；
//   · 每条护栏都有默认值 ⇒ 只写 name + schedule 的最小 loop 也是"能 7×24 跑"的；
//   · 越过硬上限一律**拒绝**（不是夹紧）—— 夹紧会让"我明明写了 500 轮"变成静默 60 轮。

/** 两轮之间的硬地板：`every 1s` 这种手滑不许打爆 provider。 */
export const MIN_ROUND_INTERVAL_S = 120;

import { HANDOFF_DEFAULTS, HANDOFF_HARD_LIMITS } from './handoff.js';

/** 硬上限（越过即报错，不夹紧）。bunnyseek 的 item_turn_cap 上限是 2000；我们收紧到 500。 */
export const HARD_LIMITS = {
	maxItemsPerRound: 20,
	itemTurnCap: 500,
	itemTimeoutS: 6 * 3600,
	maxAttempts: 5,
	retryBackoffS: 24 * 3600,
	consecutiveFailureLimit: 10,
	runsRetentionS: 365 * 86400,
};

/**
 * 默认值 —— 与 bunnyseek 的差异只有两处，且都是有意的：
 *   · maxItemsPerRound 5 → 3（我们的单次模型调用更贵）；
 *   · itemTimeout 2h → 45m（同上；真需要长的在 loop 里显式写）。
 */
export const DEFAULTS = {
	schedule: 'manual',
	quietHours: '',
	maxItemsPerRound: 3,
	maxConcurrent: 1,
	onAsk: 'block',
	itemTurnCap: 60,
	itemTimeout: '45m',
	harvestTimeout: '2m',
	maxAttempts: 2,
	retryBackoff: '30m',
	consecutiveFailureLimit: 3,
	roundCostCeiling: 0,
	runsRetention: '30d',
	notify: ['web'],
};

export const ON_ASK = ['block', 'assume'];
const SCHEDULES = ['every', 'daily', 'manual'];
const UNITS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

export class LoopSpecError extends Error {
	constructor(key, detail) {
		super(`${key}: ${detail}`);
		this.name = 'LoopSpecError';
		this.key = key;
	}
}

const text = value => (typeof value === 'string' ? value.trim() : '');

/** `30s` / `15m` / `4h` / `30d` / 裸数字（秒，bunnyseek 口径）→ 整数秒。 */
export function parseDuration(raw, key = 'duration') {
	const input = text(raw);
	const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(input);
	if (!m) {
		throw new LoopSpecError(key, `expected a duration like 30s / 15m / 4h / 30d, got ${JSON.stringify(input)}`);
	}
	return Math.trunc(Number(m[1]) * UNITS[m[2].toLowerCase()]);
}

/** `HH:MM` → 本地零点起的分钟数。 */
export function parseClock(raw, key = 'time') {
	const m = /^(\d{1,2}):(\d{2})$/.exec(text(raw));
	if (!m) {
		throw new LoopSpecError(key, `expected HH:MM, got ${JSON.stringify(text(raw))}`);
	}
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	if (hh > 23 || mm > 59) {
		throw new LoopSpecError(key, `${JSON.stringify(text(raw))} is not a valid time of day`);
	}
	return hh * 60 + mm;
}

/**
 * `every 4h` / `daily 02:20` / `manual`（空串等价 manual）。
 * 返回 `{ kind, intervalS?, atMinute?, text }` —— `text` 是规范化后的描述，直接进 UI。
 */
export function parseSchedule(raw) {
	const input = text(raw).split(/\s+/).filter(Boolean).join(' ');
	if (!input || input.toLowerCase() === 'manual') {
		return { kind: 'manual', text: 'manual' };
	}
	const [head, ...rest] = input.split(' ');
	const kind = head.toLowerCase();
	const tail = rest.join(' ');
	if (kind === 'every') {
		const intervalS = parseDuration(tail, 'schedule');
		if (intervalS < MIN_ROUND_INTERVAL_S) {
			throw new LoopSpecError('schedule', `'every ${tail}' is below the ${MIN_ROUND_INTERVAL_S}s minimum round interval`);
		}
		return { kind: 'every', intervalS, text: `every ${intervalS}s` };
	}
	if (kind === 'daily') {
		const atMinute = parseClock(tail, 'schedule');
		const hh = String(Math.trunc(atMinute / 60)).padStart(2, '0');
		const mm = String(atMinute % 60).padStart(2, '0');
		return { kind: 'daily', atMinute, text: `daily ${hh}:${mm}` };
	}
	throw new LoopSpecError('schedule', `expected 'every <duration>', 'daily HH:MM' or 'manual', got ${JSON.stringify(input)}`);
}

/**
 * `23:00-06:00` 安静时段（本地时间：说的是操作员的作息，不是 UTC）。
 * `start > end` 表示跨午夜。空 / none / off ⇒ 不启用。
 */
export function parseQuietHours(raw) {
	const input = text(raw);
	if (!input || ['none', 'off'].includes(input.toLowerCase())) {
		return { active: false, startMinute: 0, endMinute: 0, text: '' };
	}
	const [start, end] = input.split('-');
	const startMinute = parseClock(start, 'quietHours');
	const endMinute = parseClock(end, 'quietHours');
	const pad = n => String(n).padStart(2, '0');
	return {
		active: true,
		startMinute,
		endMinute,
		text: `${pad(Math.trunc(startMinute / 60))}:${pad(startMinute % 60)}-${pad(Math.trunc(endMinute / 60))}:${pad(endMinute % 60)}`,
	};
}

/** 安静时段是否包含某一分钟（跨午夜两种情形都覆盖）。 */
export function quietHoursContains(quiet, minuteOfDay) {
	if (!quiet?.active || quiet.startMinute === quiet.endMinute) {
		return false;
	}
	if (quiet.startMinute < quiet.endMinute) {
		return quiet.startMinute <= minuteOfDay && minuteOfDay < quiet.endMinute;
	}
	return minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute;
}

function intIn(raw, key, min, max, fallback) {
	if (raw === undefined || raw === null || raw === '') {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value)) {
		throw new LoopSpecError(key, `expected an integer, got ${JSON.stringify(raw)}`);
	}
	if (value < min || value > max) {
		throw new LoopSpecError(key, `${value} is out of range ${min}..${max}`);
	}
	return value;
}

/**
 * 校验一份 loop 元数据（`loop.json` 的原始对象）→ 规范化的 spec。
 *
 * 参数 `name` 来自目录名（loop 的身份就是目录名，bunnyseek 同口径）：
 * 目录名不用在 loop.json 里重复写，避免"两处不一致时以谁为准"的问题。
 */
export function normalizeLoop(name, raw = {}) {
	if (!/^[A-Za-z0-9._-]+$/.test(text(name))) {
		throw new LoopSpecError('name', `invalid loop directory name ${JSON.stringify(name)}`);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new LoopSpecError('loop.json', 'expected an object');
	}
	const onAsk = text(raw.onAsk) || DEFAULTS.onAsk;
	if (!ON_ASK.includes(onAsk)) {
		throw new LoopSpecError('onAsk', `expected one of ${ON_ASK.join(' / ')}, got ${JSON.stringify(onAsk)}`);
	}
	const itemTimeoutS = parseDuration(raw.itemTimeout ?? DEFAULTS.itemTimeout, 'itemTimeout');
	const retryBackoffS = parseDuration(raw.retryBackoff ?? DEFAULTS.retryBackoff, 'retryBackoff');
	const harvestTimeoutS = parseDuration(raw.harvestTimeout ?? DEFAULTS.harvestTimeout, 'harvestTimeout');
	const runsRetentionS = parseDuration(raw.runsRetention ?? DEFAULTS.runsRetention, 'runsRetention');
	if (itemTimeoutS > HARD_LIMITS.itemTimeoutS) {
		throw new LoopSpecError('itemTimeout', `${itemTimeoutS}s exceeds the hard limit ${HARD_LIMITS.itemTimeoutS}s`);
	}
	if (retryBackoffS > HARD_LIMITS.retryBackoffS) {
		throw new LoopSpecError('retryBackoff', `${retryBackoffS}s exceeds the hard limit ${HARD_LIMITS.retryBackoffS}s`);
	}
	if (runsRetentionS > HARD_LIMITS.runsRetentionS) {
		throw new LoopSpecError('runsRetention', `${runsRetentionS}s exceeds the hard limit ${HARD_LIMITS.runsRetentionS}s`);
	}
	const notify = Array.isArray(raw.notify) ? raw.notify.map(text).filter(Boolean) : [...DEFAULTS.notify];
	const ceiling = Number(raw.roundCostCeiling ?? DEFAULTS.roundCostCeiling);
	if (!Number.isFinite(ceiling) || ceiling < 0) {
		throw new LoopSpecError('roundCostCeiling', `expected a non-negative number, got ${JSON.stringify(raw.roundCostCeiling)}`);
	}
	const maxConcurrent = intIn(raw.maxConcurrent, 'maxConcurrent', 1, 1, DEFAULTS.maxConcurrent);

	const spec = {
		name: text(name),
		title: text(raw.title) || text(name),
		description: text(raw.description),
		schedule: parseSchedule(raw.schedule ?? DEFAULTS.schedule),
		quietHours: parseQuietHours(raw.quietHours ?? DEFAULTS.quietHours),
		maxItemsPerRound: intIn(raw.maxItemsPerRound, 'maxItemsPerRound', 1, HARD_LIMITS.maxItemsPerRound, DEFAULTS.maxItemsPerRound),
		maxConcurrent,
		onAsk,
		itemTurnCap: intIn(raw.itemTurnCap, 'itemTurnCap', 1, HARD_LIMITS.itemTurnCap, DEFAULTS.itemTurnCap),
		itemTimeoutS,
		harvestTimeoutS,
		maxAttempts: intIn(raw.maxAttempts, 'maxAttempts', 1, HARD_LIMITS.maxAttempts, DEFAULTS.maxAttempts),
		retryBackoffS,
		consecutiveFailureLimit: intIn(raw.consecutiveFailureLimit, 'consecutiveFailureLimit', 1, HARD_LIMITS.consecutiveFailureLimit, DEFAULTS.consecutiveFailureLimit),
		roundCostCeiling: ceiling,
		runsRetentionS,
		notify,
		// 取活：`harvest.command` 跑一条命令、stdout 必须是 JSON 数组（见 store/runner）。
		harvest: {
			command: text(raw.harvest?.command),
			cwd: text(raw.harvest?.cwd),
			// 行的哪些字段进 identity key；为空 = 用 `id`。
			identityFields: Array.isArray(raw.identityFields) ? raw.identityFields.map(text).filter(Boolean) : ['id'],
		},
		work: {
			template: text(raw.work?.template),
			prompt: text(raw.work?.prompt),
			taskHeader: text(raw.work?.taskHeader),
			allowedTools: Array.isArray(raw.work?.allowedTools) ? raw.work.allowedTools.map(text).filter(Boolean) : [],
			cwd: text(raw.work?.cwd),
			model: text(raw.work?.model),
		},
		completion: {
			requireMarker: raw.completion?.requireMarker !== false,
			onMissingMarker: text(raw.completion?.onMissingMarker) === 'done' ? 'done' : 'failed',
		},
		// ★ 2026-10-31：结构化交接（对照官方 Ralph）。默认 **不强制** —— 没配置的 loop 与从前逐字一致；
		//   开了 `require` 才要求每份 item 交 handoff，且超长/字段矛盾一律判失败（不截断）。
		handoff: {
			require: raw.handoff?.require === true,
			maxChars: intIn(raw.handoff?.maxChars, 'handoff.maxChars', 1024, HANDOFF_HARD_LIMITS.maxChars, HANDOFF_DEFAULTS.maxChars),
		},
	};

	// 非致命问题：只在 UI/干跑里提示，不阻止保存（对齐 bunnyseek 的 warnings 口径）。
	const warnings = [];
	if (!spec.harvest.command) {
		warnings.push('harvest.command 为空：这个 loop 每轮都会采到 0 条（干跑可确认）');
	}
	if (!spec.work.prompt && !spec.work.template) {
		warnings.push('work.prompt 与 work.template 都为空：item 会带着空 prompt 跑');
	}
	if (spec.schedule.kind === 'manual') {
		warnings.push('schedule=manual：只能手动触发，不会自动跑');
	}
	if (spec.roundCostCeiling === 0) {
		warnings.push('roundCostCeiling=0（关）：无人值守时没有成本上限');
	}
	for (const name of [...spec.work.allowedTools]) {
		if (!/^[a-z0-9_]+$/i.test(name)) {
			warnings.push(`work.allowedTools 里的 ${JSON.stringify(name)} 不像一个工具名`);
		}
	}
	return { spec, warnings };
}

/** UI / 工具回执用的扁平投影（不含 prompt 正文 —— 它可能几十 KB）。 */
export function describeLoop(spec) {
	return {
		name: spec.name,
		title: spec.title,
		description: spec.description,
		schedule: spec.schedule.text,
		quietHours: spec.quietHours.text,
		maxItemsPerRound: spec.maxItemsPerRound,
		onAsk: spec.onAsk,
		itemTurnCap: spec.itemTurnCap,
		itemTimeoutS: spec.itemTimeoutS,
		maxAttempts: spec.maxAttempts,
		consecutiveFailureLimit: spec.consecutiveFailureLimit,
		roundCostCeiling: spec.roundCostCeiling,
		handoff: { ...spec.handoff, selfReported: true },
		notify: [...spec.notify],
		hasHarvestCommand: !!spec.harvest.command,
		hasPrompt: !!(spec.work.prompt || spec.work.template),
	};
}
