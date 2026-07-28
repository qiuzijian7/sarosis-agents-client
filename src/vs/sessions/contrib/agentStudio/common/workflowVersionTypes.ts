/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow 版本管理类型定义。
 * 参考 Agent 系统的 AgentVersionTypes，基于 isomorphic-git 的 per-workflow git 版本控制。
 *
 * 每个工作流目录（~/.vssaros/workflows/<id>/）包含一个独立的 .git 仓库，
 * 追踪 workflow.json 的变更历史。
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** 提交元数据 */
export interface WorkflowCommitMeta {
	/** 完整 SHA */
	readonly sha: string;
	/** 简短 SHA（前 7 位） */
	readonly shortSha: string;
	/** 提交消息 */
	readonly message: string;
	/** 作者 */
	readonly author: string;
	/** 提交时间（ISO 8601） */
	readonly time: string;
}

/** Diff 行 */
export interface WorkflowDiffLine {
	readonly kind: 'context' | 'add' | 'remove';
	readonly text: string;
}

/** Diff hunk */
export interface WorkflowDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: readonly WorkflowDiffLine[];
}

/** 完整 Diff 结果 */
export interface WorkflowDiffResult {
	readonly fromSha: string;
	readonly toSha: string;
	readonly hunks: readonly WorkflowDiffHunk[];
	/** Unified diff 文本 */
	readonly unified: string;
}

/**
 * Workflow 版本管理服务接口。
 *
 * 每个 workflow 在其存储目录下维护一个独立的 `.git` 仓库，
 * 每次 `updateWorkflow` 保存时自动 commit workflow.json。
 */
export interface IWorkflowVersionService {
	readonly _serviceBrand: undefined;

	/** 检查 isomorphic-git 是否可用（仅桌面端 Electron renderer） */
	isAvailable(): boolean;

	/** 初始化 workflow 目录为 git 仓库（仅首次） */
	init(workflowId: string): Promise<void>;

	/** 自动提交 workflow.json 变更（无变化则跳过，返回 sha 或 null） */
	autoCommit(workflowId: string): Promise<string | null>;

	/** 获取 workflow.json 的提交历史（默认 50 条） */
	history(workflowId: string, limit?: number): Promise<WorkflowCommitMeta[]>;

	/** 获取某次提交的 diff */
	diff(workflowId: string, sha: string): Promise<WorkflowDiffResult | null>;

	/** 读取某次提交的 workflow.json 内容（不修改工作区） */
	workflowAtVersion(workflowId: string, sha: string): Promise<string>;

	/** 回滚 workflow.json 到指定版本（覆盖工作区，不自动提交） */
	rollback(workflowId: string, sha: string): Promise<string>;
}

/** DI token */
export const IWorkflowVersionService = createDecorator<IWorkflowVersionService>('workflowVersionService');
