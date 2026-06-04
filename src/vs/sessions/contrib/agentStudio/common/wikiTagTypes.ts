/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wiki Tag Index — 面板侧类型定义
 * 与 wiki-tag-server MCP Server 的数据结构保持同步
 */

// ============ Tag Levels ============

export type TagLevel = 'domain' | 'entity' | 'L1' | 'L2';

/** Level priority for sorting (lower = more important) */
export const TAG_LEVEL_PRIORITY: Record<TagLevel, number> = {
	domain: 0,
	entity: 1,
	L1: 2,
	L2: 3,
};

/** Level color mapping */
export const TAG_LEVEL_COLORS: Record<TagLevel, string> = {
	domain: '#E24B4A',
	entity: '#D85A30',
	L1: '#BA7517',
	L2: '#378ADD',
};

// ============ Domain ============

export interface IDomainEntry {
	description: string;
	synonyms: string[];
	cross_refs: string[];
	status: 'active' | 'archived';
	created: string;
}

// ============ Tag ============

export interface ITagDefinition {
	level: 1 | 2;
	synonyms: string[];
	description: string;
	status: 'approved' | 'pending';
	created: string;
	parent?: string; // L1 parent for L2 tags
}

// ============ Entity ============

export interface IEntityEntry {
	description: string;
	synonyms: string[];
	created: string;
}

// ============ Proposal (LLM 提议) ============

export interface IProposalItem {
	id: string;               // unique identifier
	level: TagLevel;
	name: string;
	description: string;
	domain?: string;          // 所属 Domain（L1/L2 必填）
	parentL1?: string;        // 所属 L1（L2 必填）
	synonyms: string[];
	proposed_at: string;
	similar_existing?: string[]; // 近似已有标签名
}

// ============ Staging (待入库) ============

export interface IStagingItem {
	id: string;               // 与 proposal 同 id
	level: TagLevel;
	name: string;             // 可被用户修改
	originalName: string;     // 原始名
	description: string;
	domain?: string;
	parentL1?: string;
	synonyms: string[];
	approved_at: string;
}

// ============ Validation ============

export interface IValidationResult {
	valid: boolean;
	message?: string; // 错误原因
}

// ============ Tag Tree Node ============

export interface ITagTreeNode {
	name: string;
	level: TagLevel;
	description?: string;
	children: ITagTreeNode[];
}

// ============ Deletion Record ============

export interface IDeletionItem {
	tagPath: string;        // e.g. "GameDesign.Combat.Melee"
	level: TagLevel;
	displayName: string;
}

export interface IDeletionRecord {
	id: string;             // unique identifier
	timestamp: string;      // ISO 8601
	domain?: string;        // affected domain (for L1/L2 deletions)
	items: IDeletionItem[];
	processed: boolean;     // LLM sets true after cleanup
}

// ============ Rename Validation (for library tags) ============

export interface ITagRenameValidationResult {
	valid: boolean;
	message?: string;
}

// ============ Rejection Reason ============

/** Preset rejection reasons */
export const REJECTION_REASONS = [
	'标签太细节',
	'功能划分不正确',
	'与已有标签重复',
	'命名不规范',
	'不属于该 Domain',
] as const;

export type RejectionReason = typeof REJECTION_REASONS[number] | string;

// ============ Review Result (legacy compat) ============

export interface IReviewResult {
	processed: string[];
	skipped: string[];
	message: string;
}
