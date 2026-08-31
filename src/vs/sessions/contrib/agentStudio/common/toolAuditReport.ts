/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具调用合理性审计（`[ToolAudit]`）—— 把「这轮工具用得合不合理」变成可读日志。
 *
 * ## 为什么需要
 * 改前判断工具调用是否合理，只能**手工 grep 逐条数**（分析 460 份日志统计
 * 「216 个 callId 真实重试、0 次成功」就是这么数出来的）。已有日志的问题不是
 * 缺数据，而是缺**聚合视图**：
 *   · `executeTool: "x" OK (123ms)` —— 逐条有，但 turn 结束无汇总；
 *   · 四道搜索熔断 —— **只在触发瞬间**打日志，「计数到 2 而阈值 3」= 差一点
 *     失控，完全不可见（这是调阈值的唯一依据，却看不到）；
 *   · 工具「成功」≠ 有用 —— 零命中的 search、重复读同一文件全记 OK。
 *
 * ## 四类可归因指标
 *   cost      —— 谁在烧时间/输出（回答「哪个工具占了 80% wall time」）
 *   efficacy  —— 成功但无用（空结果率、同参数重复）
 *   pattern   —— 形态异常（串行连击、后期仍在探索不收敛）
 *   guardrail —— 闸门**水位**（max/threshold），而非只报「是否触发」
 *
 * ## 设计纪律
 * 1. **只做聚合，不新增采集点**：数据全部来自已有的工具执行结果
 *    （`metadata.executionTimeMs` + content 长度），不引入第二套状态。
 * 2. **判据由调用方注入**（`isExplorationTool` / `isReadOnlyTool`）——
 *    复用 executor 已有的集合与 `isParallelSafeReadOnlyTool`，绝不在此另写一份
 *    工具分类表。本项目已多次因两份判据漂移踩坑。
 * 3. **只有真缺陷才 warn**（沿用 promptDiagnostics 的级别纪律）：形态异常 /
 *    高空结果率 / 重复读 → warn；纯成本分布 → info。否则 warn 被稀释成噪音。
 *
 * 纯函数、零依赖 → 可单测、可在 common 层安全使用。
 */

// ─── 输入 ───────────────────────────────────────────────────────────────

export interface IToolCallRecord {
	readonly name: string;
	/** 发生在第几个 iteration（用于「后期是否仍在探索」判定）。 */
	readonly iteration: number;
	readonly ok: boolean;
	/** 来自 `result.metadata.executionTimeMs`；缺失记 0。 */
	readonly ms: number;
	/** 结果文本字节数（近似 = 字符数）。 */
	readonly outputBytes: number;
	/** 成功但零结果（如 search 零命中、terminal 无输出）。 */
	readonly empty: boolean;
	/**
	 * 同参数重复判定键（调用方对入参取指纹）。
	 * 缺省则该记录不参与 dup 统计 —— 宁可漏报，不可误报。
	 */
	readonly argsKey?: string;
}

/**
 * 闸门水位。
 *
 * ★ `max` 是本 turn 达到过的**最高计数**，不是最终值 —— 计数器会被清零，
 * 只看最终值永远是 0，什么都发现不了。
 */
export interface IGuardrailWatermark {
	readonly name: string;
	readonly max: number;
	readonly threshold: number;
	/** 本 turn 实际触发（注入 reminder / 熔断）次数。 */
	readonly fired: number;
	/** 贡献最多的工具名（可选，便于直接定位）。 */
	readonly hot?: string;
}

export interface IToolAuditInput {
	readonly records: ReadonlyArray<IToolCallRecord>;
	readonly iterations: number;
	readonly wallMs: number;
	readonly guardrails?: ReadonlyArray<IGuardrailWatermark>;
	/** 单工具串行连击的最高值与阈值（executor 的 `_singleToolStreak`）。 */
	readonly maxSingleToolStreak?: number;
	readonly singleToolStreakThreshold?: number;
	/** 连击期间本可并行的工具名（由 executor 用 isParallelSafeReadOnlyTool 判定）。 */
	readonly parallelizableInStreak?: ReadonlyArray<string>;
	/**
	 * 探索类工具判据 —— **只应含语义纯粹的「搜索」工具**（searchToolGroups 的
	 * TEXT/STRUCTURAL 集合）。
	 *
	 * ⚠ 不得把 `file_read` / `execute_code` / `terminal` 算进来：它们有双重语义
	 * （探索 vs 验证），「改完读文件确认」与「npx tsc / git diff 验证」是收敛的
	 * **表现**而非「探索不收敛」。按工具名无法区分二者，硬算必误伤
	 * （2026-08-22 日志 1787381220642 实测 `late-phase-exploration: 74%` 误报）。
	 */
	readonly isExplorationTool?: (name: string) => boolean;
	/** 只读工具判据 —— 复用 `isParallelSafeReadOnlyTool`。仅只读工具算 dup。 */
	readonly isReadOnlyTool?: (name: string) => boolean;
	readonly turnId?: string;
}

// ─── 阈值（集中在此，便于据日志水位调参）──────────────────────────────────

/** 空结果率告警门槛（且调用数须达 MIN_CALLS_FOR_RATE，避免小样本误报）。 */
export const EMPTY_RATE_WARN = 0.5;
export const MIN_CALLS_FOR_RATE = 3;
/** 同参数重复调用告警门槛（同 name+argsKey 出现次数）。 */
export const DUP_CALLS_WARN = 2;
/** 后期探索占比告警门槛。 */
export const LATE_EXPLORE_RATE_WARN = 0.6;
/** 「后期」定义：iteration 超过总轮数的这个比例之后。 */
export const LATE_PHASE_FROM = 0.5;
/** 闸门水位距阈值 ≤ 此值时标注「near-miss」（差一点失控）。 */
export const GUARDRAIL_NEAR_MISS_GAP = 1;

// ─── 输出 ───────────────────────────────────────────────────────────────

export interface IToolCostLine {
	readonly name: string;
	readonly calls: number;
	readonly ms: number;
	readonly bytes: number;
	readonly msPct: number;
	readonly bytesPct: number;
}

export interface IToolEfficacyLine {
	readonly name: string;
	readonly calls: number;
	readonly empty: number;
	readonly emptyRate: number;
	/** 同参数重复次数（超出首次的部分）。 */
	readonly dup: number;
	/** 该行是否达告警门槛。 */
	readonly warn: boolean;
}

export interface IToolAuditReport {
	readonly turnId?: string;
	readonly iterations: number;
	readonly calls: number;
	readonly ok: number;
	readonly failed: number;
	readonly wallMs: number;
	readonly toolMs: number;
	readonly cost: ReadonlyArray<IToolCostLine>;
	/** 仅含达到告警门槛的行（正常 turn 应为空 —— 有专门控制组测试）。 */
	readonly efficacy: ReadonlyArray<IToolEfficacyLine>;
	readonly patterns: ReadonlyArray<string>;
	readonly guardrails: ReadonlyArray<IGuardrailWatermark>;
	/** 是否存在任一告警（决定日志级别）。 */
	readonly hasWarning: boolean;
}

// ─── 构建 ───────────────────────────────────────────────────────────────

function pct(part: number, total: number): number {
	return total > 0 ? (part / total) * 100 : 0;
}

export function buildToolAuditReport(input: IToolAuditInput): IToolAuditReport {
	const records = input.records ?? [];

	// ── cost ──
	const agg = new Map<string, { calls: number; ms: number; bytes: number; empty: number }>();
	let ok = 0;
	let toolMs = 0;
	let totalBytes = 0;
	for (const r of records) {
		if (r.ok) { ok++; }
		toolMs += r.ms;
		totalBytes += r.outputBytes;
		const a = agg.get(r.name) ?? { calls: 0, ms: 0, bytes: 0, empty: 0 };
		a.calls++;
		a.ms += r.ms;
		a.bytes += r.outputBytes;
		if (r.ok && r.empty) { a.empty++; }
		agg.set(r.name, a);
	}
	const cost: IToolCostLine[] = [...agg]
		.map(([name, a]) => ({
			name,
			calls: a.calls,
			ms: a.ms,
			bytes: a.bytes,
			msPct: pct(a.ms, toolMs),
			bytesPct: pct(a.bytes, totalBytes),
		}))
		.sort((x, y) => y.ms - x.ms || y.calls - x.calls || x.name.localeCompare(y.name));

	// ── efficacy：同参数重复只统计只读工具 ──
	// 写类工具重复写同一路径是合法的迭代修改（patch 反复改一个文件很正常），
	// 计入 dup 会产生大量误报。判据由调用方注入，此处不自建工具分类表。
	const dupCount = new Map<string, number>();
	if (input.isReadOnlyTool) {
		const seen = new Map<string, number>();
		for (const r of records) {
			if (!r.argsKey || !input.isReadOnlyTool(r.name)) { continue; }
			const key = `${r.name}\u0000${r.argsKey}`;
			const n = (seen.get(key) ?? 0) + 1;
			seen.set(key, n);
			if (n > 1) { dupCount.set(r.name, (dupCount.get(r.name) ?? 0) + 1); }
		}
	}
	const efficacy: IToolEfficacyLine[] = [];
	for (const [name, a] of agg) {
		const dup = dupCount.get(name) ?? 0;
		const emptyRate = pct(a.empty, a.calls) / 100;
		const warn =
			(a.calls >= MIN_CALLS_FOR_RATE && emptyRate >= EMPTY_RATE_WARN) ||
			dup >= DUP_CALLS_WARN;
		if (warn) {
			efficacy.push({ name, calls: a.calls, empty: a.empty, emptyRate, dup, warn });
		}
	}
	efficacy.sort((x, y) => (y.empty + y.dup) - (x.empty + x.dup) || x.name.localeCompare(y.name));

	// ── pattern ──
	const patterns: string[] = [];
	const streak = input.maxSingleToolStreak ?? 0;
	const streakThreshold = input.singleToolStreakThreshold ?? 0;
	if (streakThreshold > 0 && streak >= streakThreshold) {
		const par = input.parallelizableInStreak ?? [];
		patterns.push(
			`serial-single-tool: ${streak} consecutive single-tool iterations (threshold=${streakThreshold})` +
			(par.length > 0 ? ` — parallelizable: ${[...par].sort().join(', ')}` : '')
		);
	}
	// 后期仍高比例探索 = 迟迟不收敛。只在轮数够多时判定（短 turn 全是探索属正常）。
	if (input.isExplorationTool && input.iterations >= 6) {
		const fromIter = Math.ceil(input.iterations * LATE_PHASE_FROM);
		const late = records.filter((r) => r.iteration >= fromIter);
		if (late.length >= MIN_CALLS_FOR_RATE) {
			const explore = late.filter((r) => input.isExplorationTool!(r.name)).length;
			const rate = explore / late.length;
			if (rate >= LATE_EXPLORE_RATE_WARN) {
				patterns.push(
					`late-phase-exploration: ${(rate * 100).toFixed(0)}% of calls after iteration ${fromIter} ` +
					`are search (${explore}/${late.length}) — exploration not converging`
				);
			}
		}
	}

	const guardrails = [...(input.guardrails ?? [])].sort(
		(a, b) => (b.max - b.threshold) - (a.max - a.threshold) || b.max - a.max || a.name.localeCompare(b.name)
	);

	const hasWarning = efficacy.length > 0 || patterns.length > 0;

	return {
		turnId: input.turnId,
		iterations: input.iterations,
		calls: records.length,
		ok,
		failed: records.length - ok,
		wallMs: input.wallMs,
		toolMs,
		cost,
		efficacy,
		patterns,
		guardrails,
		hasWarning,
	};
}

// ─── 格式化 ─────────────────────────────────────────────────────────────

/** cost 段最多列几行（其余合并）。 */
const MAX_COST_LINES = 8;

function fmtSec(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(n: number): string {
	if (n >= 1024 * 1024) { return `${(n / 1024 / 1024).toFixed(1)}MB`; }
	if (n >= 1024) { return `${Math.round(n / 1024)}KB`; }
	return `${n}B`;
}

/**
 * 渲染审计日志。
 *
 * ⚠ 格式是**对外契约**（会被 grep 统计）：首行以 `[ToolAudit] SUMMARY` 开头，
 * 段标题以 `  ── ` 开头，明细行以 4 空格缩进。改动前先看单测。
 */
export function formatToolAuditLog(report: IToolAuditReport): { readonly text: string; readonly level: 'info' | 'warn' } {
	const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
	const head =
		`[ToolAudit] SUMMARY` +
		(report.turnId ? ` turn=${report.turnId}` : '') +
		` iters=${report.iterations} calls=${report.calls} (ok=${report.ok} failed=${report.failed})` +
		` wall=${fmtSec(report.wallMs)} toolTime=${fmtSec(report.toolMs)}`;

	const lines: string[] = [head];

	if (report.cost.length > 0) {
		lines.push('  ── cost ──');
		const shown = report.cost.slice(0, MAX_COST_LINES);
		for (const c of shown) {
			lines.push(
				`    ${pad(c.name, 22)}×${String(c.calls).padStart(3)}  ${pad(fmtSec(c.ms), 8)}` +
				`${pad(fmtBytes(c.bytes), 8)}  time=${c.msPct.toFixed(0)}% out=${c.bytesPct.toFixed(0)}%`
			);
		}
		const rest = report.cost.slice(MAX_COST_LINES);
		if (rest.length > 0) {
			const rc = rest.reduce((n, c) => n + c.calls, 0);
			const rm = rest.reduce((n, c) => n + c.ms, 0);
			lines.push(`    ${pad(`(others ×${rest.length} tools)`, 22)}×${String(rc).padStart(3)}  ${fmtSec(rm)}`);
		}
	}

	if (report.efficacy.length > 0) {
		lines.push('  ── efficacy (succeeded but possibly useless) ──');
		for (const e of report.efficacy) {
			const bits: string[] = [];
			if (e.empty > 0) { bits.push(`empty=${e.empty}/${e.calls} (${(e.emptyRate * 100).toFixed(0)}%)`); }
			if (e.dup > 0) { bits.push(`dup=${e.dup} (same args)`); }
			lines.push(`    ⚠ ${pad(e.name, 22)}×${String(e.calls).padStart(3)}  ${bits.join('  ')}`);
		}
	}

	if (report.patterns.length > 0) {
		lines.push('  ── pattern ──');
		for (const p of report.patterns) { lines.push(`    ⚠ ${p}`); }
	}

	if (report.guardrails.length > 0) {
		lines.push('  ── guardrails (watermark: max reached / threshold) ──');
		for (const g of report.guardrails) {
			// 2026-08-30（日志 20260829T232635）：原判据允许负 gap —— threshold=0
			// 的「只记录不触发」闸门会算出 `-5 away from firing` 这种无意义标注
			// （实测 antiGuidanceCall max=5/0 → "near-miss (-5 away from firing)"）。
			// near-miss 的语义是「还差一点就触发」，故 gap 必须 >= 0：
			//   gap < 0 → 水位已越过阈值，不是临界，而是已超（或被刻意设为不触发）。
			const gap = g.threshold - g.max;
			const nearMiss = g.fired === 0 && g.max > 0 && gap >= 0 && gap <= GUARDRAIL_NEAR_MISS_GAP;
			lines.push(
				`    ${pad(g.name, 22)}max=${g.max}/${g.threshold}  fired=${g.fired}` +
				(g.hot ? `  hot=${g.hot}` : '') +
				(nearMiss ? `  ← near-miss (${gap} away from firing)` : '')
			);
		}
	}

	return { text: lines.join('\n'), level: report.hasWarning ? 'warn' : 'info' };
}

/**
 * 即时告警：闸门在本轮**新触发**时打一行（不等 turn 结束）。
 *
 * 与 SUMMARY 的分工：SUMMARY 是复盘用的全量视图，这条是「正在失控」的实时信号。
 */
export function formatGuardrailFiredLog(name: string, count: number, threshold: number, detail?: string): string {
	return `[ToolAudit] guardrail FIRED: ${name} count=${count}/${threshold}${detail ? ` — ${detail}` : ''}`;
}
