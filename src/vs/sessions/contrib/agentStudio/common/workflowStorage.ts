/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// workflowStorage.ts - 工作流文件存储服务接口
// ------------------------------------------------------------------------------------------------
//
// 作用: 将工作流以 JSON 文件形式持久化到当前工作区的
//       `.sarosworkspace/workflows/` 目录下，支持读取、写入、列举、删除。
//
// 与 CrewTeamService 的区别:
// - CrewTeamService 用 IStorageService（浏览器存储）持久化，不落地到工作区文件。
// - WorkflowStorageService 直接用 IFileService 写文件到 .sarosworkspace/workflows/，
//   每个工作流一个 `{id}.json` 文件，可被版本管理 / 团队共享。
//
// 设计: 每个工作流默认绑定一个 Agent（presetId + 部署后的 agentId），
//       执行工作流即执行该 Agent，所有内容在 Agent 的聊天框中显示。

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import type { IWorkflow } from './crewTeam.js';

// ------------------------------------------------------------------------------------------------
// 扩展工作流数据模型 — 增加 Agent 绑定字段 + 节点图（ReactFlow 编辑器用）
// ------------------------------------------------------------------------------------------------

/**
 * 存储到文件的工作流。在 IWorkflow 基础上增加 Agent 绑定信息和可选的节点图。
 *
 * 双模态数据：
 * - steps (IWorkflowStep[]): 线性步骤列表（向后兼容，供执行器使用）
 * - nodes + connections: 节点图表示（供 ReactFlow 编辑器使用）
 *
 * 每个工作流默认对应一个 Agent：
 * - presetId: 该工作流使用的预设 Agent ID（默认 'workflow-agent'）
 * - agentId: 部署后真实 Agent 的 ID（执行时确保存在）
 */
export interface IStoredWorkflow extends IWorkflow {
	/** 关联的预设 Agent ID（默认 'workflow-agent'） */
	presetId?: string;
	/** 部署后的真实 Agent ID（执行工作流时使用） */
	agentId?: string;
	/** 所属工作区 ID */
	workspaceId?: string;

	/** 节点图节点列表（ReactFlow 编辑器使用；为空时 fallback 到 steps） */
	nodes?: WorkflowGraphNode[];
	/** 节点图连接列表（ReactFlow 编辑器使用） */
	connections?: WorkflowGraphConnection[];

	/**
	 * v5a: workflow-level breakpoints. Persisted to the workflow JSON so
	 * they survive page reload and apply to every subsequent run.
	 * nodeIds reference entries in `nodes[].id`.
	 */
	breakpoints?: string[];

	// 发布相关字段（可选）
	/** 工作流版本号 */
	version?: string;
	/** 工作流分类 */
	category?: string;
	/** 作者 */
	author?: string;
	/** 可见性：公开或私有 */
	visibility?: 'public' | 'private';
	/** 标签列表 */
	tags?: string[];
	/** 使用指南（Markdown 格式） */
	useGuide?: string;
	/** 来源：builtin=产品内置，undefined=用户/商城 */
	source?: string;
}

// ------------------------------------------------------------------------------------------------
// 节点图类型定义 — 供 ReactFlow 编辑器使用的节点/连接模型
// ------------------------------------------------------------------------------------------------

/** 节点类型 */
export const enum WorkflowNodeType {
	Start = 'start',
	End = 'end',
	Task = 'task',
	// New types — cc-wf-studio inspired
	Prompt = 'prompt',
	Agent = 'agent',
	Skill = 'skill',
	Tool = 'tool',
	IfElse = 'ifElse',
	Switch = 'switch',
	AskUser = 'askUser',
	Group = 'group',
	/** ComfyUI 兼容节点（LiteGraph 画布引入） */
	Comfy = 'comfy',
	/** ComfyTV 风格媒体 stage 节点 */
	ComfyStage = 'comfyStage',
}

/** 节点画布位置 */
export interface WorkflowNodePosition {
	x: number;
	y: number;
}

/** 节点数据（类型特定字段通过 data 透传） */
export interface WorkflowNodeData {
	label?: string;
	taskId?: string;
	branches?: BranchDef[];
	executorId?: string;
	// Prompt node
	prompt?: string;
	variables?: Record<string, string>;
	// Agent node
	agentId?: string;
	agentConfig?: { model?: string; tools?: string[]; memory?: string };
	/**
	 * Controls how much conversation context the agent node receives.
	 * - 'session' (default): shares the session with other agent nodes for the
	 *   same execution — full conversation history is available.
	 * - 'upstream-only': creates a fresh session; only upstream node outputs
	 *   are injected as a system message (no prior conversation history).
	 * - 'fresh': creates a fully isolated session with no upstream context at all.
	 */
	contextScope?: 'session' | 'upstream-only' | 'fresh';
	// Failure recovery: per-node retry policy (exponential backoff + jitter).
	retryMaxAttempts?: number;      // max retry attempts (default: 0)
	retryInitialDelayMs?: number;   // initial delay before first retry (default: 1000)
	retryBackoffMultiplier?: number;// backoff multiplier (default: 2)
	retryMaxDelayMs?: number;       // max delay between retries (default: 30000)
	// Failure recovery: per-node timeout policy.
	timeoutRunMs?: number;          // hard wall-clock timeout (default: 300000 = 5min)
	timeoutIdleMs?: number;         // max idle time without progress (default: 60000 = 1min)
	// Skill node
	skillName?: string;
	skillArgs?: Record<string, string>;
	// Tool node
	toolName?: string;
	toolParams?: Record<string, string>;
	// IfElse / Switch
	evaluationTarget?: string;
	// AskUser
	questionText?: string;
	options?: AskUserOption[];
	multiSelect?: boolean;
	useAiSuggestions?: boolean;
	// Group
	isCollapsed?: boolean;
	[key: string]: unknown;
}

export interface BranchDef {
	id: string;
	label: string;
	condition: string;
	isDefault?: boolean;
}

export interface AskUserOption {
	label: string;
	description?: string;
}

/** 节点图中的节点 */
export interface WorkflowGraphNode {
	id: string;
	type: WorkflowNodeType;
	name: string;
	position: WorkflowNodePosition;
	data?: WorkflowNodeData;
	parentId?: string;
	style?: { width?: number; height?: number };
}

/** 节点图中的连接（边） */
export interface WorkflowGraphConnection {
	id: string;
	from: string;
	to: string;
	fromPort?: string;
	toPort?: string;
	condition?: string;
}

// ------------------------------------------------------------------------------------------------
// 服务接口
// ------------------------------------------------------------------------------------------------

export const IWorkflowStorageService = createDecorator<IWorkflowStorageService>('workflowStorageService');

export interface IWorkflowStorageService {
	readonly _serviceBrand: undefined;

	/** 工作流列表发生变化时触发（创建/更新/删除） */
	readonly onDidChangeWorkflows: Event<void>;

	/**
	 * 列举当前激活工作区下 `.sarosworkspace/workflows/` 中的所有工作流。
	 * 如果没有激活工作区或目录不存在，返回空数组。
	 */
	listWorkflows(workspaceId?: string): Promise<IStoredWorkflow[]>;

	/** 读取单个工作流。 */
	getWorkflow(id: string, workspaceId?: string): Promise<IStoredWorkflow | undefined>;

	/**
	 * 创建工作流并写入文件。
	 * @returns 创建后的工作流（含生成的 id）
	 */
	createWorkflow(data: {
		name: string;
		description?: string;
		presetId?: string;
		agentId?: string;
		steps?: IStoredWorkflow['steps'];
		/** Optional slug — when provided, the workflow ID becomes `wf-{slug}`. Otherwise auto-generated from name. */
		slug?: string;
	}, workspaceId?: string): Promise<IStoredWorkflow>;

	/**
	 * 更新工作流（合并字段）并写回文件。
	 * `opts.autoCommit`（缺省 true）控制是否触发 git 版本提交：auto-save 传 false
	 * 以抑制版本爆炸（版本历史应只含用户有意义的检查点，而非高频自动持久化）。
	 */
	updateWorkflow(id: string, patch: Partial<IStoredWorkflow>, workspaceId?: string, opts?: { autoCommit?: boolean }): Promise<IStoredWorkflow>;

	/** v19: 重排工作流顺序并持久化。 */
	reorderWorkflows(orderedIds: string[], workspaceId?: string): Promise<void>;

	/** 删除工作流文件。 */
	deleteWorkflow(id: string, workspaceId?: string): Promise<void>;
}
