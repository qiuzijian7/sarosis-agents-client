/*---------------------------------------------------------------------------------------------
 *  记忆门面 — 简化的统一 API 入口。
 *
 *  解决问题：memoryProvider.ts 已暴露 200+ 方法，调用方难以选择正确的方法。
 *  MemoryFacade 提供高层级 API，内部编排多个模块。
 *
 *  高层级 API：
 *    1. remember(agentId, content, opts) — 智能写入（自动去重 + 压缩 + 索引 + 持久化）
 *    2. recall(agentId, query, opts) — 智能召回（模糊 + BM25 + Vector + 滑动窗口）
 *    3. forget(agentId, id, opts) — 智能遗忘（级联删除 + 索引清理 + 审计）
 *    4. reflect(agentId) — 智能反思（评分 + 固化 + 清理）
 *    5. status(agentId) — 统一状态（聚合所有模块统计）
 *--------------------------------------------------------------------------------------------*/

export interface RememberOptions {
	importance?: number;
	type?: 'working' | 'episodic' | 'semantic' | 'procedural';
	tags?: string[];
	concepts?: string[];
	files?: string[];
	sessionId?: string;
	source?: string;
	skipDedup?: boolean;
	skipCompress?: boolean;
	skipIndex?: boolean;
}

export interface RecallOptions {
	limit?: number;
	tokenBudget?: number;
	includeSlots?: boolean;
	includeWorkingMemory?: boolean;
	includeConsolidation?: boolean;
	fuzzy?: boolean;
	fuzzyThreshold?: number;
}

export interface ForgetOptions {
	cascade?: boolean;       // 级联删除关联资源
	cleanupIndex?: boolean; // 清理索引
	reason?: string;
}

export interface MemoryStatus {
	agentId: string;
	longTermCount: number;
	shortTermCount: number;
	strengthDistribution: { high: number; medium: number; low: number; superseded: number };
	topConcepts: Array<{ concept: string; count: number }>;
	topFiles: Array<{ file: string; count: number }>;
	lastWriteAt: number;
	lastSearchAt: number;
	indexHealth: { bm25: boolean; vector: boolean; graph: boolean };
}

export interface FacadeResult<T> {
	success: boolean;
	result?: T;
	warnings: string[];
	elapsedMs: number;
}

/**
 * 门面接口 — 定义高层级 API 契约
 * 实际实现由 memoryProvider.ts 提供
 */
export interface IMemoryFacade {
	remember(agentId: string, content: string, opts?: RememberOptions): Promise<FacadeResult<string>>;
	recall(agentId: string, query: string, opts?: RecallOptions): Promise<FacadeResult<unknown[]>>;
	forget(agentId: string, memoryId: string, opts?: ForgetOptions): Promise<FacadeResult<boolean>>;
	reflect(agentId: string): Promise<FacadeResult<unknown>>;
	status(agentId: string): Promise<FacadeResult<MemoryStatus>>;
}

/**
 * 门面实现的基类（不含具体逻辑，由 provider 填充）
 */
export abstract class MemoryFacadeBase implements IMemoryFacade {
	abstract remember(agentId: string, content: string, opts?: RememberOptions): Promise<FacadeResult<string>>;
	abstract recall(agentId: string, query: string, opts?: RecallOptions): Promise<FacadeResult<unknown[]>>;
	abstract forget(agentId: string, memoryId: string, opts?: ForgetOptions): Promise<FacadeResult<boolean>>;
	abstract reflect(agentId: string): Promise<FacadeResult<unknown>>;
	abstract status(agentId: string): Promise<FacadeResult<MemoryStatus>>;
}

/**
 * 辅助工具：构建 FacadeResult
 */
export function successResult<T>(result: T, warnings: string[] = [], startTime: number): FacadeResult<T> {
	return { success: true, result, warnings, elapsedMs: Date.now() - startTime };
}

export function errorResult<T>(error: string, startTime: number, warnings: string[] = []): FacadeResult<T> {
	return { success: false, warnings: [error, ...warnings], elapsedMs: Date.now() - startTime };
}
