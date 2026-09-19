/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **焦点轨迹**埋点（2026-09-18）—— 定位「多窗口时，切换焦点（点另一个窗口的输入框）卡顿」。
 *
 * ── 为什么需要专门的埋点（既有工具为什么不够）────────────────────────────
 * · `[WsSwitchDiag]` 看门狗报的是「**本窗口**主线程被阻塞 N ms + 当时阶段名」✓
 *   —— 它能告诉你"卡了"，但**多窗口场景的元凶常常在*另一个*窗口** ✗：
 *   VS Code 的辅助窗口（多开聊天框 / popout）**共享同一个 renderer 主线程** ✓
 *   ⇒ 另一个窗口在跑重活（大图渲染、流式重建、会话锁 IO…）会**冻住所有窗口** ✗✗，
 *     而看门狗只会在**它自己**窗口的记录里报一个"来源不明"的阻塞 ✗。
 * · `chatPerf` 报的是**函数级**耗时 ✓，但它不知道"用户此刻正在切窗口"✗
 *   ⇒ 需要一条能把「**焦点事件 → 可交互**」串起来的时间轴 ✓。
 *
 * ── 核心指标（一条日志就能判定）──────────────────────────────────────────
 * `queueDelay` = **窗口获得焦点的时刻 → 本窗口第一次 rAF 回调**的间隔。
 *   它同时代表两件事：
 *     ① 主线程在焦点切换那一刻**被占用多久**（浏览器要等它空出来才能绘制 ✓）；
 *     ② 用户"点了输入框却没反应"的**感知延迟** ✓✓
 *   ⇒ 这个数 ≫ 16ms 就说明**那次切换确实卡**，而同期 `longTasks` 会指出是谁占的 ✓
 *
 * ── 日志形态（按 `[FocusTrace]` grep）──────────────────────────────────
 * ```
 * [FocusTrace] window 获得焦点 → 首次可绘制 +482ms ⚠（阈值 50ms）
 * [FocusTrace]   +3ms   pane.activateTab pane=#2
 * [FocusTrace]   +6ms   input.focusin pane=#2
 * [FocusTrace]   +12ms  pane.catchUpFlush 340ms
 * [FocusTrace]   +360ms pane.sessionLock 121ms（file IO，session=sess_xxx）
 * [FocusTrace]   longTask 312ms（self）／longTask 88ms（self）
 * ```
 * 读法：`queueDelay` 大 ⇒ 再往下看**哪一段吃掉了它** ✓；
 * 若所有 mark 加起来远小于 `queueDelay` ⇒ **占用线程的不是本窗口的代码** ✗
 * ⇒ 那就是**另一个窗口**在跑重活（此时去另一个窗口的日志里找同步时间点的阻塞 ✓）。
 *
 * ── 开关与噪音控制 ──────────────────────────────────────────────────────
 * · 默认档：焦点后**2s 内**的 mark 全部**只留在内存**，最后在该窗口第一次 rAF 时
 *   **汇总成一段日志**（1 次焦点 = 1~7 行）✓ ⇒ 不刷屏，但足够定位 ✓
 * · 仅当 `queueDelay ≥ 50ms` 或 `__SAROSIS_FOCUS_TRACE = true` 时打印明细段 ✓
 * · `__SAROSIS_FOCUS_TRACE_DUMP()` 打印最近 N 次焦点的统计（含最慢一次的时间轴）✓
 */

/** 日志标签（grep 用）。 */
export const FOCUS_TRACE_TAG = '[FocusTrace]';

/** `queueDelay` 超过它就判定"这次切换有可感知卡顿"，并打印全部明细。 */
export const FOCUS_TRACE_SLOW_MS = 50;

/** 焦点事件后多久内继续收集 mark（防长时间运行下数组无界）。 */
const TRACE_WINDOW_MS = 2000;

/** 最近多少次焦点记录保留在内存（供 dump）。 */
const MAX_RECORDS = 20;

interface IFocusMark {
	/** 相对本次焦点事件的时间（ms）。 */
	rel: number;
	label: string;
	/** 该 mark 自身耗时（span 类才有）。 */
	durMs?: number;
	detail?: string;
}

interface IFocusRecord {
	at: number;
	queueDelay: number;
	/** 自带探针实测的「本窗口主线程最长一次占用」（ms）—— 判定是否 JS 阻塞的核心数 ✓。 */
	maxBlockMs: number;
	marks: IFocusMark[];
	longTasks: string[];
}

class FocusTrace {

	private _focusAt = 0;
	/** 焦点瞬间的阶段名（见 `registerFocusStageProvider` 的注释 ✓）。 */
	private _stageAtFocus = '';

	/** 自带阻塞探针的间隔（ms）：25ms 足够密（40 次/s 开销可忽略），又能测出几十 ms 级的占用 ✓。 */
	private static readonly BLOCK_PROBE_MS = 25;
	private _probeTimer: ReturnType<typeof setTimeout> | undefined;
	private _probeAt = 0;
	private _probeStartAt = 0;
	/** 「焦点代」：每次焦点 +1，用于丢弃上一次焦点遗留的 rAF/timeout/定时器回调 ✓。 */
	private _focusGen = 0;
	/** 本窗口在本次焦点窗口内**最长一次主线程占用**（ms）—— 判定"到底是不是本窗口卡"的核心数 ✓。 */
	private _maxBlockInTrace = 0;
	private _probeTicks = 0;
	/** 因窗口不可见被**节流**而无效的探针次数（避免把节流误读成阻塞 ✗）。 */
	private _probeThrottled = 0;
	/** rAF 帧表：帧数 + 最大帧间隔 —— 与探针的"定时器是否被饿死"互相印证 ✓。 */
	private _rafTicks = 0;
	private _lastRafAt = 0;
	private _maxRafGap = 0;
	private _marks: IFocusMark[] = [];
	private _longTasks: string[] = [];
	private _records: IFocusRecord[] = [];
	private _observer: PerformanceObserver | undefined;
	private _installed = false;
	/** 最近一次焦点是否已经打印过（避免 rAF 抖动时重复打印）。 */
	private _flushed = false;
	private readonly _log: (msg: string) => void = msg => {
		try { console.info(msg); } catch { /* 诊断绝不影响主流程 */ }
	};

	/** 详细档：每次 mark 立即打印（排查时开）。 */
	private get _verbose(): boolean {
		try { return (globalThis as unknown as Record<string, unknown>)['__SAROSIS_FOCUS_TRACE'] === true; } catch { return false; }
	}

	/** 安装监听（幂等）。模块加载时自动调用 ✓（各窗口各自一份 module 实例 ⇒ 各自安装 ✓）。 */
	install(): void {
		if (this._installed) { return; }
		this._installed = true;
		try {
			window.addEventListener('focus', () => this._onWindowFocus(), true);
			window.addEventListener('blur', () => this._onWindowBlur(), true);
			document.addEventListener('visibilitychange', () => {
				// 窗口被隐藏/恢复同样会改变"能否绘制" ⇒ 与焦点合并观察 ✓
				if (!document.hidden) { this.mark('window.visibleAgain'); }
			});
			this._startLongTaskObserver();
		} catch { /* 非浏览器环境（单测）静默跳过 */ }
	}

	/** 相对最近一次焦点事件（没焦点基线时返回 -1）。 */
	private _rel(at: number): number {
		return this._focusAt > 0 ? Math.round(at - this._focusAt) : -1;
	}

	/** 记录一个时间点（默认档只留在内存，随汇总一起打印 ✓）。 */
	mark(label: string, detail?: string): void {
		if (this._focusAt <= 0) { return; }
		const now = performance.now();
		if (now - this._focusAt > TRACE_WINDOW_MS) { return; }
		this._marks.push({ rel: this._rel(now), label, detail });
		if (this._verbose) { this._log(`${FOCUS_TRACE_TAG}   +${this._rel(now)}ms ${label}${detail ? ` ${detail}` : ''}`); }
	}

	/** 包住一段**同步**工作并计时（≥1ms 才记，避免噪音 ✓）。 */
	span<T>(label: string, fn: () => T, detail?: string): T {
		const t0 = performance.now();
		try {
			return fn();
		} finally {
			this._record(label, t0, detail);
		}
	}

	/** 包住一段**异步**工作（会话锁是文件 IO ⇒ 必须用它 ✓）。 */
	async spanAsync<T>(label: string, fn: () => Promise<T>, detail?: string): Promise<T> {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			this._record(label, t0, detail);
		}
	}

	private _record(label: string, t0: number, detail?: string): void {
		if (this._focusAt <= 0) { return; }
		const now = performance.now();
		if (now - this._focusAt > TRACE_WINDOW_MS) { return; }
		const dur = Math.round(now - t0);
		if (dur < 1 && !this._verbose) { return; }
		this._marks.push({ rel: this._rel(t0), label, durMs: dur, detail });
		if (this._verbose) { this._log(`${FOCUS_TRACE_TAG}   +${this._rel(t0)}ms ${label} ${dur}ms${detail ? ` ${detail}` : ''}`); }
	}

	/** dump 最近若干次焦点的统计（控制台入口）。 */
	dump(note?: string): void {
		if (this._records.length === 0) { this._log(`${FOCUS_TRACE_TAG}（无采样）${note ? ` — ${note}` : ''}`); return; }
		this._log(`${FOCUS_TRACE_TAG} ===== 汇总${note ? `（${note}）` : ''} =====`);
		for (const r of this._records) {
			this._log(`${FOCUS_TRACE_TAG} queueDelay=${Math.round(r.queueDelay)}ms maxBlock=${r.maxBlockMs}ms marks=${r.marks.length} longTasks=${r.longTasks.length} marks_detail=${r.marks.map(m => `${m.label}${m.durMs ? `:${m.durMs}ms` : ''}`).join(' → ') || '-'}`);
		}
	}

	// ─── 内部 ──────────────────────────────────────────────────────────────

	private _onWindowFocus(): void {
		this._focusAt = performance.now();
		this._marks = [];
		this._longTasks = [];
		this._flushed = false;
		// ★ 每一次焦点一个「代」（generation）：用于**丢弃上一次焦点遗留的 rAF/timeout 回调** ✗。
		// 真机踩过：连续快速切换时（+7ms / +654ms / +8ms 连发 ✓），上一次未决的 rAF 会在**新窗口**
		// 里触发 `_flush`，把新窗口的计数（探针 0 次等）当结果打出来 ⇒ 结论完全失真 ✗✗。
		const gen = ++this._focusGen;
		// ★ 记下**焦点瞬间**的阶段名：浏览器无法绘制的那段时间，主线程上跑的多半就是它 ✓
		this._stageAtFocus = _currentStage();
		this._startLongTaskObserver();
		this._startBlockProbe(gen);
		this._startRafMeter(gen);
		// ★ 核心指标：等到本窗口"能画第一帧"为止 —— 这中间的等待就是用户感知的卡顿 ✓
		// 用 rAF + 超时兜底（rAF 在窗口不可见时不触发 ✗，本仓踩过 ✓）
		void Promise.race([
			new Promise<void>(resolve => requestAnimationFrame(() => resolve())),
			new Promise<void>(resolve => setTimeout(resolve, 3000)),
		]).then(() => {
			if (this._flushed || gen !== this._focusGen) { return; }
			this._flushed = true;
			this._flush(performance.now() - this._focusAt);
		});
	}

	private _onWindowBlur(): void {
		// 失焦时把已收集的轨迹留证（多窗口切换 ⇒ 下一个窗口的日志才是重点，但本窗口
		// 的"失焦前在忙什么"能解释对方为什么会卡 ✓）
		if (this._focusAt > 0 && this._marks.length > 0 && this._verbose) {
			this._log(`${FOCUS_TRACE_TAG} window 失焦（此前收集 ${this._marks.length} 个 mark）`);
		}
	}

	private _flush(queueDelay: number): void {
		this._stopBlockProbe();
		const rec: IFocusRecord = {
			at: Date.now(),
			queueDelay,
			maxBlockMs: Math.round(this._maxBlockInTrace),
			marks: this._marks.slice(),
			longTasks: this._longTasks.slice(),
		};
		this._records.push(rec);
		while (this._records.length > MAX_RECORDS) { this._records.shift(); }

		const slow = queueDelay >= FOCUS_TRACE_SLOW_MS;
		if (!slow && !this._verbose) {
			// 不慢 ⇒ 一行简报即可（低频事件，仍然保留可见性 ✓）
			this._log(`${FOCUS_TRACE_TAG} window 获得焦点 → 首次可绘制 +${Math.round(queueDelay)}ms（正常）`);
			return;
		}
		this._log(`${FOCUS_TRACE_TAG} window 获得焦点 → 首次可绘制 +${Math.round(queueDelay)}ms${slow ? ` ⚠（阈值 ${FOCUS_TRACE_SLOW_MS}ms）` : ''}`);
		// ★ 阶段对比：焦点瞬间 → 汇总瞬间（后者通常已是 idle）。字面量里带上具体阶段名，
		//   才能直接回答"这 387ms 里主线程在跑什么"✓
		this._log(`${FOCUS_TRACE_TAG}   阶段：焦点时「${this._stageAtFocus}」→ 现在「${_currentStage()}」`);
		// ★★ 最关键的一行：**本窗口主线程到底有没有被占住**（自带探针实测，不依赖任何阶段标记 ✗✓）
		// 同时给出 rAF 帧数 ⇒ 「探针 0 次」时才能分清"真阻塞"与"被节流"✗✓（见 _startRafMeter 注释）
		this._log(`${FOCUS_TRACE_TAG}   本窗口主线程最长占用 ${Math.round(this._maxBlockInTrace)}ms（探针 ${this._probeTicks} 次${this._probeStartAt > 0 ? `，启动于 +${Math.round(this._probeStartAt - this._focusAt)}ms` : '，**探针未启动**（代码未生效？）'} / rAF ${this._rafTicks} 帧、最大帧间 ${Math.round(this._maxRafGap)}ms${this._probeThrottled > 0 ? `，其中 ${this._probeThrottled} 次探针因窗口不可见被节流已排除` : ''}；可见性=${typeof document !== 'undefined' ? document.visibilityState : 'n/a'}）`);
		for (const m of this._marks) {
			this._log(`${FOCUS_TRACE_TAG}   +${m.rel}ms ${m.label}${m.durMs !== undefined ? ` ${m.durMs}ms` : ''}${m.detail ? `（${m.detail}）` : ''}`);
		}
		for (const lt of this._longTasks) {
			this._log(`${FOCUS_TRACE_TAG}   ${lt}`);
		}
			// ★ 结论式提示（★ 2026-09-18 修正措辞）：原先写"占用主线程的很可能是**另一个窗口**" ✗ ——
		// 这条结论**被真机证伪**：那次慢的其实是**本窗口的图增量索引**（同一份日志里紧跟
		// `[CodebaseGraph] 增量索引…合计=1732ms` ✓），只是它当时没打阶段名 ⇒ 本模块的 mark
		// 覆盖不到它 ✗。故措辞改为「未被本模块的 mark 覆盖」，并给出**下一步该看什么** ✓
		const markSum = this._marks.reduce((a, m) => a + (m.durMs ?? 0), 0);
		if (slow && markSum < queueDelay * 0.5) {
			this._log(`${FOCUS_TRACE_TAG}   ⇒ 本模块自证开销仅 ${markSum}ms（远小于 ${Math.round(queueDelay)}ms）⇒ 阻塞**不在**聊天面板的焦点链上；嫌疑在：① 另一个窗口（多窗口共享同一 renderer 主线程）② **本窗口的其它子系统**（图索引 / GC / 布局 / 磁盘）—— 用上面「阶段：」那行 + 同时间点的 \`[WsSwitchDiag]\`/\`[CodebaseGraph]\` 日志判定 ✓（注：mark 覆盖不到 ≠ 不是本窗口 ✗）`);
		}
		// ★★ 用自带探针把"不是本模块"进一步二分（这是前两轮日志都答不出来的那一步 ✗✓）：
		//   · 占用大 ⇒ **本窗口主线程真被占住**了 ⇒ 看上面的 LoAF 行（`脚本≈… / 样式布局绘制≈…`）+
		//     `scripts[]` 里的 invoker/文件名，直接指名道姓 ✓；若 `阶段：` 是 idle ⇒ 说明那段活
		//     **没打阶段名**（该补 `wsStage()`，而不是继续怀疑别的窗口 ✗）；
		//   · 占用小 ⇒ 本窗口 JS 全程是空闲的 ⇒ 延迟来自**非 JS 路径**（样式/布局/绘制/合成器，
		//     或另一个进程）⇒ 此时该查 DOM 体量与重绘，而不是查 JS 调用栈 ✓。
		if (slow) {
			const block = Math.round(this._maxBlockInTrace);
			const ticks = this._probeTicks;
			if (ticks < 2) {
				// ★★ 关键修正（2026-09-18 真机踩坑，我上一版把这里读反了 ✗✗）：
				// 「探针 0 次」**不是**"主线程空闲" ✗，而恰恰是**探针被饿死**：
				// 等待了 `queueDelay`(≥50ms，实测 654ms) 却连一个 25ms 的定时器都没跑成 ⇒
				// 说明这段时间主线程被**连续占住**（定时器任务排不进去）✓。
				// 与 rAF 帧数交叉验证 ✓：
				//   · rAF 帧数 = 0 ⇒ 窗口不可见/没在画 ⇒ **数据不可信**，不能下结论 ✗；
				//   · rAF 帧数 > 0（说明窗口可见且在画 ⇒ rAF 能跑而定时器不能 ⇒ 只可能是被 JS 占住 ✓）
				//     ⇒ **就是本窗口的 JS 阻塞** ✓✓。
				const raf = this._rafTicks;
				const gap = Math.round(this._maxRafGap);
				if (raf === 0) {
					this._log(`${FOCUS_TRACE_TAG}   ⇒ 探针与 rAF **都没跑**（探针 ${ticks} 次 / rAF ${raf} 帧）⇒ 窗口当时很可能不可见/被节流 ⇒ **本次数据不可信**，不能据此判断阻塞 ✗（请以「阶段：」行 + [WsSwitchDiag] 为准）`);
				} else if (gap >= 50) {
					this._log(`${FOCUS_TRACE_TAG}   ⇒★ 探针**被饿死**（${ticks} 次，间隔仅 25ms；rAF ${raf} 帧但**最大帧间 ${gap}ms** ⇒ 浏览器自己也在等）⇒ 等待的 ${Math.round(queueDelay)}ms 里**主线程被连续占住** ✓✓ ⇒ **就是本窗口的 JS 阻塞**（不是"没阻塞"✗）⇒ 按 LoAF 的「脚本≈」/阶段行定位；若「阶段：」为 idle ⇒ 那段活**没打阶段名**（补 wsStage() ✓）`);
				} else if (raf >= 3) {
					// rAF 帧间隔小 ⇒ 画面其实在流畅地画 ✗ ⇒ 探针没跑 ≠ 主线程被占（可能只是定时器被降优先级/节流）
					this._log(`${FOCUS_TRACE_TAG}   ⇒ 探针未跑（${ticks} 次）但 **rAF 很流畅**（${raf} 帧、最大帧间仅 ${gap}ms）⇒ 说明**不是主线程被占住**，而是本环境对定时器降优先级/节流 ⇒ 本次探针数字**不可信** ✗ ⇒ 请以「阶段：」行 + [WsSwitchDiag] 交互延迟为判据 ✓`);
				} else {
					// ★ 2026-09-19 修正：`raf === 1`（只有触发 flush 的那一帧）**不代表"流畅"** ✗ ——
					// 帧数 <3 时根本量不出帧间隔（`gap` 恒为 0 ✗），只能说明"这段时间没画第 2 帧"。
					// 此时最可能的原因是**单个长任务**占住主线程（定时器与下一帧都排不进去 ✓），
					// 但**不能仅凭本行断言** ⇒ 明写"无法判断"，并指向看门狗的「交互延迟 + 阶段名」✓
					this._log(`${FOCUS_TRACE_TAG}   ⇒ 探针启动后 0 次、rAF 仅 ${raf} 帧（量不出帧间隔）⇒ **本行无法判断** ✗ —— 但注意：等待 ${Math.round(queueDelay)}ms 却连一个 25ms 定时器都没跑成，最常见是**单个长任务**占住主线程 ✓ ⇒ 请核对同一时刻的 \`[WsSwitchDiag]\` 交互延迟（它会给出**耗时 + 阶段名**，例：\`≈2039ms（阶段=graph: 写入内存 store）\` ✓）`);
				}
			} else if (block >= 50) {
				this._log(`${FOCUS_TRACE_TAG}   ⇒ 探针实测本窗口主线程最长被占 ${block}ms（≈ 用户等待的 ${Math.round(queueDelay)}ms）⇒ **就是本窗口在忙** ✓ ⇒ 按上面的 LoAF/阶段行定位；若「阶段：」为 idle ⇒ 是**未打阶段名**的那段活在跑（补 wsStage() 即可）✓`);
			} else {
				this._log(`${FOCUS_TRACE_TAG}   ⇒ 探针实测本窗口主线程**基本未被占住**（${ticks} 次探针，最长仅 ${block}ms）⇒ 这 ${Math.round(queueDelay)}ms **不是 JS 阻塞**：要么是样式/布局/绘制（DOM 体量大 ⇒ 看 LoAF 的「样式布局绘制≈」），要么是另一个进程/窗口 ✓ ⇒ 别再按"JS 卡"的方向优化 ✗`);
			}
		}
		// ★ 无 longtask/LoAF 记录也要说出来：否则读者会误以为"没有长任务" ✗
		if (slow && this._longTasks.length === 0) {
			this._log(`${FOCUS_TRACE_TAG}   （本次未采集到 longtask/LoAF 条目 —— 本环境可能未支持该 entryType ⇒ 请以上面「主线程最长占用」与「阶段：」两行为判据 ✓）`);
		}
	}

	/** longtask / LoAF 观察器（Chromium 支持 ✓；不支持则静默跳过 ✓）。 */
	private _startLongTaskObserver(): void {
		if (this._observer || typeof PerformanceObserver === 'undefined') { return; }
		// ★ 2026-09-18（第二次真机反馈后改）：**优先 LoAF**（`long-animation-frame`，Chrome 123+ ✓）。
		// 原因：真机日志里 longtask **一条都没采到** ✗（本环境未产出该 entryType），
		// 而"阶段=idle 却慢 370ms"必须区分「**脚本阻塞**」与「**样式/布局/绘制**」——这只有 LoAF 能答：
		// LoAF 条目给出 `renderStart` / `styleAndLayoutStart` / `blockingDuration` 与 `scripts[]`
		// （含 `invoker` + `sourceURL` ⇒ **能指名道姓说是谁在跑** ✓✓）。
		try {
			this._observer = new PerformanceObserver(list => {
				for (const e of list.getEntries() as (PerformanceEntry & {
					renderStart?: number; styleAndLayoutStart?: number; blockingDuration?: number;
					scripts?: Array<{ invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration?: number }>;
				})[]) {
					if (this._focusAt <= 0) { continue; }
					if (performance.now() - this._focusAt > TRACE_WINDOW_MS) { continue; }
					const dur = Math.round(e.duration ?? 0);
					const renderStart = e.renderStart ?? 0;
					// renderStart 是相对帧起点的偏移 ⇒ 之前是脚本时间、之后是样式/布局/绘制 ✓
					const scriptMs = renderStart > 0 ? Math.round(renderStart) : undefined;
					const renderMs = renderStart > 0 ? Math.round(dur - renderStart) : undefined;
					const top = (e.scripts ?? []).slice(0, 3)
						.map(s => `${s.invoker ?? '?'}${s.sourceFunctionName ? `:${s.sourceFunctionName}` : ''}@${(s.sourceURL ?? '?').split('/').slice(-2).join('/')} ${Math.round(s.duration ?? 0)}ms`)
						.join(' ｜ ');
					this._longTasks.push(
						`LoAF ${dur}ms` +
						(scriptMs !== undefined ? `｜脚本≈${scriptMs}ms / 样式布局绘制≈${renderMs}ms` : '｜（无 renderStart ⇒ 该条目主要耗时在脚本 ✓）') +
						(e.blockingDuration ? `｜blocking=${Math.round(e.blockingDuration)}ms` : '') +
						(top ? `｜${top}` : ''),
					);
				}
			});
			this._observer.observe({ entryTypes: ['long-animation-frame'] });
		} catch {
			// 回退：不支持 LoAF（老 Chromium / jsdom）时仍试 longtask ✓
			try {
				this._observer = new PerformanceObserver(list => {
					for (const e of list.getEntries()) {
						if (this._focusAt <= 0) { continue; }
						if (performance.now() - this._focusAt > TRACE_WINDOW_MS) { continue; }
						this._longTasks.push(`longTask ${Math.round(e.duration)}ms`);
					}
				});
				this._observer.observe({ entryTypes: ['longtask'] });
			} catch { /* 两种都不支持 ⇒ 只能靠自带探针（见 _startBlockProbe）✓ */ }
		}
	}

	/**
	 * rAF 帧表：统计本次焦点窗口内**画了多少帧**、**最大帧间隔**。
	 *
	 * ★ 为什么需要（2026-09-18 真机踩坑 ✗）：探针（`setTimeout` 25ms）出现「**0 次**」时，
	 * 有两种完全相反的解释 ——
	 *   · ① 主线程被**连续占住** ⇒ 定时器排不进去（= 真阻塞 ✓）；
	 *   · ② 计时器被**节流**（窗口不可见）⇒ 同样一次都不跑（≠ 阻塞 ✗）。
	 * 单看探针分不清 ✗。而 rAF **只在可见时**才触发 ✓ ⇒ 用它做交叉验证：
	 *   · rAF 帧数 **0** ⇒ ②（窗口没在画 ⇒ 探针数字不可信 ✗）；
	 *   · rAF 帧数 >0 且最大帧间隔很大 ⇒ ①（能画但很卡 ⇒ 主线程确实被占 ✓✓）。
	 */
	private _startRafMeter(gen: number): void {
		this._rafTicks = 0;
		this._lastRafAt = 0;
		this._maxRafGap = 0;
		const step = (): void => {
			if (gen !== this._focusGen || this._flushed || this._focusAt <= 0) { return; }
			const now = performance.now();
			if (this._lastRafAt > 0) {
				const gap = now - this._lastRafAt;
				if (gap > this._maxRafGap) { this._maxRafGap = gap; }
			}
			this._lastRafAt = now;
			this._rafTicks++;
			if (now - this._focusAt > TRACE_WINDOW_MS) { return; }
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	/** 停掉自带探针（`_flush` 入口调用 ✓；探针自身也有 `_flushed` 守卫，双保险 ✓）。 */
	private _stopBlockProbe(): void {
		if (this._probeTimer !== undefined) {
			clearTimeout(this._probeTimer);
			this._probeTimer = undefined;
		}
	}

	/**
	 * ★ 自带"主线程占用"探针 —— **回答本窗口是否真的被阻塞**（这是前两轮真机日志答不出来的一步 ✗）。
	 *
	 * 原理：每 `BLOCK_PROBE_MS` 排一个 `setTimeout`，量它**实际**被跑到的时间差
	 * （与看门狗同法 ✓）。主线程被占住 ⇒ 回调晚到 ⇒ 差值即占用时长 ✓。
	 *
	 * 为什么不让它去读看门狗的 `takeMaxBlockMs()` ✗：那个是模块级**读+清零**的（谁读谁清 ✓），
	 * 多个消费者会互相抢 ⇒ 焦点埋点自己测，互不干扰，且**只测自己关心的这段窗口** ✓。
	 *
	 * ⚠ 排除假阳性：窗口不可见（被遮挡/最小化）时 Chromium 会**节流**定时器（≥1s）✗ ⇒
	 * 只在 `document.visibilityState === 'visible'` 时才计入；被节流的次数单独报出来 ✓。
	 */
	private _startBlockProbe(gen: number): void {
		this._stopBlockProbe(); // ★ 清掉上一轮遗留的定时器（否则快速连切时会串到新窗口的计数里 ✗）
		this._probeAt = performance.now();
		this._probeStartAt = this._probeAt;
		this._maxBlockInTrace = 0;
		this._probeTicks = 0;
		this._probeThrottled = 0;
		const tick = (): void => {
			if (gen !== this._focusGen) { return; } // 已被新焦点取代 ⇒ 停止 ✗
			const now = performance.now();
			const late = now - this._probeAt - FocusTrace.BLOCK_PROBE_MS;
			const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
			if (visible) {
				if (late > this._maxBlockInTrace) { this._maxBlockInTrace = late; }
			} else if (late > FocusTrace.BLOCK_PROBE_MS * 2) {
				this._probeThrottled++;
			}
			this._probeTicks++;
			this._probeAt = now;
			if (this._flushed || this._focusAt <= 0 || now - this._focusAt > TRACE_WINDOW_MS) {
				this._probeTimer = undefined;
				return;
			}
			this._probeTimer = setTimeout(tick, FocusTrace.BLOCK_PROBE_MS);
		};
		this._probeTimer = setTimeout(tick, FocusTrace.BLOCK_PROBE_MS);
	}
}

/**
 * 「当前阶段名」提供者 —— **反向注册**（由 contrib 侧注入 `wsStageName()` 等）。
 *
 * ★ 为什么不在本模块直接 import `wsSwitchDiag`（2026-09-18，真机实测后补）：
 *   ① **分层**：本模块在 `sessions/browser/`，看门狗在 `sessions/contrib/agentStudio/`；
 *      browser → contrib 属反向依赖 ✗（contrib → browser 才是允许方向 ✓）；
 *   ② **实证需求**：真机焦点日志原本是
 *      `首次可绘制 +387ms` + `本窗口自证开销仅 0ms ⇒ 占用主线程的很可能是另一个窗口` ✗
 *      —— 但同一份日志里紧跟着 `[CodebaseGraph] 增量索引…合计=1732ms` ✓
 *      ⇒ 阻塞其实来自**本窗口的图索引**，那句结论会把人带偏 ✗✓。
 *   有了阶段名，同一行就能写成「焦点瞬间阶段=`graph: 增量—解析7个文件`」⇒ 一眼定位 ✓✓。
 */
let _stageProvider: (() => string) | undefined;

/** 注册阶段名提供者（幂等覆盖；由看门狗贡献在启动期注入 ✓）。 */
export function registerFocusStageProvider(fn: () => string): void {
	_stageProvider = fn;
}

/** 读当前阶段名（provider 缺失/抛错都不影响埋点本身 ✓）。 */
function _currentStage(): string {
	// ★ 2026-09-18：**先查全局钩子**（`globalThis.__SAROSIS_WS_STAGE__`）——
	// 真机日志里出现过「（未注册阶段提供者）」✗：`registerFocusStageProvider()` 是**模块级函数**，
	// 若看门狗贡献与本模块被加载成**两个模块实例**（不同 bundle / 不同入口 ✓），注册就会落到
	// 另一个实例上 ⇒ 本实例读不到 ✗。全局钩子**跨模块实例共享** ⇒ 天然免疫该问题 ✓✓
	try {
		const g = (globalThis as unknown as { __SAROSIS_WS_STAGE__?: () => string }).__SAROSIS_WS_STAGE__;
		if (typeof g === 'function') { return g(); }
	} catch { /* 全局钩子异常 ⇒ 走下面的注册表 */ }
	try {
		return _stageProvider ? _stageProvider() : '（未注册阶段提供者）';
	} catch {
		return '（阶段提供者异常）';
	}
}

/** 模块级单例：每个窗口（各自 JS realm）一份 ⇒ 各自记录本窗口的焦点轨迹 ✓。 */
export const focusTrace = new FocusTrace();

/** 安装全局入口（幂等）。 */
export function installFocusTraceGlobals(): void {
	try {
		const g = globalThis as unknown as Record<string, unknown>;
		if (g['__SAROSIS_FOCUS_TRACE_DUMP_INSTALLED'] === true) { return; }
		g['__SAROSIS_FOCUS_TRACE_DUMP_INSTALLED'] = true;
		g['__SAROSIS_FOCUS_TRACE_DUMP'] = (note?: string) => { focusTrace.dump(note ?? '手动 dump'); };
	} catch { /* ignore */ }
}

// ★ 模块加载即安装（幂等）——刻意做成模块副作用：本模块被聊天面板/pane 静态 import，
//   这样不必去改各面板构造函数即可覆盖全部窗口 ✓（与 chatPerf 同一取舍 ✓）。
focusTrace.install();
installFocusTraceGlobals();
