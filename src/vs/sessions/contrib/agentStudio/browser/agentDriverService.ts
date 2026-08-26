/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentDriverService, AgentTurnStatus } from '../common/agentDriver.js';
import { IAgentTurnRequest, IMemoryProvider, ChatImageMimeType, IChatContentPart } from '../common/providers.js';
import { wrapUserQuery } from '../common/userQuery.js';
import { resolveEffectiveWorktreeRoot } from '../common/worktreeBinding.js';
import type { IChatStreamDelta } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IChatSendOptions } from '../common/agentStudio.js';
import type { IChatAttachmentSend } from '../../../common/agentStudioService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISkillRegistry, ISkillDefinition } from '../common/skills.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { AgentBinding } from '../../../common/agentStudioTypes.js';
import { AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING, AGENT_STUDIO_RESPONSE_LANGUAGE_SETTING, AGENT_STUDIO_LANGUAGE_SETTING } from '../common/constants.js';
import { buildResponseLanguageDirective } from '../common/responseLanguage.js';
import { buildEnvironmentDirective } from '../common/environmentDirective.js';
import { GLOBAL_SYSTEM_SUFFIX, GLOBAL_SYSTEM_PREFIX, getStrategyGuidance } from '../common/chatModeConfig.js';
import { getParadigmOverride } from '../common/paradigmOverride.js';
import { joinSections, composeFrozenPrefix, composeVolatileMessage, buildCompactToolSection, type ISystemPromptTiers } from '../common/systemPromptComposer.js';
import { detectModelFamily } from '../common/modelFamilyPrompt.js';
import { snapshotPromptPrefix, diffPromptPrefix, formatPromptPrefixLog, type IPromptPrefixSnapshot } from '../common/promptDiagnostics.js';
import { isMemoryInjectionEnabled } from './agentMemoryInjection.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IMcpService, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { restoreRunState } from '../common/agentRunState.js';
import type { AgentRunState, AgentRunStateSnapshot } from '../common/agentRunState.js';

// ─── Skill 目录 XML 渲染（可单测的纯函数） ───────────────────────────
// 抽离自 buildSystemPrompt 的 buildSkillEntry 闭包，便于单元测试覆盖
// 「双向打通」给 workflow 来源 skill 加的 <type>workflow</type> / <executable> /
// <workflow_id> 标注（行为与原闭包完全一致）。

/**
 * 把一个 skill 渲染成 `<available_skills>` 目录里的一条 `<skill>` XML。
 * @param compact 为 true 时省略 <description>（超预算降级用）
 */
export function buildSkillEntryXml(s: ISkillDefinition, compact: boolean): string {
	const lines = ['  <skill>'];
	lines.push(`    <name>${s.name}</name>`);
	if (!compact && s.description) {
		// 截断描述到 80 字符，减少 XML 目录体积（参考 Hermes-Agent 60 字符策略）
		const desc = s.description.length > 80
			? s.description.slice(0, 77) + '...'
			: s.description;
		lines.push(`    <description>${desc}</description>`);
	}
	lines.push(`    <id>${s.id}</id>`);
	lines.push(`    <activation>${s.activation}</activation>`);
	// 渐进披露：提示技能附带的支持文件（references/scripts/assets/templates），
	// 模型可用 read_skill(skill_id, path) 按需读取
	if (!compact && s.supportFiles && s.supportFiles.length > 0) {
		const shown = s.supportFiles.slice(0, 10);
		const suffix = s.supportFiles.length > 10 ? ` (+${s.supportFiles.length - 10} more)` : '';
		lines.push(`    <support_files>${shown.join(', ')}${suffix}</support_files>`);
	}
	// 双向打通：workflow 来源的 skill 为「可执行型」，触发即运行工作流而非注入文本
	if (s.source === 'workflow') {
		lines.push(`    <type>workflow</type>`);
		lines.push(`    <executable>true</executable>`);
		if (s.workflowId) {
			lines.push(`    <workflow_id>${s.workflowId}</workflow_id>`);
		}
	}
	lines.push('  </skill>');
	return lines.join('\n');
}

// ─── 顶层 Turn 并发限流信号量 ─────────────────────────────────────
// 多 session / 多 agent / 多窗口同时发送消息时，防止 N 个完整 agent loop
// 无限制并行 → API 限流/配额耗尽 + V8 4GB 堆透支。FIFO 排队，超额 turn 等待。
// acquire 支持 AbortSignal：排队中的 turn 被取消时从队列移除并 reject，
// 调用方据此短路，不占用并发名额、不执行（修复「排队中 turn 无法取消」缺陷）。

class TurnConcurrencySemaphore {
	private _available: number;
	private readonly _waiters: Array<{
		resolve: () => void;
		reject: (err: Error) => void;
		signal?: AbortSignal;
		onAbort: () => void;
	}> = [];

	constructor(limit: number) {
		this._available = Math.max(1, limit);
	}

	/**
	 * 获取一个并发名额。
	 * @param signal 可选 AbortSignal：在排队等待期间被 abort 时，从等待队列移除并 reject，
	 *               调用方据此直接短路（不执行、不占名额）。用于修复「排队中的 turn 无法取消」缺陷。
	 */
	async acquire(signal?: AbortSignal): Promise<void> {
		// 已在取消途中：直接拒绝，不进入队列、不占用名额
		if (signal?.aborted) {
			throw new Error('TurnConcurrencySemaphore.acquire() was cancelled before it could start');
		}
		if (this._available > 0) {
			this._available--;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let entry!: { resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal; onAbort: () => void };
			const onAbort = () => {
				const idx = this._waiters.indexOf(entry);
				if (idx !== -1) {
					this._waiters.splice(idx, 1);
					reject(new Error('TurnConcurrencySemaphore.acquire() was cancelled while queued'));
				}
			};
			entry = { resolve, reject, signal, onAbort };
			signal?.addEventListener('abort', onAbort, { once: true });
			this._waiters.push(entry);
		});
	}

	release(): void {
		const next = this._waiters.shift();
		if (next) {
			// 正常出队：移除 abort 监听，避免 AbortSignal 上的监听器泄漏
			next.signal?.removeEventListener('abort', next.onAbort);
			next.resolve();
		} else {
			this._available++;
		}
	}
}

// ─── Agent Driver Service Implementation ────────────────────────

export class AgentDriverService extends Disposable implements IAgentDriverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTurnStatus = this._register(new Emitter<{ status: AgentTurnStatus; turnId: string }>());
	readonly onDidChangeTurnStatus = this._onDidChangeTurnStatus.event;

	private readonly _turnStatusMap = new Map<string, AgentTurnStatus>();
	private readonly _activeTurns = new Map<string, AbortController>();
	private readonly _logService: ILogService;

	/** 顶层 turn 并发上限默认值（可被配置 agentStudio.driver.turnConcurrencyLimit 覆盖）。 */
	private static readonly DEFAULT_TOP_LEVEL_TURN_CONCURRENCY_LIMIT = 4;
	private static readonly MAX_TOP_LEVEL_TURN_CONCURRENCY_LIMIT = 32;
	private readonly _turnSemaphore: TurnConcurrencySemaphore;
	/** 记录哪些 turnId 已拿到信号量，用于 cancelTurn 精准 release 避免配额泄漏。 */
	private readonly _turnHoldsSemaphore = new Set<string>();

	/**
	 * Per-(workspace,agent) 互斥锁：防止同 workspace 下同 agent 的并发 turn
	 * 相互覆盖 AgentBinding.worktreePath → 工具执行时 cwd 解析错误 / 恢复错误。
	 * key = `${workspaceId}::${agentId}`，互斥量 = 1。
	 */
	private readonly _bindingWriteLocks = new Map<string, TurnConcurrencySemaphore>();

	/** System prompt 分层缓存 — stable 层 session 内不变，免重复计算 */
	/** 工具清单缓存（按 chatMode+agentId 分流） */
	private readonly _toolInventoryCache = new Map<string, string>();

	/**
	 * 上一轮的提示词前缀指纹快照（按 sessionId，缺失时按 agentId）。
	 * 仅供 `[PromptFingerprint]` 漂移归因日志使用 —— 纯诊断状态，
	 * 不参与任何行为判定；LRU 上限 64 防长进程无限增长。
	 */
	private readonly _lastPrefixSnapshot = new Map<string, IPromptPrefixSnapshot>();

	private _getBindingLock(workspaceId: string, agentId: string): TurnConcurrencySemaphore {
		const key = `${workspaceId}::${agentId}`;
		let lock = this._bindingWriteLocks.get(key);
		if (!lock) {
			lock = new TurnConcurrencySemaphore(1); // 互斥：同时只允许一个 turn 改
			this._bindingWriteLocks.set(key, lock);
		}
		return lock;
	}

	/** 释放所有 per-(workspace,agent) 互斥锁表，避免长期多 workspace 切换累积。 */
	public override dispose(): void {
		this._bindingWriteLocks.clear();
		super.dispose();
	}

	/**
	 * 启动自愈：扫描所有 workspace 的 binding，恢复残留的临时 worktree 覆盖。
	 *
	 * 进程崩溃/退出（task 执行中途断电、OOM、强制关闭）时，finally 中的 worktreePath
	 * 恢复可能未执行，binding.worktreePath 卡在 task 的临时值，而内存中的
	 * originalBindingWorktreePath 已随进程丢失 → 无法恢复。
	 *
	 * 修复：task 临时覆盖时已把 originalWorktreePath 持久化进 binding.tempWorktreeOverride。
	 * 本方法在 driver 构造后（尚无任何 turn 运行）扫描所有带标记的 binding，
	 * 将其 worktreePath 恢复为 originalWorktreePath 并清除标记。重启后所有临时覆盖的
	 * owner（turnId）必然已失效（旧进程已死），故统一恢复。
	 *
	 * 仅动带 tempWorktreeOverride 标记的 binding；普通用户手动设置的 worktreePath 不带
	 * 标记，绝不被触碰，彻底避免误清合法绑定。
	 */
	private async _recoverOrphanedTempOverrides(): Promise<void> {
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			let recovered = 0;
			for (const ws of workspaces) {
				let bindings: AgentBinding[] = [];
				try {
					bindings = await this._agentStudioService.getAgentBindings(ws.id);
				} catch {
					continue;
				}
				for (const b of bindings) {
					if (!b.tempWorktreeOverride) {
						continue;
					}
					const override = b.tempWorktreeOverride;
					this._logService.info(
						`[AgentDriver] Recovering orphaned temp worktree override for ${ws.id}/${b.agentId}: ` +
						`temp="${b.worktreePath ?? '(none)'}" -> original="${override.originalWorktreePath ?? '(none)'}" ` +
						`(owner=${override.owner}, ts=${override.timestamp})`
					);
					await this._agentStudioService.upsertAgentBinding(ws.id, b.agentId, {
						worktreePath: override.originalWorktreePath,
						tempWorktreeOverride: undefined,
					});
					recovered++;
				}
			}
			if (recovered > 0) {
				this._logService.info(`[AgentDriver] Recovered ${recovered} orphaned temp worktree override(s) on startup`);
			}
		} catch (err) {
			this._logService.warn('[AgentDriver] Failed to recover orphaned temp worktree overrides:', err);
		}
	}


	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
		@ILogService logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
			@IMcpService private readonly _mcpService: IMcpService,
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._logService = logService;
		// 按配置初始化顶层 turn 并发信号量（默认 4，可在设置中调整）
		this._turnSemaphore = new TurnConcurrencySemaphore(this._readTurnConcurrencyLimit());

		// 启动自愈：恢复进程崩溃/重启残留的临时 worktree 覆盖。
		// 仅处理带 tempWorktreeOverride 标记的 binding；普通用户手动设置的
		// worktreePath 不带标记，绝不被触碰，因此不会误清合法绑定。
		this._recoverOrphanedTempOverrides().catch(err => {
			this._logService.warn('[AgentDriver] startup temp-worktree recovery error:', err);
		});
	}

	// ─── 工作流型 skill 触发（双向打通 P1）──────────────────────────────

	/**
	 * 触发一个 workflow 来源的可执行型 skill：后台启动工作流执行（fire-and-forget）。
	 * 工作流在其专属 owner agent 会话中运行，AskUser/变量卡等交互由工作流自身处理，
	 * 不阻塞当前 agent turn。结果通过工作流的 trace 机制呈现，不在本方法内同步回灌。
	 */
	private async _triggerWorkflowSkill(workflowId: string, input: string | undefined, name: string): Promise<void> {
		try {
			// 懒获取打破循环依赖链：agentDriverService -> workflowExecutionService ->
			// agentChatService -> agentDriverService。直到 /skill <id> 触发时才解析。
			const wfService = this._instantiationService.invokeFunction((accessor) =>
				accessor.get(IWorkflowExecutionService)
			);
			const executionId = await wfService.executeWorkflow(workflowId, {
				context: { input: input ?? '' },
				skipVariableCollection: true,
			});
			this._logService.info(`[AgentDriver] workflow skill execution started: wf=${workflowId} exec=${executionId}`);
		} catch (err) {
			this._logService.warn(`[AgentDriver] workflow skill execution failed: wf=${workflowId}`, err);
		}
	}

	/**
	 * 工作流模式 turn（/workflow <id>、/wf、bare /{wf-xxx} 触发）。
	 *
	 * 与 _triggerWorkflowSkill 的 fire-and-forget 不同：本方法 await 工作流终态，
	 * 把最终节点输出作为本 turn 的 assistant 回答锚定返回，期间：
	 * - owner 会话绑定为当前聊天 agent（options.agentId），subagent 进度卡片内联显示；
	 * - chat 侧 abort 信号联动 cancelExecution；
	 * - 严格按工作流配置执行：每节点的 agent/prompt/工具/上下文隔离均由 DAG 决定，
	 *   本 turn 不走自由 LLM 循环。
	 */
	private async *_executeWorkflowTurn(
		request: IAgentTurnRequest,
		trigger: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] },
		controller: AbortController,
	): AsyncIterable<IChatStreamDelta> {
		const wfService = this._instantiationService.invokeFunction((accessor) =>
			accessor.get(IWorkflowExecutionService)
		);

		yield {
			type: 'text',
			content: `⚙️ 正在执行工作流 **${trigger.workflowId}**${trigger.input ? `（输入：${trigger.input}）` : ''}...\n\n`,
		};

		let executionId: string;
		try {
			executionId = await wfService.executeWorkflow(trigger.workflowId, {
				agentId: request.agentId,
				sessionId: request.sessionId,
				context: {
					input: trigger.input ?? '',
					...(trigger.variables ?? {}),
					...(trigger.images && trigger.images.length > 0 ? { images: trigger.images } : {}),
				},
				skipVariableCollection: true,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn(`[AgentDriver] workflow trigger failed: ${trigger.workflowId}`, err);
			yield { type: 'text', content: `❌ 工作流启动失败：${msg}` };
			return;
		}

		// abort 联动：chat 侧取消 → 取消工作流执行
		const abortListener = () => { void wfService.cancelExecution(executionId); };
		controller.signal.addEventListener('abort', abortListener);

		try {
			// 收集终态结果（输出文本 + 媒体快照）。
			const collectFinal = (state: { status: unknown; nodeStates: Map<string, { status: unknown; output?: string; snapshot?: Array<{ kind: string; ref: string }> }> }) => {
				let last = '';
				const images: string[] = [];
				for (const ns of state.nodeStates.values()) {
					if ((ns.status as string) === 'completed' && ns.output) {
						last = ns.output;
					}
					// ComfyStage 媒体快照（image/video）→ 聊天卡渲染输出
					if (ns.snapshot) {
						for (const snap of ns.snapshot) {
							if (snap.kind === 'image' || snap.kind === 'video') {
								images.push(snap.ref);
							}
						}
					}
				}
				return { output: last, images };
			};

			// ComfyStage 节点逐格进度（node_progress trace）→ 队列 + 唤醒器。
			const progressQueue: Array<{ nodeName: string; progress: number; message?: string }> = [];
			let progressWake: (() => void) | null = null;
			const progressSub = wfService.onDidExecutionTrace(ev => {
				if (ev.executionId !== executionId || ev.kind !== 'node_progress') { return; }
				progressQueue.push({ nodeName: ev.nodeName, progress: ev.progress, ...(ev.message !== undefined ? { message: ev.message } : {}) });
				progressWake?.();
			});

			// 等待终态，期间透传进度：每次被进度唤醒就 yield 一条 progress delta，直到终态。
			let finalOutput: { output: string; failed: boolean; cancelled: boolean; images: string[] };
			for (;;) {
				const terminal = await new Promise<{ output: string; failed: boolean; cancelled: boolean; images: string[] } | null>((resolve) => {
					const sub = wfService.onDidExecutionStatusChange(state => {
						if (state.executionId !== executionId) { return; }
						const s = state.status as string;
						if (s === 'completed' || s === 'failed' || s === 'cancelled') {
							sub.dispose();
							const collected = collectFinal(state);
							resolve({ output: collected.output, failed: s === 'failed', cancelled: s === 'cancelled', images: collected.images });
						}
					});
					progressWake = () => {
						progressWake = null;
						resolve(null);
					};
					// 竞态兜底：等待期间已有进度到达则立即唤醒。
					if (progressQueue.length > 0) { progressWake(); }
				});

				if (terminal !== null) {
					finalOutput = terminal;
					break;
				}

				// 透传进度（取队列中最新一条，其余合并丢弃）。
				const items = progressQueue.splice(0);
				if (items.length > 0) {
					const latest = items[items.length - 1];
					yield {
						type: 'progress',
						progress: latest.progress,
						...(latest.message !== undefined ? { stage: latest.message } : {}),
						progressData: [{
							id: `wf-${executionId}-progress`,
							content: latest.message ?? `${latest.nodeName}：生成中 ${latest.progress}%`,
							status: latest.progress >= 100 ? 'completed' as const : 'in-progress' as const,
						}],
					};
				}
			}
			progressSub.dispose();

			if (finalOutput.cancelled) {
				yield { type: 'text', content: `⏹ 工作流已取消。` };
			} else if (finalOutput.failed) {
				yield { type: 'text', content: `❌ 工作流执行失败。${finalOutput.output ? `\n\n${finalOutput.output}` : ''}` };
			} else {
				const mediaMd = finalOutput.images.length > 0
					? `\n\n${finalOutput.images.map((ref, i) => `![输出 ${i + 1}](${ref})`).join('\n')}`
					: '';
				yield {
					type: 'text',
					content: `${finalOutput.output
						? finalOutput.output
						: `✅ 工作流 **${trigger.workflowId}** 执行完成。`}${mediaMd}`,
				};
			}
		} finally {
			controller.signal.removeEventListener('abort', abortListener);
		}
	}

	/** 从配置读取顶层 turn 并发上限，夹在 [1, 32] 区间，非法/缺省回退默认值。 */
	private _readTurnConcurrencyLimit(): number {
		const configured = this._configurationService.getValue<number>(AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING);
		const n = typeof configured === 'number' && Number.isFinite(configured)
			? Math.floor(configured)
			: AgentDriverService.DEFAULT_TOP_LEVEL_TURN_CONCURRENCY_LIMIT;
		return Math.min(AgentDriverService.MAX_TOP_LEVEL_TURN_CONCURRENCY_LIMIT, Math.max(1, n));
	}

	// ─── WorkMode 跨 turn 持久化（P1：planning 阶段不因 turn 边界而丢失） ──
	// plan_enter → workMode='plan' → 本 turn 结束 → 下一 turn 应从 plan 继续。
	// 这里用 sessionId 做 key，在 executeTurn stream 中监听 work_mode_changed
	// delta 并写入 storage，executeFromChatOptions 时恢复注入 IAgentTurnRequest.
	private static readonly _WORK_MODE_KEY_PREFIX = 'agentStudio.workMode.';
	private readonly _sessionWorkModes = new Map<string, 'plan' | 'work'>();

	private _workModeKey(sessionId: string): string {
		return `${AgentDriverService._WORK_MODE_KEY_PREFIX}${sessionId}`;
	}

	private _saveWorkMode(sessionId: string | undefined, mode: 'plan' | 'work'): void {
		if (!sessionId) { return; }
		this._sessionWorkModes.set(sessionId, mode);
		try {
			this._storageService.store(this._workModeKey(sessionId), mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch { /* best-effort */ }
	}

	private _restoreWorkMode(sessionId: string | undefined): 'plan' | 'work' | undefined {
		if (!sessionId) { return undefined; }
		// Check memory cache first, then fall back to storage.
		const mem = this._sessionWorkModes.get(sessionId);
		if (mem) { return mem; }
		try {
			const raw = this._storageService.get(this._workModeKey(sessionId), StorageScope.WORKSPACE);
			if (raw === 'plan' || raw === 'work') {
				this._sessionWorkModes.set(sessionId, raw);
				return raw;
			}
		} catch { /* ignore */ }
		return undefined;
	}

	// ─── 多 agent 图 checkpoint/resume 持久化（supervisor/goto Step D driver 接线）──
	//
	// executeAgentGraph（agentOSService）本身存储无关：它在节点边界通过
	// request.checkpointSink 落盘、从 request.resumeFrom 续跑。driver 是唯一
	// 知道 sessionId ↔ 存储映射的层，故在此把 sink/resume 接到 IStorageService。
	//
	// ─── Agent Turn Checkpoint（单 agent + 图模式统一，V3 支持断点续跑）───
	// 单 agent: agentTurnExecutor 每 3 轮 persist snapshot（budget + messages + iteration）
	// 图模式: executeAgentGraph 在节点边界 persist snapshot（graph + nodeThreads）
	// 两种模式共用同一 checkpointSink/resumeFrom 接口，存储介质 = workspace storage。

	private static readonly _TURN_CHECKPOINT_KEY_PREFIX = 'agentStudio.turnCheckpoint.';

	private _turnCheckpointKey(sessionId: string): string {
		return `${AgentDriverService._TURN_CHECKPOINT_KEY_PREFIX}${sessionId}`;
	}

	/**
	 * 从 workspace storage 恢复上一次 turn 落盘的快照（容错），返回裸 AgentRunState
	 * 供 request.resumeFrom 使用。无 checkpoint / 解析失败 → undefined。
	 * 支持 V2（graph only）和 V3（budget + preExplore + loopMessages）两种格式。
	 */
	private _loadTurnCheckpoint(sessionId: string): AgentRunState | undefined {
		try {
			const raw = this._storageService.get(this._turnCheckpointKey(sessionId), StorageScope.WORKSPACE);
			if (!raw) {
				return undefined;
			}
			return restoreRunState(JSON.parse(raw));
		} catch (err) {
			this._logService.warn(`[AgentDriver] failed to load turn checkpoint for session ${sessionId}: ${err}`);
			return undefined;
		}
	}

	/** 在 turn 执行中把快照落盘到 workspace storage（sink 抛错仅记日志，不阻断执行）。 */
	private _saveTurnCheckpoint(sessionId: string, snapshot: AgentRunStateSnapshot): void {
		try {
			this._storageService.store(
				this._turnCheckpointKey(sessionId),
				JSON.stringify(snapshot),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
		} catch (err) {
			this._logService.warn(`[AgentDriver] failed to save turn checkpoint for session ${sessionId}: ${err}`);
		}
	}

	/**
	 * 清除 turn checkpoint — turn 成功完成后调用，防止下一个用户消息
	 * 错误地从上一个 turn 的 checkpoint 恢复（budget/loopMessages/preExploreDone）。
	 *
	 * checkpoint 仅用于崩溃恢复（程序重启时续跑未完成的 turn），不应跨用户消息复用。
	 */
	private _clearTurnCheckpoint(sessionId: string): void {
		try {
			this._storageService.remove(this._turnCheckpointKey(sessionId), StorageScope.WORKSPACE);
			this._logService.info(`[AgentDriver] Cleared turn checkpoint for session ${sessionId} (turn completed)`);
		} catch (err) {
			this._logService.warn(`[AgentDriver] failed to clear turn checkpoint for session ${sessionId}: ${err}`);
		}
	}

	// ─── 统一执行入口 ─────────────────────────────────────

	async *executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		const turnId = request.sessionId ? `${request.sessionId}::${request.agentId}` : request.agentId;
		this.cancelTurn(turnId);

		// 并发限流 + 排队期间可取消（signal-aware acquire）
		const controller = new AbortController();
		this._activeTurns.set(turnId, controller);
		try {
			await this._turnSemaphore.acquire(controller.signal);
		} catch (err) {
			this._activeTurns.delete(turnId);
			this._logService.info(`[AgentDriver] Turn ${turnId} cancelled while queued`);
			return;
		}
		this._turnHoldsSemaphore.add(turnId);

		// 提升到 try 外供 finally 使用
		let memoryProvider = this._agentOS.getActiveMemoryProvider();
		const assistantChunks: string[] = [];
		// rawDeltaChunks 累积剥离前的原始输出（含 <memory_extract> 标签），供 memory provider 端做标签剥离
		const rawDeltaChunks: string[] = [];
		let originalBindingWorktreePath: string | undefined;
		let didTemporarilyOverride = false;
		let resolvedMemoryScope: 'agent' | 'global' = 'agent';

	try {
		this._updateTurnStatus(turnId, AgentTurnStatus.Running);
		this._logService.info(`[AgentDriver] executeTurn START: agentId=${request.agentId}, sessionId=${request.sessionId ?? 'none'}, messages=${request.messages.length}, turnId=${turnId}`);

		// ── 工作流模式：/workflow <id>（/wf、bare /{wf-xxx}）触发 ──
		// 控制权从自由 LLM 循环移交给工作流 DAG：跳过 Memory/Prompt 组装，
		// 直接由 WorkflowExecutionService 按节点配置严格执行，工作流结束即 turn 结束。
		if (request.workflowTrigger) {
			this._logService.info(`[AgentDriver] workflow mode: triggering ${request.workflowTrigger.workflowId}`);
			yield* this._executeWorkflowTurn(request, request.workflowTrigger, controller);
			return;
		}

	// ── 编排流程：① Memory scope 解析 → ② Prompt 分层组装 → ③ AgentOS 执行 → ④ Memory 写回 ──

	// ① 解析召回作用域（2026-07-25 修正：移除此处每轮的 loadContext 调用——
	//   其结果从未被消费（真正的注入在下游 agentMemoryInjection 进行），
	//   且不受 AGENTMEMORY_INJECT_CONTEXT 门控，每轮白付一次网关混合搜索
	//   + 策展组装。scope 解析保留，经 memoryScope 传给下游。）
	if (memoryProvider) {
			try {
			let recallOptions: { scope: 'agent' | 'global' } | undefined;
			try {
				this._logService.info(`[AgentDriver] Step 1a: resolving workspaceId (sessionId=${request.sessionId ?? 'none'})`);
				const wsId = await this._resolveWorkspaceId(request.sessionId);
				this._logService.info(`[AgentDriver] Step 1a: resolved workspaceId=${wsId ?? 'none'}`);
				this._logService.info(`[AgentDriver] Step 1b: getting agent binding (agentId=${request.agentId})`);
				const binding = wsId
					? await this._agentStudioService.getAgentBinding(wsId, request.agentId)
					: undefined;
				this._logService.info(`[AgentDriver] Step 1b: got binding=${binding ? 'yes' : 'no'}`);
				const scope: 'agent' | 'global' = binding?.memoryConfig?.scope ?? 'agent';

				if (scope === 'global') {
					recallOptions = { scope: 'global' };
				} else {
					recallOptions = { scope: 'agent' };
				}
			} catch (scopeErr) {
				// 解析失败按最严格策略兜底
				this._logService.warn(
					`[AgentDriver] resolve memory scope failed, falling back to 'agent': ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`,
				);
				recallOptions = { scope: 'agent' };
			}

			resolvedMemoryScope = recallOptions.scope;
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve memory scope:', error);
			}
		}

	// ② Prompt 分层组装（stable / context / volatile）
	const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
	let enrichedRequest = request;
	this._logService.info(`[AgentDriver] Step 2: enriching request (memoryScope=${resolvedMemoryScope})`);

			try {
				// 生成已安装技能清单（仅 name + description，全文通过 read_skill 按需读取）
				const agent = await this._agentStudioService.getAgent(request.agentId);
				const personaBinding = await this._resolveBinding(request.agentId, request.sessionId);

				// 规范化 skills 格式：兼容旧格式（对象数组）和新格式（字符串数组）
				const rawSkills = agent?.skills || [];
				const agentSkillIds = new Set(
					rawSkills.map(s => {
						if (typeof s === 'string') {
							return s;
						} else if (s && typeof s === 'object' && 'id' in s) {
							return (s as { id: string }).id;
						}
						return '';
					}).filter(Boolean)
				);

				// 加入用户通过 /skill 显式选择的技能
				const explicitSkillIds = request.explicitSkillIds || [];
				const newExplicitIds: string[] = [];
				for (const id of explicitSkillIds) {
					if (agentSkillIds.has(id)) {
						this._logService.info(`[AgentDriver] Skill '${id}' already in agent config, skipping duplicate`);
					} else {
						agentSkillIds.add(id);
						newExplicitIds.push(id);
					}
				}
				if (newExplicitIds.length > 0) {
					this._logService.info(`[AgentDriver] Explicit skills added for this turn: ${newExplicitIds.join(', ')}`);
				}

				// allSkills = 所有已注册且启用的技能（展示在 <available_skills> 中）
				const allSkills = [...this._skillRegistry.getSkills()]
					.filter(s => s.enabled !== false);

			// ── 分层组装系统提示词（stable / context / volatile）────
			const stableParts: string[] = [];
			const contextParts: string[] = [];
			const volatileParts: string[] = [];

			// ── 冻结前缀的命名段清单（仅供 [PromptBudget] 预算表按段归因）──────────
			// 只登记 stable + context（= 冻结前缀）的段；volatile 是独立 system 消息，
			// 由 promptBudget.classifySystemSegment 按内容分类，**不得**登记到这里，
			// 否则前缀残差行会被算成负数。
			const promptSegments: Array<{ name: string; text: string }> = [];
			/**
			 * 登记一段系统提示词：同时进入实际拼接桶与诊断用命名段清单。
			 * ⚠ 新增前缀内容请用它而不是裸 `push` —— 裸 push 的内容仍会计入总量，
			 * 但在预算表里落到 `system:frozen/(unattributed)` 残差行、失去归因。
			 */
			const pushSeg = (bucket: string[], name: string, text: string): void => {
				if (!text) { return; }
				bucket.push(text);
				promptSegments.push({ name, text });
			};

			// stable 基底：Agent persona + caller systemPrompt
			const callerSystemPrompt = (request.systemPrompt || '').trim();
			const agentSelfPrompt = typeof agent?.systemPrompt === 'string' ? agent.systemPrompt.trim() : '';
			if (agentSelfPrompt) {
				pushSeg(stableParts, 'agent-persona', agentSelfPrompt);
			}
			if (callerSystemPrompt) {
				pushSeg(stableParts, 'caller-prompt', callerSystemPrompt);
			}

			// GLOBAL_SYSTEM_PREFIX（并行走 subagent + 行号剥离 + code_explorer + search_graph_priority）
			if (GLOBAL_SYSTEM_PREFIX) {
				pushSeg(stableParts, 'global-prefix', GLOBAL_SYSTEM_PREFIX);
			}

			// 策略提示词（按 paradigm 注入：执行模型 + 推荐工具链）
			// 解析链与主循环一致：运行时覆盖（switch_paradigm）> Agent 配置 ——
			// 必须同步切换，否则提示词说范式 A 而策略行为是范式 B（错配风险 R4）。
			const strategyGuidance = getStrategyGuidance(getParadigmOverride(request.agentId) ?? agent?.paradigm);
			if (strategyGuidance.length > 0) {
				pushSeg(stableParts, 'strategy-guidance', strategyGuidance.join('\n'));
			}

		// GLOBAL_SYSTEM_SUFFIX（保密 / 安全 / 身份边界）
		if (GLOBAL_SYSTEM_SUFFIX) {
			pushSeg(stableParts, 'global-suffix', GLOBAL_SYSTEM_SUFFIX);
		}

		// ── 回答语言限制（全局边界规则，stable 层）──
		// 完全由 Agent Studio 设置决定，不探测操作系统语言。'auto' 跟随
		// sessions.agentStudio.preferences.language（langSetting，默认 zh-CN）；
		// 子代理经 forkContext 继承本 prompt，或由 taskOrchestrationService 注入
		// dispatch 字段后由 _buildSystemPrompt 重新生成，保证语言一致性（Hermes 风格）。
		try {
			const responseLang = this._configurationService.getValue<string>(AGENT_STUDIO_RESPONSE_LANGUAGE_SETTING);
			// 'auto' 跟随 Agent Studio 显示语言设置（sessions.agentStudio.preferences.language，默认 zh-CN），
			// 完全由设置决定，不探测操作系统语言（navigator.languages / platform.language）。
			const langSetting = this._configurationService.getValue<string>(AGENT_STUDIO_LANGUAGE_SETTING) || 'zh-CN';
			const langDirective = buildResponseLanguageDirective(responseLang, langSetting);
			if (langDirective) {
				pushSeg(stableParts, 'response-language', langDirective);
			}
		} catch (error) {
			this._logService.warn('[AgentDriver] Failed to inject response language directive:', error);
		}

		// ── 运行环境（OS / Shell，stable 层）──
		// 2026-08-09：此前仅 user_info 标签带 OS 信息（贴在 user message 上），
		// system prompt 层无平台信息 → 模型在 Windows 上反复写 Unix 语法
		// （dir ... | head -50，日志 1786264843850）。这里注入 system prompt 层，
		// 模型每轮决策时都可见。子代理经继承自动获得。
		try {
			const envDirective = buildEnvironmentDirective();
			if (envDirective) {
				pushSeg(stableParts, 'environment', envDirective);
			}
		} catch (error) {
			this._logService.warn('[AgentDriver] Failed to inject environment directive:', error);
		}

			// ── Persona Memory（用户硬事实，volatile 层）──
			// 与 L0/L1 自动召回互补：用户显式设定、永不衰减。
			// 放 volatile 层保持高优先级但不进前缀指纹。
			// 注入门控：对齐 agentmemory 原版「capture 常开、注入默认关」姿态 ——
			// 仅当 AGENTMEMORY_INJECT_CONTEXT=true 时注入；默认关闭时
			// Persona 事实可通过 memory_search/memory_recall 工具按需召回。
			if (isMemoryInjectionEnabled()) try {
					const personaEntries = (personaBinding?.memoryConfig?.enabled !== false)
						? (personaBinding?.memoryConfig?.entries || [])
						: [];
					if (personaEntries.length > 0) {
						// V4（2026-07-26 §16）：Persona 预算——按 updatedAt 降序保留，
						// 超 2000 chars 截断（防 Persona 无限增长撑大 volatile 层）。
						const PERSONA_MAX_CHARS = 2000;
						const sorted = [...personaEntries].sort((a, b) =>
							String((b as { updatedAt?: string }).updatedAt ?? '').localeCompare(String((a as { updatedAt?: string }).updatedAt ?? '')));
						const budgeted: typeof personaEntries = [];
						let usedChars = 160; // header/footer 预留
						let truncatedCount = 0;
						for (const e of sorted) {
							const lineLen = String(e.key ?? '').length + String(e.value ?? '').length + 8;
							if (usedChars + lineLen > PERSONA_MAX_CHARS) { truncatedCount++; continue; }
							usedChars += lineLen;
							budgeted.push(e);
						}
						const lines: string[] = [
							'',
							'## Persona Memory (永久事实，最高优先级)',
							'',
							'以下是用户显式设定的硬性事实与规则。在整个对话中，你必须始终把它们当作既定真相对待，优先于其他上下文：',
							'',
						];
						const grouped = new Map<string, typeof personaEntries>();
						for (const entry of budgeted) {
							const cat = (entry.category && entry.category.trim()) || '通用';
							if (!grouped.has(cat)) {
								grouped.set(cat, []);
							}
							grouped.get(cat)!.push(entry);
						}
						for (const [cat, items] of grouped) {
							lines.push(`### ${cat}`);
							for (const item of items) {
								lines.push(`- **${item.key}** = ${item.value}`);
							}
							lines.push('');
						}
						lines.push('（以上事实由用户在 Persona Memory 中显式维护，永不衰减；如与你的默认假设冲突，以这些事实为准。）');
						if (truncatedCount > 0) {
							lines.push(`（另有 ${truncatedCount} 条 Persona 事实因注入预算未展示，可用 memory_search 工具召回。）`);
						}
						lines.push('');
					const personaSection = lines.join('\n');
					volatileParts.push(personaSection);
					this._logService.info(`[AgentDriver] Injected Persona Memory: ${budgeted.length}/${personaEntries.length} entries (${personaSection.length} chars) into volatile tier`);
					}
				} catch (error) {
					this._logService.warn('[AgentDriver] Failed to inject Persona Memory:', error);
				}

			// 注入工作区上下文，让模型始终知晓当前工作区信息（context 层，会话内稳定）
			const workspaceContext = await this._buildWorkspaceContext(request.agentId, request.sessionId, request.worktreePath);
			if (workspaceContext) {
				pushSeg(contextParts, 'workspace', workspaceContext);
			}

				// ── 临时覆盖 AgentBinding.worktreePath（per-task 优先）──
			if (request.worktreePath) {
				try {
					const workspaceId = await this._resolveWorkspaceId(request.sessionId);
					if (workspaceId) {
						// ── 加锁：防止同 workspace 同 agent 的并发 turn 互相覆盖 ──
						const bLock = this._getBindingLock(workspaceId, request.agentId);
						await bLock.acquire();
						try {
							const binding = await this._resolveBinding(request.agentId, request.sessionId);
							originalBindingWorktreePath = binding?.worktreePath;
							if (binding && originalBindingWorktreePath !== request.worktreePath) {
						didTemporarilyOverride = true;
						await this._agentStudioService.upsertAgentBinding(
							workspaceId,
							request.agentId,
							{
								worktreePath: request.worktreePath,
								// 记录临时覆盖标记：进程崩溃/重启后，启动自愈可据此恢复原始 worktreePath。
								// 仅 task 执行期由本处写入；普通用户设置 worktreePath 不写此标记。
								tempWorktreeOverride: {
									originalWorktreePath: originalBindingWorktreePath,
									owner: turnId,
									timestamp: Date.now(),
								},
							},
						);
								this._logService.info(`[AgentDriver] Temporarily set binding.worktreePath="${request.worktreePath}" for task execution`);
							} else {
								originalBindingWorktreePath = undefined; // 无需恢复
							}
						} finally {
							bLock.release();
						}
						}
					} catch (err) {
						this._logService.warn('[AgentDriver] Failed to temporarily set binding worktreePath:', err);
						originalBindingWorktreePath = undefined;
					}
				}

		if (allSkills.length > 0) {
				// Phase 1+2: 不再将 skill catalog 注入 system prompt。
				// 对齐 MiMo-Code (OpenCode)：system prompt 只保留使用说明，
				// skill 发现通过 skill_search (BM25)，skill 加载通过 read_skill。
				const skillsInstruction = [
					'', '## Skills', '',
					'Skills provide specialized instructions and workflows for specific tasks.',
					'On the first user query in a session, when the task might benefit from a specialized workflow, call `skill_search` to find the best matching skill.',
					'If skill_search returns a match, use `read_skill` with the skill_id to load its full instructions, then follow them.',
					'If no match, continue normally without a skill.',
					'Skills tagged <type>workflow</type> are EXECUTABLE skills: triggering them runs a workflow (use /skill <id>), they are NOT prompt-injection skills — do not load their content as instructions via read_skill.',
					'One skill at a time max. Never guess/fabricate skill content.',
					'',
				].join('\n');
				pushSeg(contextParts, 'skills', skillsInstruction);
			}

				// 3a-1b. 注入 MCP 服务器摘要（让 LLM 知道有哪些 MCP 能力可用，通过桥接工具访问）
				{
					const servers = this._mcpService.servers.get();
					const runningServers = servers.filter(s => {
						const conn = s.connectionState.get();
						return conn.state === McpConnectionState.Kind.Running;
					});
					if (runningServers.length > 0) {
						const serverLines = runningServers.map(s => {
							const label = s.definition.label;
							const toolCount = s.tools.get().length;
							// 取第一个工具的描述首句作为服务器能力摘要
							const tools = s.tools.get();
							const firstDesc = tools.length > 0 ? (tools[0].definition.description || '') : '';
							const summary = firstDesc.slice(0, 80);
							return `  - ${label}: ${toolCount} tool(s)${summary ? `. ${summary}` : ''}`;
						});
						// MCP 工具通过统一的 tool_search → tool_describe → tool_call 路径按需发现
						const mcpSection = [
							'',
							'## MCP Servers',
							'',
							'MCP tools are discovered via tool_search, not listed here. Use tool_search with descriptive ' +
							'keywords to find tools, tool_describe to inspect them, and tool_call to invoke.',
							'',
						'Servers available:',
						...serverLines,
						'',
					].join('\n');
					pushSeg(contextParts, 'mcp', mcpSection);
				}
			}

				// 3a-2. 注入已启用工具的使用指引（Knot provider 跳过：服务端处理工具）
				const activeModelSelection = this._agentOS.getActiveModelSelection();
				const isKnotProvider = activeModelSelection?.providerId.includes('knot');
				// 模型族：决定工具调用格式指令的措辞（真源 common/modelFamilyPrompt.ts）。
				// 沿用与 isKnotProvider 相同的前提（都基于 activeModelSelection）。
				const promptModelFamily = detectModelFamily(activeModelSelection?.modelId);

			// 缓存 key 必须纳入 focus/toolset/hardPermission 等过滤条件的签名——否则同一 agent
			// 在不同 workMode（plan/work）、不同 toolsetsOverride、不同 excludedTools/allowedTools
			// 下会复用错误的旧文字清单，与本轮真实下发的工具 schema 脱节。
			// ⚠ 2026-08-22 起**必须**再纳入 promptModelFamily：工具段的格式指令按族分发，
			// 不纳入会让「切换模型」命中上一个模型族的缓存段（例如从 claude 切到 generic
			// 模型后仍拿不到 JSON 退路说明），且因前缀字节不变而完全无从察觉。
			const toolFilterSignature = JSON.stringify({
				g: request.agentGraph ? Object.keys(request.agentGraph.nodes).length : 0,
				t: request.toolsetsOverride ?? null,
				h: request.workMode ?? request.chatMode ?? null,
				e: request.excludedTools ?? null,
				a: request.allowedTools ?? null,
				f: promptModelFamily,
			});
			const toolCacheKey = `tools:${request.agentId}:${toolFilterSignature}`;
		const cachedToolSection = this._toolInventoryCache.get(toolCacheKey);
		if (cachedToolSection !== undefined) {
			pushSeg(stableParts, 'tool-section', cachedToolSection);
			this._logService.info(`[AgentDriver] Tool inventory CACHE HIT (key=${toolCacheKey})`);
			} else if (!isKnotProvider) {
				try {
					// P0 修复：改用 getEnabledToolNamesForPrompt（focus 模式 + toolset 白名单 +
					// hardPermission 过滤后的结果），而非 listAllToolsWithState 的全量 enabled 工具。
					// 后者会导致提示词文字点名了实际未随请求下发 schema 的工具（如 kanban_*/kb_*/
					// echo/get_time 等被 focus 模式剪掉的工具），模型据此调用必然失败或产生幻觉。
					const nonMcpToolNames = await this._agentOS.getEnabledToolNamesForPrompt(
						request.agentId,
						request.agentGraph,
						request.toolsetsOverride,
						this._agentOS._resolveHardPermission(request),
						request.excludedTools,
						request.allowedTools,
					);
					this._logService.info(`[AgentDriver] Tool inventory (prompt-visible, non-MCP): ${nonMcpToolNames.length}`);

			if (nonMcpToolNames.length > 0) {
				// P0：工具清单只保留压缩后的「名称清单」（结构化 schema 已随请求下发）
				const toolSectionStr = buildCompactToolSection(nonMcpToolNames, promptModelFamily);
				pushSeg(stableParts, 'tool-section', toolSectionStr);
				this._toolInventoryCache.set(toolCacheKey, toolSectionStr);
				this._logService.info(`[AgentDriver] Injected compact tool section (${nonMcpToolNames.length} enabled, names-only, family=${promptModelFamily}) into stable tier`);
			}
				} catch (error) {
					this._logService.warn('[AgentDriver] Failed to inject tool inventory:', error);
				}
			} else if (cachedToolSection === undefined) {
				this._logService.info(`[AgentDriver] Skipped Available Tools injection (Knot provider detected: ${activeModelSelection?.providerId})`);
			}

				// 3b. 解析本轮激活的技能内容并注入
				let mergedMessages = [...request.messages];

				if (lastUserMessage) {
					const injections = await this._skillRegistry.resolveActivations({
						userMessage: lastUserMessage.content,
						agentId: request.agentId,
						sessionId: request.sessionId,
						explicit: explicitSkillIds,
						// 强制加载全文：仅 agent 配置中指定的技能（不依赖 activation 关键词匹配）
						required: [...agentSkillIds],
					});

					// 不按 agentSkillIds 过滤 —— 所有技能均可通过 activation 关键词匹配
					// 或 <available_skills> 目录被 LLM 发现。agentSkillIds 仅决定 required（强制加载）。
				const filteredInjections = injections;

				// ── P1: 工作流型（可执行型）skill 触发 ──
				// workflow skill 默认 manual，仅当用户显式 `/skill <id>` 时触发执行；
				// required/always 命中的 workflow skill 不自动执行重型工作流，仅作为
				// 描述文本注入（降级为文本型），避免每个 turn 误触发多 agent 流程。
				const explicitSet = new Set((explicitSkillIds ?? []).map(s => s.toLowerCase()));
				const triggeredWorkflowIds = new Set<string>();
				for (const inj of filteredInjections) {
					if (inj.executor?.kind === 'workflow' && explicitSet.has(inj.skill.id.toLowerCase())) {
						const wfId = inj.executor.workflowId;
						this._logService.info(`[AgentDriver] workflow skill triggered (explicit): ${inj.skill.id} → wf=${wfId}`);
						void this._triggerWorkflowSkill(wfId, lastUserMessage?.content, inj.skill.name);
						triggeredWorkflowIds.add(inj.skill.id);
					}
				}

				if (filteredInjections.length > 0) {
				// 渐进披露（Phase 1）：所有激活技能统一作为独立 user message 注入，
				// 不再内联 system prompt。已触发执行的 workflow skill 不注入 prompt 文本。
				const userInjections = filteredInjections.filter(inj => !triggeredWorkflowIds.has(inj.skill.id));
					// 已触发的 workflow skill 收集回执消息（独立数组，避免污染 ISkillInjection[] 类型）
					const workflowReceipts: Array<{ role: 'user'; content: string }> = [];
					if (triggeredWorkflowIds.size > 0) {
						for (const id of triggeredWorkflowIds) {
							const inj = filteredInjections.find(i => i.skill.id === id);
							if (inj) {
								workflowReceipts.push({
									role: 'user' as const,
									content: `[Workflow Skill] 已为你启动工作流「${inj.skill.name}」(id=${id})。执行过程在其专属 Agent 会话中展示，完成后会以消息形式回灌。`,
								});
							}
						}
					}

					// 将激活技能注入插入为 synthetic user message（在实际用户消息之前，sidecar='skill'）
						if (userInjections.length > 0 || workflowReceipts.length > 0) {
						const skillMessages: Array<{ role: 'user'; content: string; synthetic?: boolean; sidecar?: 'skill' }> = userInjections.map(inj => ({
							role: 'user' as const,
							content: inj.content,
							// sidecar 标记：auto/explicit 命中的技能激活块（非用户真实输入），
							// 压缩与持久化前剥离，避免污染干净 transcript（对齐 MiMo synthetic:true）。
							synthetic: true,
							sidecar: 'skill' as const,
						}));
							if (workflowReceipts.length > 0) {
								skillMessages.push(...workflowReceipts);
							}
							// 插入到最后一条用户消息之前
							const lastIdx = mergedMessages.length - 1;
							mergedMessages = [
								...mergedMessages.slice(0, lastIdx),
								...skillMessages,
								mergedMessages[lastIdx],
							];
						}

					const allInjectedSkillIds = filteredInjections.map(i => i.skill.id);
					this._logService.info(`[AgentDriver] Injected ${filteredInjections.length} skills (user: ${userInjections.length}): ${allInjectedSkillIds.join(', ')}`);
					}
				}

			// ── Memory Extract 提示与 Knot user 补丁已移除（2026-07-25）──
			// 对齐 agentmemory 原版「capture 常开、注入默认关、召回走工具」姿态：
			// 原版 prompt 中没有任何每轮记忆指令（capture 靠 PostToolUse 钩子自动
			// 完成 + remember 工具显式写入）。本项目的等价通道全部保留且默认开启：
			//   - turn observations（每轮自动写入 mem:obs 暂存层）
			//   - session_end 链（compressSession→slotReflect→graphExtract，引擎侧自动）
			//   - memory_remember 工具（LLM 显式写入）
			// （2026-07-26：L1/L2/L3 客户端抽取管线已移除，提炼语义归引擎 session_end 链）
			// <memory_extract> 标签的流式剥离代码保留作为被动安全网（模型若从
			// 训练习惯中自行输出该标签，仍会被捕获而不泄漏到正文）。
			// 收益：冻结前缀每轮减少 ~1.5KB 指令文本，且消除 Knot 模型对
			// user 消息的注入式污染。

			// 解析 memoryConfig 策略 / 上限，向下游 AgentOS 传递。
				// B 方案兼容：当 messages 含历史时强制 'summary'，避免 L0 与历史重复。
				const rawStrategy = personaBinding?.memoryConfig?.strategy;
				const hasHistoryInMessages = mergedMessages.length > 1;
				const memoryStrategy: 'summary' | 'full' =
					hasHistoryInMessages ? 'summary'
						: rawStrategy === 'summary' ? 'summary' : 'full';
				if (hasHistoryInMessages && rawStrategy !== 'summary') {
					this._logService.info(
						`[AgentDriver] B-plan override: memoryStrategy forced to 'summary' ` +
						`(messages=${mergedMessages.length}, L0 would duplicate history)`,
					);
				}
				const memoryMaxEntries = (
					typeof personaBinding?.memoryConfig?.maxEntries === 'number' &&
					personaBinding.memoryConfig.maxEntries > 0
				) ? personaBinding.memoryConfig.maxEntries : undefined;

			// ── 合成冻结前缀（stable+context）与易变层（volatile）────────────
			// 冻结前缀作为第一条 system 消息 + fork 前缀指纹对象（保持字节稳定 → 缓存命中）；
			// volatile 作为独立 system 消息由 executor 追加在前缀之后，不进前缀指纹。
			const promptTiers: ISystemPromptTiers = {
				stable: joinSections(...stableParts),
				context: joinSections(...contextParts),
				volatile: joinSections(...volatileParts),
			};
			const frozenPrefix = composeFrozenPrefix(promptTiers);
			const volatileMessage = composeVolatileMessage(promptTiers);

			enrichedRequest = {
				...request,
				systemPrompt: frozenPrefix,
				systemPromptVolatile: volatileMessage,
				// 命名段明细随请求下发，供 executor 在请求发出点打 [PromptBudget] 预算表。
				// 纯诊断数据：不进前缀指纹、不参与任何行为判定。
				promptSegments,
				messages: mergedMessages,
				memoryStrategy,
				memoryMaxEntries,
				memoryScope: resolvedMemoryScope,
				paradigm: agent?.paradigm,        // AgentLoop 范式（来自 Agent 配置）
				budgetMaxTotal: agent?.budgetMaxTotal,  // 每 turn 最大预算
			};

		this._logService.info(
			`[AgentDriver] Tiered prompt: stable=${promptTiers.stable.length} chars, ` +
			`context=${promptTiers.context.length} chars, volatile=${promptTiers.volatile.length} chars, ` +
			`frozenPrefix=${frozenPrefix.length} chars (${allSkills.length} skills catalog)`
		);

			// ── [PromptFingerprint] 前缀漂移归因（2026-08-22）─────────────────────
			// 上面那条只有 chars —— 前缀缓存断裂时无法回答「断在 stable 还是 context、
			// 哪一段变的」。这里按层 + 按命名段取指纹并与**上一轮同会话**对比：
			//   · frozenChanged=true → 本轮 provider 前缀缓存必然 MISS（warn 级）；
			//   · volatile 变化单独说明（不进前缀指纹，属预期，不该被当故障排查）；
			//   · unexplained → 冻结前缀变了但所有登记段全等 = 变化来自未登记内容
			//     （裸 *Parts.push、层拼接顺序、driver 之外的追加），最需要警惕。
			// 会话级基线：按 sessionId 存快照，key 缺失时退化为「只打基线不比对」。
			try {
				const snap = snapshotPromptPrefix({
					stable: promptTiers.stable,
					context: promptTiers.context,
					volatile: promptTiers.volatile,
					segments: promptSegments,
				});
				const fpKey = request.sessionId || `agent:${request.agentId}`;
				const prevSnap = this._lastPrefixSnapshot.get(fpKey);
				const delta = diffPromptPrefix(prevSnap, snap);
				const fpLog = formatPromptPrefixLog(snap, delta, prevSnap ? `session=${fpKey}` : `session=${fpKey} (baseline)`);
				if (fpLog.level === 'warn') {
					this._logService.warn(fpLog.text);
				} else {
					this._logService.info(fpLog.text);
				}
				// LRU 上限防长进程无限增长（与 _injectedSessions 同一姿态）。
				if (this._lastPrefixSnapshot.size > 64 && !this._lastPrefixSnapshot.has(fpKey)) {
					const oldest = this._lastPrefixSnapshot.keys().next().value;
					if (oldest !== undefined) { this._lastPrefixSnapshot.delete(oldest); }
				}
				this._lastPrefixSnapshot.set(fpKey, snap);
			} catch (fpError) {
				// 诊断失败绝不阻断 turn
				this._logService.warn('[PromptFingerprint] snapshot failed:', fpError);
			}
			this._logService.info(`[AgentDriver] frozenPrefix preview: ${frozenPrefix.substring(0, 300)}...`);
			this._logService.info(`[AgentDriver] Memory injection policy: strategy=${memoryStrategy}, maxEntries=${memoryMaxEntries ?? 'unlimited'}, scope=${resolvedMemoryScope} (raw=${rawStrategy ?? 'undefined'})`);
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve skill activations:', error);
				// Skill 解析失败不阻塞主流程
			}

		// ③ 委托 AgentOS 执行（累积 assistant 文本供 ④ 写回记忆）
		// checkpoint/resume：sessionId 存在时接 workspace storage（崩溃恢复用）
		let graphRequest = enrichedRequest;
		if (enrichedRequest.sessionId) {
			const sid = enrichedRequest.sessionId;
			graphRequest = {
				...enrichedRequest,
				resumeFrom: enrichedRequest.resumeFrom ?? this._loadTurnCheckpoint(sid),
				checkpointSink: enrichedRequest.checkpointSink ?? ((snapshot: AgentRunStateSnapshot) => this._saveTurnCheckpoint(sid, snapshot)),
			};
		}
		this._logService.info(`[AgentDriver] Step 4: delegating to AgentOS (enrichedMsgs=${graphRequest.messages.length})`);
		const osStream = this._agentOS.executeAgentTurn(graphRequest);

			// ── 流式记忆标签剥离（支持 <memory_extract> 和 [MEMORY:] 两种格式）──
			let tagBuffer = '';
			let tagOpenLogged = false; // 防止 "awaiting close" 日志在每个 delta 重复刷屏
			/** 收集本次 processTextChunk 调用中捕获的记忆标签，供主循环 yield memory_extracted 事件 */
			const capturedMemoryTags: Array<{ content: string; type?: string; priority?: number; sceneName?: string; raw: string }> = [];
			// 注意：rawDeltaChunks 已提升到 try 外层声明，此处仅引用并清空（防止跨轮残留）。
			rawDeltaChunks.length = 0;
			// 两种格式的开头标记（取最短公共前缀用于快速判断）
			const TAG_OPENS = ['<memory_extract>', '[MEMORY:'];
			const TAG_CLOSES: Record<string, string> = {
				'<memory_extract>': '</memory_extract>',
				'[MEMORY:': '[/MEMORY]',
			};

			const flushTagBuffer = (): string => {
				// 缓冲区里没有完整标签，把内容当普通文本返回
				const result = tagBuffer;
				tagBuffer = '';
				tagOpenLogged = false;
				return result;
			};

			/**
			 * 处理一段文本：剥离其中的记忆标签，返回干净文本。
			 * 支持 <memory_extract>...</memory_extract> 和 [MEMORY:...][/MEMORY] 两种格式。
			 * 跨 delta 的标签通过 tagBuffer 缓冲处理。
			 */
			const processTextChunk = (chunk: string): string => {
				let output = '';
				let remaining = tagBuffer + chunk;
				tagBuffer = '';

				while (remaining.length > 0) {
					// 找到最早出现的标签开头
					let earliestOpenIdx = -1;
					let matchedOpen = '';
					for (const tagOpen of TAG_OPENS) {
						const idx = remaining.indexOf(tagOpen);
						if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
							earliestOpenIdx = idx;
							matchedOpen = tagOpen;
						}
					}

					if (earliestOpenIdx === -1) {
						// 没有标签开头，但末尾可能是某个标签的前缀（如 "<memo" 或 "[MEM"）
						let prefixLen = 0;
						for (const tagOpen of TAG_OPENS) {
							for (let i = tagOpen.length - 1; i >= 1; i--) {
								if (remaining.endsWith(tagOpen.slice(0, i))) {
									if (i > prefixLen) { prefixLen = i; }
									break;
								}
							}
						}
						if (prefixLen > 0) {
							// 末尾是潜在标签前缀，缓冲起来等待下一个 delta
							output += remaining.slice(0, remaining.length - prefixLen);
							tagBuffer = remaining.slice(remaining.length - prefixLen);
						} else {
							output += remaining;
						}
						remaining = '';
					} else {
						// 找到标签开头
						output += remaining.slice(0, earliestOpenIdx);
						remaining = remaining.slice(earliestOpenIdx);

						const tagClose = TAG_CLOSES[matchedOpen];
						const closeIdx = remaining.indexOf(tagClose);
						if (closeIdx === -1) {
							// 标签未闭合，缓冲等待后续 delta
							// 但先检查：内容是否看起来像真正的标签（JSON 开头）
							const afterTag = remaining.slice(matchedOpen.length).trimStart();
							const MAX_BUFFER = 5000; // 安全阀：缓冲区超过此大小则按普通文本处理

							if (matchedOpen === '<memory_extract>' && afterTag.length > 5 && !afterTag.startsWith('{')) {
								// 内容不是 JSON 开头 → 模型只是在文档/讨论中提到了标签名，不是真正的记忆标签
								// 当作普通文本输出，不缓冲
								output += remaining;
								remaining = '';
							} else if (remaining.length > MAX_BUFFER) {
								// 缓冲区过大，可能是模型输出了未闭合的标签 → 当作普通文本
								output += remaining;
								remaining = '';
							} else {
								// 真正的标签等待闭合 — 仅记录一次日志（避免每个 delta 刷屏）
								if (!tagOpenLogged) {
									tagOpenLogged = true;
									const seenOpenMsg = `[AgentDriver] ⏳ Memory tag open detected, awaiting close (open="${matchedOpen}", bufferedLen=${remaining.length}, preview="${remaining.replace(/\s+/g, ' ').slice(0, 200)}")`;
									this._logService.info(seenOpenMsg);
								}
								tagBuffer = remaining;
								remaining = '';
							}
						} else {
							// 找到完整标签，剥离它（不输出给用户）
							const fullTag = remaining.slice(0, closeIdx + tagClose.length);
							// 解析记忆数据，推入 capturedMemoryTags 供主循环 yield
							const tagContent = remaining.slice(matchedOpen.length, closeIdx).trim();
							let parsed: { content?: string; type?: string; priority?: number; scene_name?: string } | null = null;
							if (matchedOpen === '<memory_extract>') {
								try { parsed = JSON.parse(tagContent); } catch { /* noop */ }
							}
							capturedMemoryTags.push({
								content: parsed?.content ?? tagContent,
								type: parsed?.type,
								priority: parsed?.priority,
								sceneName: parsed?.scene_name,
								raw: fullTag,
							});
							const diagMsg = `[AgentDriver] 🧠 Captured memory tag (open="${matchedOpen}", len=${fullTag.length}): ${fullTag.replace(/\s+/g, ' ').slice(0, 300)}`;
							this._logService.info(diagMsg);
							// 镜像到 DevTools console，便于排查（_logService 默认走 OutputChannel/log 文件，DevTools 不可见）
							try { console.warn(diagMsg); } catch { /* noop */ }
							remaining = remaining.slice(closeIdx + tagClose.length);
							tagOpenLogged = false; // 标签已闭合，重置日志标志供下次使用
						}
					}
				}

				return output;
			};

			for await (const delta of osStream) {
				// 检查取消
				if (controller.signal.aborted) {
					// 刷新缓冲区（未完成的标签当普通文本处理）
					const flushed = flushTagBuffer();
					if (flushed.length > 0) {
						assistantChunks.push(flushed);
					}
					yield { type: 'done' };
					break;
				}

				if (delta.type === 'text' && typeof delta.content === 'string' && delta.content.length > 0) {
					// 【诊断】先累积 raw 文本（剥离前），用于流结束后排查标签输出情况
					rawDeltaChunks.push(delta.content);
					// 流式剥离记忆标签：用户看不到标签，assistantChunks 收集干净文本
					capturedMemoryTags.length = 0;
					const cleanContent = processTextChunk(delta.content);
					if (cleanContent.length > 0) {
						assistantChunks.push(cleanContent);
						yield { ...delta, content: cleanContent };
					}
					// 捕获到记忆标签 → yield memory_extracted 事件供前端渲染卡片
					for (const mem of capturedMemoryTags) {
						yield { type: 'memory_extracted', content: mem.content, metadata: { memoryType: mem.type, priority: mem.priority, sceneName: mem.sceneName } };
					}
					// 如果 cleanContent 为空（整个 delta 都是标签），不 yield
				} else if (delta.type === 'content_replace' && typeof delta.content === 'string') {
					// content_replace：用最新内容覆盖整个 assistant 输出
					// 【诊断】content_replace 模式下也累积 raw（覆盖式）
					rawDeltaChunks.length = 0;
					rawDeltaChunks.push(delta.content);
					// 对完整内容做一次全量剥离
					tagBuffer = '';
					capturedMemoryTags.length = 0;
					const cleanContent = processTextChunk(delta.content) + flushTagBuffer();
					assistantChunks.length = 0;
					assistantChunks.push(cleanContent);
					yield { ...delta, content: cleanContent };
					for (const mem of capturedMemoryTags) {
						yield { type: 'memory_extracted', content: mem.content, metadata: { memoryType: mem.type, priority: mem.priority, sceneName: mem.sceneName } };
					}
			} else if ((delta as any).type === 'discard_prior_text') {
				// Hermes-style 合成恢复信号：upstream 检测到 fake-completion / unfinished-intent，
				// 要求下游完全丢弃刚才的幻觉/过渡文本，防止它进入 memory 和 history 形成对话循环。
					rawDeltaChunks.length = 0;
					assistantChunks.length = 0;
					tagBuffer = '';
					const reason = (delta as any).metadata?.reason ?? 'unknown';
					this._logService.info(
						`[AgentDriver] 🧹 Received discard_prior_text signal (reason=${reason}) — cleared rawDeltaChunks + assistantChunks to prevent conversation rot`,
					);
					// 把信号原样向上游 yield（chatService 同样需要清空 fullContent/fullThinking）
					yield delta;
				} else if (delta.type === 'work_mode_changed' && (delta as any).workMode) {
					// P1: persist WorkMode across turns so the planning/work phase survives turn boundaries.
					const newWorkMode = (delta as any).workMode as 'plan' | 'work';
					this._saveWorkMode(request.sessionId, newWorkMode);
					this._logService.info(`[AgentDriver] WorkMode saved: session=${request.sessionId ?? '(none)'}, mode=${newWorkMode}`);
					yield delta;
				} else if (delta.type === 'done') {

					// 流结束：刷新缓冲区，未完成的标签当普通文本处理
					const flushed = flushTagBuffer();
					if (flushed.length > 0) {
						assistantChunks.push(flushed);
						yield { type: 'text', content: flushed };
					}
					yield delta;
				} else {
					yield delta;
				}
			}

			// 流结束后再次刷新（防止 generator 提前退出时缓冲区有残留）
			const finalFlushed = flushTagBuffer();
			if (finalFlushed.length > 0) {
				assistantChunks.push(finalFlushed);
				// 【诊断】finalFlushed 包含未闭合的标签（如开标签出现但闭合标签没到）
				// 检测开标签字面量是否在最终残留中，以判断是否是被截断的标签。
				if (/<memory_extract>/i.test(finalFlushed) || /\[MEMORY:/i.test(finalFlushed)) {
					const orphanMsg = `[AgentDriver] ⚠️ ORPHAN unfinished memory tag at stream end (len=${finalFlushed.length}): ${finalFlushed.replace(/\s+/g, ' ').slice(0, 400)}`;
					this._logService.warn(orphanMsg);
					try { console.warn(orphanMsg); } catch { /* noop */ }
				}
			}

			// 【诊断】流结束后打印 raw 模型输出的尾部（排查 memory_extract 标签输出）
			try {
				const rawFull = rawDeltaChunks.join('');
				const hasExtractTag = /<memory_extract>/i.test(rawFull);
				const hasLegacyTag = /\[MEMORY:/i.test(rawFull);
				this._logService.info(`[AgentDriver] RAW model output: totalLen=${rawFull.length}, hasMemoryExtractTag=${hasExtractTag}, hasLegacyMemoryTag=${hasLegacyTag}, tail=${JSON.stringify(rawFull.slice(-800))}`);
			} catch (diagErr) {
				this._logService.warn(`[AgentDriver] raw output diagnostic failed: ${(diagErr as Error).message}`);
			}

			this._logService.info(`[AgentDriver] Before _updateTurnStatus(Done)`);
			this._updateTurnStatus(turnId, AgentTurnStatus.Done);
			this._logService.info(`[AgentDriver] After _updateTurnStatus(Done)`);

		} catch (error) {
			this._logService.error(`[AgentDriver] Turn ${turnId} failed:`, error);
			this._updateTurnStatus(turnId, AgentTurnStatus.Error);
			yield {
				type: 'error',
				content: String(error),
			};
		} finally {
			this._activeTurns.delete(turnId);

			// ── 清除 turn checkpoint（防止下一个用户消息从旧 checkpoint 恢复）──
			if (request.sessionId) {
				this._clearTurnCheckpoint(request.sessionId);
			}

			// 释放并发限流名额
			if (this._turnHoldsSemaphore.delete(turnId)) {
				this._turnSemaphore.release();
			}

			this._logService.info(`[AgentDriver] finally block START (turnId=${turnId})`);

			// ── 恢复 AgentBinding.worktreePath（fire-and-forget + 超时保护）──
			// finally 中 await 会阻塞 generator return → 阻塞 consumer for-await 退出。
			if (originalBindingWorktreePath !== undefined) {
				const restoreStart = Date.now();
				void (async () => {
					try {
						// 超时保护：5 秒内未完成则放弃，避免 finally 块永远挂起
						const timeoutPromise = new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error('worktree restore timeout (5s)')), 5000)
						);
						const workspaceId = await Promise.race([
							this._resolveWorkspaceId(request.sessionId),
							timeoutPromise,
						]);
						if (workspaceId) {
							// ── 加锁：恢复写入同样需与并发 turn 互斥 ──
							const bLock = this._getBindingLock(workspaceId, request.agentId);
							await Promise.race([bLock.acquire(), timeoutPromise]);
							try {
								// 防御：仅当 binding 当前仍停留在本次临时覆盖值(= task 的 worktreePath)
								// 时才恢复，避免覆盖并发 turn / 用户在此期间改写的合法 worktreePath。
								const currentBinding = await Promise.race([
									this._agentStudioService.getAgentBinding(workspaceId, request.agentId),
									timeoutPromise,
								]);
								if (didTemporarilyOverride && currentBinding?.worktreePath === request.worktreePath) {
									await Promise.race([
										this._agentStudioService.upsertAgentBinding(
											workspaceId,
											request.agentId,
											{ worktreePath: originalBindingWorktreePath || undefined, tempWorktreeOverride: undefined },
										),
										timeoutPromise,
									]);
									this._logService.info(
										`[AgentDriver] Restored binding.worktreePath="${originalBindingWorktreePath || '(none)'}" ` +
										`after task execution (${Date.now() - restoreStart}ms)`
									);
								} else {
									this._logService.info(
										`[AgentDriver] Skipped worktree restore for ${request.agentId}: ` +
										`binding changed concurrently (current="${currentBinding?.worktreePath ?? '(none)'}", expectedTemp="${request.worktreePath}")`
									);
								}
							} finally {
								bLock.release();
							}
						}
					} catch (err) {
						this._logService.warn(
							`[AgentDriver] Failed to restore binding worktreePath (${Date.now() - restoreStart}ms):`,
							err
						);
					}
				})();
			}

			// ④ 写回记忆（finally 中 fire-and-forget，防止 await 阻塞 generator 退出）
			// 连续写 user + assistant 两条，供 vendor /capture 接口配对。
			if (memoryProvider) {
				const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
				const rawAssistantContent = rawDeltaChunks.join('').trim();
				const cleanedAssistantContent = assistantChunks.join('').trim();
			const assistantContent = rawAssistantContent.length > 0 ? rawAssistantContent : cleanedAssistantContent;

	// W2（2026-07-26 §16 日志实证修复）：turn 级 user/assistant 捕获复用
		// storeTurnObservations（mem:obs 暂存层 + 内容哈希去重）——此前此处每轮
		// writeMemory(type=working)×2 直写长期层，与 storeTurnObservations 完全
		// 重复（§11 分层改造的漏网通道，子代理长任务下洪泛 core memory）。
		// ExecutionProvider 路径的 turn 消息捕获也经此统一覆盖；删除噪音 UI 卡片。
		(async () => {
				try {
					const turnMessages: Array<{ role: string; content: string }> = [];
					if (lastUserMessage) {
						turnMessages.push({ role: 'user', content: lastUserMessage.content });
					}
					if (assistantContent.length > 0) {
						turnMessages.push({ role: 'assistant', content: assistantContent });
					}
					if (turnMessages.length > 0) {
						await this._agentOS._storeTurnObservations(memoryProvider, request.agentId, request.sessionId ?? '', turnMessages);
					}
					this._logService.info(`[AgentDriver] Stored turn observations for ${request.agentId} (user=${lastUserMessage ? 'yes' : 'no'}, assistantLen=${assistantContent.length})`);
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to store turn observations:', error);
				}
			})();
			}
		}
		this._logService.info(`[AgentDriver] finally block END (turnId=${turnId}) — generator returning, for-await loop will exit`);
	}

	// ─── 取消轮次 ─────────────────────────────────────

	cancelTurn(turnId: string): void {
		const controller = this._activeTurns.get(turnId);
		if (controller) {
			this._logService.info(`[AgentDriver] Cancelling turn ${turnId}`);
			this._updateTurnStatus(turnId, AgentTurnStatus.Cancelling);
			controller.abort();
			this._activeTurns.delete(turnId);
		}

		// ── 顶层 turn 并发限流：取消已排队的 turn 时归还配额 ──
		// 场景：turn 尚在 semaphore 队列中等待 → cancelTurn 提前终止
		// → 归还 acquire() 占用的名额，防止被取消 turn 永久排挤后续 turn。
		if (this._turnHoldsSemaphore.delete(turnId)) {
			this._turnSemaphore.release();
		}

		// NOTE: Do NOT call chatService.cancelStream() here.
		// AgentChatService.sendMessage() already cancels old streams on entry (line 46).
		// Calling cancelStream() here would abort the *new* controller that sendMessage()
		// just created, causing the stream to be killed after the first delta.
	}

	// ─── 查询轮次状态 ─────────────────────────────────

	getTurnStatus(turnId: string): AgentTurnStatus {
		return this._turnStatusMap.get(turnId) ?? AgentTurnStatus.Idle;
	}

	getActiveMemoryProvider(): IMemoryProvider | undefined {
		return this._agentOS.getActiveMemoryProvider();
	}

	private _updateTurnStatus(turnId: string, status: AgentTurnStatus): void {
		this._turnStatusMap.set(turnId, status);
		try {
			this._onDidChangeTurnStatus.fire({ status, turnId });
		} catch (e) {
			this._logService.warn(`[AgentDriver] _onDidChangeTurnStatus.fire() threw for status=${status}:`, e);
		}
	}

	/**
	 * Resolve the workspace that owns a given turn.
	 *
	 * `IAgentTurnRequest` only carries agentId + sessionId, never workspaceId.
	 * The owning workspace is recovered via the session record
	 * (`getSession(sessionId).workspaceId`). When there is no sessionId (e.g.
	 * a probe turn) we fall back to the currently-active workspace.
	 *
	 * Returns undefined only when neither path yields a workspace.
	 */
	private async _resolveWorkspaceId(sessionId?: string): Promise<string | undefined> {
		if (sessionId) {
			try {
				const session = await this._agentStudioService.getSession(sessionId);
				if (session?.workspaceId) { return session.workspaceId; }
			} catch (err) {
				this._logService.debug(`[AgentDriver] _resolveWorkspaceId: getSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const active = this._agentStudioService.getActiveWorkspaceId();
		return active ?? undefined;
	}

	/**
	 * Resolve the per-workspace runtime binding for an agent in the turn's
	 * workspace. Returns undefined if the agent has never run in this workspace
	 * (no worktree / memoryConfig persisted yet) — callers must treat that as
	 * "use defaults", never as an error.
	 */
	private async _resolveBinding(agentId: string, sessionId?: string) {
		const workspaceId = await this._resolveWorkspaceId(sessionId);
		if (!workspaceId) { return undefined; }
		try {
			return await this._agentStudioService.getAgentBinding(workspaceId, agentId);
		} catch (err) {
			this._logService.debug(`[AgentDriver] _resolveBinding(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/**
	 * Build a workspace context section for the system prompt.
	 *
	 * Working-directory resolution priority:
	 *   1. `binding.worktreePath` — when the agent is bound to a git
	 *      worktree in this workspace, that worktree directory IS its working
	 *      sandbox. The agent operates entirely inside the worktree (its own
	 *      branch), isolated from the main checkout. This MUST take precedence
	 *      and MUST NOT be auto-synced away to the VS Code open folder.
	 *   2. Otherwise the Saros workspace path, kept in sync with the VS Code
	 *      currently-open folder.
	 *
	 * Also includes a sandbox rule: the agent may ONLY operate within the
	 * resolved working directory tree.
	 */
	private async _buildWorkspaceContext(agentId: string, sessionId?: string, taskWorktreePath?: string): Promise<string | undefined> {
		try {
			const workspaceId = await this._resolveWorkspaceId(sessionId);
			if (!workspaceId) {
				return undefined;
			}

			const workspace = await this._agentStudioService.getWorkspace(workspaceId);
			if (!workspace) {
				return undefined;
			}

			const binding = await this._resolveBinding(agentId, sessionId);

			// ── 最高优先级：per-task worktreePath（来自 TaskBoardRecord）────────
			if (taskWorktreePath) {
				const worktreeRoot = taskWorktreePath.replace(/[\\/]+$/, '');
				this._logService.info(`[AgentDriver] Task overrides worktree for agent ${agentId}, working dir = "${worktreeRoot}"`);
				return this._composeWorkspaceContextText(workspace.name, worktreeRoot, /* isWorktree */ true);
			}

			// ── 次优先：agent 实例绑定的 worktree 即其工作沙盒 ──────────────
			// 绑定 worktree 的 agent 完全运行在该 worktree 目录（独立分支）内，
			// 与主仓 checkout 隔离。此时工作根 = worktreePath，且【跳过】下面的
			// auto-sync（否则会被 VS Code 当前打开文件夹覆盖回去），与工具沙箱
			// (_resolveAndCheckWorkspacePath) 的判定口径保持一致。
			//
			// ⚠ 经 resolveEffectiveWorktreeRoot 判定（2026-08-20，日志 1787211923566）：
			// worktreePath 等于 workspace 主路径时（用户把 agent 绑回主仓/选 "main"）
			// **不算 worktree 隔离** —— 否则会 ① 用 isWorktree:true 让提示词谎称
			// 「运行在与主仓隔离的 worktree 分支内」② 跳过下面的 auto-sync 使工作根
			// 不再跟随 VS Code 当前打开文件夹。此时应落到常规逻辑。
			const worktreeRoot = resolveEffectiveWorktreeRoot(binding?.worktreePath, workspace.path);
			if (worktreeRoot) {
				this._logService.info(
					`[AgentDriver] Agent ${agentId} bound to worktree, working dir = "${worktreeRoot}" ` +
					`(mainRepo="${workspace.path}") — searches/edits default to this worktree, NOT the main checkout`
				);
				return this._composeWorkspaceContextText(workspace.name, worktreeRoot, /* isWorktree */ true);
			}
			if (binding?.worktreePath) {
				// 绑定存在但指向主仓：记一条可诊断日志，避免"看起来绑了却没生效"的困惑
				this._logService.info(
					`[AgentDriver] Agent ${agentId} worktree binding points at the main repo ` +
					`("${binding.worktreePath}") — treating as NOT worktree-bound (regular multi-root mode)`
				);
			}

			let workspaceRoot = workspace.path;

			// Auto-sync: if the VS Code currently-open folder differs from the
			// stored workspace path, update the workspace record to match.
			const vsCodeFolders = this._workspaceContextService.getWorkspace().folders;
			const vsCodeFolder = vsCodeFolders.length > 0 ? vsCodeFolders[0].uri.fsPath : undefined;

			if (vsCodeFolder && workspaceRoot !== vsCodeFolder) {
				this._logService.info(
					`[AgentDriver] Syncing workspace path: "${workspaceRoot}" → "${vsCodeFolder}"`
				);
				try {
					await this._agentStudioService.updateWorkspace(workspaceId, { path: vsCodeFolder });
				} catch (err) {
					this._logService.warn('[AgentDriver] Failed to sync workspace path:', err);
				}
				workspaceRoot = vsCodeFolder;
			}

			if (!workspaceRoot) {
				return undefined;
			}

			return this._composeWorkspaceContextText(workspace.name, workspaceRoot, /* isWorktree */ false, workspace.relatedFolders);
		} catch {
			return undefined;
		}
	}

	/**
	 * Compose the "Workspace Context" system-prompt section for a resolved
	 * working-directory root. Shared by both the worktree-bound path and the
	 * regular workspace path so the sandbox wording stays consistent.
	 *
	 * @param workspaceName Display name of the Saros workspace.
	 * @param rootDir The resolved working directory (worktree dir or workspace path).
	 * @param isWorktree Whether `rootDir` is a git worktree the agent is bound to.
	 */
	private async _composeWorkspaceContextText(
		workspaceName: string,
		rootDir: string,
		isWorktree: boolean,
		relatedFolders?: Array<{ path: string; name?: string; isGitRepo?: boolean }>,
	): Promise<string> {
		const lines: string[] = [
			'## Workspace Context',
			'',
			`You are operating inside the Saros workspace "${workspaceName}".`,
		];

		if (isWorktree) {
			// 措辞同样须对齐运行时：worktree 绑定只硬约束**写**（写进未绑定的
			// worktree 副本会被 detectStaleWorktreeAccess 拦下），读仍不拦（运行时
			// 注释：「读 → 不拦，用户可能确实要求排查某个 worktree，仅 warn 留痕」）。
			lines.push(
				`This agent is bound to a dedicated git worktree. Your working directory is: ${rootDir}`,
				`You operate on this worktree's own branch, isolated from the main checkout. Default all relative paths, searches and commands to this worktree, and keep your edits here — writing into a different worktree copy is rejected because it is a stale checkout.`,
			);
		} else {
			lines.push(`The workspace root directory is: ${rootDir}`);
		}

		// ── 列出所有关联目录 ──────────────────────────────────────────
		// 工作区可能关联多个代码仓库（如 S1Game + UE5EA）。
		// LLM 需要知道所有目录才能正确搜索所有代码。
		const dirs = (relatedFolders ?? []).filter(f => f?.path && f.path !== rootDir);
		if (dirs.length > 0) {
			lines.push('');
			lines.push('### Related Directories');
			lines.push('This workspace also includes the following directories. When searching code or analyzing the project structure, you should search ALL of these:');
			for (const f of dirs) {
				const name = f.name || f.path.split(/[\\/]/).pop() || f.path;
				const gitTag = f.isGitRepo ? ' [git]' : '';
				lines.push(`  - ${name}: ${f.path}${gitTag}`);
			}
		}

		// ── Codebase 工具摘要（对齐 OpenClaw coreToolSummaries — 工具名+用途）─
		// 不写 "use X for Y task" 领域引导，依赖工具描述让 LLM 自行判断。
		lines.push('');
		lines.push('### Codebase Tools (Direct)');
		lines.push('IMPORTANT: The codebase graph persists across sessions and auto-loads on startup. ' +
			'Use index_status to check if the graph is ready. Only call index_repository if the graph is NOT already loaded ' +
			'(it will skip automatically if loaded, but you can avoid wasting a turn by checking first).');
		lines.push('- index_repository: Build code knowledge graph (one-time; skips if already loaded unless force=true).');
		lines.push('- index_status: Check graph status (loaded node/edge/file counts).');
		lines.push('- search_graph: BM25 full-text search or name_pattern regex. query="..." for natural language. file_pattern/label filter. Pagination via limit+offset+hasMore.');
		lines.push('- search_code: FALLBACK text search within indexed files (use only when search_graph returns nothing). mode=compact|full|files, context lines. Multi-word query → regex.');
		lines.push('- query_graph: Cypher queries (MATCH, WHERE, RETURN, ORDER BY, LIMIT).');
		lines.push('- get_architecture: Overview with communities, languages, packages, hotspots. aspects for dimensions.');
		lines.push('- trace_path: Call chain tracing (mode=calls|data_flow|cross_service).');
		lines.push('- get_code_snippet: Read source code by qualifiedName, with neighbor context.');
		lines.push('If a tool returns "no graph loaded", call index_repository first (one-time only).');







		// ── 安全沙箱说明（2026-08-21 重写，日志 1787308143123）──────────────────
		// ⚠ 这段文案必须与运行时真实行为一致。真源：
		//    `providers/tool/workspaceSecurity.ts`（判定）+ 各工具传入的 checkSandbox。
		//
		// 旧文案声称「read / write / search / execute 全部限制在工作区内，越界一律
		// refuse」，与运行时**三处**不符，导致模型拒绝用户明确要求的合法操作：
		//   ① 读与搜索**根本不做**沙箱判定 —— `checkSandbox=false`：
		//      file_read(coreTools:551)、terminal cwd(coreTools:862)、
		//      search_files/search_code/search_graph(codebaseTools:1149/1348/1393/1405)。
		//      只有 file_write(coreTools:731) 与 patch(compatibilityTools:239) 走默认 true。
		//      运行时注释原文：「沙箱仅限制【写】操作……允许按用户要求自由访问任意目录」。
		//   ② 允许根远不止 rootDir：还含关联仓库、Agent 自身数据目录（技能/记忆/
		//      agent 定义/会话/知识库），plan 模式更是**必须**写 `<数据目录>/plans/*.md`
		//      —— 旧文案等于叫模型别碰自己的数据目录，与 plan 文件豁免直接冲突。
		//   ③ 写越界不是「拒绝」，而是**弹确认卡片交用户决定**（允许本次／允许此工作区／
		//      改用建议路径，见 agentSandboxGuard.buildConfirmationCard）。模型提前 refuse
		//      会把用户的授权机会一并吞掉，用户根本看不到那张卡片。
		//
		// 收紧或放宽真实权限请改 workspaceSecurity.ts；此处只负责**如实描述**，
		// 不要再写成「一律禁止 + refuse」。
		//
		// ⚠ 2026-08-22 增补「硬拒」段：写黑名单（common/writeDenyList.ts）对凭据 /
		// 应用状态 / 扩展代码是**硬拒、不弹卡片、不可授权**，与上面「越界会征求同意」
		// 的语义相反。必须显式区分这两类，否则模型会以为所有拒绝都能靠用户点「允许」
		// 解决，从而反复重试同一路径（或改用 terminal 绕过）。
		// 真源对应：APP_DATA_DENY / HOME_DENY_DIRS / DENY_ENV_BASENAMES。
		const sandboxWriteRoots = [rootDir, ...dirs.map(f => f.path)];
		lines.push(
			'',
			'When the user refers to "workspace", "project", "current directory", or asks to print/list the workspace,',
			`they mean this directory: ${rootDir}`,
			'',
			'### Security Sandbox',
			'',
			'Reading, searching and running commands are NOT path-restricted. If the user explicitly points you at a',
			'path outside the workspace (a log file, a config elsewhere on disk, another checkout), just read it.',
			'Never refuse such a request on sandbox grounds and never claim you are confined to the working directory.',
			'',
			'Writes and deletions ARE restricted. They are allowed inside:',
			...sandboxWriteRoots.map(r => `  - ${r}`),
			'  - your own agent data directory (skills, memories, agent definitions, sessions, knowledge base, plan files)',
			'',
			'If a write would land outside those roots, still issue the tool call normally. The runtime intercepts it and',
			'asks the user to approve ("allow once" / "allow for this workspace" / "use suggested path"), so do not',
			'pre-emptively refuse, and do not silently redirect the path to somewhere else without saying so.',
			'',
			'A SMALL set of paths is hard-denied for writing and CANNOT be approved by the user — do not retry them and',
			'do not try to work around them with terminal/execute_code:',
			'  - credential and settings files: your app data `User/` directory (contains provider API keys), `auth.json`,',
			'    `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh`, `~/.config/gcloud`,',
			'    `.netrc`, `.npmrc`, `.git-credentials`, and any `.env` / `.env.*` secret file (`.env.example` is fine)',
			'  - application state: chat history, agent memory database, backups, context storage, browser/runtime state',
			'  - the installed `extensions/` directory (writing there would inject auto-loaded code)',
			'Everything else under your agent data directory (skills, plans, memories, tmp, knowledge base) stays writable.',
		);

		// 把 AGENT.md 的规则放在工作区上下文最前面（最高优先级）
		const workspaceContextText = lines.join('\n');
		return workspaceContextText;
	}





	// ─── 兼容层：将旧 IChatSendOptions 适配为 IAgentTurnRequest ──

	/**
	 * 兼容现有 agentChatService.sendMessage() 调用方式
	 * Phase 2 中 agentChatService 将委托此方法
	 */
	async *executeFromChatOptions(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		priorMessages?: import('../common/providers.js').IChatMessage[],
	): AsyncIterable<IChatStreamDelta> {
		// 构建多模态 contentParts：文本 + 图片附件（文件附件以文本上下文内联）。
		// 提取为纯函数 buildUserContentParts 便于单测，且保证与 chat 输入框附件透传逻辑一致。
		// 用户原始输入用 <user_query>...</user_query> 包装，使模型能明确区分「用户真实指令」
		// 与注入的 system/skill/memory 上下文（buildUserContentParts 内部对文本块同步包装）。
		// 注意：buildUserContentParts 自身会包装文本块，此处传入原始 message，
		// content 字段单独用 wrapUserQuery 包装，二者保持一致、不重复包装。
		const wrappedUserText = wrapUserQuery(message);
		const contentParts = buildUserContentParts(message, options.attachments);

		const userMessage: import('../common/providers.js').IChatMessage = {
			role: 'user',
			content: wrappedUserText,
			contentParts,
		};

		const request: IAgentTurnRequest = {
			agentId: agentId,
			sessionId: options.agentSessionId,
			// 完整会话历史（由 chatService 从持久化历史转换并去重当前 user 消息后传入）
			// + 本轮 user 消息。priorMessages 缺省时退化为仅当前消息（旧行为）。
			messages: [...(priorMessages ?? []), userMessage],
			systemPrompt: options.systemPrompt,
			explicitSkillIds: options.explicitSkillIds,
			workflowTrigger: options.workflowTrigger,
			worktreePath: options.worktreePath,
			// Fork 前缀缓存：透传父级 ForkContext，使 (system+tools) 与父级冻结前缀对齐
			// → 请求构造端注入 cache 断点、命中 provider prompt cache（零行为变更）。
			forkContext: options.forkContext,
			// v39: forward per-request model override from workflow node config / 面板本地选择。
			// providerId 可选：聊天输入框常只选 model 不显式选 provider（_localProviderId 为空），
			// 此时仍要以 model 覆盖全局 defaultModel，providerId 由消费端保留当前 provider。
			modelOverride: options.model
				? { providerId: options.providerId ?? '', modelId: options.model }
				: undefined,
			chatOnly: options.chatOnly,
			chatMode: options.chatMode, // @deprecated — 保留兼容
			workMode: this._restoreWorkMode(options.agentSessionId),
			options: {
				temperature: options.temperature,
				reasoning: options.reasoning,
			},
		};
		yield* this.executeTurn(request);
	}
}

/**
 * 将用户文本消息 + 附件转换为多模态 contentParts（IChatContentPart[]）。
 *
 * 规则：
 * - 无附件时返回 undefined，消息由 IChatMessage.content 字段承载（向后兼容，
 *   避免给每条纯文本消息都附加 contentParts，影响历史序列化/Token 计算）。
 * - 图片附件（type==='image' 且 mimeType 以 image/ 开头）→ image contentPart，
 *   携带 base64 data + mimeType。下游 MessageFormatConverter 会将其转换为对应
 *   LLM API 的多模态格式（OpenAI image_url / Anthropic base64 source / Gemini
 *   inline_data），确保图片真实内容送达 LLM。
 * - 文件附件（type==='file'）→ 以文本块形式内联到 text contentPart
 *   （文本文件为原文，二进制文件为其 base64），供模型作为上下文阅读。
 *
 * 该纯函数同时被 executeFromChatOptions 调用，并被单测直接覆盖，
 * 是"聊天输入框附件能否正确发送给 LLM"的核心逻辑。
 */
export function buildUserContentParts(
	message: string,
	attachments?: readonly IChatAttachmentSend[],
): IChatContentPart[] | undefined {
	if (!attachments || attachments.length === 0) {
		return undefined;
	}

	const contentParts: IChatContentPart[] = [];
	if (message.trim()) {
		// 用户真实指令用 <user_query>...</user_query> 包装；文件附件上下文在下方追加，
		// 保持在标签之外（非用户指令）。
		contentParts.push({ type: 'text', text: wrapUserQuery(message) });
	}

	for (const att of attachments) {
		if (att.type === 'image' && att.mimeType.startsWith('image/')) {
			contentParts.push({
				type: 'image',
				data: att.data,
				mimeType: att.mimeType as ChatImageMimeType,
			});
		} else if (att.type === 'file') {
			const fileContext = `\n\n--- File: ${att.name} ---\n${att.data}\n--- End of ${att.name} ---`;
			if (contentParts.length > 0 && contentParts[0].type === 'text') {
				// 追加到首个 text 块，避免产生过多零散文本块
				(contentParts[0] as { type: 'text'; text: string }).text += fileContext;
			} else {
				contentParts.push({ type: 'text', text: fileContext });
			}
		} else if (att.type === 'folder') {
			// 文件夹：无法读取目录内容，仅把系统路径交给 agent 由其自行读取/操作
			const folderContext = `\n\n--- Folder: ${att.name} ---\nPath: ${att.filePath ?? att.data}\n--- End of ${att.name} ---`;
			if (contentParts.length > 0 && contentParts[0].type === 'text') {
				(contentParts[0] as { type: 'text'; text: string }).text += folderContext;
			} else {
				contentParts.push({ type: 'text', text: folderContext });
			}
		}
	}

	return contentParts.length > 0 ? contentParts : undefined;
}
