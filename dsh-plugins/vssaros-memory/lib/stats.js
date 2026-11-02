// @vssaros/dsh-memory — 沉淀统计的落盘（记忆工作台 v2 · P4 漏斗，2026-11-02）。
//
// 为什么要落盘：`state.distill` 在内存里，Host 一重启就清零 ⇒ 页面回答不了
// "自动提升 0 条，是没有候选，还是被门槛拦下？"（重启后 0 和"从没跑过"长得一样）。
// 存储位置 `<数据根>/memory-drafts/stats.json`，与草稿同目录（同一个 `dataRootOf` 口径）。
//
// ## 口径（这是最容易做错的地方）
// 全部是**自 `since` 起的累计事件数**——"回合 / 候选 / 草稿 / 自动提升 / 人工提升 / 丢弃"。
// 「当前待审」是**时点值**（草稿文件里此刻 status=draft 的行数）：它不是累计量，
// 不能和上面那些画在同一个漏斗里（首次部署时已有 17 条待审，会比累计草稿数还大）。
// 所以漏斗只画累计量，待审另列。
//
// ## 同步方式
// `state.distill` 是进程内累计、重启归零；这里用「上次看到的值」算增量再累加：
//   delta = max(0, 当前 - 上次看到)，上次看到 ← 当前
// ⇒ 重启后 `lastSeen` 重置为 0、`state.distill` 也从 0 开始，增量依旧正确，不会重复累加。
// 人工动作（提升/丢弃/撤销…）没有 `state.distill` 对应物，走 `event(key)` 直接 +1。
//
// ⚠ 失败绝不抛（照 draft.js / audit.js 的纪律）：统计丢了不影响任何主流程。
// ⚠ 原子写（临时文件 + rename）+ 防抖：一回合可能同步多次，不能每次都落盘。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { draftDirOf } from './draft.js';

export const STATS_FILE_NAME = 'stats.json';
export const STATS_VERSION = 1;

/** 从 `state.distill` 同步的计数键（与 `lib/index.js` 里的初始形状一一对应）。 */
export const DISTILL_KEYS = Object.freeze([
	'turns', 'candidates', 'summaries', 'summaryFacts', 'turnSummaries', 'written', 'skipped', 'failed',
	'judged', 'judgeDropped', 'judgeSkipped', 'repeats', 'autoPromoted', 'autoFailed',
]);

/** 人工动作事件键（页面触发；自动提升已在 `autoPromoted` 里，这里**不重复计**）。 */
export const EVENT_KEYS = Object.freeze(['humanPromoted', 'discarded', 'undone', 'edited', 'archiveRestored']);

const ALL_KEYS = Object.freeze([...DISTILL_KEYS, ...EVENT_KEYS]);

/** 文件路径：`<数据根>/memory-drafts/stats.json`。 */
export function statsFileOf(config) {
	return join(draftDirOf(config), STATS_FILE_NAME);
}

/** 全 0 的累计表。 */
export function emptyTotals() {
	return Object.fromEntries(ALL_KEYS.map(key => [key, 0]));
}

const nonNegInt = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * 解析落盘内容（损坏 / 缺字段 / 未来版本 ⇒ 一律回落空表，**不抛**）。
 * @param {string|null|undefined} raw
 * @returns {{since: number|null, totals: Record<string, number>}}
 */
export function parseStats(raw) {
	const totals = emptyTotals();
	if (typeof raw !== 'string' || !raw) { return { since: null, totals }; }
	try {
		const row = JSON.parse(raw);
		if (!row || typeof row !== 'object') { return { since: null, totals }; }
		for (const key of ALL_KEYS) { totals[key] = nonNegInt(row.totals?.[key]); }
		const since = Number(row.since);
		return { since: Number.isFinite(since) && since > 0 ? since : null, totals };
	} catch {
		return { since: null, totals };
	}
}

/**
 * 算 `state.distill` 相对「上次看到」的增量（只含 `DISTILL_KEYS`；负数/非数 ⇒ 0）。
 * @param {Record<string, unknown>} current 当前 `state.distill`
 * @param {Record<string, number>} last 上次看到的值
 * @returns {Record<string, number>} 只含大于 0 的键
 */
export function deltaOf(current, last) {
	const out = {};
	for (const key of DISTILL_KEYS) {
		const d = nonNegInt(Number(current?.[key])) - nonNegInt(Number(last?.[key]));
		if (d > 0) { out[key] = d; }
	}
	return out;
}

/**
 * 漏斗各级（全部是累计事件数）。
 *  · 候选 = 显式句式 + 整段摘要 + 回合摘要 + 摘要事实（四条候选流的总和）
 *  · 草稿 = 实际落盘的行数（扣掉了判定丢弃、去重命中）
 * @param {Record<string, number>} totals
 */
export function funnelOf(totals) {
	const t = totals ?? {};
	const n = key => nonNegInt(Number(t[key]));
	return {
		turns: n('turns'),
		candidates: n('candidates') + n('summaries') + n('turnSummaries') + n('summaryFacts'),
		drafts: n('written'),
		auto: n('autoPromoted'),
		human: n('humanPromoted'),
		discarded: n('discarded'),
		undone: n('undone'),
		edited: n('edited'),
		judgeDropped: n('judgeDropped'),
		repeats: n('repeats'),
		failed: n('failed') + n('autoFailed'),
	};
}

/**
 * 建统计存储。
 * @param {object} config 插件 config
 * @param {{now?: () => number, flushMs?: number, logger?: {warn?: Function}}} [deps] 探针可注入时钟与更短的防抖
 */
export function createStatsStore(config, deps = {}) {
	const file = statsFileOf(config);
	const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
	const flushMs = Number.isFinite(deps.flushMs) && deps.flushMs >= 0 ? deps.flushMs : 1500;
	let totals = emptyTotals();
	let since = null;
	let loaded = null; // Promise：保证"先读盘、再累加"，否则累加会被随后读到的旧值覆盖
	let dirty = false;
	let timer = null;
	let writing = Promise.resolve();
	let warned = false;
	let lastSeen = {};

	const warnOnce = error => {
		if (warned) { return; }
		warned = true;
		try { deps.logger?.warn?.(`[vssaros-memory] 沉淀统计落盘失败（后续同类失败不再重复报告）：${error?.message ?? error}`); } catch { /* 绝不再抛 */ }
	};

	const ensureLoaded = () => {
		if (!loaded) {
			loaded = (async () => {
				try {
					const parsed = parseStats(await readFile(file, 'utf8'));
					totals = parsed.totals;
					since = parsed.since;
				} catch { /* 文件不存在 = 第一次运行 */ }
				if (since === null) { since = now(); dirty = true; }
			})();
		}
		return loaded;
	};

	async function flushNow() {
		await ensureLoaded();
		if (timer) { clearTimeout(timer); timer = null; }
		if (!dirty) { return; }
		dirty = false;
		const body = JSON.stringify({ version: STATS_VERSION, since, updatedAt: now(), totals });
		// 串行写：并发的两次 rename 会互相踩（Windows 上尤其容易 EPERM）
		writing = writing.then(async () => {
			try {
				await mkdir(join(file, '..'), { recursive: true });
				const tmp = `${file}.tmp-${process.pid}`;
				await writeFile(tmp, body, 'utf8');
				await rename(tmp, file);
			} catch (error) {
				dirty = true; // 没写成 ⇒ 下次还要写
				warnOnce(error);
			}
		});
		await writing;
	}

	function schedule() {
		if (timer) { return; }
		timer = setTimeout(() => { timer = null; void flushNow(); }, flushMs);
		if (typeof timer.unref === 'function') { timer.unref(); } // 防抖定时器不该拖住进程退出
	}

	/** 累加（只认已知键；非正数忽略）。 */
	async function add(delta) {
		try {
			await ensureLoaded();
			let touched = false;
			for (const key of ALL_KEYS) {
				const d = nonNegInt(Number(delta?.[key]));
				if (d > 0) { totals[key] += d; touched = true; }
			}
			if (touched) { dirty = true; schedule(); }
		} catch (error) { warnOnce(error); }
	}

	return {
		add,
		/** 人工动作事件 +1（未知键忽略）。 */
		event(key, n = 1) {
			return EVENT_KEYS.includes(key) ? add({ [key]: n }) : Promise.resolve();
		},
		/**
		 * 把 `state.distill` 的增量并入累计（见文件头「同步方式」）。
		 * ⚠ 增量**同步**算好并更新 `lastSeen`，再异步累加——否则两次紧挨着的调用会重复计同一段增量。
		 */
		syncDistill(distill) {
			const delta = deltaOf(distill, lastSeen);
			if (Object.keys(delta).length === 0) { return Promise.resolve(); }
			for (const key of Object.keys(delta)) { lastSeen[key] = nonNegInt(Number(distill?.[key])); }
			return add(delta);
		},
		/** 当前累计（读盘后的内存值）。 */
		async snapshot() {
			await ensureLoaded();
			return { since, totals: { ...totals } };
		},
		flushNow,
		file: () => file,
	};
}
