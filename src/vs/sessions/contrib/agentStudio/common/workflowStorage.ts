/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// workflowStorage.ts - 工作流文件存储服务接口
// ------------------------------------------------------------------------------------------------
//
// 作用: 将工作流以 JSON 文件形式持久化到当前工作区的
//       `.sarosisworkspace/workflows/` 目录下，支持读取、写入、列举、删除。
//
// 与 CrewTeamService 的区别:
// - CrewTeamService 用 IStorageService（浏览器存储）持久化，不落地到工作区文件。
// - WorkflowStorageService 直接用 IFileService 写文件到 .sarosisworkspace/workflows/，
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
}

// ------------------------------------------------------------------------------------------------
// 节点图类型定义 — 供 ReactFlow 编辑器使用的节点/连接模型
// ------------------------------------------------------------------------------------------------

/** 节点类型 */
export const enum WorkflowNodeType {
	Start = 'start',
	End = 'end',
	Task = 'task',
	Condition = 'condition',
	Parallel = 'parallel',
	Loop = 'loop',
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
	condition?: string;
	branches?: Array<{ id: string; label: string; condition: string }>;
	parallelSteps?: string[];
	loopConfig?: { items: string; itemVariable: string };
	executorId?: string;
	[key: string]: unknown;
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
	 * 列举当前激活工作区下 `.sarosisworkspace/workflows/` 中的所有工作流。
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
	}, workspaceId?: string): Promise<IStoredWorkflow>;

	/** 更新工作流（合并字段）并写回文件。 */
	updateWorkflow(id: string, patch: Partial<IStoredWorkflow>, workspaceId?: string): Promise<IStoredWorkflow>;

	/** 删除工作流文件。 */
	deleteWorkflow(id: string, workspaceId?: string): Promise<void>;
}
