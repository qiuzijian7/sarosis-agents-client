/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IAgentTaskBoardService, ITaskOrchestrationService } from '../../../common/agentStudio.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import type { TaskBoardRecord } from '../../../common/types.js';
import { TaskBoardStatus, TaskSource } from '../../../common/types.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../../../common/constants.js';
import {
	UnifiedSubAgentDispatch,
	SubAgentType,
	type SubAgentResult,
} from '../../../common/unifiedSubAgentDispatch.js';
import {
	ISwarmService,
	SwarmSpec,
	SwarmStatus,
	SwarmWorkerSpec,
	SwarmWorkerState,
	BlackboardEntry,
	BlackboardEntryType,
} from '../../../common/swarmService.js';

const BLACKBOARD_PREFIX = '[swarm:blackboard]';

/** 持久化文件名（与 taskboard.json 同目录：~/.agent-studio/data/）。 */
const DATA_FILE_SWARMS = 'swarms.json';

/** 持久化的磁盘格式：状态快照 + blackboard 一并落盘。 */
interface PersistedSwarm {
	readonly status: SwarmStatus;
	readonly blackboard: BlackboardEntry[];
}

/**
 * SwarmService —— 多智能体协作的编排实现。
 *
 * 复用现有三层能力：
 *  - IAgentTaskBoardService：承载 root/worker/verifier/synthesizer 的看板拓扑与依赖
 *  - UnifiedSubAgentDispatch（经 ITaskOrchestrationService.subAgentDispatch）：并行执行 worker
 *  - IAgentOSService.executeAgentTurn：每个 worker 的真实 agent 轮次
 *
 * blackboard 以 [swarm:blackboard] 前缀的结构化行追加进根任务 description，
 * 实现追加式状态共享；worker 上下文注入「整体目标 + 最新 blackboard 摘要」。
 */
export class SwarmService extends Disposable implements ISwarmService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateSwarm = this._register(new Emitter<SwarmStatus>());
	readonly onDidUpdateSwarm: Event<SwarmStatus> = this._onDidUpdateSwarm.event;

	/** swarmId → 运行态状态快照。 */
	private readonly _swarms = new Map<string, SwarmStatus>();
	/** swarmId → blackboard 条目（追加式）。 */
	private readonly _blackboards = new Map<string, BlackboardEntry[]>();
	/** swarmId → 取消标志。 */
	private readonly _cancelled = new Set<string>();

	/** 持久化数据目录（懒解析）。 */
	private _dataUri: URI | undefined;
	/** debounce 保存句柄，避免高频 _fire 时频繁写盘。 */
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** 启动恢复完成的 promise（保证恢复早于首次写盘）。 */
	private readonly _restored: Promise<void>;

	constructor(
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super();
		this._restored = this._restoreFromDisk();
	}

	override dispose(): void {
		// flush 任何待写盘的状态。
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = undefined;
			void this._saveToDisk();
		}
		super.dispose();
	}

	// ─── createSwarm ────────────────────────────────────────────────────────

	async createSwarm(spec: SwarmSpec): Promise<string> {
		// 确保磁盘恢复先于首次写盘，避免覆盖尚未读入的历史 swarm。
		await this._restored;
		if (!spec.workers || spec.workers.length === 0) {
			throw new Error('createSwarm: at least one worker is required');
		}

		const swarmId = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const enableVerifier = spec.enableVerifier ?? (spec.workers.length >= 2);
		const enableSynthesizer = spec.enableSynthesizer ?? true;

		// 1) 根任务：若提供 parentTaskId 则复用，否则新建并立即标记 done（伞任务）。
		let rootTask: TaskBoardRecord;
		if (spec.parentTaskId) {
			const existing = await this.taskBoardService.getTask(spec.parentTaskId);
			if (!existing) {
				throw new Error(`createSwarm: parentTaskId "${spec.parentTaskId}" not found`);
			}
			rootTask = existing;
		} else {
			rootTask = await this.taskBoardService.createTask({
				title: spec.title,
				description: spec.goal ? `${spec.goal}\n\n[SWARM ${swarmId}]` : `[SWARM ${swarmId}]`,
				status: TaskBoardStatus.Done,
				source: TaskSource.Manual,
				workspaceId: spec.workspaceId ?? '',
			});
		}

		// 2) 建 worker 看板卡片（依赖根任务）。
		const workerStates: SwarmWorkerState[] = [];
		const workerTaskIds: string[] = [];
		for (const w of spec.workers) {
			const card = await this.taskBoardService.createTask({
				title: w.title,
				description: w.body,
				status: TaskBoardStatus.Ready,
				source: TaskSource.Manual,
				workspaceId: rootTask.workspaceId,
				priority: w.priority,
				dependencies: [rootTask.id],
			});
			workerTaskIds.push(card.id);
			workerStates.push({
				taskId: card.id,
				title: w.title,
				role: 'worker',
				status: 'pending',
			});
		}

		// 3) verifier 节点（依赖所有 worker）。
		let verifierState: SwarmWorkerState | undefined;
		if (enableVerifier) {
			const vCard = await this.taskBoardService.createTask({
				title: `✅ Verify: ${spec.title}`,
				description: spec.verifierProfile ?? 'Verify worker outputs for correctness, completeness and consistency.',
				status: TaskBoardStatus.Todo,
				source: TaskSource.Manual,
				workspaceId: rootTask.workspaceId,
				dependencies: workerTaskIds,
			});
			verifierState = { taskId: vCard.id, title: vCard.title, role: 'verifier', status: 'pending' };
		}

		// 4) synthesizer 节点（依赖 verifier，或在无 verifier 时依赖所有 worker）。
		let synthesizerState: SwarmWorkerState | undefined;
		if (enableSynthesizer) {
			const deps = verifierState ? [verifierState.taskId] : workerTaskIds;
			const sCard = await this.taskBoardService.createTask({
				title: `🧬 Synthesize: ${spec.title}`,
				description: spec.synthesizerProfile ?? 'Synthesize all worker outputs into a single coherent result.',
				status: TaskBoardStatus.Todo,
				source: TaskSource.Manual,
				workspaceId: rootTask.workspaceId,
				dependencies: deps,
			});
			synthesizerState = { taskId: sCard.id, title: sCard.title, role: 'synthesizer', status: 'pending' };
		}

		const status: SwarmStatus = {
			swarmId,
			rootTaskId: rootTask.id,
			title: spec.title,
			workspaceId: rootTask.workspaceId,
			phase: 'planning',
			workers: workerStates,
			verifier: verifierState,
			synthesizer: synthesizerState,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this._swarms.set(swarmId, status);
		this._blackboards.set(swarmId, []);
		this._fire(status);

		// 异步执行（不阻塞 createSwarm 返回，让 UI 立即拿到拓扑）。
		void this._runSwarm(swarmId, spec).catch(err => {
			this.logService.error(`[Swarm] ${swarmId} run failed`, err);
			const s = this._swarms.get(swarmId);
			if (s && s.phase !== 'cancelled') {
				s.phase = 'failed';
				s.updatedAt = Date.now();
				this._fire(s);
			}
		});

		this.logService.info(`[Swarm] created ${swarmId}: ${workerStates.length} workers, verifier=${!!verifierState}, synthesizer=${!!synthesizerState}`);
		return swarmId;
	}

	// ─── orchestration ────────────────────────────────────────────────────────

	private async _runSwarm(swarmId: string, spec: SwarmSpec): Promise<void> {
		const status = this._swarms.get(swarmId);
		if (!status) { return; }

		const dispatch = this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
		const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> =>
			this.agentOS.executeAgentTurn(request);

		// ── Phase: running (workers in parallel) ──
		status.phase = 'running';
		status.updatedAt = Date.now();
		this._fire(status);

		const workerPromises = spec.workers.map((w, idx) =>
			this._runWorker(swarmId, dispatch, executeFn, w, status.workers[idx]),
		);
		const workerResults = await Promise.all(workerPromises);

		if (this._isCancelled(swarmId)) { return this._markCancelled(swarmId); }

		// ── Phase: verifying ──
		if (status.verifier) {
			status.phase = 'verifying';
			status.updatedAt = Date.now();
			this._fire(status);
			await this._runAggregator(
				swarmId, dispatch, executeFn, status.verifier,
				spec.verifierProfile ?? 'You are a meticulous reviewer.',
				this._buildVerifierPrompt(spec, workerResults),
			);
			if (this._isCancelled(swarmId)) { return this._markCancelled(swarmId); }
		}

		// ── Phase: synthesizing ──
		if (status.synthesizer) {
			status.phase = 'synthesizing';
			status.updatedAt = Date.now();
			this._fire(status);
			const finalOut = await this._runAggregator(
				swarmId, dispatch, executeFn, status.synthesizer,
				spec.synthesizerProfile ?? 'You are a synthesis expert.',
				this._buildSynthesizerPrompt(swarmId, spec, workerResults),
			);
			status.finalOutput = finalOut;
			// 把最终产物写回根任务。
			const note = `\n\n## Swarm Result (${swarmId})\n${finalOut}`;
			const root = await this.taskBoardService.getTask(status.rootTaskId);
			if (root) {
				await this.taskBoardService.updateTask(status.rootTaskId, {
					description: (root.description ?? '') + note,
				});
			}
		}

		if (this._isCancelled(swarmId)) { return this._markCancelled(swarmId); }

		status.phase = 'done';
		status.updatedAt = Date.now();
		this._fire(status);
		this.logService.info(`[Swarm] ${swarmId} done`);
	}

	private async _runWorker(
		swarmId: string,
		dispatch: UnifiedSubAgentDispatch,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		spec: SwarmWorkerSpec,
		state: SwarmWorkerState,
	): Promise<{ title: string; output: string; success: boolean }> {
		if (this._isCancelled(swarmId)) {
			state.status = 'cancelled';
			return { title: spec.title, output: '', success: false };
		}

		state.status = 'running';
		this._touch(swarmId);
		await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Running);

		const context = this._buildWorkerContext(swarmId, spec);
		try {
			const result: SubAgentResult = await dispatch.dispatch(
				`swarm-${swarmId}`,
				spec.body,
				executeFn,
				{
					// P2b: swarm worker 是对等协作 agent —— 显式标 peer 档：
					// 独立生命周期，不因父 turn 取消而误杀，仅由 cancelSwarm 取消。
					isolationLevel: 'peer',
					type: SubAgentType.General,
					context,
					priority: spec.priority ?? 'medium',
					timeout: spec.maxRuntimeSeconds ? spec.maxRuntimeSeconds * 1000 : undefined,
				},
			);
			state.subAgentId = undefined;
			if (result.success) {
				state.status = 'done';
				state.output = result.output;
				await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Done);
				await this.postBlackboardUpdate(swarmId, state.taskId, result.output ?? '(no output)', 'result');
			} else {
				state.status = 'error';
				state.error = result.error;
				await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Blocked);
				await this.postBlackboardUpdate(swarmId, state.taskId, `FAILED: ${result.error ?? 'unknown'}`, 'blocked');
			}
			this._touch(swarmId);
			return { title: spec.title, output: result.output ?? '', success: result.success };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.status = 'error';
			state.error = msg;
			await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Blocked);
			this._touch(swarmId);
			return { title: spec.title, output: '', success: false };
		}
	}

	private async _runAggregator(
		swarmId: string,
		dispatch: UnifiedSubAgentDispatch,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		state: SwarmWorkerState,
		profile: string,
		prompt: string,
	): Promise<string> {
		state.status = 'running';
		this._touch(swarmId);
		await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Running);
		try {
			const result = await dispatch.dispatch(
				`swarm-${swarmId}`,
				prompt,
				executeFn,
				// P2b: verifier/synthesizer 也是对等协作 agent，显式标 peer 档。
				{ type: SubAgentType.General, isolationLevel: 'peer', context: profile },
			);
			if (result.success) {
				state.status = 'done';
				state.output = result.output;
				await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Done);
				await this.postBlackboardUpdate(swarmId, state.taskId, result.output ?? '(no output)', state.role === 'verifier' ? 'insight' : 'result');
			} else {
				state.status = 'error';
				state.error = result.error;
				await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Blocked);
			}
			this._touch(swarmId);
			return result.output ?? '';
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.status = 'error';
			state.error = msg;
			await this._safeUpdateStatus(state.taskId, TaskBoardStatus.Blocked);
			this._touch(swarmId);
			return '';
		}
	}

	// ─── prompts / context ──────────────────────────────────────────────────

	private _buildWorkerContext(swarmId: string, spec: SwarmWorkerSpec): string {
		const parts: string[] = [];
		if (spec.profile) { parts.push(`ROLE: ${spec.profile}`); }
		const bb = this._blackboards.get(swarmId) ?? [];
		if (bb.length > 0) {
			const recent = bb.slice(-6).map(e => `- [${e.type}] ${e.content.slice(0, 300)}`).join('\n');
			parts.push(`SHARED BLACKBOARD (latest):\n${recent}`);
		}
		if (spec.skills && spec.skills.length) {
			parts.push(`SUGGESTED SKILLS: ${spec.skills.join(', ')}`);
		}
		return parts.join('\n\n');
	}

	private _buildVerifierPrompt(spec: SwarmSpec, results: Array<{ title: string; output: string; success: boolean }>): string {
		const body = results.map((r, i) =>
			`### Worker ${i + 1}: ${r.title} (${r.success ? 'ok' : 'failed'})\n${r.output || '(no output)'}`,
		).join('\n\n');
		return [
			`Goal: ${spec.goal ?? spec.title}`,
			``,
			`Review the following worker outputs. Identify gaps, contradictions, or unmet requirements.`,
			`Respond with a concise verification report (issues found + whether the goal is satisfied).`,
			``,
			body,
		].join('\n');
	}

	private _buildSynthesizerPrompt(swarmId: string, spec: SwarmSpec, results: Array<{ title: string; output: string; success: boolean }>): string {
		const body = results.map((r, i) =>
			`### Worker ${i + 1}: ${r.title}\n${r.output || '(no output)'}`,
		).join('\n\n');
		const bb = this._blackboards.get(swarmId) ?? [];
		const verifierNotes = bb.filter(e => e.type === 'insight').map(e => `- ${e.content.slice(0, 400)}`).join('\n');
		return [
			`Goal: ${spec.goal ?? spec.title}`,
			``,
			`Synthesize the worker outputs below into a single coherent final result that fully addresses the goal.`,
			verifierNotes ? `\nVERIFIER NOTES:\n${verifierNotes}\n` : ``,
			body,
		].join('\n');
	}

	// ─── blackboard ──────────────────────────────────────────────────────────

	async getBlackboard(swarmId: string): Promise<BlackboardEntry[]> {
		await this._restored;
		return (this._blackboards.get(swarmId) ?? []).slice();
	}

	async postBlackboardUpdate(swarmId: string, workerId: string, update: string, type: BlackboardEntryType = 'progress'): Promise<void> {
		const status = this._swarms.get(swarmId);
		const bb = this._blackboards.get(swarmId);
		if (!bb || !status) { return; }

		const workerTitle = this._findWorkerTitle(status, workerId);
		const entry: BlackboardEntry = {
			workerId,
			workerTitle,
			timestamp: Date.now(),
			content: update,
			type,
		};
		bb.push(entry);

		// 追加进根任务 description（结构化前缀），实现持久化的状态共享。
		try {
			const root = await this.taskBoardService.getTask(status.rootTaskId);
			if (root) {
				const line = `\n${BLACKBOARD_PREFIX} ${type} | ${workerTitle ?? workerId.slice(-6)}: ${update.slice(0, 500)}`;
				await this.taskBoardService.updateTask(status.rootTaskId, {
					description: (root.description ?? '') + line,
				});
			}
		} catch (err) {
			this.logService.warn(`[Swarm] blackboard persist failed for ${swarmId}: ${err}`);
		}

		this._touch(swarmId);
	}

	// ─── status / cancel ──────────────────────────────────────────────────────

	async getSwarmStatus(swarmId: string): Promise<SwarmStatus | undefined> {
		await this._restored;
		return this._swarms.get(swarmId);
	}

	listSwarms(workspaceId?: string): SwarmStatus[] {
		const all = Array.from(this._swarms.values());
		return workspaceId ? all.filter(s => s.workspaceId === workspaceId) : all;
	}

	async cancelSwarm(swarmId: string): Promise<void> {
		const status = this._swarms.get(swarmId);
		if (!status) { return; }
		this._cancelled.add(swarmId);
		// 中断仍在运行的 worker sub-agents。
		for (const w of [...status.workers, status.verifier, status.synthesizer]) {
			if (w && w.subAgentId && (w.status === 'running' || w.status === 'pending')) {
				UnifiedSubAgentDispatch.interruptSubAgentGlobal(w.subAgentId);
			}
		}
		this._markCancelled(swarmId);
	}

	// ─── helpers ────────────────────────────────────────────────────────────

	private _isCancelled(swarmId: string): boolean {
		return this._cancelled.has(swarmId);
	}

	private _markCancelled(swarmId: string): void {
		const status = this._swarms.get(swarmId);
		if (!status) { return; }
		status.phase = 'cancelled';
		status.updatedAt = Date.now();
		for (const w of [...status.workers, status.verifier, status.synthesizer]) {
			if (w && (w.status === 'pending' || w.status === 'running')) {
				w.status = 'cancelled';
			}
		}
		this._fire(status);
		this.logService.info(`[Swarm] ${swarmId} cancelled`);
	}

	private _findWorkerTitle(status: SwarmStatus, taskId: string): string | undefined {
		const all = [...status.workers, status.verifier, status.synthesizer].filter(Boolean) as SwarmWorkerState[];
		return all.find(w => w.taskId === taskId)?.title;
	}

	private async _safeUpdateStatus(taskId: string, newStatus: TaskBoardStatus): Promise<void> {
		try {
			await this.taskBoardService.updateTaskStatus(taskId, newStatus);
		} catch (err) {
			this.logService.warn(`[Swarm] updateTaskStatus(${taskId}, ${newStatus}) failed: ${err}`);
		}
	}

	private _touch(swarmId: string): void {
		const status = this._swarms.get(swarmId);
		if (status) {
			status.updatedAt = Date.now();
			this._fire(status);
		}
	}

	private _fire(status: SwarmStatus): void {
		// 发出一个浅拷贝，避免外部直接持有可变引用。
		this._onDidUpdateSwarm.fire({
			...status,
			workers: status.workers.map(w => ({ ...w })),
			verifier: status.verifier ? { ...status.verifier } : undefined,
			synthesizer: status.synthesizer ? { ...status.synthesizer } : undefined,
		});
		// 任意状态变更都触发一次去抖持久化。
		this._scheduleSave();
	}

	// ─── persistence ──────────────────────────────────────────────────────────

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				this._dataUri = URI.joinPath(this.environmentService.userHome, '.agent-studio', 'data');
			}
		}
		return this._dataUri;
	}

	/** 去抖保存（500ms 合并多次状态变更，避免高频写盘）。 */
	private _scheduleSave(): void {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
		}
		this._saveTimer = setTimeout(() => {
			this._saveTimer = undefined;
			void this._saveToDisk();
		}, 500);
	}

	private async _saveToDisk(): Promise<void> {
		try {
			const payload: PersistedSwarm[] = Array.from(this._swarms.values()).map(status => ({
				status,
				blackboard: this._blackboards.get(status.swarmId) ?? [],
			}));
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_SWARMS);
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
		} catch (err) {
			this.logService.warn(`[Swarm] persist failed: ${err}`);
		}
	}

	/**
	 * 启动时从磁盘恢复。进程重启后 sub-agent 已消失，运行中的 swarm 无法续跑，
	 * 因此把活跃态（planning/running/verifying/synthesizing）标记为 interrupted，
	 * 但完整保留拓扑与 blackboard 供 UI 查看；终态（done/cancelled/failed）原样恢复。
	 */
	private async _restoreFromDisk(): Promise<void> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_SWARMS);
			const content = await this.fileService.readFile(uri);
			const persisted = JSON.parse(content.value.toString()) as PersistedSwarm[];
			if (!Array.isArray(persisted)) { return; }

			let interruptedCount = 0;
			for (const { status, blackboard } of persisted) {
				if (!status?.swarmId) { continue; }
				const activePhases = new Set(['planning', 'running', 'verifying', 'synthesizing']);
				if (activePhases.has(status.phase)) {
					status.phase = 'interrupted';
					// 进程已消失，所有未完结节点也归为中断态。
					for (const w of [...status.workers, status.verifier, status.synthesizer]) {
						if (w && (w.status === 'pending' || w.status === 'running')) {
							w.status = 'cancelled';
							w.subAgentId = undefined;
						}
					}
					interruptedCount++;
				}
				this._swarms.set(status.swarmId, status);
				this._blackboards.set(status.swarmId, Array.isArray(blackboard) ? blackboard : []);
			}
			if (persisted.length > 0) {
				this.logService.info(`[Swarm] restored ${persisted.length} swarm(s) from disk (${interruptedCount} marked interrupted)`);
				// 通知任何已挂载的监听者（恢复后的初始状态）。
				for (const status of this._swarms.values()) {
					this._onDidUpdateSwarm.fire({
						...status,
						workers: status.workers.map(w => ({ ...w })),
						verifier: status.verifier ? { ...status.verifier } : undefined,
						synthesizer: status.synthesizer ? { ...status.synthesizer } : undefined,
					});
				}
			}
		} catch {
			// 文件不存在或损坏 —— 全新启动，忽略。
		}
	}
}
