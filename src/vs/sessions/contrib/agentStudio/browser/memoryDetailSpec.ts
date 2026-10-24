/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 记忆条目的**类型定义与层筛选规格**（2026-10-24 从 `memoryDetailEditorPane.ts` 外提）。
 *
 * 为什么外提：`fileSizeBudget.test.ts` 预算是 2500 行，那个文件涨到 2503。**不能靠压行/删注释**
 * 去凑 ✓（指标好看、债务还在），所以搬走的是这一段**纯类型 + 纯函数**：条目形状、筛选器取值域、
 * 原生类型集合、层级匹配规则。它们与 DOM、服务、视图生命周期都无关 ⇒ 搬家零行为变化 ✓。
 *
 * ⚠ `CATEGORY_HOVER_CLS` / `CATEGORY_TRIGGER_TIPS`（给用户看的提示文案）**留在视图侧**：
 *   那两张表只被该视图使用，搬过来反而把"规格"与"展示文案"混在一处。
 */

export interface IMemoryEntry {
	id: string;
	type: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

/**
 * agentmemory 原生类型筛选器 — 直接使用 Memory.type 值，不再做 4-Tier 映射。
 * 所有 agentmemory 细分类型（pattern/preference/bug/fact/architecture/workflow）均为一级筛选标签。
 */
export type LayerFilter = 'all' | 'working' | 'episodic' | 'semantic' | 'procedural'
	| 'pattern' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'fact';

/** Episodic 层的原生类型集合（agentmemory 原版：KV.memories 内 Memory.type 的合法值） */
export const EPISODIC_TYPES: ReadonlySet<string> = new Set(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']);

export function isEpisodicType(type: string): boolean { return EPISODIC_TYPES.has(type); }
