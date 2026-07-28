/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 版本管理类型定义。
 * 参考 KB 系统的 KbVersionTypes，用于 agent 的 git 版本控制。
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Agent 工作区状态
 */
export interface AgentCommitMeta {
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
export interface AgentDiffLine {
	readonly kind: 'context' | 'add' | 'remove';
	readonly text: string;
}

/** Diff hunk */
export interface AgentDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: readonly AgentDiffLine[];
}

/** 完整 Diff 结果 */
export interface AgentDiffResult {
	readonly fromSha: string;
	readonly toSha: string;
	readonly hunks: readonly AgentDiffHunk[];
	/** Unified diff 文本 */
	readonly unified: string;
}

/**
 * Agent 版本管理服务接口（DI token: IAgentVersionService）
 */
export interface IAgentVersionService {
	readonly _serviceBrand: undefined;

	/** 初始化 agent 目录为 git 仓库（仅首次） */
	init(agentId: string): Promise<void>;

	/** 自动提交 .agent.md 变更（无变化则跳过） */
	autoCommit(agentId: string): Promise<string | null>;

	/** 获取 .agent.md 的提交历史（默认 50 条） */
	history(agentId: string, limit?: number): Promise<AgentCommitMeta[]>;

	/** 获取某次提交的 diff */
	diff(agentId: string, sha: string): Promise<AgentDiffResult | null>;

	/** 读取某次提交的 .agent.md 内容（不修改工作区） */
	fileAtVersion(agentId: string, sha: string): Promise<string>;

	/** 回滚 .agent.md 到指定版本（覆盖工作区，不自动提交） */
	rollback(agentId: string, sha: string): Promise<string>;
}

/** DI token */
export const IAgentVersionService = createDecorator<IAgentVersionService>('agentVersionService');
