/*---------------------------------------------------------------------------------------------
 *  mainThreadBreadcrumb.ts — 主线程「面包屑」共享槽（2026-10-22，卡死取证用）
 *
 * ## 为什么需要（三次卡死的共同盲区）
 *
 * 现场指纹都一样：**主进程 `Runtime.evaluate` 不回复、CPU ≈ 0**（在等，不在算）、
 * 窗口日志同时停止。`mainHeartbeat.ts` 只能给出「**什么时候**卡的」（时间戳断层），
 * 给不出「**卡在哪个调用**」——因为主线程一卡，日志、定时器、inspector 全停，
 * 事后手里只剩"最后一条日志"，而那往往已经离卡点有几秒（甚至几十秒）。
 *
 * 本模块补上「**卡在哪**」这一半：
 *   · 主线程在**可疑的同步操作**入口写一个 (阶段下标, 时间戳) 到 **SharedArrayBuffer**
 *     （两次 `Atomics.store`，**零分配、零 IO** —— 它自己绝不能成为阻塞源 ✓）；
 *   · 独立的 **worker 线程**（见 `mainThreadWatchdog.ts`）每秒读一次 ⇒ 主线程停更 >8s
 *     就把「最后阶段 + CPU 占用率 + RSS」落盘 ⇒ 下次冻结直接指名道姓 ✓。
 *
 * ## 设计约束（刻意的）
 *   · 阶段表是**主线程与 worker 共用**的（worker 读下标 + 同一张表 ⇒ 不必跨线程传字符串 ✓）；
 *   · 用 `BigInt64Array` 而不是 `Int32Array`：时间戳要 epoch ms（Int32 装不下 ✗）；
 *   · 未初始化时 `markMainThreadPhase()` **静默 no-op**（测试/非主进程环境安全 ✓）。
 *--------------------------------------------------------------------------------------------*/

/**
 * 阶段表。**只允许追加**（下标即 ABI：已落盘的诊断文件里会写 `phase=<名字>`，
 * 改动既有下标会让历史诊断对不上 ✗）。
 */
export const MAIN_PHASES = [
	'idle',
	'heartbeat',
	'credit-route',
	'dsh-view-probe',
	'dsh-workspace-sync',
	'dsh-host-command',
	'sqlite-call',
	'graph-save',
	'graph-load',
	'plugin-install',
	// ★ 2026-10-22（"卡在第一个 10 万行 chunk 的 commit/checkpoint"现场）：把主进程 SQLite 的
	//   提交/回写单独标出来 —— 它们**不在** IPC 入口那一段里（入口早已返回控制权给事件循环）。
	'sqlite-commit',
	'sqlite-checkpoint',
	'sqlite-write',
	// ★ 2026-10-23：**增量补丁跑在渲染进程** ⇒ 主进程的面包屑对它无效（SAB 不在同一个进程）
	//   ⇒ 那四段改用渲染侧日志 `[phase] 增量补丁：… 开始` 留痕（见 codebaseGraphService）。
] as const;

export type MainPhase = typeof MAIN_PHASES[number];

/** SAB 里的槽位（BigInt64）。 */
export const BREADCRUMB_SLOTS = Object.freeze({ phase: 0, at: 1 });

/** 一个槽子够用（16 个 int64），留余量给后续加字段。 */
const SAB_BYTES = 128;

let sab: SharedArrayBuffer | undefined;
let slots: BigInt64Array | undefined;

/**
 * 创建（或复用）共享槽。**只应由主进程启动时调一次**（看门狗与心跳共用同一份）。
 */
export function initMainThreadBreadcrumb(): SharedArrayBuffer {
	if (!sab) {
		sab = new SharedArrayBuffer(SAB_BYTES);
		slots = new BigInt64Array(sab);
		Atomics.store(slots, BREADCRUMB_SLOTS.phase, BigInt(0));
		Atomics.store(slots, BREADCRUMB_SLOTS.at, BigInt(Date.now()));
	}
	return sab;
}

/** 当前共享槽（未初始化 ⇒ undefined）。 */
export function mainThreadBreadcrumbBuffer(): SharedArrayBuffer | undefined {
	return sab;
}

/** 名字 → 下标（未知名字映射到 0 = idle，不抛错：取证代码不该影响业务 ✓）。 */
export function mainPhaseIndex(phase: MainPhase | number): number {
	if (typeof phase === 'number') {
		return Number.isFinite(phase) && phase >= 0 ? Math.floor(phase) : 0;
	}
	const i = MAIN_PHASES.indexOf(phase);
	return i >= 0 ? i : 0;
}

/**
 * 打一个面包屑（**同步、零分配、无 IO**）。
 *
 * 用法：在可疑的同步段**入口**调一次即可（不必成对）—— 看门狗只需要知道"最后进入的是哪一段"。
 */
export function markMainThreadPhase(phase: MainPhase | number): void {
	if (!slots) {
		return;
	}
	try {
		Atomics.store(slots, BREADCRUMB_SLOTS.phase, BigInt(mainPhaseIndex(phase)));
		Atomics.store(slots, BREADCRUMB_SLOTS.at, BigInt(Date.now()));
	} catch {
		/* 取证失败绝不能影响业务 ✓ */
	}
}

/** 读面包屑（worker 与单测用）。 */
export function readMainThreadBreadcrumb(buffer: SharedArrayBuffer): { phase: number; at: number } {
	const s = new BigInt64Array(buffer);
	return {
		phase: Number(Atomics.load(s, BREADCRUMB_SLOTS.phase)),
		at: Number(Atomics.load(s, BREADCRUMB_SLOTS.at)),
	};
}
