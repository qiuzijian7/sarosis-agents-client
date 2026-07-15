/*---------------------------------------------------------------------------------------------
 *  AgentOS — AgentGraph（supervisor / AgentCommand(goto) 设计 Step A）
 *
 *  纯类型 + 纯函数（无运行时依赖、零行为变更），对齐 doc/agentos-supervisor-goto-design.md。
 *  本模块是 supervisor 图运行时的"地基"：定义图 / 节点 / 路由指令的数据形状，
 *  以及可单测的纯函数（resolveGoto / staticEdgeTarget / applyCommandToState）。
 *  图解释器（Step C）与交接工具（Step B）才消费这些类型；本文件不接触 loop。
 *
 *  依赖方向：本文件 → agentRunState（单向，无循环依赖）。
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRunState,
	AgentGraphRunState,
	AgentGraphNodeExecutionStatus,
} from './agentRunState.js';

// ─── 图 / 节点定义 ─────────────────────────────────────────────────

export type AgentGraphNodeKind = 'supervisor' | 'worker' | 'io';

export interface AgentGraphNode {
	/** 节点 id（goto 目标） */
	id: string;
	/** 绑定到 AgentStudio 中已配置的 agent */
	agentId: string;
	kind: AgentGraphNodeKind;
	/** 进入该节点时注入的 system 追加指令（如 supervisor 的路由规则） */
	systemAppend?: string;
	/** 是否把上一节点的 handoff 摘要作为首条 user 消息注入（默认 true） */
	inheritHandoff?: boolean;
	/** 该节点是否可在无 goto 时自然结束（worker 默认 true；supervisor 默认 false） */
	terminalAllowed?: boolean;
}

export interface AgentGraphEdge {
	from: string;
	to: string; // 静态兜底边（当节点无 goto 时遵循）
}

/** 终态哨兵（到达即整图结束）。图的 endNodeId 缺省时复用此值。 */
export const END_NODE = '__END__';

export interface AgentGraph {
	id: string;
	entryNodeId: string;
	nodes: Record<string, AgentGraphNode>;
	edges: AgentGraphEdge[];
	/** 终态节点 id（默认 END_NODE） */
	endNodeId?: string;
}

// ─── AgentCommand（节点返回的路由指令，对齐 LangGraph Command）─────

export interface AgentCommand {
	/** 下一个节点 id（动态路由）。支持 fan-out 多目标。 */
	goto?: string | string[];
	/** 交接摘要：作为下一节点的首条 user 上下文（来自 transfer_to_agent.summary） */
	summary?: string;
	/** 写回共享黑板（跨节点 KV，等价 WorkflowExecutionService.sharedMemory） */
	update?: Record<string, unknown>;
}

// ─── 纯函数 ────────────────────────────────────────────────────────

/** 由图定义构造初始图运行状态（所有节点 pending，currentNodeId = entry）。 */
export function createInitialGraphRunState(graph: AgentGraph): AgentGraphRunState {
	const nodeStatus: Record<string, AgentGraphNodeExecutionStatus> = {};
	for (const id of Object.keys(graph.nodes)) {
		nodeStatus[id] = 'pending';
	}
	return {
		currentNodeId: graph.entryNodeId,
		nodeThreads: {},
		sharedMemory: {},
		handoffSummary: undefined,
		nodeStatus,
	};
}

/** 节点 id 是否为图内合法目标（含 END 哨兵）。 */
export function isKnownNode(graph: AgentGraph, nodeId: string): boolean {
	const end = graph.endNodeId ?? END_NODE;
	return nodeId === end || Object.prototype.hasOwnProperty.call(graph.nodes, nodeId);
}

/**
 * 解析 AgentCommand.goto → 有序的下一节点 id 列表（fan-out 顺序保持）。
 * 任一目标非法（非图内节点且非 END）则抛错：goto 是运行期路由指令，
 * 指向未知节点属编程/配置错误，应快速失败而非静默吞掉。
 */
export function resolveGoto(command: AgentCommand, graph: AgentGraph): string[] {
	if (!command.goto) {
		return [];
	}
	const targets = Array.isArray(command.goto) ? command.goto : [command.goto];
	const known = Object.keys(graph.nodes);
	const end = graph.endNodeId ?? END_NODE;
	for (const t of targets) {
		if (t !== end && !Object.prototype.hasOwnProperty.call(graph.nodes, t)) {
			throw new Error(
				`[AgentGraph] resolveGoto: unknown target node "${t}" ` +
				`(known: ${known.join(', ')}, END=${end})`,
			);
		}
	}
	return targets;
}

/**
 * 静态兜底边目标：返回 from 的首条静态边 to（LangGraph 式 default edge）。
 * 无静态边则返回 undefined（调用方应改为 END）。
 */
export function staticEdgeTarget(graph: AgentGraph, from: string): string | undefined {
	const edge = graph.edges.find((e) => e.from === from);
	return edge?.to;
}

/**
 * 图解释器路由决策（Step C，纯函数、可单测）。
 * 给定当前节点与节点返回的 `AgentCommand`，计算"下一个 current 节点 id"：
 * - `command.goto` 存在 → `resolveGoto` 的首目标（v1 fan-out 取首目标；
 *   多目标队列留待后续扩展，设计 §3.5 注释）。
 * - 否则按节点 `terminalAllowed` 语义（默认 worker=true / supervisor=false）：
 *   允许自然结束 → END；否则走静态兜底边的 `to`（无则 END）。
 *
 * 设计 §3.2：节点无 goto 且 `terminalAllowed` → 沿静态边或 END 收尾。
 */
export function computeNextNode(graph: AgentGraph, node: AgentGraphNode, command?: AgentCommand): string {
	const end = graph.endNodeId ?? END_NODE;
	if (command?.goto) {
		const targets = resolveGoto(command, graph);
		return targets[0] ?? end;
	}
	const effectiveTerminal = node.terminalAllowed ?? (node.kind === 'worker');
	if (effectiveTerminal) {
		return end;
	}
	return staticEdgeTarget(graph, node.id) ?? end;
}

/**
 * 将 AgentCommand 的副作用（sharedMemory 写回 + handoff 摘要）应用到 runState。
 * 不可变：返回新 state。graph 为 undefined（单 agent 模式）时按最小图状态惰性创建，
 * 但单 agent 模式不会派发含 goto 的 command，故实际只在图模式命中。
 * 命令完全为空（无 goto / summary / update）时原样返回（no-op）。
 */
export function applyCommandToState(state: AgentRunState, command: AgentCommand): AgentRunState {
	if (!command.goto && command.summary === undefined && !command.update) {
		return state;
	}
	const graph: AgentGraphRunState = state.graph ?? {
		currentNodeId: undefined,
		nodeThreads: {},
		sharedMemory: {},
		nodeStatus: {},
	};
	const nextGraph: AgentGraphRunState = { ...graph };
	if (command.summary !== undefined) {
		nextGraph.handoffSummary = command.summary;
	}
	if (command.update) {
		nextGraph.sharedMemory = { ...nextGraph.sharedMemory, ...command.update };
	}
	return { ...state, graph: nextGraph };
}

// ─── 交接工具（supervisor / AgentCommand(goto) 设计，Step B）─────────

/** builtin 交接工具名（来源 A 的路由指令工具，loop 拦截为 AgentCommand）。 */
export const TRANSFER_TO_AGENT_TOOL = 'transfer_to_agent';

/**
 * 由 transfer_to_agent 的工具参数构造 AgentCommand（纯函数，可单测）。
 *
 * 语义（设计 §3.3）：节点调用 `transfer_to_agent({ node_id, summary })` →
 * loop 拦截 → buildHandoffCommand → `AgentCommand({ goto: node_id, summary,
 * update: { lastHandoffSummary: summary } })`。
 *
 * - `graph` 缺失（单 agent 模式）：返回 undefined（loop 不会拦截、但该工具
 *   也已被 _getEnabledTools 过滤，故不会到达此处）。
 * - `node_id` 缺失或非图内合法节点：返回 undefined → 调用方发错误提示而非崩溃
 *   （goto 指向未知节点属编程/配置错误，快速失败）。
 * - 合法：返回完整 AgentCommand（`summary` 与 `update.lastHandoffSummary` 同源）。
 */
export function buildHandoffCommand(
	args: { node_id?: unknown; summary?: unknown },
	graph?: AgentGraph,
): AgentCommand | undefined {
	if (!graph) {
		return undefined;
	}
	const nodeId = typeof args.node_id === 'string' ? args.node_id : undefined;
	const summary = typeof args.summary === 'string' ? args.summary : undefined;
	if (!nodeId || !isKnownNode(graph, nodeId)) {
		return undefined;
	}
	return {
		goto: nodeId,
		summary,
		update: { lastHandoffSummary: summary },
	};
}
