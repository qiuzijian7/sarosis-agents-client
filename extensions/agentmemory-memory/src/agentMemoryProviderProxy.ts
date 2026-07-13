/*---------------------------------------------------------------------------------------------
 *  AgentMemoryProviderProxy — Opt1 框架重设计（renderer 侧薄代理）
 *
 *  真实 IMemoryProvider 实现（引擎 amFunctions + 全部方法）已迁移到网关
 *  主进程（host.mjs）在进程内运行；本文件只是 renderer 侧的薄代理：
 *
 *    - 异步方法（loadContext / writeMemory / searchMemory / getStats / …）
 *      → HTTP POST /provider/<method>（网关内进程执行，零自环 HTTP）
 *    - 同步方法（getTimeline / getStats / onPreCompact / …）
 *      → 本地空默认（保持 IMemoryProvider 同步签名，避免返回 Promise 破坏调用方）
 *    - onMemoryWritten / onMemoryWriteFailed → 本地事件（UI 反馈在 renderer 触发）
 *
 *  renderer 扩展不再 import 任何引擎模块（amFunctions/amPipeline/…），
 *  重活全在网关进程，缓解 4GB renderer isolate 压力，符合
 *  「AgentMemoryProviderV2 不在插件中实现」的重构目标。
 *--------------------------------------------------------------------------------------------*/

import { serverBase, REQUEST_TIMEOUT_MS } from './serverConfig.js';

export class AgentMemoryProviderProxy {
	readonly id = 'agentmemory';
	readonly name = 'AgentMemory';

	private _handlers = new Map<string, Set<(...args: any[]) => void>>();
	private _providerBase = `${serverBase()}/provider`;

	private _on(event: string, handler: (...args: any[]) => void): () => void {
		if (!this._handlers.has(event)) this._handlers.set(event, new Set());
		this._handlers.get(event)!.add(handler);
		return () => this._handlers.get(event)?.delete(handler);
	}
	private _emit(event: string, ...args: any[]): void {
		this._handlers.get(event)?.forEach(h => { try { h(...args); } catch { /* ignore */ } });
	}

	/** 通用转发：POST /provider/<method> { args }，返回解析后的 JSON 或 null。 */
	async _call(method: string, ...args: any[]): Promise<any> {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
			const resp = await fetch(`${this._providerBase}/${encodeURIComponent(method)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ args }),
				signal: ctrl.signal,
			});
			clearTimeout(timer);
			if (!resp.ok) return null;
			const txt = await resp.text();
			return txt ? JSON.parse(txt) : null;
		} catch {
			return null;
		}
	}

	// ─── 核心异步方法（显式，保证事件与返回正确）────────────────────

	async loadContext(agentId: string, sessionId: string, query?: string, options?: any): Promise<any> {
		return this._call('loadContext', agentId, sessionId, query, options);
	}

	async writeMemory(agentId: string, entry: any): Promise<void> {
		const ok = await this._call('writeMemory', agentId, entry);
		if (ok) {
			const noticeId = entry?.metadata?.['noticeId'] as string | undefined;
			const memoryType = (entry?.metadata?.['memoryType'] as string) ?? entry?.type;
			this._emit('memory_written', agentId, {
				memoryId: entry?.id ?? '',
				noticeId,
				memoryType,
				contentLength: entry?.content?.length ?? 0,
			});
		}
	}

	async searchMemory(agentId: string, query: string): Promise<any[]> {
		return (await this._call('searchMemory', agentId, query)) ?? [];
	}

	async recallFormatted(agentId: string, query: string, strategy?: string, limit?: number): Promise<string> {
		return (await this._call('recallFormatted', agentId, query, strategy, limit)) ?? 'memory_recall: no results found';
	}

	async reinforceMemory(agentId: string, memId: string): Promise<boolean> {
		return (await this._call('reinforceMemory', agentId, memId)) ?? false;
	}

	async forgetMemory(agentId: string, memId: string): Promise<boolean> {
		return (await this._call('forgetMemory', agentId, memId)) ?? false;
	}

	async getStats(agentId: string): Promise<Record<string, unknown>> {
		return (await this._call('getStats', agentId)) ?? {};
	}

	async getExtendedStats(agentId: string): Promise<Record<string, unknown>> {
		return (await this._call('getExtendedStats', agentId)) ?? {};
	}

	async coreMemoryAdd(agentId: string, content: string, importance?: number, pinned?: boolean): Promise<string> {
		return (await this._call('coreMemoryAdd', agentId, content, importance, pinned)) ?? '';
	}

	async coreMemoryRemove(agentId: string, id: string): Promise<boolean> {
		return (await this._call('coreMemoryRemove', agentId, id)) ?? false;
	}

	async coreMemoryList(agentId: string): Promise<any[]> {
		return (await this._call('coreMemoryList', agentId)) ?? [];
	}

	async lessonSave(agentId: string, content: string, context?: string, confidence?: number, project?: string): Promise<any> {
		return (await this._call('lessonSave', agentId, content, context, confidence, project)) ?? { action: 'error', id: '' };
	}

	async lessonRecall(agentId: string, query: string, project?: string, limit?: number): Promise<any[]> {
		return (await this._call('lessonRecall', agentId, query, project, limit)) ?? [];
	}

	async removeAgent(agentId: string): Promise<void> {
		await this._call('removeAgent', agentId);
	}

	async getSlots(agentId: string): Promise<Array<{ name: string; content: string }>> {
		return (await this._call('getSlots', agentId)) ?? [];
	}

	async getProfile(agentId: string): Promise<Record<string, unknown> | null> {
		return (await this._call('getProfile', agentId)) ?? null;
	}

	async getLessons(agentId: string): Promise<Array<{ id: string; content: string; context?: string; tags?: string[] }>> {
		return (await this._call('getLessons', agentId)) ?? [];
	}

	async addLesson(agentId: string, content: string, context?: string, tags?: string[]): Promise<{ id: string; content: string }> {
		return (await this._call('addLesson', agentId, content, context, tags)) ?? { id: '', content };
	}

	async deleteLesson(agentId: string, lessonId: string): Promise<void> {
		await this._call('deleteLesson', agentId, lessonId);
	}

	async getEpisodicMemories(agentId: string): Promise<any[]> {
		return (await this._call('getEpisodicMemories', agentId)) ?? [];
	}

	async getSemanticMemories(agentId: string): Promise<any[]> {
		return (await this._call('getSemanticMemories', agentId)) ?? [];
	}

	async getProceduralMemories(agentId: string): Promise<any[]> {
		return (await this._call('getProceduralMemories', agentId)) ?? [];
	}

	async getConsolidationContext(agentId: string): Promise<string> {
		return (await this._call('getConsolidationContext', agentId)) ?? '';
	}

	async getRelations(agentId: string, memoryId: string): Promise<any[]> {
		return (await this._call('getRelations', agentId, memoryId)) ?? [];
	}

	async getRelationStats(agentId: string): Promise<Record<string, number>> {
		return (await this._call('getRelationStats', agentId)) ?? {};
	}

	async getReplaySession(sessionId: string): Promise<any> {
		return (await this._call('getReplaySession', sessionId)) ?? null;
	}

	async getReplaySessions(agentId: string): Promise<any[]> {
		return (await this._call('getReplaySessions', agentId)) ?? [];
	}

	async searchAllAgents(query: string): Promise<Array<Record<string, unknown>>> {
		return (await this._call('searchAllAgents', query)) ?? [];
	}

	async listAllAgentsWithData(): Promise<string[]> {
		return (await this._call('listAllAgentsWithData')) ?? [];
	}

	async triggerHook(type: string, ctx: Record<string, unknown>): Promise<void> {
		await this._call('triggerHook', type, ctx);
	}

	// ─── 同步桩（保持 IMemoryProvider 同步签名，本地返回空默认）────

	getTimeline(agentId: string): unknown[] { return []; }
	getAuditSummary(): Record<string, number> { return { totalAuditEntries: 0 }; }
	// ─── 技能方法（真实引擎在网关进程，统一异步转发）────
	// agentId 为首参，对齐 host.mjs 的 /provider 路由约定（首参即 agentId）。
	async getSkillStats(agentId: string): Promise<{ totalSkills: number; avgConfidence: number; avgSteps: number; totalUsage: number; writtenCount: number }> {
		return (await this._call('getSkillStats', agentId)) ?? { totalSkills: 0, avgConfidence: 0, avgSteps: 0, totalUsage: 0, writtenCount: 0 };
	}
	async listSkills(agentId: string, filter?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
		return (await this._call('listSkills', agentId, filter)) ?? [];
	}
	async addSkill(agentId: string, data: { title: string; trigger: string; steps: string[]; expectedOutcome?: string; tags?: string[] }): Promise<Record<string, unknown> | null> {
		return (await this._call('addSkill', agentId, data)) ?? null;
	}
	async writeSkillFile(agentId: string, skillId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
		return (await this._call('writeSkillFile', agentId, skillId)) ?? { ok: false, error: 'network error' };
	}
	async deleteSkillFile(agentId: string, skillId: string): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
		return (await this._call('deleteSkillFile', agentId, skillId)) ?? { ok: false, error: 'network error' };
	}
	async writeAllSkillFiles(agentId: string): Promise<{ written: number; failed: number; errors: string[] }> {
		return (await this._call('writeAllSkillFiles', agentId)) ?? { written: 0, failed: 0, errors: [] };
	}
	async updateSkill(agentId: string, id: string, updates: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		return (await this._call('updateSkill', agentId, id, updates)) ?? null;
	}
	async deleteSkill(agentId: string, id: string): Promise<boolean> {
		return (await this._call('deleteSkill', agentId, id)) ?? false;
	}
	getHookStats(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } | Promise<{ totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> }> {
		// Opt1：真实 HookSystem 在网关进程，必须异步转发（editor pane 会 await）。
		return this._call('getHookStats').then((r: any) => r ?? { totalHooks: 0, hooksByType: {}, callCounts: {} });
	}
	getCommitStats(): Record<string, unknown> { return { totalCommits: 0 }; }
	getRecentCommits(): Array<Record<string, unknown>> { return []; }
	getAuditLog(): Array<Record<string, unknown>> { return []; }
	traceProvenance(agentId: string, memoryId: string): Record<string, unknown> | null { return null; }
	// setSlot/getSlot：IMemoryProvider 签名为同步（V1 兼容），但真实
	// 引擎在网关进程，必须异步转发。调用方（editor pane）用 `?.` 且忽略
	// 返回值，返回 Promise<void> 仍可赋值为 void 签名，不破坏契约。
	async setSlot(agentId: string, label: string, content: string): Promise<void> {
		await this._call('setSlot', agentId, label, content);
	}
	async getSlot(agentId: string, label: string): Promise<string> {
		return (await this._call('getSlot', agentId, label)) ?? '';
	}
	onPreCompact(agentId: string, sessionId: string, messages: Array<{ role: string; content: string; timestamp: number }>, tokenBudget: number): { injectedContext: string; totalTokens: number } {
		return { injectedContext: '', totalTokens: 0 };
	}
	onTaskCompleted(agentId: string, sessionId: string, taskSubject: string, taskId?: string): void { /* noop (hosted) */ }
	onGitCommit(commit: { sha: string; message: string; author: string; filesChanged: string[]; insertions: number; deletions: number; timestamp: number; branch?: string }): unknown { return undefined; }
	onSubagentStart(parentAgentId: string, task: string): unknown { return undefined; }
	onSubagentStop(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean { return true; }

	onMemoryWritten(handler: (agentId: string, data: { memoryId: string; noticeId?: string; memoryType?: string; contentLength?: number }) => void): () => void {
		return this._on('memory_written', handler);
	}
	onMemoryWriteFailed(handler: (agentId: string, data: { noticeId?: string; error: string; memoryType?: string }) => void): () => void {
		return this._on('memory_write_failed', handler);
	}

	// ─── 兜底：未显式声明的方法一律转发网关（多为 async 高级特性）────
	constructor() {
		const self = this;
		return new Proxy(this, {
			get(target, prop: string) {
				if (typeof prop !== 'string') return (target as any)[prop];
				if (prop in target) return (target as any)[prop];
				// 未声明方法 → 转发到网关（保持与宿主 Provider 方法名一致）
				return (...args: any[]) => (self as any)._call(prop, ...args);
			},
		});
	}

	dispose(): void {
		this._handlers.clear();
	}
}
