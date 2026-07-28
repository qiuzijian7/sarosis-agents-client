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
	/** 网关连接状态：只在状态迁移时打日志，避免刷屏。 */
	private _gatewayUp: boolean | undefined = undefined;
	/** 连续失败计数：单次 5s 超时（网关忙于压缩/大扫除）不判 down，连续 2 次才判（P2 去抖）。 */
	private _consecutiveFailures = 0;
	/** P1 写入重试队列：网关短暂不可达时 writeMemory 不再静默丢弃，
	 *  入队后在下次成功调用/定时器驱动下重放（上限 200 条防内存膨胀，单条最多 5 次）。 */
	private _writeQueue: Array<{ agentId: string; entry: any; attempts: number }> = [];
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushing = false;

	private _on(event: string, handler: (...args: any[]) => void): () => void {
		if (!this._handlers.has(event)) this._handlers.set(event, new Set());
		this._handlers.get(event)!.add(handler);
		return () => this._handlers.get(event)?.delete(handler);
	}
	private _emit(event: string, ...args: any[]): void {
		this._handlers.get(event)?.forEach(h => { try { h(...args); } catch { /* ignore */ } });
	}

	private _markGateway(up: boolean, method: string): void {
		if (up) {
			this._consecutiveFailures = 0;
			if (this._gatewayUp !== true) {
				this._gatewayUp = true;
				console.log(`[AgentMemory] gateway connected (first ok call: ${method})`);
			}
			return;
		}
		// 去抖：连续 2 次失败才判 down（单次超时多为网关忙于压缩/大扫除的瞬态）
		this._consecutiveFailures++;
		if (this._gatewayUp === false || this._consecutiveFailures < 2) { return; }
		this._gatewayUp = false;
		console.warn(`[AgentMemory] gateway UNREACHABLE — memory calls return empty defaults, writes queued for retry (failed: ${method})`);
	}

	/** 通用转发：POST /provider/<method> { args }，返回解析后的 JSON 或 null。
	 *
	 *  故障语义（2026-07-27 修正）：
	 *  - 网络层失败（连接拒绝/5s 超时）→ 才计入 UNREACHABLE 去抖；
	 *    冷启动期（_gatewayUp 未知，网关子进程可能仍在重建索引）额外重试 2 次
	 *    （500ms/1500ms 退避），消除"窗口刚起就发消息 → 误报 UNREACHABLE"竞态。
	 *  - HTTP 层失败（404 未知方法 / 500 方法内部抛错）→ 网关**可达**，
	 *    标记 up 并打方法级 warn，绝不误报 UNREACHABLE。
	 */
	async _call(method: string, ...args: any[]): Promise<any> {
		// 冷启动（本 renderer 生命周期内从未成功连过）多给 2 次机会；
		// 已连通过的网关瞬态失败沿用原有"连续 2 次才判 down"去抖，不加重试
		// （避免真宕机时每调用 5s×3 = 15s 悬挂）。
		const maxAttempts = this._gatewayUp === undefined ? 3 : 1;
		for (let attempt = 1; ; attempt++) {
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
				if (!resp.ok) {
					// 有响应 = 网关可达；是方法级故障（404 方法缺失 / 500 引擎抛错）
					this._markGateway(true, method);
					console.warn(`[AgentMemory] provider method '${method}' failed: HTTP ${resp.status} (gateway reachable — method-level error)`);
					return null;
				}
				const txt = await resp.text();
				const parsed = txt ? JSON.parse(txt) : null;
				this._markGateway(true, method);
				return parsed;
			} catch {
				if (attempt < maxAttempts) {
					await new Promise<void>(r => setTimeout(r, attempt === 1 ? 500 : 1500));
					continue;
				}
				this._markGateway(false, method);
				return null;
			}
		}
	}

	// ─── 核心异步方法（显式，保证事件与返回正确）────────────────────

	async loadContext(agentId: string, sessionId: string, query?: string, options?: any): Promise<any> {
		// 网关不可达时返回安全空上下文（避免下游 null.longTermMemories 崩溃）
		const ctx = (await this._call('loadContext', agentId, sessionId, query, options))
			?? { longTermMemories: [], shortTermMemories: [], injectedContext: '' };
		if (this._gatewayUp) {
			console.log(
				`[AgentMemory] loadContext agent=${agentId} session=${sessionId}: ` +
				`short=${ctx.shortTermMemories?.length ?? 0} long=${ctx.longTermMemories?.length ?? 0} ` +
				`sysPrompt=${(ctx.systemPrompt ?? '').length} chars`
			);
		}
		return ctx;
	}

	async writeMemory(agentId: string, entry: any): Promise<void> {
		const ok = await this._call('writeMemory', agentId, entry);
		const noticeId = entry?.metadata?.['noticeId'] as string | undefined;
		const memoryType = (entry?.metadata?.['memoryType'] as string) ?? entry?.type;
		if (ok) {
			// 网关 host.mjs 对 void 方法统一回 { ok: true } —— ok 为真即调用成功，
			// 本地补发 memory_written（网关宿主引擎的事件到不了 renderer，无 SSE 通道）。
			console.log(`[AgentMemory] writeMemory ok: agent=${agentId} type=${memoryType} len=${entry?.content?.length ?? 0}`);
			this._emit('memory_written', agentId, {
				memoryId: entry?.id ?? '',
				noticeId,
				memoryType,
				contentLength: entry?.content?.length ?? 0,
			});
			void this._flushWriteQueue(); // 网关恢复时顺带重放积压
		} else {
			// P1：不再静默丢弃 —— 入队重试（网关忙于压缩/大扫除的瞬态会恢复）
			this._enqueueWrite(agentId, entry);
			console.warn(`[AgentMemory] writeMemory FAILED (queued for retry): agent=${agentId} type=${memoryType} len=${entry?.content?.length ?? 0}`);
			this._emit('memory_write_failed', agentId, {
				noticeId,
				memoryType,
				error: 'memory gateway unavailable — queued for retry',
			});
		}
	}

	private _enqueueWrite(agentId: string, entry: any): void {
		if (this._writeQueue.length >= 200) {
			this._writeQueue.shift(); // 上限：丢最老一条，防内存膨胀
		}
		this._writeQueue.push({ agentId, entry, attempts: 0 });
		this._scheduleFlush();
	}

	private _scheduleFlush(): void {
		if (this._flushTimer !== undefined) { return; }
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			void this._flushWriteQueue();
		}, 3000);
	}

	private async _flushWriteQueue(): Promise<void> {
		if (this._flushing) { return; }
		this._flushing = true;
		try {
			while (this._writeQueue.length > 0) {
				const item = this._writeQueue[0];
				const ok = await this._call('writeMemory', item.agentId, item.entry);
				if (!ok) {
					item.attempts++;
					if (item.attempts >= 5) {
						this._writeQueue.shift();
						console.warn(`[AgentMemory] writeMemory dropped after 5 attempts: agent=${item.agentId} len=${item.entry?.content?.length ?? 0}`);
						continue;
					}
					break; // 网关仍不可达，等下一轮
				}
				this._writeQueue.shift();
				const entry = item.entry;
				console.log(`[AgentMemory] writeMemory replayed ok: agent=${item.agentId} len=${entry?.content?.length ?? 0}`);
				this._emit('memory_written', item.agentId, {
					memoryId: entry?.id ?? '',
					noticeId: entry?.metadata?.['noticeId'] as string | undefined,
					memoryType: (entry?.metadata?.['memoryType'] as string) ?? entry?.type,
					contentLength: entry?.content?.length ?? 0,
				});
			}
		} finally {
			this._flushing = false;
			if (this._writeQueue.length > 0) { this._scheduleFlush(); }
		}
	}

	async searchMemory(agentId: string, query: string): Promise<any[]> {
		const results = (await this._call('searchMemory', agentId, query)) ?? [];
		if (this._gatewayUp) {
			const q = (query ?? '').length > 40 ? query.slice(0, 40) + '…' : query;
			console.log(`[AgentMemory] searchMemory agent=${agentId} query="${q}" → ${results.length} results`);
		}
		return results;
	}

	async recallFormatted(agentId: string, query: string, strategy?: string, limit?: number): Promise<string> {
		return (await this._call('recallFormatted', agentId, query, strategy, limit)) ?? 'memory_recall: no results found';
	}

	/** 文件相关 bug 记忆（mem::enrich 复刻）——volatile 层「历史 bug 提示」注入用 */
	async bugMemoriesForFiles(agentId: string, files: string[], project?: string): Promise<Array<{ id: string; title: string; content: string }>> {
		return (await this._call('bugMemoriesForFiles', agentId, files, project)) ?? [];
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

	/** semantic scope 列表（mem:semantic）— memoryDetail 记忆视图聚合用 */
	async semanticList(agentId: string): Promise<any[]> {
		return (await this._call('semanticList', agentId)) ?? [];
	}

	/** procedural scope 列表（mem:procedural）— memoryDetail 记忆视图聚合用 */
	async proceduralList(agentId: string): Promise<any[]> {
		return (await this._call('proceduralList', agentId)) ?? [];
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

	/** 会话记录（KV.sessions）— Dashboard/memoryDetail 会话面板用 */
	async listSessions(agentId: string): Promise<any[]> {
		return (await this._call('listSessions', agentId)) ?? [];
	}

	/** 会话摘要（KV.summaries，按 createdAt desc，可 limit） */
	async listSummaries(agentId: string, limit?: number): Promise<any[]> {
		return (await this._call('listSummaries', agentId, limit)) ?? [];
	}

	/** 单会话观察列表（mem:obs:<agent>:<session>） */
	async observeList(agentId: string, sessionId: string): Promise<any[]> {
		return (await this._call('observeList', agentId, sessionId)) ?? [];
	}

	async triggerHook(type: string, ctx: Record<string, unknown>): Promise<void> {
		await this._call('triggerHook', type, ctx);
	}

	/**
	 * 定期维护清扫（调用网关 runMaintenanceSweep：全量清扫→技能提取→自动晶化）。
	 * 若网关提取到技能（result.skillExtracted），在本地 emit 'skill_extracted'
	 * 供 agentChatService._ensureMemoryEventBridge 显示技能沉淀卡片。
	 */
	async runMaintenanceSweep(agentId: string): Promise<Record<string, unknown>> {
		const result = (await this._call('runMaintenanceSweep', agentId)) ?? {};
		if (result && (result as any)['skillExtracted']) {
			const s = (result as any)['skillExtracted'];
			this._emit('skill_extracted', {
				agentId,
				data: {
					skillId: s.skillId ?? '',
					title: s.title ?? '未知技能',
					trigger: s.trigger ?? '',
					confidence: s.confidence ?? 0,
					steps: s.steps ?? 0,
				},
			});
		}
		return result;
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
	async updateMemory(agentId: string, id: string, updates: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		return (await this._call('updateMemory', agentId, id, updates)) ?? null;
	}
	async deleteMemory(agentId: string, id: string): Promise<boolean> {
		return (await this._call('deleteMemory', agentId, id)) ?? false;
	}
	getHookStats(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } | Promise<{ totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> }> {
		// Opt1：真实 HookSystem 在网关进程，必须异步转发（editor pane 会 await）。
		return this._call('getHookStats').then((r: any) => r ?? { totalHooks: 0, hooksByType: {}, callCounts: {} });
	}
	// Opt1：commit/audit 真实实例在网关进程，异步转发（renderer 已改为 await）。
	async getCommitStats(): Promise<Record<string, unknown>> {
		return (await this._call('getCommitStats')) ?? { totalCommits: 0 };
	}
	async getRecentCommits(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this._call('getRecentCommits', limit)) ?? [];
	}
	async getAuditLog(filter?: { limit?: number; agentId?: string }): Promise<Array<Record<string, unknown>>> {
		return (await this._call('getAuditLog', filter)) ?? [];
	}
	async onGitCommit(commit: { sha: string; message: string; author: string; filesChanged: string[]; insertions: number; deletions: number; timestamp: number; branch?: string }): Promise<void> {
		await this._call('onGitCommit', commit);
	}
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
		// 机制修复（原为 noop stub）：fire-and-forget 转发到网关 V2.onPreCompact ——
		// 引擎侧的真实工作是 fire-and-forget compressSession（压缩前写 session summary）。
		// 同步签名约束：本地立即返回空注入（与 V2 返回值语义一致）。
		// V2.onPreCompact 接收单个 ctx 对象，按其对齐参数形状。
		void this._call('onPreCompact', { agentId, sessionId, messages, tokensSaved: 0, contextWindow: tokenBudget });
		return { injectedContext: '', totalTokens: 0 };
	}
	onTaskCompleted(agentId: string, sessionId: string, taskSubject: string, taskId?: string): void {
		// 机制修复（原为 noop stub）：fire-and-forget 转发到网关 V2.onTaskCompleted
		// （coreAdd + sessionSummarySave，原版 task_completed hook 的等价物）。
		void this._call('onTaskCompleted', agentId, sessionId, taskSubject, taskId);
	}
	onSubagentStart(parentAgentId: string, task: string): unknown {
		// 转发到网关 V2.onSubagentStart（返回 { sessionId }）；同步签名下本地
		// 立即返回 undefined，引擎侧日志异步到达。
		void this._call('onSubagentStart', parentAgentId, task);
		return undefined;
	}
	onSubagentStop(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean {
		// 转发到网关 V2.onSubagentStop（completed 时写 [subagent_completed] 核心记忆）。
		void this._call('onSubagentStop', agentId, status, result, error);
		return true;
	}

	onMemoryWritten(handler: (agentId: string, data: { memoryId: string; noticeId?: string; memoryType?: string; contentLength?: number }) => void): () => void {
		return this._on('memory_written', handler);
	}
	onMemoryWriteFailed(handler: (agentId: string, data: { noticeId?: string; error: string; memoryType?: string }) => void): () => void {
		return this._on('memory_write_failed', handler);
	}

	// ─── 通用事件订阅（本地，对齐 V1 的 EventBus.on）────────────
	// Opt1 下网关不向 renderer 推送事件（无 SSE 通道），故这里只做
	// 本地注册，与 onMemoryWritten/onMemoryWriteFailed 一致；调用方
	// 通过返回的 unsub 注销。切勿让 Proxy 兜底把它转发成 HTTP，否则
	// 会 404 到 /provider/onEvent。
	onEvent(event: string, handler: (...args: any[]) => void): () => void {
		return this._on(event, handler);
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
