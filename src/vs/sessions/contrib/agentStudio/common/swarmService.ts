/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ─── Swarm Service ──────────────────────────────────────────────────────────
// 多智能体协作（Swarm）。对应 Hermes 的 kanban_swarm：把一个父任务展开成
// 「多 Worker 并行 → Verifier 校验 → Synthesizer 汇总」的协作拓扑，Worker 之间
// 通过共享 blackboard（结构化 comment）交换中间产物与进展。
//
//   Root Task (done immediately)
//   ├── Worker 1 (ready) ───┐
//   ├── Worker 2 (ready) ───┤──→ Verifier (deps=workers) ──→ Synthesizer (deps=verifier)
//   └── Worker 3 (ready) ───┘
//
// 实现复用现有 SubAgent 调度（UnifiedSubAgentDispatch）执行每个 Worker，
// 看板任务（TaskBoardRecord）承载拓扑与依赖，blackboard 以 [swarm:blackboard]
// 前缀追加进根任务 description，实现追加式状态共享。

export const ISwarmService = createDecorator<ISwarmService>('swarmService');

export interface ISwarmService {
	readonly _serviceBrand: undefined;

	/** 每当某个 swarm 的状态发生变化（worker 完成 / blackboard 更新 / 阶段推进）时触发。 */
	readonly onDidUpdateSwarm: Event<SwarmStatus>;

	/**
	 * 创建并启动一个 swarm。
	 * 会同步建立看板拓扑（root / workers / verifier / synthesizer），
	 * 然后异步并行执行 Worker，最后跑 verifier + synthesizer。
	 * @returns swarmId（也是根任务的关联 id）
	 */
	createSwarm(spec: SwarmSpec): Promise<string>;

	/** 获取一个 swarm 的当前状态快照。 */
	getSwarmStatus(swarmId: string): Promise<SwarmStatus | undefined>;

	/** 列出当前内存中所有 swarm 的状态快照（可按 workspace 过滤）。 */
	listSwarms(workspaceId?: string): SwarmStatus[];

	/** 获取一个 swarm 的 blackboard（追加式条目，按时间升序）。 */
	getBlackboard(swarmId: string): Promise<BlackboardEntry[]>;

	/** 向一个 swarm 的 blackboard 追加一条更新（由 worker 或外部调用）。 */
	postBlackboardUpdate(swarmId: string, workerId: string, update: string, type?: BlackboardEntryType): Promise<void>;

	/** 取消一个正在运行的 swarm（中断尚未完成的 worker）。 */
	cancelSwarm(swarmId: string): Promise<void>;
}

// ─── Spec ───────────────────────────────────────────────────────────────────

export interface SwarmSpec {
	/** 父任务标题（作为 swarm 的根任务标题）。 */
	readonly title: string;
	/** 父任务的整体目标描述（注入每个 worker 的上下文）。 */
	readonly goal?: string;
	/** workspace 隔离 id。 */
	readonly workspaceId?: string;
	/** 已存在的父任务 id；若提供则复用它作为根任务，否则新建。 */
	readonly parentTaskId?: string;
	/** Worker 规格列表（至少 1 个）。 */
	readonly workers: SwarmWorkerSpec[];
	/** 是否启用 Verifier 阶段（默认 true，当 workers >= 2 时有意义）。 */
	readonly enableVerifier?: boolean;
	/** 是否启用 Synthesizer 阶段（默认 true）。 */
	readonly enableSynthesizer?: boolean;
	/** Verifier 的人格/角色描述（可选）。 */
	readonly verifierProfile?: string;
	/** Synthesizer 的人格/角色描述（可选）。 */
	readonly synthesizerProfile?: string;
}

export interface SwarmWorkerSpec {
	/** Agent 人格/角色（注入 system 上下文，如 "前端工程师"）。 */
	readonly profile?: string;
	/** 看板卡片标题。 */
	readonly title: string;
	/** 任务正文（worker 要做什么）。 */
	readonly body: string;
	/** 建议启用的 skills/toolsets（可选）。 */
	readonly skills?: string[];
	/** 调度优先级。 */
	readonly priority?: 'low' | 'medium' | 'high';
	/** 单 worker 最大运行时长（秒），超时中断。 */
	readonly maxRuntimeSeconds?: number;
}

// ─── Blackboard ───────────────────────────────────────────────────────────────

export type BlackboardEntryType = 'progress' | 'result' | 'blocked' | 'insight';

export interface BlackboardEntry {
	readonly workerId: string;
	/** worker 的可读标题（便于 UI 展示）。 */
	readonly workerTitle?: string;
	readonly timestamp: number;
	readonly content: string;
	readonly type: BlackboardEntryType;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export type SwarmPhase =
	| 'planning'      // 拓扑建立中
	| 'running'       // Worker 并行执行中
	| 'verifying'     // Verifier 阶段
	| 'synthesizing'  // Synthesizer 阶段
	| 'done'          // 全部完成
	| 'cancelled'     // 被取消
	| 'failed'        // 失败（如无可用模型）
	| 'interrupted';  // 进程重启后无法续跑（reload 时活跃态 swarm 的归宿，拓扑与 blackboard 保留）

export type SwarmWorkerStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface SwarmWorkerState {
	/** 看板任务 id（拓扑节点）。 */
	readonly taskId: string;
	/** 内部 sub-agent id（执行中才有）。 */
	subAgentId?: string;
	readonly title: string;
	readonly role: 'worker' | 'verifier' | 'synthesizer';
	status: SwarmWorkerStatus;
	/** worker 的最终输出（done 后填充）。 */
	output?: string;
	error?: string;
}

export interface SwarmStatus {
	readonly swarmId: string;
	/** 根任务 id。 */
	readonly rootTaskId: string;
	readonly title: string;
	readonly workspaceId?: string;
	phase: SwarmPhase;
	readonly workers: SwarmWorkerState[];
	/** verifier 节点状态（启用时）。 */
	verifier?: SwarmWorkerState;
	/** synthesizer 节点状态（启用时）。 */
	synthesizer?: SwarmWorkerState;
	/** 最终汇总产物（synthesizer 完成后填充）。 */
	finalOutput?: string;
	readonly createdAt: number;
	updatedAt: number;
}

/**
 * createSwarm 的同步返回结构（也可通过 getSwarmStatus 拉取最新）。
 */
export interface SwarmResult {
	readonly swarmId: string;
	readonly rootTaskId: string;
	readonly status: SwarmStatus;
}
