/*---------------------------------------------------------------------------------------------
 *  turn 收尾段 —— 由 `agentTurnExecutor.ts` 迁出（2026-09-17 Part 化期 4）。
 *
 *  包含两个**互相独立**、均无 yield / 无控制流逃逸的收尾动作：
 *
 *    1. `storeTurnObservationsAtEnd`（原主文件 3917-3931）
 *       每轮 turn 结束把本轮新增对话增量外置到记忆，供后续 turn 检索取回。
 *       调用点在 while 循环之后、`finally` 之前（仍在 try 内）。
 *
 *    2. `logToolAuditSummary`（原主文件 3949-4005）
 *       [ToolAudit] SUMMARY 诊断日志。调用点在 `finally` 内 —— **必须覆盖
 *       abort / 异常 / generator return 全部退出路径**，因为「工具用得不合理」
 *       的 turn 恰恰最常以中断收尾（撞硬超时、用户取消），只在正常结束处打
 *       就会漏掉最该看的那些。
 *
 *  两者都对调用方零副作用（不改 messages / runState / loopState），失败均被
 *  内部吞掉，绝不阻断 turn 收尾。
 *--------------------------------------------------------------------------------------------*/

import {
	buildToolAuditReport,
	formatToolAuditLog,
	type IToolCallRecord,
} from '../../common/toolAuditReport.js';
import {
	STRUCTURAL_SEARCH_TOOL_NAMES,
	TEXT_SEARCH_TOOL_NAMES,
} from '../../common/searchToolGroups.js';
import { isParallelSafeReadOnlyTool } from '../toolCallUtils.js';

/** 单个闸门的本 turn 水位记录（与主文件 `_audit.watermarks` 的 value 同构）。 */
export interface IToolAuditWatermark {
	max: number;
	fired: number;
	threshold: number;
	hot?: string;
}

/**
 * turn 级工具审计容器 —— 结构与主文件的 `_audit` 字面量逐字段对应。
 * 这里刻意声明为**只读视图**：收尾段只读不写。
 */
export interface IToolAuditState {
	readonly records: ReadonlyArray<IToolCallRecord>;
	readonly watermarks: ReadonlyMap<string, IToolAuditWatermark>;
	readonly maxSingleToolStreak: number;
	readonly streakNames: ReadonlySet<string>;
	readonly startedAt: number;
	readonly iterations: number;
	readonly singleToolStreakThreshold: number;
}

/** 日志宿主的窄接口 —— 只声明本段实际调用的成员，便于测试 stub。 */
export interface ITurnFinalizationLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

/** `logToolAuditSummary` 的入参。 */
export interface IToolAuditSummaryDeps {
	audit: IToolAuditState;
	logService: ITurnFinalizationLogger;
	/** 报告里用于关联日志的 turn 标识（主文件传 `request.sessionId`）。 */
	turnId: string | undefined;
	/** 注入当前时刻，便于测试固定 wallMs（默认 `Date.now`）。 */
	now?: () => number;
}

/**
 * 输出 [ToolAudit] SUMMARY 诊断日志。
 *
 * 只有存在告警（空结果率高 / 重复读 / 形态异常）才 `warn`，纯成本分布用 `info`
 * —— 与 [FullRefresh] SUMMARY 同姿态：默认输出、不挂开关。
 *
 * 无审计记录（`records` 为空）时直接返回，不产生任何日志。
 * 任何异常都被吞掉并降级为一条 warn：诊断绝不阻断 turn 收尾。
 */
export function logToolAuditSummary(deps: IToolAuditSummaryDeps): void {
	const { audit, logService, turnId } = deps;
	const now = deps.now ?? Date.now;
	try {
		if (audit.records.length === 0) {
			return;
		}
		const auditReport = buildToolAuditReport({
			records: [...audit.records],
			iterations: audit.iterations,
			wallMs: now() - audit.startedAt,
			turnId,
			maxSingleToolStreak: audit.maxSingleToolStreak,
			singleToolStreakThreshold: audit.singleToolStreakThreshold,
			parallelizableInStreak: [...audit.streakNames],
			// 判据复用：探索类 = searchToolGroups 的两类**纯粹搜索**集合
			// （TEXT ∪ STRUCTURAL，其文件头注释即「本表决定探索策略引导」）。
			// 只读判定复用 isParallelSafeReadOnlyTool。绝不在审计模块另建工具分类表。
			//
			// ⚠⚠ 2026-08-22 两轮实证修正「探索」的边界（先后各犯一次方向相反的错误）：
			//   · 初版含 `isParallelSafeReadOnlyTool` —— 它把 `file_read` 也算了进来，
			//     而「改完读文件确认」是收敛的**表现**，不是「探索不收敛」；
			//   · 中版再叠 `execute_code` / `terminal`（为抓 1787373914386 里
			//     「python3 逐行试探」的绕过）—— 却把「npx tsc / git diff」这类
			//     验证也算成探索。
			// 实测（日志 1787381220642）「修改 webview 代码」任务后期是
			//   patch×7 + file_read(确认) + execute_code(tsc 验证)，被误报为
			//   `late-phase-exploration: 74% (14/19)` —— 该 turn 其实是健康的。
			//
			// 结论：`file_read` / `execute_code` / `terminal` 有**双重语义**
			// （探索 vs 验证），按工具名无法区分，硬算必误伤。故「探索不收敛」
			// 只统计语义纯粹的搜索工具：
			//   - 搜索工具 = 只搜新信息，不存在「验证」语义 → 不会误报；
			//   - 「python 试探」的空转危害已由 `allBlocked` 零进展治理覆盖
			//     （1787377582459 修），不必再靠 late-phase 去抓；
			//   - 「python 试探」的串行浪费本就不适合「并行提醒」缓解（验证命令
			//     常有依赖顺序），late-phase 对它的价值本就有限。
			// 注意 isReadOnlyTool 保持 isParallelSafeReadOnlyTool 不变（写类重复
			// 是合法迭代，计入 dup 会误报）。
			isExplorationTool: (n) => TEXT_SEARCH_TOOL_NAMES.has(n) || STRUCTURAL_SEARCH_TOOL_NAMES.has(n),
			isReadOnlyTool: (n) => isParallelSafeReadOnlyTool(n),
			guardrails: [...audit.watermarks].map(([name, w]) => ({
				name, max: w.max, threshold: w.threshold, fired: w.fired, hot: w.hot,
			})),
		});
		const auditLog = formatToolAuditLog(auditReport);
		if (auditLog.level === 'warn') {
			logService.warn(auditLog.text);
		} else {
			logService.info(auditLog.text);
		}
	} catch (auditError) {
		// 诊断绝不阻断 turn 收尾
		logService.warn('[ToolAudit] failed to build summary:', auditError);
	}
}

/**
 * 记忆提供方 —— 本段只需判定「是否支持检索式回放」，不触碰其余能力，
 * 故刻意声明为 `object` 而非结构化窄接口：后者所有成员都可选，会触发
 * TS 的 weak type detection（`IMemoryProvider` 与之「无公共属性」而报 TS2322）。
 * 能力探测改在运行时用 `in` 完成。
 */
export type TurnMemoryProvider = object;

/** 判定该提供方是否支持检索式回放（`recallFormatted`）。 */
function supportsRecallFormatted(provider: TurnMemoryProvider): boolean {
	return 'recallFormatted' in provider && !!(provider as { recallFormatted?: unknown }).recallFormatted;
}

/** `storeTurnObservationsAtEnd` 的入参。 */
export interface IStoreTurnObservationsDeps {
	/** 检索式压缩总开关（主文件传 `RETRIEVAL_COMPACTION_ENABLED`）。 */
	retrievalCompactionEnabled: boolean;
	/** 取当前激活的记忆提供方；无则返回 undefined/null。 */
	getActiveMemoryProvider: () => TurnMemoryProvider | undefined | null;
	/** 真正的外置写入动作（主文件传 `host._storeTurnObservations`）。 */
	storeTurnObservations: (
		provider: TurnMemoryProvider,
		agentId: string,
		sessionId: string,
		messages: ReadonlyArray<unknown>,
	) => Promise<unknown>;
	agentId: string | undefined;
	sessionId: string | undefined;
	messages: ReadonlyArray<unknown>;
}

/**
 * 每轮 turn 结束：把本轮新增对话增量外置到记忆（延续检索式上下文，而非只在
 * 压缩时才外置），供后续 turn 检索取回，逐步累积历史上下文。
 *
 * **fire-and-forget**：写入供「后续」turn 使用，绝不应阻塞本 turn 收尾——
 * 多迭代 turn（如 22 步子代理）会产生 ~40 条增量消息，串行 await 网关写
 * （IPC 往返 50-500ms/条）会在 turn 末造成数秒~分钟级卡死；网关不可达时
 * 更糟（2026-07-25 日志实证：turn 末 writeMemory 洪泛 300+ 条阻塞收尾）。
 *
 * 注意：storeTurnObservations 内部先 `seen.add(hash)` 再写，后台写入期间
 * 下一 turn 的 turn-start 外置不会重复写同内容。
 */
export function storeTurnObservationsAtEnd(deps: IStoreTurnObservationsDeps): void {
	if (!deps.retrievalCompactionEnabled) {
		return;
	}
	const provider = deps.getActiveMemoryProvider();
	if (!provider || !supportsRecallFormatted(provider)) {
		return;
	}
	void deps.storeTurnObservations(
		provider,
		deps.agentId ?? 'default',
		deps.sessionId ?? '',
		deps.messages,
	).catch(() => { /* 单条失败已在内部吞掉；此处兜底防 unhandled rejection */ });
}
