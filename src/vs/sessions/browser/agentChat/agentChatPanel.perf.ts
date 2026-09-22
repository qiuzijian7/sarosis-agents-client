/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天框**性能埋点**（2026-09-18）—— 统一口径，方便下次定位"哪个函数慢"。
 *
 * ── 为什么需要（本仓已多次吃过"没有耗时数据"的亏）────────────────────────
 * 排查「卡顿」时的顺序总是：看门狗（`[WsSwitchDiag]`）告诉我们**哪一段窗口**卡，
 * 但**段内**是哪个函数、哪条消息、哪张卡，日志里没有 ⇒ 只能靠改代码加临时日志再复现 ✗。
 * 本模块把"加临时日志"这一步**固定下来**，并且默认就开着（低噪音）：
 *
 *   · **默认档（无需任何开关）**：只报「单次 ≥ `CHAT_PERF_SLOW_MS`（50ms）」的调用，
 *     外加**每 30s 一行汇总**（仅汇总本周期内真的被调用过的标签 ⇒ 不会刷屏）。
 *   · **详细档**：控制台执行 `__SAROSIS_CHAT_PERF = true` ⇒ 每次调用都打一行（排查时用）。
 *   · **随时手动 dump**：控制台执行 `__SAROSIS_CHAT_PERF_DUMP()` ⇒ 把累计统计（次数/总时长/
 *     最慢一次及其上下文）全部打出来，**不需要重启**。
 *
 * ── 用法（约定，务必一致）──────────────────────────────────────────────
 * ```ts
 * // ① 表达式型（推荐）：包住一段可返回值的计算
 * const el = chatPerf.span('card.create.search', () => this._build(tc), `key=${key}`);
 *
 * // ② 语句型（不改缩进，进出两行）：
 * const t0 = chatPerf.start();
 * ... 原有代码 ...
 * chatPerf.end('render.appendMessageDom', t0, `msg=${msg.id}`);
 * ```
 *
 * ⚠ 约定要点：
 *   1. **标签用点分层**（`域.子域.动作`），保持可 grep、可排序；别写中文（便于与代码对应）。
 *   2. `detail` 里带上**可定位的 id**（`msg=` / `tool=` / `count=`）—— 只报耗时没有 id 等于白报。
 *   3. 早期 `return` 的分支要么在 return 前补 `end()`，要么改用 `span()` —— 否则该次调用不计入。
 *   4. 埋点自身开销：`performance.now()` 两次 + 一次 Map 累加（纳秒级）⇒ 可放在热路径上 ✓
 *      但**不要**在每次调用里构造长字符串（`detail` 建议传字符串或惰性函数，慢路径才会用到）。
 *
 * 与既有诊断的分工：`[WsSwitchDiag]`（主线程阻塞/排队）、`[StreamPerf]`（流式 delta 批次）、
 * `[FullRefresh]`（整卡/整消息重建计数）各自管一段；本模块管**"函数级耗时与最慢一次"**。
 */

import { registerRenderActivityFallbackSource } from '../../../base/common/renderActivityTrace.js';

/** 统一日志标签（grep 用）。 */
export const CHAT_PERF_TAG = '[ChatPerf]';

/** 单次调用超过它 ⇒ **立刻**打一行（默认档唯一的"单点"输出）。 */
export const CHAT_PERF_SLOW_MS = 50;

/** 近期 span 环容量（2026-09-22）：够覆盖一个长任务窗口内的 span 密度（流式爆发 ~百级/秒）。 */
const SPAN_RING_CAPACITY = 256;

/** 汇总行自动上报间隔（ms）。仅汇总本周期内被调用过的标签。 */
const SUMMARY_INTERVAL_MS = 30_000;

interface IPerfStat {
	/** 调用次数。 */
	count: number;
	/** 累计耗时（ms）。 */
	totalMs: number;
	/** 最慢一次（ms）与其 `detail`（便于定位是哪个 msg/tool）。 */
	maxMs: number;
	maxDetail: string;
	/** 上一个汇总周期内是否被调用过（决定是否进下一次汇总）。 */
	touched: boolean;
}

/**
 * 性能埋点器。
 *
 * ★ 设计成**模块级单例**（`chatPerf`）而不是每个面板一个实例：多聊天框 pane 的耗时应当
 * 汇到一处（标签里已带可区分的信息），且**接线的改动面最小**（不必动各面板构造函数）✓
 */
export class ChatPerf {

	private readonly _stats = new Map<string, IPerfStat>();
	private _lastSummaryAt = 0;
	private readonly _log: (msg: string) => void;

	constructor(log: (msg: string) => void) {
		this._log = log;
	}

	/** 详细档开关（控制台 `__SAROSIS_CHAT_PERF = true`）。 */
	private get _verbose(): boolean {
		try {
			return (globalThis as unknown as Record<string, unknown>)['__SAROSIS_CHAT_PERF'] === true;
		} catch {
			return false;
		}
	}

	/** 开始计时（配合 `end()`；适配"不改缩进"的场景）。 */
	start(): number {
		return performance.now();
	}

	/**
	 * 结束计时并记录。
	 * @param label 标签（点分层，如 `render.appendMessageDom`）
	 * @param t0    `start()` 的返回值
	 * @param detail 可定位的上下文（如 `msg=${msg.id}`）；建议传字符串，热路径别构造大字符串
	 */
	end(label: string, t0: number, detail?: string): void {
		this._record(label, performance.now() - t0, detail);
	}

	/**
	 * 包住一段**同步**计算并计时（适合单出口、可直接返回值的场景）。
	 * 异常路径也会记录（`finally`）—— 抛错也可能很慢 ✓
	 */
	span<T>(label: string, fn: () => T, detail?: string): T {
		const t0 = performance.now();
		try {
			return fn();
		} finally {
			this._record(label, performance.now() - t0, detail);
		}
	}

	/** `span` 的异步版。 */
	async spanAsync<T>(label: string, fn: () => Promise<T>, detail?: string): Promise<T> {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			this._record(label, performance.now() - t0, detail);
		}
	}

	/** 手动记录一次（用于已在别处计时、或不便包住的点）。 */
	record(label: string, ms: number, detail?: string): void {
		this._record(label, ms, detail);
	}

	/** 清空统计（A/B 复测前调用，避免历史累积污染）。 */
	reset(): void {
		this._stats.clear();
		this._lastSummaryAt = performance.now();
	}

	/**
	 * 把累计统计打出来（每标签一行：次数 / 总时长 / 最慢一次及其上下文）。
	 *
	 * 设计意图：**卡顿是复现后再来看的** —— 用户/开发者不必提前开详细档；平时积累，
	 * 出问题时 dump 一次就能看到"这段时间里最慢的是哪个函数、慢在哪个 msg/tool"✓
	 */
	dump(note?: string): void {
		if (this._stats.size === 0) {
			this._log(`${CHAT_PERF_TAG}（无采样数据）${note ? ` — ${note}` : ''}`);
			return;
		}
		const rows = Array.from(this._stats.entries())
			.map(([label, s]) => ({ label, ...s, avgMs: s.totalMs / Math.max(1, s.count) }))
			// 排序口径：**累计耗时**降序 —— 它才是"总卡顿预算"的真实消耗者
			//（一个 5ms 但被调 2000 次的函数，比一个 100ms 只调 1 次的函数更该被优化）
			.sort((a, b) => b.totalMs - a.totalMs);
		this._log(`${CHAT_PERF_TAG} ===== 汇总${note ? `（${note}）` : ''} =====`);
		for (const r of rows) {
			this._log(`${CHAT_PERF_TAG} ${r.label} ×${r.count} total=${Math.round(r.totalMs)}ms avg=${r.avgMs.toFixed(1)}ms max=${Math.round(r.maxMs)}ms${r.maxDetail ? ` (max@${r.maxDetail})` : ''}`);
		}
	}

	/**
	 * 窗口查询（给 RenderHeartbeat 的兜底归因，2026-09-22）。
	 *
	 * 返回形如 `perf=[card.create.tool×3/612ms, render.messages.total×1/89ms]` ——
	 * 与活动标记的 `tag×n` 形状对齐，但多了**累计耗时**（回答"谁是窗口内的主要占用者"，
	 * 单个 5ms×200 次的标签比 100ms×1 次更该背锅）。窗口内无 span 返回 `undefined`。
	 */
	formatWindow(startMs: number, endMs: number, maxItems = 5): string | undefined {
		try {
			const agg = new Map<string, { n: number; total: number }>();
			const n = Math.min(this._ringWritten, SPAN_RING_CAPACITY);
			for (let i = 0; i < n; i++) {
				const idx = this._ringWritten <= SPAN_RING_CAPACITY ? i : (this._ringCursor + i) % SPAN_RING_CAPACITY;
				const start = this._ringStart[idx]!;
				const end = this._ringEnd[idx]!;
				// 重叠判定：span 与窗口有交集即计入（span 可能跨窗口边界）
				if (end < startMs || start > endMs) { continue; }
				const label = this._ringLabel[idx]!;
				if (!label) { continue; }
				const a = agg.get(label) ?? { n: 0, total: 0 };
				a.n++;
				a.total += this._ringMs[idx]!;
				agg.set(label, a);
			}
			if (agg.size === 0) { return undefined; }
			const rows = [...agg.entries()].sort((a, b) => b[1].total - a[1].total);
			const head = rows.slice(0, maxItems)
				.map(([label, a]) => `${label}×${a.n}/${Math.round(a.total)}ms`)
				.join(', ');
			return `perf=[${head}${rows.length > maxItems ? `, …(共${rows.length}类)` : ''}]`;
		} catch { return undefined; }
	}

	// ─── 内部 ──────────────────────────────────────────────────────────────

	// 近期 span 环（平行数组 + 游标 ⇒ 记录零分配；容量够覆盖一个长任务窗口的密度）
	private readonly _ringLabel: string[] = new Array<string>(SPAN_RING_CAPACITY).fill('');
	private readonly _ringStart: number[] = new Array<number>(SPAN_RING_CAPACITY).fill(0);
	private readonly _ringEnd: number[] = new Array<number>(SPAN_RING_CAPACITY).fill(0);
	private readonly _ringMs: number[] = new Array<number>(SPAN_RING_CAPACITY).fill(0);
	private _ringCursor = 0;
	private _ringWritten = 0;

	private _record(label: string, ms: number, detail?: string): void {
		let s = this._stats.get(label);
		if (!s) {
			s = { count: 0, totalMs: 0, maxMs: 0, maxDetail: '', touched: false };
			this._stats.set(label, s);
		}
		s.count++;
		s.totalMs += ms;
		s.touched = true;
		if (ms > s.maxMs) { s.maxMs = ms; s.maxDetail = detail ?? ''; }

		// ★ 2026-09-22：写入近期 span 环（供 RenderHeartbeat「无标记」LONG_TASK 兜底归因）。
		// 与 renderActivityTrace 的标记环同构：平行数组 + 游标 ⇒ **零分配**（label 多为字面量，
		// 环只存引用；detail 不进环 —— 它才是分配大头）。
		const endWall = Date.now();
		this._ringLabel[this._ringCursor] = label;
		this._ringStart[this._ringCursor] = endWall - ms;   // 近似墙钟开始（ms 为 perf 时长）
		this._ringEnd[this._ringCursor] = endWall;
		this._ringMs[this._ringCursor] = ms;
		this._ringCursor = (this._ringCursor + 1) % SPAN_RING_CAPACITY;
		this._ringWritten++;

		if (ms >= CHAT_PERF_SLOW_MS || this._verbose) {
			this._log(`${CHAT_PERF_TAG} ${ms >= CHAT_PERF_SLOW_MS ? '⚠ SLOW ' : ''}${label}=${ms.toFixed(1)}ms${detail ? ` | ${detail}` : ''}`);
		}

		// 定期汇总：只汇总"本周期真的被调用过"的标签（否则空转刷屏 ✗）
		const now = performance.now();
		const hasTouched = Array.from(this._stats.values()).some(v => v.touched);
		if (hasTouched && now - this._lastSummaryAt >= SUMMARY_INTERVAL_MS) {
			this._lastSummaryAt = now;
			this.dump('周期自动汇总');
			for (const v of this._stats.values()) { v.touched = false; }
		}
	}
}

// ─── 单例 + 全局入口 ───────────────────────────────────────────────────────
//
// 日志出口：这里刻意用 `console.info` 而不是 ILogService —— 本模块被多处（含静态工具类）
// 复用，注入 logService 会把改动面放大。`console.info` 在本仓**会进 vscode-app 日志文件**
// （见 `agentChatPanel.searchCard.ts` 的历史注释：`console.info` 不进日志、`_logService` 才进
// —— 那条结论针对的是**扩展宿主**；renderer 侧 console 会进 renderer.log ✓ 而本模块只在 renderer 用）。
// ⚠ 若将来发现 dump 没进日志文件，把出口换成注入的 `_logService` 即可（接口已收成一个函数）。

export const chatPerf = new ChatPerf(msg => {
	try { console.info(msg); } catch { /* 诊断绝不影响主流程 */ }
});

/** 安装全局入口（幂等）：`__SAROSIS_CHAT_PERF`（详细档）与 `__SAROSIS_CHAT_PERF_DUMP()`（手动汇总）。 */
export function installChatPerfGlobals(): void {
	try {
		const g = globalThis as unknown as Record<string, unknown>;
		if (g['__SAROSIS_CHAT_PERF_DUMP_INSTALLED'] === true) { return; }
		g['__SAROSIS_CHAT_PERF_DUMP_INSTALLED'] = true;
		g['__SAROSIS_CHAT_PERF_DUMP'] = (note?: string) => { chatPerf.dump(note ?? '手动 dump'); };
	} catch { /* ignore */ }
}

// ★ 模块加载即安装（幂等）——刻意做成**模块副作用**：本模块被多处静态 import，
//   这样不必去改各面板的构造函数（接线面最小 ✓）。诊断模块的全局入口，物有所值。
installChatPerfGlobals();

// ★ 2026-09-22：注册为 RenderHeartbeat 的「无标记 LONG_TASK」兜底归因源 ——
//   长任务发生在没打活动标记的代码里时，`因=[(窗口内无标记…)]` 之后还能拼出
//   `perf=[card.create.tool×3/612ms]`（窗口内的 span 聚合），归因不再只能靠猜。
//   见 base/common/renderActivityTrace.ts 的兜底源约定（异常自吞、低频调用）。
registerRenderActivityFallbackSource((startMs, endMs) => chatPerf.formatWindow(startMs, endMs));
