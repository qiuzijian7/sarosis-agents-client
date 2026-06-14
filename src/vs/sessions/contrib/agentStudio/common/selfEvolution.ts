/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Self-Evolution (自进化) 系统类型定义。
 *
 * 设计参考：Hermes-Agent 的闭环学习系统 (Closed Learning Loop)。
 *
 * 核心机制：
 * - 每个 Agent 在对话达到一定阈值后，触发后台审查
 * - 审查后台 Agent 分析对话历史，决定是否需要：
 *   1. 创建/更新 Skill
 *   2. 更新记忆 (Memory)
 *   3. 修改配置文件
 * - 所有进化操作记录为 EvolutionRecord，可追溯
 *
 * 存储位置：
 *   全局: `<userRoamingDataHome>/saros/evolution/`
 *   工作区: `<workspace>/.sarosworkspace/agents/<agentId>/evolution/`
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

// --- Evolution Record Types ---

/**
 * 进化触发来源
 */
export type EvolutionTrigger =
	| 'nudge_memory'       // 记忆审查 nudge（N轮对话后）
	| 'nudge_skill'        // 技能审查 nudge（N次工具调用后）
	| 'nudge_combined'     // 组合审查（同时审查记忆+技能）
	| 'curator'            // Curator 定期审查
	| 'manual';            // 用户手动触发

/**
 * 进化操作类型
 */
export type EvolutionAction =
	| 'skill_created'      // 创建了新 Skill
	| 'skill_updated'      // 更新了已有 Skill (patch)
	| 'skill_merged'       // 合并了多个 Skill
	| 'skill_archived'     // 归档了 Skill
	| 'memory_updated'     // 更新了记忆
	| 'config_updated'     // 更新了配置文件
	| 'file_modified';     // 修改了文件

/**
 * 文件差异信息
 */
export interface IFileDiff {
	/** 文件路径 (相对于 agent 目录或 workspace 目录) */
	readonly filePath: string;
	/** 文件 URI */
	readonly fileUri?: URI;
	/** 变更类型 */
	readonly changeType: 'created' | 'modified' | 'deleted';
	/** 变更前内容片段 (用于 diff 展示，可选) */
	readonly before?: string;
	/** 变更后内容片段 */
	readonly after?: string;
	/** 差异行数 */
	readonly linesAdded?: number;
	readonly linesRemoved?: number;
}

/**
 * 生成的 Skill 信息
 */
export interface IGeneratedSkill {
	/** Skill ID */
	readonly skillId: string;
	/** Skill 名称 */
	readonly skillName: string;
	/** 操作类型 */
	readonly action: 'created' | 'updated' | 'merged' | 'archived';
	/** Skill 存储路径 */
	readonly storagePath: string;
	/** Skill 文件 URI */
	readonly storageUri?: URI;
	/** Skill 来源标记 */
	readonly provenance: 'foreground' | 'background_review' | 'curator';
}

/**
 * 单条进化记录
 */
export interface IEvolutionRecord {
	/** 唯一 ID */
	readonly id: string;
	/** 时间戳 (ISO 8601) */
	readonly timestamp: string;
	/** 触发来源 */
	readonly trigger: EvolutionTrigger;
	/** 执行的操作列表 */
	readonly actions: readonly EvolutionAction[];
	/** 所属 Workspace ID */
	readonly workspaceId: string;
	/** 所属 Workspace 名称 */
	readonly workspaceName: string;
	/** 所属 Agent ID */
	readonly agentId: string;
	/** Agent 名称 */
	readonly agentName: string;
	/** Agent Emoji */
	readonly agentEmoji?: string;
	/** 触发进化的上下文摘要 (基于什么信息) */
	readonly contextSummary: string;
	/** 修改的文件列表 (差异信息) */
	readonly fileDiffs: readonly IFileDiff[];
	/** 生成/更新的 Skill */
	readonly generatedSkills: readonly IGeneratedSkill[];
	/** 简短摘要 (用于列表展示) */
	readonly summary: string;
	/** 详细说明 */
	readonly detail?: string;
	/** 进化持续时间 (毫秒) */
	readonly durationMs?: number;
	/** 使用的 token 数 */
	readonly tokensUsed?: number;
}

/**
 * 进化配置 (per-agent)
 */
export interface IEvolutionConfig {
	/** 是否启用自进化 */
	readonly enabled: boolean;
	/** 记忆审查间隔 (每 N 轮用户对话) */
	readonly memoryNudgeInterval: number;
	/** 技能审查间隔 (每 N 次工具调用) */
	readonly skillNudgeInterval: number;
	/** Curator 运行间隔 (天) */
	readonly curatorIntervalDays: number;
	/** 技能 stale 阈值 (天) */
	readonly staleThresholdDays: number;
	/** 技能 archive 阈值 (天) */
	readonly archiveThresholdDays: number;
}

/**
 * 默认进化配置
 */
export const DEFAULT_EVOLUTION_CONFIG: IEvolutionConfig = {
	enabled: true,
	memoryNudgeInterval: 10,
	skillNudgeInterval: 10,
	curatorIntervalDays: 7,
	staleThresholdDays: 30,
	archiveThresholdDays: 90,
};

// --- Service Interface ---

export const ISelfEvolutionService = createDecorator<ISelfEvolutionService>('selfEvolutionService');

export interface ISelfEvolutionService {
	readonly _serviceBrand: undefined;

	/** 进化记录变更事件 */
	readonly onDidChangeRecords: Event<void>;

	/** 进化进行中事件 (用于 UI 反馈) */
	readonly onDidStartEvolution: Event<{ agentId: string; trigger: EvolutionTrigger }>;

	/** 进化完成事件 */
	readonly onDidCompleteEvolution: Event<IEvolutionRecord>;

	// --- Query ---

	/** 获取所有进化记录（按时间倒序） */
	getRecords(options?: { workspaceId?: string; agentId?: string; limit?: number }): readonly IEvolutionRecord[];

	/** 按 ID 获取单条记录 */
	getRecord(id: string): IEvolutionRecord | undefined;

	/** 获取指定 Agent 的进化配置 */
	getConfig(agentId: string): IEvolutionConfig;

	// --- Mutation ---

	/** 更新指定 Agent 的进化配置 */
	updateConfig(agentId: string, config: Partial<IEvolutionConfig>): void;

	/** 手动触发某个 Agent 的进化审查 */
	triggerEvolution(agentId: string, trigger?: EvolutionTrigger): Promise<IEvolutionRecord | undefined>;

	/** 记录一次进化 (由内部模块调用) */
	recordEvolution(record: IEvolutionRecord): void;

	/** 删除指定记录 */
	deleteRecord(id: string): void;

	/** 清除指定 Agent 的所有记录 */
	clearRecords(agentId: string): void;

	// --- Nudge Tracking ---

	/** 通知一次用户对话轮次 (用于记忆 nudge 计数) */
	notifyUserTurn(agentId: string): void;

	/** 通知一次工具调用迭代 (用于技能 nudge 计数) */
	notifyToolIteration(agentId: string, iterationCount: number): void;

	// --- Lifecycle ---

	/** 重新加载记录 */
	reload(): Promise<void>;
}

// --- Editor Input Types ---

/**
 * 进化详情编辑器输入的数据
 */
export interface IEvolutionDetailData {
	readonly recordId: string;
	readonly record: IEvolutionRecord;
}
