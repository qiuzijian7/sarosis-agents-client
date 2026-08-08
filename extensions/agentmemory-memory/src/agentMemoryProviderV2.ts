/*---------------------------------------------------------------------------------------------
 *  AgentMemoryProviderV2 — 统一 IMemoryProvider 实现
 *
 *  废弃 V1 AgentMemoryProvider，统一使用 V2 无状态函数式架构：
 *    - 无运行时内存 Map（所有数据从 StateKV / BM25Index / VectorIndex 读取）
 *    - 独立 KV scope（mem:memories / mem:core-memory / mem:lessons / mem:insights / ...）
 *    - 每条记忆是独立 KV key-value（非 JSONL 批量 blob）
 *    - 完全实现 IMemoryProvider 接口 + 所有可选方法
 *--------------------------------------------------------------------------------------------*/

import type { IMemoryEntry, IMemoryContext, Memory } from './amTypes.js';
import { KV } from './amSchema.js';
import { StateKV } from './stateKV.js';
import { checkHealth, serverBase, REQUEST_TIMEOUT_MS } from './serverConfig.js';
import * as fn from './amFunctions.js';
import * as pipe from './amPipeline.js';
import * as slots from './amSlots.js';
import * as feat from './amFeatures.js';
import * as extra from './amExtras.js';
import * as adv from './amAdvanced.js';
import * as repl from './amReplication.js';
import * as rem from './amRemaining.js';
import * as fin from './amFinal.js';
import * as compress from './amCompress.js';
import { HookSystem } from './hooks.js';
import { AuditLog } from './auditLog.js';
import { PostCommitCapture } from './postCommitCapture.js';
import { ReportGenerator } from './reportGenerator.js';
import {
	createSessionStartHook,
	createUserPromptSubmitHook,
	createPreToolUseHook,
	createPostToolUseHook,
	createPostToolFailureHook,
	createPreCompactHook,
	createStopHook,
	createSessionEndHook,
	createTaskCompletedHook,
	createNotificationHook,
} from './hooks.js';
import * as skillX from './skillExtract.js';
import { promises as _fs } from 'node:fs';
import _path from 'node:path';
import _os from 'node:os';

// ─── Plan C: BM25/Vector 索引已下沉到网关主进程 ─────────────────
// 这里只保留「网关 HTTP 代理」：amFunctions 的混合召回逻辑保持不变，
// 但实际的索引检索改由网关 /search 端点提供，renderer 不再持有任何索引
// 内存（消除「重活塞 4GB renderer isolate」的反模式）。

// 2026-07-25 P1 并发安全：agentId 改为构造期绑定（每次调用新建实例），
// 删除 static currentAgent 可变字段——多 agent 并发调用时旧实现互相覆盖，
// 导致跨 agent 召回泄漏。
class ServerBM25Proxy {
	private _size = 0;
	constructor(private readonly _agentId: string) { }
	get size(): number { return this._size; }
	get available(): boolean { return true; }
	async search(query: string, limit = 20): Promise<Array<{ id: string; score: number }>> {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
			const resp = await fetch(`${serverBase()}/search/${encodeURIComponent(this._agentId)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query, limit }),
				signal: ctrl.signal,
			});
			clearTimeout(timer);
			if (!resp.ok) return [];
			const data = await resp.json() as Array<{ id: string; score: number }>;
			this._size = data.length;
			return data;
		} catch {
			return [];
		}
	}
}

class ServerVectorProxy {
	get size(): number { return 0; }
	get available(): boolean { return false; }
	async search(_query: string, _limit = 20): Promise<Array<{ id: string; score: number }>> { return []; }
}

const _vectorProxy = new ServerVectorProxy();

// 全量列出上限（searchMemory 空查询 / '*'）：UI 侧栏/详情面板用空查询拉取
// 全部记忆做分类统计；1000 足以覆盖实际规模，同时避免 KV 全表扫描失控。
const SEARCH_ALL_LIMIT = 1000;

// 技能文件根目录：与渲染进程 skillRegistryService 的读取路径保持一致
// （~/.vssaros(-dev)/skills/）。主进程 spawn 网关时注入 AGENTMEMORY_SKILLS_DIR
// （= <userDataPath>/skills，dev 下为 ~/.vssaros-dev/skills）；缺失注入时回退
// 到 dev 感知目录（VSCODE_DEV 决定 .vssaros-dev，与 product.ts 一致）。
// 历史曾硬编码 ~/.saros/skills，与渲染进程读取位置不一致，导致引擎写出的
// SKILL.md 不可见。
function _skillsDir(): string {
	const folder = process.env.VSCODE_DEV ? '.vssaros-dev' : '.vssaros';
	return process.env.AGENTMEMORY_SKILLS_DIR || _path.join(_os.homedir(), folder, 'skills');
}

export class AgentMemoryProviderV2 {
	readonly id = 'agentmemory';
	readonly name = 'AgentMemory';

	// StateKV(renderer 代理) | InProcessKV(网关宿主，进程内直连 KV+BM25)
	// 注：InProcessKV 在 host.mjs 中以 `any` 形式传入，本类型用 StateKV 保持
	// 泛型方法（list<T>/get<T>）正常推导；运行时结构兼容即可。
	private _kv: StateKV;
	private _tokenBudget: number = 2000;
	private _serverAvailable: boolean = false;
	private _healthChecked: boolean = false;
	private _lastHealthCheckAt: number = 0;
	/** 宿主（网关）模式：引擎直接在网关进程运行，不走 HTTP。 */
	private _hosted: boolean = false;

	// 生命周期 Hook 系统（进程内，对齐 V1 _hooks）：
	// 默认内置钩子在本实例构造时注册，getHookStats 据此向 editor pane 报告「活跃」状态。
	private _hookSystem = new HookSystem();

	// 审计/提交/报告 — 三者之前只有类定义但从未实例化，UI 视图始终空数据。
	// 修复：在构造时实例化，各方法委托到真实实例。
	private _auditLog = new AuditLog();
	private _postCommitCapture = new PostCommitCapture();
	private _reportGenerator: ReportGenerator;  // 构造末尾 init（需 this 自身作为 ReportDataSource）

	// 事件系统（内存态，对齐 V1 _eventBus / _hooks）
	private _handlers = new Map<string, Set<(...args: any[]) => void>>();

	private _on(event: string, handler: (...args: any[]) => void): () => void {
		if (!this._handlers.has(event)) this._handlers.set(event, new Set());
		this._handlers.get(event)!.add(handler);
		return () => this._handlers.get(event)?.delete(handler);
	}
	private _emit(event: string, ...args: any[]): void {
		this._handlers.get(event)?.forEach(h => { try { h(...args); } catch { /* ignore */ } });
	}

	constructor(config?: {
		/** HTTP KV server URL (覆盖 AGENTMEMORY_URL)。仅非宿主(renderer 代理)模式使用。 */
		httpUrl?: string;
		/** 网关宿主模式：传入进程内 KV 适配器（InProcessKV），引擎直接在网关进程运行。 */
		kv?: any;
		/** 宿主模式标记（网关内部使用，跳过 HTTP 健康检查与渲染端索引代理）。 */
		hosted?: boolean;
	}) {
		this._hosted = config?.hosted ?? false;
		this._kv = config?.kv ?? new StateKV(config?.httpUrl);
		// 非宿主（renderer 代理）模式：索引检索走网关 /search 的 HTTP 代理。
		// 宿主（网关）模式：getter 由网关 loadProvider 注入进程内 BM25，此处跳过。
		if (!this._hosted) {
			fn.setIndexGetters((agentId) => new ServerBM25Proxy(agentId), () => _vectorProxy);
		}
		// 注册内置默认钩子，使 editor pane 的 Hook 视图显示「活跃」而非「未注册」。
		this._registerDefaultHooks();

		// 报告生成器 — this 即 ReportDataSource（provider 自身实现了 getStats / getCommitStats / getHookStats 等）
		this._reportGenerator = new ReportGenerator(this as any);
	}

	/** 注册内置默认生命周期钩子（进程内，仅内存态，供 getHookStats 报告）。 */
	private _registerDefaultHooks(): void {
		const defaults = [
			createSessionStartHook(),
			createUserPromptSubmitHook(),
			createPreToolUseHook(),
			createPostToolUseHook(),
			createPostToolFailureHook(),
			createPreCompactHook(),
			createStopHook(),
			createSessionEndHook(),
			createTaskCompletedHook(),
			createNotificationHook(),
		];
		for (const d of defaults) {
			this._hookSystem.register(d.type, d.handler, d.priority);
		}
	}

	// ─── IMemoryProvider 核心接口 ──────────────────────────────────────────

	async loadContext(agentId: string, sessionId: string, query?: string, options?: any): Promise<IMemoryContext> {
		await this._ensureServer();
		const budget = options?.tokenBudget ?? this._tokenBudget;
		// includeEntries 默认 false：注入路径不需要长/短期记忆数组
		// （省去两次全表 list + JSON.parse，防止阻塞网关事件循环）；
		// UI 等确需数组的消费者显式传 includeEntries: true。
		return fn.loadContextFn(this._kv, agentId, sessionId, query, budget,
			{ includeEntries: options?.includeEntries === true });
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		await this._ensureServer();
		const ok = await fn.writeMemory(this._kv, agentId, entry);
		if (ok) {
			const noticeId = entry.metadata?.['noticeId'] as string | undefined;
			const memoryType = (entry.metadata?.['memoryType'] as string) ?? entry.type;
			// 串台防护：把 entry 携带的 sessionId 一并透传给 memory_written 事件，
			// 使消费方（agentChatService）能按 agentId::sessionId 精确路由到对应会话，
			// 而非仅靠"同 agent 最近活跃流"兜底（解决多开聊天框、相同 agentId 不同
			// session 时记忆卡片串台）。sessionId 由写入方写入 entry.metadata。
			const sessionId = (entry.metadata?.['sessionId'] as string | undefined)
				?? (entry.metadata?.['session_id'] as string | undefined);
			this._emit('memory_written', agentId, {
				memoryId: entry.id ?? '',
				noticeId,
				memoryType,
				contentLength: entry.content?.length ?? 0,
				sessionId,
			});
			this._auditLog.record('write', agentId, [entry.id ?? ''], { type: entry.type, memoryType });
			// Plan C: 索引更新由网关在收到 KV PUT 时自动增量完成，renderer 不再持有索引。
		}
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		await this._ensureServer();
		// Plan C: 检索经网关 /search（amFunctions 混合召回逻辑保留，
		// 索引检索走网关代理——agentId 经 getter 参数显式传递，无可变共享状态）。
		// 网关索引为空时回退 KV 扫描。
		// 空查询 / '*' = 全量列出（UI 侧栏与详情面板需要完整列表做分类统计，
		// 不能套用搜索路径的 20 条上限）。
		if (query === '*' || query === '*:*' || !query?.trim()) {
			return fn.searchMemoryFn(this._kv, agentId, '', SEARCH_ALL_LIMIT);
		}
		const results = await fn.searchMemories(this._kv, agentId, query, 20);
		// R4：搜索历史记录（对齐原版 mem::search 的 recent-searches 诊断面，
		// followupStats 的数据来源；fire-and-forget 不阻塞召回）
		void fin.recentSearchesAdd(this._kv, agentId, query, results.length).catch(() => {});
		if (results.length > 0) {
			return results.map(r => ({
				id: r.id,
				type: (r as any).type || 'fact',
				content: r.content,
				metadata: { score: r.score, source: r.source },
			}) as IMemoryEntry);
		}
		// 网关索引为空时的安全网：回退 KV 扫描
		return fn.searchMemoryFn(this._kv, agentId, query);
	}

	// ─── 可选方法（被主产品通过 (as any) 或 ?. 调用）────────────────────

	async recallFormatted(agentId: string, query: string, strategy?: string, limit?: number): Promise<string> {
		await this._ensureServer();
		const results = await fn.searchMemories(this._kv, agentId, query, limit ?? 10);
		// G4（对齐原版 mem::smart-search 的 lessons 数组并入召回返回）
		const lessons = await fn.lessonRecall(this._kv, agentId, query, undefined, 5).catch(() => []);
		if (results.length === 0 && lessons.length === 0) return 'memory_recall: no results found';
		const parts: string[] = [];
		if (results.length > 0) {
			parts.push(`Recalled ${results.length} memories:\n${results.map((r, i) => `[${i + 1}] ${r.content.slice(0, 200)}`).join('\n')}`);
		}
		if (lessons.length > 0) {
			parts.push(`Lessons:\n${lessons.map(l => `- [${l.source}] ${l.content.slice(0, 200)}`).join('\n')}`);
		}
		return parts.join('\n\n');
	}

	/** 文件相关 bug 记忆（mem::enrich 复刻）——volatile 层「历史 bug 提示」注入用 */
	async bugMemoriesForFiles(agentId: string, files: string[], project?: string): Promise<Array<{ id: string; title: string; content: string }>> {
		const memories = await fn.bugMemoriesForFiles(this._kv, agentId, files, project, 3);
		return memories.map(m => ({
			id: m.id,
			title: m.title || m.content.slice(0, 60),
			content: m.content.slice(0, 160),
		}));
	}

	async reinforceMemory(agentId: string, memId: string): Promise<boolean> {
		await this._ensureServer();
		return fn.reinforceMemory(this._kv, agentId, memId);
	}

	async forgetMemory(agentId: string, memId: string): Promise<boolean> {
		await this._ensureServer();
		// Plan C: forgetMemory 仅置 isLatest=false 并写回 KV；
		// 网关在收到该 PUT 时自动从索引移除。
		return fn.forgetMemory(this._kv, agentId, memId);
	}

	/** 触发 Hook — 对齐 V1 triggerHook，供 agentOSService 生命周期调用 */
	async triggerHook(type: string, ctx: Record<string, unknown>): Promise<void> {
		const agentId = (ctx['agentId'] as string) ?? 'default';
		const sessionId = (ctx['sessionId'] as string) ?? 'default';
		// ── 原版写入时机复刻 ───────────────────────────────────────────
		// session_start：显式注册会话记录（KV.sessions，summaries/观察块的关联键）
		if (type === 'session_start') {
			await fn.sessionStart(this._kv, agentId, sessionId, ctx['project'] as string | undefined, ctx['cwd'] as string | undefined).catch(() => {});
		}
		// session_end（客户端每轮末触发）：下限 5 条未压缩观察时压缩为
		// SessionSummary（对齐原版 session-end → flow-compress；compressSession
		// 已与既有摘要合并，turn 级分批压缩会累积叙事而不是互相覆盖）。
		if (type === 'session_end') {
			const { compressSession, countUncompressed } = await import('./amCompress.js');
			countUncompressed(this._kv, agentId, sessionId).then(async (n: number) => {
				let summary: import('./amTypes.js').SessionSummary | null = null;
				if (n >= 5) {
					summary = await compressSession(this._kv, agentId, sessionId, ctx['project'] as string | undefined).catch(() => null);
				}
				// D2a（doc §13，复刻 mem::slot-reflect）：session 结束把近期观察
				// 反思进 slots（pending_items/session_patterns/project_context）——
				// 原版 events.ts session.stopped 事件链标配；AGENTMEMORY_REFLECT=false 关闭。
				if (slots.isReflectEnabled()) {
					await slots.slotReflect(this._kv, agentId, sessionId).catch(() => {});
				}
				// D2b（复刻 graph-extract 联动）：AGENTMEMORY_GRAPH_EXTRACTION=true 才开
				// （对齐原版 GRAPH_EXTRACTION_ENABLED 默认关）；从刚压缩的摘要抽取实体。
				if (process.env['AGENTMEMORY_GRAPH_EXTRACTION'] === 'true' && summary?.narrative) {
					const { graphExtract } = await import('./amPipeline.js');
					const text = `${summary.title}\n${summary.narrative}\n${summary.keyDecisions.join('; ')}`;
					await graphExtract(this._kv, agentId, sessionId, text).catch(() => {});
				}
			}).catch(() => {});
		}
		// 走真正的 HookSystem（内置默认钩子 + 调用计数），并持久化其 observe 结果。
		const results = await this._hookSystem.trigger(type as any, {
			agentId,
			sessionId,
			timestamp: Date.now(),
			...ctx,
		});
		for (const r of results) {
			if (r?.observeEntry) {
				const e = r.observeEntry;
				await fn.coreAdd(this._kv, agentId, e.content.slice(0, 2000), 5, false).catch(() => {});
			}
		}
	}

	/** 事件：写入完成回调 — 对齐 V1 onMemoryWritten */
	onMemoryWritten(handler: (agentId: string, data: { memoryId: string; noticeId?: string; memoryType?: string; contentLength?: number }) => void): () => void {
		return this._on('memory_written', handler);
	}

	/** 事件：Git 提交 — 对齐 V1 onGitCommit */
	onGitCommit(commit: { sha: string; message?: string; filesChanged: string[]; author?: string; authorEmail?: string; timestamp?: number; branch?: string; insertions?: number; deletions?: number }): void {
		const entry = this._postCommitCapture.capture({
			sha: commit.sha,
			message: commit.message ?? '',
			author: commit.author ?? 'unknown',
			authorEmail: commit.authorEmail ?? '',
			filesChanged: commit.filesChanged ?? [],
			insertions: commit.insertions ?? 0,
			deletions: commit.deletions ?? 0,
			timestamp: commit.timestamp ?? Date.now(),
			branch: commit.branch,
		});
		// 同步写入审计并异步持久化记忆
		const commitAgentId = commit.author ?? 'default';
		this._auditLog.record('write', commitAgentId, [entry.id ?? ''], {
			sha: commit.sha,
			memoryType: 'git_commit',
		});
		// fire-and-forget KV 持久化（不阻塞调用链）
		fn.writeMemory(this._kv, commitAgentId, entry).catch(() => {});
	}

	/** Pre-compact 注入回调 — 注入 SessionSummary 上下文以帮助 LLM 压缩 */ 
	onPreCompact(ctx: { agentId: string; sessionId: string; messages: Array<{ role: string; content: string; timestamp: number }>; tokensSaved: number; contextWindow: number }): string {
		// fire-and-forget：在 compact 前写入 session summary
		compress.compressSession(this._kv, ctx.agentId, ctx.sessionId).catch(() => {});
		// 同步返回上下文注入（暂不注入文本，summary 在下次 buildContext 时自动包含）
		return '';
	}

	/** 压缩会话 — 对齐 agentmemory mem::compress */
	async compressSession(agentId: string, sessionId: string, project?: string) {
		await this._ensureServer();
		return compress.compressSession(this._kv, agentId, sessionId, project);
	}

	/** 获取压缩上下文 — 对齐 agentmemory buildContext 的 summaries 块 */
	async getCompactContext(agentId: string, limit?: number) {
		return compress.getCompactContext(this._kv, agentId, limit);
	}

	/** 任务完成回调 — 对齐 V1 onTaskCompleted */
	onTaskCompleted(agentId: string, sessionId: string, message: string): void {
		fn.coreAdd(this._kv, agentId, `[task_completed] ${message.slice(0, 200)}`, 6, false).catch(() => {});
		// 写入 Session Summary
		fn.sessionSummarySave(this._kv, agentId, sessionId, agentId,
			message.slice(0, 80), message, [], [], [], 0).catch(() => {});
	}

	// ─── 统计 / 诊断 ──────────────────────────────────────────────────────

	async getStats(agentId: string): Promise<Record<string, number>> {
		await this._ensureServer();
		return fn.getStatsFn(this._kv, agentId);
	}

	async getExtendedStats(agentId: string): Promise<Record<string, unknown>> {
		const stats = await this.getStats(agentId);
		const s = await this._serverStats(agentId);
		return {
			...stats,
			bm25IndexSize: s.indexSize,
			vectorIndexSize: 0,
			searchHost: 'gateway',
			serverAvailable: this._serverAvailable,
		};
	}

	// ─── 管理方法 ─────────────────────────────────────────────────────────

	async coreMemoryAdd(agentId: string, content: string, importance?: number, pinned?: boolean): Promise<string> {
		await this._ensureServer();
		return fn.coreAdd(this._kv, agentId, content, importance, pinned);
	}

	async coreMemoryRemove(agentId: string, id: string): Promise<boolean> {
		await this._ensureServer();
		return fn.coreRemove(this._kv, agentId, id);
	}

	async coreMemoryList(agentId: string) {
		await this._ensureServer();
		return fn.coreList(this._kv, agentId);
	}
	/** semantic scope 列表（mem:semantic）— memoryDetail 记忆视图聚合用 */
	async semanticList(agentId: string) {
		await this._ensureServer();
		return fn.semanticList(this._kv, agentId);
	}
	/** procedural scope 列表（mem:procedural）— memoryDetail 记忆视图聚合用 */
	async proceduralList(agentId: string) {
		await this._ensureServer();
		return fn.proceduralList(this._kv, agentId);
	}

	async lessonSave(agentId: string, content: string, context?: string, confidence?: number, project?: string) {
		await this._ensureServer();
		return fn.lessonSave(this._kv, agentId, content, context, confidence, project);
	}

	async lessonRecall(agentId: string, query: string, project?: string, limit?: number) {
		await this._ensureServer();
		return fn.lessonRecall(this._kv, agentId, query, project, limit);
	}

	async removeAgent(agentId: string): Promise<void> {
		await fn.removeAgentFn(this._kv, agentId);
	}

	// ─── Profile / Timeline / Diagnostics ────────────────────────────────

	async getProfile(agentId: string): Promise<Record<string, unknown> | null> {
		await this._ensureServer();
		const p = await pipe.getProfile(this._kv, agentId);
		return p as unknown as Record<string, unknown> | null;
	}

	getTimeline(agentId: string): unknown[] { return []; }

	runDiagnostics(agentId: string): Record<string, unknown> {
		return { agentId, status: 'ok', serverAvailable: this._serverAvailable };
	}
	runExtendedDiagnostics(agentId: string): Record<string, unknown> {
		return { ...this.runDiagnostics(agentId), bm25Size: 'gateway-hosted', searchHost: 'gateway' };
	}

	// ─── Slots ───────────────────────────────────────────────────────────

	async slotList(agentId: string) { await this._ensureServer(); return slots.slotList(this._kv, agentId); }
	async slotGet(agentId: string, label: string) { return slots.slotGet(this._kv, agentId, label); }
	async slotSet(agentId: string, label: string, content: string) { return slots.slotSet(this._kv, agentId, label, content); }
	// ─── 原版机制复刻（amReplication）：slots 完整操作 ──────────────
	async slotCreate(agentId: string, data: { label: string; content?: string; sizeLimit?: number; description?: string; pinned?: boolean; scope?: 'project' | 'global' }) { await this._ensureServer(); return repl.slotCreate(this._kv, agentId, data); }
	async slotAppend(agentId: string, label: string, text: string) { await this._ensureServer(); return repl.slotAppend(this._kv, agentId, label, text); }
	async slotReplace(agentId: string, label: string, content: string) { await this._ensureServer(); return repl.slotReplace(this._kv, agentId, label, content); }
	async slotDelete(agentId: string, label: string) { await this._ensureServer(); return repl.slotDelete(this._kv, agentId, label); }
	async getSlots(agentId: string): Promise<Array<{ name: string; content: string }>> {
		const all = await slots.slotList(this._kv, agentId);
		return all.map(s => ({ name: s.label, content: s.content }));
	}

	// ─── Lessons CRUD ───────────────────────────────────────────────────

	async getLessons(agentId: string): Promise<Array<{ id: string; content: string; context?: string; tags?: string[] }>> {
		await this._ensureServer();
		const all = await fn.lessonList(this._kv, agentId);
		return all.filter(l => !l.deleted).map(l => ({ id: l.id, content: l.content, context: l.context, tags: l.tags }));
	}
	getTopLessons(agentId: string, limit?: number): unknown[] { return []; }
	searchLessons(agentId: string, query: string): unknown[] { return []; }
	async addLesson(agentId: string, content: string, context?: string, tags?: string[]): Promise<{ id: string; content: string }> {
		await this._ensureServer();
		const result = await fn.lessonSave(this._kv, agentId, content, context, 0.8);
		const id = (result as any)?.id || String(result);
		return { id, content };
	}
	async deleteLesson(agentId: string, lessonId: string): Promise<void> {
		await this._ensureServer();
		await fn.lessonDelete(this._kv, agentId, lessonId);
	}

	// ─── Consolidation ──────────────────────────────────────────────────

	/** episodic 层记忆：type 属于 episodic 家族 */
	async getEpisodicMemories(agentId: string): Promise<unknown[]> {
		try {
			const mems = await this._kv.list<Memory>(KV.memories(agentId));
			return mems.filter(m => m.isLatest !== false && this._isEpisodicType(m.type));
		} catch { return []; }
	}

	/** semantic 层记忆：从独立 semantic scope 读取 */
	async getSemanticMemories(agentId: string): Promise<unknown[]> {
		try {
			return await this._kv.list<any>(KV.semantic(agentId));
		} catch { return []; }
	}

	/** procedural 层记忆：从独立 procedural scope 读取 */
	async getProceduralMemories(agentId: string): Promise<unknown[]> {
		try {
			return await this._kv.list<any>(KV.procedural(agentId));
		} catch { return []; }
	}

	/** 固化上下文摘要 */
	async getConsolidationContext(agentId: string): Promise<string> {
		try {
			const [ep, sm, pr] = await Promise.all([
				this.getEpisodicMemories(agentId),
				this.getSemanticMemories(agentId),
				this.getProceduralMemories(agentId),
			]);
			const epArr = ep as any[]; const smArr = sm as any[]; const prArr = pr as any[];
			return [
				`## Consolidation Context (${agentId})`,
				``,
			`Episodic: ${epArr.length} memories (pattern/preference/bug/fact/architecture/workflow)`,
			`Semantic: ${smArr.length} entries (mem:semantic scope)`,
			`Procedural: ${prArr.length} entries (mem:procedural scope)`,
			].join('\n');
		} catch { return ''; }
	}

	private _isEpisodicType(type: string): boolean {
		return type === 'episodic' || type === 'pattern' || type === 'preference'
			|| type === 'bug' || type === 'fact';
	}

	// ─── Relations / Provenance / Replay ────────────────────────────────

	async getRelations(agentId: string, memoryId: string): Promise<unknown[]> { return rem.getRelations(this._kv, agentId, memoryId); }
	async getRelationStats(agentId: string): Promise<Record<string, number>> { return rem.getRelationStats(this._kv, agentId); }
	traceProvenance(agentId: string, memoryId: string): unknown { return null; }
	verifyProvenance(agentId: string, memoryId: string): unknown { return null; }
	async getReplaySession(sessionId: string): Promise<unknown> { return rem.replaySession(this._kv, 'default', sessionId); }
	async getReplaySessions(agentId: string): Promise<unknown[]> { return rem.replayList(this._kv, agentId); }

	// ─── Working Memory / File Index ───────────────────────────────────

	enrichFile(agentId: string, filePath: string): unknown { return null; }
	setWorkingMemory(agentId: string, key: string, value: string): void { /* no-op V2 */ }
	getWorkingMemory(agentId: string, key: string): string { return ''; }
	getAllWorkingMemory(agentId: string): Array<{ key: string; value: string }> { return []; }
	async getFileContext(agentId: string, filePath: string): Promise<string> {
		const result = await extra.fileContext(this._kv, agentId, [filePath]);
		return result.context;
	}
	getFileIndex(agentId: string, query: string): unknown[] { return []; }

	// ─── Actions / Routines / Signals ──────────────────────────────────

	async actionCreate(agentId: string, title: string, description?: string, priority?: number) {
		await this._ensureServer(); return adv.actionCreate(this._kv, agentId, title, description, priority);
	}
	async actionUpdate(agentId: string, id: string, status?: string, priority?: number) {
		await this._ensureServer(); return adv.actionUpdate(this._kv, agentId, id, status as any, priority);
	}
	async actionList(agentId: string) { await this._ensureServer(); return adv.actionList(this._kv, agentId); }
	async actionGet(agentId: string, id: string) { await this._ensureServer(); return adv.actionGet(this._kv, agentId, id); }
	/** mem::action-edge-create：行动 DAG 关系边（blocks/depends_on/relates_to/supersedes） */
	async actionEdgeCreate(agentId: string, from: string, to: string, type?: 'blocks'|'depends_on'|'relates_to'|'supersedes') {
		await this._ensureServer(); return adv.actionEdgeCreate(this._kv, agentId, from, to, type);
	}
	getActions(agentId: string): unknown[] { return []; }
	async createRoutine(data: any) { await this._ensureServer(); return rem.routineCreate(this._kv, data.agentId || 'default', data); }
	async getRoutines(agentId: string) { await this._ensureServer(); return rem.routineList(this._kv, agentId); }
	async runRoutine(agentId: string, routineId: string) { await this._ensureServer(); return rem.routineRun(this._kv, agentId, routineId); }
	async signalSend(agentId: string, type: string, content: string, to?: string) {
		await this._ensureServer(); return adv.signalSend(this._kv, agentId, type as any, content, to);
	}
	async signalQuery(agentId: string) { await this._ensureServer(); return adv.signalQuery(this._kv, agentId); }
	getSignals(agentId: string): unknown[] { return []; }

	// ─── Snapshots / Checkpoints / Leases ──────────────────────────────

	async createSnapshot(agentId: string, name: string) { await this._ensureServer(); return adv.snapshotCreate(this._kv, agentId, name); }
	restoreSnapshot(agentId: string, snapshotId: string): boolean { return false; }
	async createCheckpoint(agentId: string, name: string) { await this._ensureServer(); return adv.checkpointCreate(this._kv, agentId, name); }
	async checkpointResolve(agentId: string, id: string, passed: boolean) { await this._ensureServer(); return adv.checkpointResolve(this._kv, agentId, id, passed); }
	async checkpointList(agentId: string) { await this._ensureServer(); return adv.checkpointList(this._kv, agentId); }
	async acquireLease(agentId: string, resourceId: string, ttlMs?: number) {
		await this._ensureServer(); const r = await adv.leaseAcquire(this._kv, agentId, resourceId, ttlMs); return r.success;
	}
	async releaseLease(agentId: string, resourceId: string) { await this._ensureServer(); return adv.leaseRelease(this._kv, agentId, resourceId); }

	// ─── Sketches / Sentinels / Crystallize / Facets ──────────────────

	async sketchCreate(agentId: string, title: string, description?: string) { await this._ensureServer(); return adv.sketchCreate(this._kv, agentId, title, description); }
	async sketchList(agentId: string) { await this._ensureServer(); return adv.sketchList(this._kv, agentId); }
	// ─── 原版机制复刻（amReplication）：sketch 生命周期 ─────────────
	async sketchAdd(agentId: string, sketchId: string, actionId: string) { await this._ensureServer(); return repl.sketchAdd(this._kv, agentId, sketchId, actionId); }
	async sketchGc(agentId: string) { await this._ensureServer(); return repl.sketchGc(this._kv, agentId); }
	// ─── 原版机制复刻（amReplication）：insights 数据层 ─────────────
	async insightSearch(agentId: string, query: string, limit?: number) { await this._ensureServer(); return repl.insightSearch(this._kv, agentId, query, limit); }
	async insightDecaySweep(agentId: string) { await this._ensureServer(); return repl.insightDecaySweep(this._kv, agentId); }
	// ─── 原版机制复刻（amReplication）：snapshot 恢复 ───────────────
	async snapshotRestore(agentId: string, snapshotId: string) { await this._ensureServer(); return repl.snapshotRestore(this._kv, agentId, snapshotId); }
	// ─── 原版机制复刻（amReplication）：routine 状态 ────────────────
	async routineStatus(agentId: string, runId: string) { await this._ensureServer(); return repl.routineStatus(this._kv, agentId, runId); }
	async routineFreeze(agentId: string, routineId: string, frozen?: boolean) { await this._ensureServer(); return repl.routineFreeze(this._kv, agentId, routineId, frozen); }
	async routineStepUpdate(agentId: string, runId: string, stepOrder: number, status: string, result?: string, error?: string) { await this._ensureServer(); return rem.routineStepUpdate(this._kv, agentId, runId, stepOrder, status as 'done'|'failed'|'skipped'|'running', result, error); }
	async routineDelete(agentId: string, routineId: string) { await this._ensureServer(); return rem.routineDelete(this._kv, agentId, routineId); }
	async getRoutine(agentId: string, routineId: string) { await this._ensureServer(); return rem.routineGet(this._kv, agentId, routineId); }
	// ─── 原版机制复刻（amReplication）：signal 线程与清理 ───────────
	async signalThreads(agentId: string, limit?: number) { await this._ensureServer(); return repl.signalThreads(this._kv, agentId, limit); }
	async signalCleanup(agentId: string) { await this._ensureServer(); return repl.signalCleanup(this._kv, agentId); }
	// ─── 原版机制复刻（amReplication）：graph 构建与重置 ────────────
	async graphBuild(agentId: string) { await this._ensureServer(); return repl.graphBuild(this._kv, agentId); }
	async graphReset() { await this._ensureServer(); return repl.graphReset(); }
	async sentinelCreate(agentId: string, name: string, condition: string, type?: string) { await this._ensureServer(); return adv.sentinelCreate(this._kv, agentId, name, condition, type as any); }
	async sentinelList(agentId: string) { await this._ensureServer(); return adv.sentinelList(this._kv, agentId); }
	async sentinelCheck(agentId: string) {
		await this._ensureServer();
		const result = await adv.sentinelCheck(this._kv, agentId);
		for (const t of result.triggered) {
			this._emit('sentinel_triggered', agentId, t);
		}
		return result;
	}
	async sentinelTrigger(agentId: string, sentinelId: string, result?: Record<string, unknown>) {
		await this._ensureServer();
		const r = await adv.sentinelTrigger(this._kv, agentId, sentinelId, result);
		if (r.success) {
			this._emit('sentinel_triggered', agentId, { id: sentinelId, name: '', type: 'manual', result: result ?? { reason: 'manual_trigger' } });
		}
		return r;
	}
	async sentinelCancel(agentId: string, sentinelId: string) { await this._ensureServer(); return adv.sentinelCancel(this._kv, agentId, sentinelId); }
	async crystallize(agentId: string, actionId: string) { await this._ensureServer(); return adv.crystallize(this._kv, agentId, actionId); }
	async crystalList(agentId: string) { await this._ensureServer(); return adv.crystalList(this._kv, agentId); }
	async facetTag(agentId: string, targetId: string, targetType: string, dimension: string, value: string) { await this._ensureServer(); return adv.facetTag(this._kv, agentId, targetId, targetType as any, dimension, value); }
	async facetQuery(agentId: string, dimension: string, value?: string) { await this._ensureServer(); return adv.facetQuery(this._kv, agentId, dimension, value); }

	// ─── Team / Mesh / Temporal Graph / Frontier ─────────────────────

	async teamShare(agentId: string, itemId: string, itemType: string, project?: string) { await this._ensureServer(); return rem.teamShare(this._kv, agentId, itemId, itemType, project); }
	async teamQuery(agentId: string, query?: string, teamId?: string) { await this._ensureServer(); return rem.teamQuery(this._kv, agentId, query, teamId); }
	// ─── 原版机制复刻（amReplication）：team feed/profile ──────────
	async teamFeed(agentId: string, limit?: number, teamId?: string) { await this._ensureServer(); return repl.teamFeed(this._kv, agentId, limit, teamId); }
	async teamProfile(agentId: string, teamId?: string) { await this._ensureServer(); return repl.teamProfile(this._kv, agentId, teamId); }
	/** mem::slot-reflect：把 session 近期观察反思进 slots（D2a 复刻） */
	async slotReflect(agentId: string, sessionId: string, maxObservations?: number) {
		await this._ensureServer();
		return slots.slotReflect(this._kv, agentId, sessionId, maxObservations);
	}
	async meshJoin(agentId: string, name: string, url: string, scopes?: string[]) { await this._ensureServer(); return rem.meshJoin(this._kv, agentId, name, url, scopes); }
	async meshList(agentId: string) { await this._ensureServer(); return rem.meshList(this._kv, agentId); }
	async meshLeave(agentId: string, peerId: string) { await this._ensureServer(); return rem.meshLeave(this._kv, agentId, peerId); }
	/** mem::mesh-sync：对等同步（push+pull，delta since lastSyncAt，需 AGENTMEMORY_SECRET） */
	async meshSync(agentId: string, opts?: { peerId?: string; scopes?: string[]; direction?: 'push' | 'pull' | 'both' }) {
		await this._ensureServer(); return rem.meshSync(this._kv, agentId, opts);
	}
	/** mem::mesh-receive：接受远端推送，LWW 合并（网关 /mesh/receive 路由调用） */
	async meshReceive(agentId: string, payload: rem.MeshSyncPayload) {
		await this._ensureServer(); return rem.meshReceive(this._kv, agentId, payload);
	}
	/** mesh 数据导出（网关 /mesh/export 路由调用） */
	async meshExport(agentId: string, scopes?: string[], since?: string) {
		await this._ensureServer();
		return rem.collectSyncData(this._kv, agentId, scopes ?? ['memories', 'actions', 'semantic', 'procedural', 'relations'], since);
	}
	async temporalExtract(agentId: string, sessionId: string) { await this._ensureServer(); return rem.temporalExtract(this._kv, agentId, sessionId); }
	async temporalQuery(agentId: string, entity: string) { await this._ensureServer(); return rem.temporalQuery(this._kv, agentId, entity); }
	async frontierAdd(agentId: string, concept: string, desc?: string, pri?: number) { await this._ensureServer(); return rem.frontierAdd(this._kv, agentId, concept, desc, pri); }
	async frontierGet(agentId: string) { await this._ensureServer(); return rem.frontierGet(this._kv, agentId); }

	// ─── Claude Bridge / Obsidian / Disk / Flow Compress ─────────────

	async claudeBridgeRead(agentId: string) { await this._ensureServer(); return rem.claudeBridgeRead(this._kv, agentId); }
	async claudeBridgeSync(agentId: string, items: any[]) { await this._ensureServer(); return rem.claudeBridgeSync(this._kv, agentId, items); }
	async obsidianExport(agentId: string) { await this._ensureServer(); return rem.obsidianExport(this._kv, agentId); }
	async diskSize(agentId: string) { await this._ensureServer(); return rem.diskSize(this._kv, agentId); }
	imageQuota(agentId: string) { return rem.imageQuota(agentId); }
	async visionSearch(agentId: string, query: string) { await this._ensureServer(); return rem.visionSearch(this._kv, agentId, query); }
	async flowCompress(agentId: string, sessionId: string) { await this._ensureServer(); return rem.flowCompress(this._kv, agentId, sessionId); }
	async compressFile(agentId: string, filePath: string) { await this._ensureServer(); return rem.compressFile(this._kv, agentId, filePath); }
	async branchSessions(agentId: string, branch: string) { await this._ensureServer(); return rem.branchSessions(this._kv, agentId, branch); }

	// ─── amFinal 补齐：cascade / frontier / audit / evolve / facet扩展 ──

	async cascadeUpdate(agentId: string, supersededMemoryId: string) { await this._ensureServer(); return fin.cascadeUpdate(this._kv, agentId, supersededMemoryId); }
	async frontierNext(agentId: string, project?: string, agentIdentity?: string, includeLeasedByOthers?: boolean) { await this._ensureServer(); return fin.frontierNext(this._kv, agentId, project, agentIdentity, includeLeasedByOthers); }
	async governanceAuditQuery(agentId: string, filter?: any) { await this._ensureServer(); return fin.governanceAuditQuery(this._kv, agentId, filter); }
	async relateEvolve(agentId: string, sourceId: string, targetId: string, relationType?: string) { await this._ensureServer(); return fin.relateEvolve(this._kv, agentId, sourceId, targetId, relationType); }
	async temporalEdgeCreate(agentId: string, source: string, target: string, type: string, weight: number, reasoning: string, sentiment?: any) { await this._ensureServer(); return fin.temporalEdgeCreate(this._kv, agentId, source, target, type, weight, reasoning, sentiment); }
	async crystalGet(agentId: string, crystalId: string) { await this._ensureServer(); return fin.crystalGet(this._kv, agentId, crystalId); }
	async autoCrystallize(agentId: string) { await this._ensureServer(); return fin.autoCrystallize(this._kv, agentId); }
	async facetStats(agentId: string) { await this._ensureServer(); return fin.facetStats(this._kv, agentId); }
	async facetDimensions(agentId: string) { await this._ensureServer(); return fin.facetDimensions(this._kv, agentId); }
	async facetUntag(agentId: string, targetId: string, dimension: string) { await this._ensureServer(); return fin.facetUntag(this._kv, agentId, targetId, dimension); }
	async facetGet(agentId: string, targetId: string, dimension?: string) { await this._ensureServer(); return fin.facetGet(this._kv, agentId, targetId, dimension); }
	async checkpointExpire(agentId: string, checkpointId: string) { await this._ensureServer(); return fin.checkpointExpire(this._kv, agentId, checkpointId); }
	async leaseRenew(agentId: string, leaseId: string, ttlMs?: number) { await this._ensureServer(); return fin.leaseRenew(this._kv, agentId, leaseId, ttlMs); }
	async leaseCleanup(agentId: string) { await this._ensureServer(); return fin.leaseCleanup(this._kv, agentId); }
	async sketchDiscard(agentId: string, sketchId: string) { await this._ensureServer(); return fin.sketchDiscard(this._kv, agentId, sketchId); }
	async diskSizeCleanup(agentId: string) { await this._ensureServer(); return fin.diskSizeCleanup(this._kv, agentId); }
	imageQuotaCleanup(agentId: string) { return fin.imageQuotaCleanup(agentId); }
	async smartSearch(agentId: string, query: string, limit?: number) { await this._ensureServer(); return fin.smartSearch(this._kv, agentId, query, limit); }
	async recentSearchesAdd(agentId: string, query: string, resultCount: number) { await this._ensureServer(); return fin.recentSearchesAdd(this._kv, agentId, query, resultCount); }
	async recentSearchesGet(agentId: string, limit?: number) { await this._ensureServer(); return fin.recentSearchesGet(this._kv, agentId, limit); }
	/** mem::diagnostic::recent-searches-sweep：按窗口与上限修剪搜索历史 */
	async recentSearchesSweep(agentId: string, maxEntries?: number, windowHours?: number) { await this._ensureServer(); return fin.recentSearchesSweep(this._kv, agentId, maxEntries, windowHours); }
	/** mem::diagnostic::followup-stats：搜索→写入追问率 */
	async followupStats(agentId: string, windowMs?: number) { await this._ensureServer(); return fin.followupStats(this._kv, agentId, windowMs); }
	/** mem::replay::import-jsonl：导入 Claude Code JSONL 会话日志为观察记录 */
	async replayImportJsonl(agentId: string, sessionId: string, jsonl: string, maxEvents?: number) { await this._ensureServer(); return fin.replayImportJsonl(this._kv, agentId, sessionId, jsonl, maxEvents); }
	async healthCheck(agentId: string) { await this._ensureServer(); return fin.healthCheck(this._kv, agentId); }
	async circuitStatesGet(agentId: string) { await this._ensureServer(); return fin.circuitStatesGet(this._kv, agentId); }
	async dedupCheck(agentId: string, key: string) { await this._ensureServer(); return fin.dedupCheck(this._kv, agentId, key); }
	async dedupMark(agentId: string, key: string) { await this._ensureServer(); return fin.dedupMark(this._kv, agentId, key); }
	async richFileContext(agentId: string, files: string[], concepts?: string[]) { await this._ensureServer(); return fin.richFileContext(this._kv, agentId, files, concepts ?? []); }
	async diffFileContext(agentId: string, filesChanged: string[]) { await this._ensureServer(); return fin.diffFileContext(this._kv, agentId, filesChanged); }
	async signalSendExpanded(agentId: string, type: any, content: string, to?: string, ttlMs?: number) { await this._ensureServer(); return fin.signalSendExpanded(this._kv, agentId, type, content, to, ttlMs); }
	async signalQueryExpanded(agentId: string, type?: string, from?: string) { await this._ensureServer(); return fin.signalQueryExpanded(this._kv, agentId, type, from); }

	// ─── Snapshot List ────────────────────────────────────────────────

	async snapshotList(agentId: string) { await this._ensureServer(); return adv.snapshotList(this._kv, agentId); }

	// ─── Health / Circuit ──────────────────────────────────────────────

	getHealthStatus(): Record<string, unknown> {
		return { serverAvailable: this._serverAvailable, status: this._serverAvailable ? 'healthy' : 'degraded' };
	}
	getCircuitStates(): Record<string, unknown> { return {}; }

	// ─── Search / Smart Search ───────────────────────────────────────

	async getSmartSearchResults(agentId: string, query: string, options?: unknown): Promise<unknown[]> {
		return fin.smartSearch(this._kv, agentId, query);
	}
	getRecentSearches(agentId: string): unknown[] { return []; }

	// ─── Hooks / Events ───────────────────────────────────────────────

	registerHook(type: string, handler: unknown, priority?: number): string { return ''; }
	unregisterHook(id: string): boolean { return false; }
	async triggerHooks(type: string, ctx: Record<string, unknown>): Promise<unknown> {
		return { injectContext: '', observeEntries: [], shouldPersist: false };
	}

	// ─── Observe / Enrich ─────────────────────────────────────────────

	/**
	 * 观测写入（对齐原版 mem::observe）：写入 mem:obs:<agent>:<session> 会话暂存层
	 * —— 便宜 KV set + 滑动窗口上限 + 阈值自动触发 compressSession。
	 * 2026-07-25 改道：原路由到 slots.observe（mem:core，与 HookSystem 写入重复且
	 * 污染短期上下文），现统一走 fn.observe（原版语义）。调用方：客户端
	 * _observeToolResult（工具结果）/ storeTurnObservations（turn 消息）。
	 */
	async observe(agentId: string, payload: { sessionId: string; hookType: string; timestamp: string; data: unknown }) {
		await this._ensureServer();
		return fn.observe(this._kv, agentId, payload as any);
	}
	async observeList(agentId: string, sessionId: string) {
		await this._ensureServer();
		return fn.observeList(this._kv, agentId, sessionId);
	}
	async observeCount(agentId: string, sessionId: string) {
		await this._ensureServer();
		return fn.observeCount(this._kv, agentId, sessionId);
	}
	/** 列出会话记录（KV.sessions）— Dashboard/memoryDetail 会话面板用 */
	async listSessions(agentId: string) {
		await this._ensureServer();
		return fn.sessionList(this._kv, agentId);
	}
	/** 列出会话摘要（KV.summaries，按 createdAt desc，可 limit） */
	async listSummaries(agentId: string, limit?: number) {
		await this._ensureServer();
		const all = await fn.sessionSummaryList(this._kv, agentId);
		return limit ? all.slice(0, limit) : all;
	}
	async enrich(agentId: string, files: string[], terms?: string[], project?: string) {
		await this._ensureServer();
		return slots.enrich(this._kv, agentId, files, terms ?? [], project);
	}

	// ─── Query Expansion / Summarize / Skill Extract ──────────────────

	async expandQuery(agentId: string, query: string, project?: string) {
		await this._ensureServer();
		return feat.expandQuery(this._kv, agentId, query, project);
	}
	async summarizeSession(agentId: string, sessionId: string) {
		await this._ensureServer();
		return feat.summarizeSession(this._kv, agentId, sessionId);
	}
	async extractSkill(agentId: string, sessionId: string) {
		await this._ensureServer();
		return feat.extractSkill(this._kv, agentId, sessionId);
	}
	/** mem::skill-list：列出已抽取技能 */
	async skillList(agentId: string) {
		await this._ensureServer();
		return feat.skillList(this._kv, agentId);
	}
	/** mem::skill-match：任务文本匹配推荐技能（D3 查询侧补齐） */
	async skillMatch(agentId: string, task: string, limit?: number) {
		await this._ensureServer();
		return feat.skillMatch(this._kv, agentId, task, limit);
	}
	/** session_handoff 复刻：生成交接文档并以 SessionSummary 持久化（下个会话策展注入自然携带） */
	async sessionHandoff(agentId: string, sessionId: string) {
		await this._ensureServer();
		return feat.sessionHandoff(this._kv, agentId, sessionId);
	}

	// ─── Sliding Window ──────────────────────────────────────────────

	async slidingWindowAdd(agentId: string, entry: { id: string; content: string; type: string; timestamp: number; score: number; source: string }) {
		await this._ensureServer();
		return feat.slidingWindowAdd(this._kv, agentId, entry as any);
	}
	async slidingWindowGet(agentId: string, limit?: number) {
		await this._ensureServer();
		return feat.slidingWindowGet(this._kv, agentId, limit);
	}

	// ─── File Index / Privacy / Export/Import ────────────────────────

	async fileContext(agentId: string, files: string[]) {
		await this._ensureServer();
		return extra.fileContext(this._kv, agentId, files);
	}

	sanitizeContent(text: string): string {
		return extra.sanitizeContent(text);
	}

	async exportMemories(agentId: string) {
		await this._ensureServer();
		return extra.exportMemories(this._kv, agentId);
	}
	async importMemories(agentId: string, data: any) {
		await this._ensureServer();
		return extra.importMemories(this._kv, agentId, data);
	}

	// ─── Governance / Diagnostics ───────────────────────────────────

	async governanceDelete(agentId: string, memoryIds: string[]) {
		await this._ensureServer();
		return extra.governanceDelete(this._kv, agentId, memoryIds);
	}
	async governanceBulkDelete(agentId: string, filters: any) {
		await this._ensureServer();
		return extra.governanceBulkDelete(this._kv, agentId, filters);
	}
	async diagnose(agentId: string) {
		await this._ensureServer();
		return extra.diagnose(this._kv, agentId);
	}
	/** mem::heal：修复畸形记忆字段（isLatest/strength/concepts/createdAt） */
	async heal(agentId: string) {
		await this._ensureServer();
		return extra.heal(this._kv, agentId);
	}

	// ─── MemoryDetailEditorPane 兼容方法 ────────────────────────────────

	/** 跨 Agent 搜索 — memoryDetailEditorPane L121（期望 IMemoryEntry[] 格式） */
	async searchAllAgents(query: string): Promise<Array<Record<string, unknown>>> {
		await this._ensureServer();
		// EditorPane 期望每个元素是 { id, type, content, metadata, timestamp, agentId }
		const allEntries: IMemoryEntry[] = [];
		// 枚举所有有记忆数据的 agent（不再 hardcode ['default']）
		const agents = await this.listAllAgentsWithData();
		if (agents.length === 0) agents.push('default');
		for (const aid of agents) {
			// 优先 BM25 搜索
			const mems = query
				? await fn.recallFormatted(this._kv, aid, query, this._tokenBudget)
				: [];
			if (mems.length > 0) {
				for (const m of mems) {
					allEntries.push({ id: m.id, type: m.type as IMemoryEntry['type'], content: m.content, metadata: { ...(m.metadata || {}), agentId: aid }, timestamp: Date.now() });
				}
			} else {
				// BM25 为空时回退 KV 直接扫描（确保分类统计不丢失）
				const rawMems = await this._kv.list<Memory>(KV.memories(aid));
				for (const m of rawMems) {
					if (m.isLatest !== false && m.content) {
						allEntries.push({ id: m.id, type: m.type, content: m.content, metadata: { agentId: aid }, timestamp: new Date(m.createdAt).getTime() });
					}
				}
			}
		}
		return allEntries.map(e => ({ id: e.id, type: e.type, content: e.content, metadata: e.metadata, timestamp: e.timestamp, agentId: (e.metadata as any)?.agentId }));
	}

	/** 列出所有有数据的 Agent — memoryDetailEditorPane L388
	 *  通过 KV scope 枚举（mem:memories:<agent>），覆盖 Opt1 网关宿主与
	 *  renderer 代理两种模式；不再 hardcode ['default']（会导致编辑器
	 *  agent 下拉框永远只显示 default，切换其它 agent 的数据不可见）。 */
	async listAllAgentsWithData(): Promise<string[]> {
		try {
			const scopes = await this._kv.listScopes('mem:memories:');
			const agents = new Set<string>();
			for (const s of scopes) {
				const aid = s.slice('mem:memories:'.length);
				if (aid && aid !== '') agents.add(aid);
			}
			return [...agents];
		} catch { return []; }
	}

	/** 刷新待写 — memoryDetailEditorPane L431 */
	async flush(): Promise<void> {
		// 无状态架构无需 flush（每次操作直接写 KV），仅接口兼容
	}

	/** 审计摘要 — memoryDetailEditorPane L676 */
	getAuditSummary(): Record<string, number> {
		const raw = this._auditLog.getSummary();
		// 兼容 renderer 期望的 { totalAuditEntries } 格式
		return { totalAuditEntries: this._auditLog.count, ...raw };
	}

	/** Hook 统计 — memoryDetailEditorPane L718（读取真实 HookSystem 状态） */
	getHookStats(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } {
		// 确保内置默认钩子已注册（构造后可能被重载/清空时兜底）。
		if (this._hookSystem.list().length === 0) {
			this._registerDefaultHooks();
		}
		return this._hookSystem.getStats();
	}

	/** 最近提交 — memoryDetailEditorPane L771 */
	getRecentCommits(limit?: number): Array<Record<string, unknown>> {
		return this._postCommitCapture.getRecent(limit ?? 50).map(c => ({
			sha: c.metadata.sha ?? '',
			message: c.content?.slice(0, 120) ?? '',
			author: c.metadata.author ?? '',
			filesChanged: c.metadata.filesChanged ?? [],
			insertions: c.metadata.insertions ?? 0,
			deletions: c.metadata.deletions ?? 0,
			timestamp: c.timestamp ?? 0,
			branch: c.metadata.branch ?? '',
		})) as Array<Record<string, unknown>>;
	}

	/** 提交统计 — memoryDetailEditorPane L778 */
	getCommitStats(): Record<string, unknown> {
		return this._postCommitCapture.getStats() as unknown as Record<string, unknown>;
	}

	/** 生成报告 — memoryDetailEditorPane L856 */
	async generateReport(type: string, agentId: string): Promise<Record<string, unknown>> {
		try {
			const report = await this._reportGenerator.generate(type as any, agentId);
			return report as unknown as Record<string, unknown>;
		} catch {
			// 回退：至少返回基础统计
			const stats = await this.getStats(agentId);
			return { type, agentId, timestamp: new Date().toISOString(), ...stats };
		}
	}

	/** 审计日志（兼容 IMemoryProvider 签名：filter? 参数） */
	getAuditLog(filter?: { limit?: number; agentId?: string }): Array<Record<string, unknown>> {
		return this._auditLog.query({
			limit: filter?.limit ?? 200,
			agentId: filter?.agentId,
		}) as unknown as Array<Record<string, unknown>>;
	}

	// ─── 技能方法（memoryDetailEditorPane skills 视图）────────────────
	// 技能由 feat.extractSkill 持久化进 KV.procedural(agentId)（id 前缀 `skl`），
	// 与 routines(`rtn`)/procedural(`prc`) 共享同一 scope，故按前缀过滤。

	private async _readSkills(agentId: string): Promise<Array<Record<string, unknown>>> {
		try {
			const all = await this._kv.list<any>(KV.procedural(agentId));
			return all
				.filter((r: any) => r && typeof r.id === 'string' && r.id.startsWith('skl'))
				.map((s: any) => ({
					id: s.id,
					trigger: Array.isArray(s.preconditions) && s.preconditions.length
						? s.preconditions[0]
						: (s.trigger ?? ''),
					title: s.title ?? '未命名技能',
					steps: Array.isArray(s.steps) ? s.steps : [],
					expectedOutcome: s.expectedOutcome ?? 'Task completed successfully',
					tags: Array.isArray(s.tags) ? s.tags : [],
					sourceSessionId: Array.isArray(s.sourceSessionIds) && s.sourceSessionIds.length
						? s.sourceSessionIds[0]
						: (s.sourceSessionId ?? ''),
					sourceSummaryId: s.sourceSummaryId,
					confidence: typeof s.confidence === 'number' ? s.confidence : 0,
					usageCount: typeof s.usageCount === 'number' ? s.usageCount : 0,
					createdAt: s.createdAt ?? new Date().toISOString(),
					updatedAt: s.updatedAt ?? s.createdAt ?? new Date().toISOString(),
					skillMdWritten: !!s.skillMdWritten,
					slug: s.slug,
				}));
		} catch {
			return [];
		}
	}

	async getSkillStats(agentId?: string): Promise<{ totalSkills: number; avgConfidence: number; avgSteps: number; totalUsage: number; writtenCount: number }> {
		const skills = await this._readSkills(agentId ?? 'default');
		const totalSkills = skills.length;
		const avgConfidence = totalSkills ? skills.reduce((a: number, s: any) => a + (s.confidence || 0), 0) / totalSkills : 0;
		const avgSteps = totalSkills ? skills.reduce((a: number, s: any) => a + (s.steps?.length || 0), 0) / totalSkills : 0;
		const totalUsage = skills.reduce((a: number, s: any) => a + (s.usageCount || 0), 0);
		const writtenCount = skills.filter((s: any) => s.skillMdWritten).length;
		return { totalSkills, avgConfidence, avgSteps, totalUsage, writtenCount };
	}

	async listSkills(agentId?: string, filter?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
		let skills = await this._readSkills(agentId ?? 'default');
		if (filter?.minConfidence !== undefined) {
			const min = Number(filter.minConfidence);
			skills = skills.filter((s: any) => (s.confidence || 0) >= min);
		}
		if (Array.isArray(filter?.tags) && (filter!.tags as string[]).length) {
			const tags = filter!.tags as string[];
			skills = skills.filter((s: any) => tags.some((t: string) => (s.tags || []).includes(t)));
		}
		return skills.sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0));
	}

	/** 新增手动技能（pane _addSkill 调用，agentId 为首参，对齐 host.mjs 路由约定） */
	async addSkill(agentId: string, data: { title: string; trigger: string; steps: string[]; expectedOutcome?: string; tags?: string[] }): Promise<Record<string, unknown> | null> {
		if (!data?.title || !Array.isArray(data.steps) || data.steps.length === 0) return null;
		const now = new Date().toISOString();
		const slug = skillX.generateSlug(data.title);
		const entry: Record<string, unknown> = {
			id: `skl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			title: data.title.slice(0, 100),
			preconditions: [data.trigger],
			steps: data.steps,
			expectedOutcome: (data.expectedOutcome ?? 'Task completed successfully').slice(0, 300),
			tags: data.tags ?? [],
			confidence: 0.8,
			sourceSessionIds: ['manual'],
			agentId,
			createdAt: now,
			updatedAt: now,
			skillMdWritten: false,
			slug,
		};
		await this._kv.set(KV.procedural(agentId), entry.id as string, entry);
		return (await this._readSkills(agentId)).find((s) => s.id === entry.id) ?? null;
	}

	/** 写入 SKILL.md 到 <skillsRoot>/<slug>/SKILL.md，并持久化 skillMdWritten */
	async writeSkillFile(agentId: string, skillId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
		try {
			const skills = await this._readSkills(agentId);
			const skill = skills.find((s) => s.id === skillId);
			if (!skill) return { ok: false, error: 'skill not found' };
			const slug = (skill.slug as string) || skillX.generateSlug(skill.title as string);
			const md = skillX.generateSkillMd(skill as any);
			const dir = _path.join(_skillsDir(), slug);
			await _fs.mkdir(dir, { recursive: true });
			const filePath = _path.join(dir, 'SKILL.md');
			await _fs.writeFile(filePath, md, 'utf8');
			const entry = await this._kv.get<any>(KV.procedural(agentId), skillId);
			if (entry) {
				entry.skillMdWritten = true;
				entry.slug = slug;
				await this._kv.set(KV.procedural(agentId), skillId, entry);
			}
			return { ok: true, path: filePath };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async deleteSkillFile(agentId: string, skillId: string): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
		try {
			const skills = await this._readSkills(agentId);
			const skill = skills.find((s) => s.id === skillId);
			const slug = (skill?.slug as string) || (skill ? skillX.generateSlug(skill.title as string) : '');
			let deleted = false;
			if (slug) {
			const dir = _path.join(_skillsDir(), slug);
			await _fs.rm(dir, { recursive: true, force: true });
			deleted = true;
			}
			const entry = await this._kv.get<any>(KV.procedural(agentId), skillId);
			if (entry) {
				entry.skillMdWritten = false;
				await this._kv.set(KV.procedural(agentId), skillId, entry);
			}
			return { ok: true, deleted };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async writeAllSkillFiles(agentId: string): Promise<{ written: number; failed: number; errors: string[] }> {
		const skills = await this._readSkills(agentId);
		let written = 0;
		let failed = 0;
		const errors: string[] = [];
		for (const s of skills) {
			const r = await this.writeSkillFile(agentId, s.id as string);
			if (r.ok) written++;
			else { failed++; errors.push(`${s.title}: ${r.error}`); }
		}
		return { written, failed, errors };
	}

	async updateSkill(agentId: string, id: string, updates: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const entry = await this._kv.get<any>(KV.procedural(agentId), id);
		if (!entry) return null;
		if (typeof updates.title === 'string') {
			entry.title = updates.title.slice(0, 100);
			if (typeof updates.slug !== 'string') entry.slug = skillX.generateSlug(entry.title);
		}
		if (typeof updates.trigger === 'string') entry.preconditions = [updates.trigger];
		if (Array.isArray(updates.steps)) entry.steps = updates.steps;
		if (typeof updates.expectedOutcome === 'string') entry.expectedOutcome = updates.expectedOutcome.slice(0, 300);
		if (Array.isArray(updates.tags)) entry.tags = updates.tags;
		if (typeof updates.slug === 'string') entry.slug = updates.slug;
		entry.skillMdWritten = false; // 编辑后需重新写入
		entry.updatedAt = new Date().toISOString();
		await this._kv.set(KV.procedural(agentId), id, entry);
		return (await this._readSkills(agentId)).find((s) => s.id === id) ?? null;
	}

	async deleteSkill(agentId: string, id: string): Promise<boolean> {
		const entry = await this._kv.get<any>(KV.procedural(agentId), id);
		if (!entry) return false;
		await this._kv.delete(KV.procedural(agentId), id);
		return true;
	}

	// ─── 长期记忆条目编辑/删除（Memory V2 可编辑）────────────────────────

	async updateMemory(agentId: string, id: string, updates: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		await this._ensureServer();
		const entry = await this._kv.get<any>(KV.memories(agentId), id);
		if (!entry) { return null; }
		if (typeof updates.title === 'string') { entry.title = updates.title.slice(0, 200); }
		if (typeof updates.content === 'string' && updates.content.trim()) { entry.content = updates.content; }
		if (typeof updates.type === 'string' && ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'].includes(updates.type)) { entry.type = updates.type; }
		if (Array.isArray(updates.concepts)) { entry.concepts = updates.concepts; }
		if (Array.isArray(updates.files)) { entry.files = updates.files; }
		if (typeof updates.strength === 'number' && updates.strength >= 0 && updates.strength <= 1) { entry.strength = updates.strength; }
		entry.updatedAt = new Date().toISOString();
		entry.version = (entry.version ?? 1) + 1;
		await this._kv.set(KV.memories(agentId), id, entry);
		return entry;
	}

	async deleteMemory(agentId: string, id: string): Promise<boolean> {
		await this._ensureServer();
		const entry = await this._kv.get<any>(KV.memories(agentId), id);
		if (!entry) { return false; }
		// 先置 isLatest=false 写回（网关 PUT 钩子据此从搜索索引移除），再硬删除 KV 条目
		entry.isLatest = false;
		entry.updatedAt = new Date().toISOString();
		await this._kv.set(KV.memories(agentId), id, entry);
		await this._kv.delete(KV.memories(agentId), id);
		return true;
	}

	// ─── 事件（IMemoryProvider 接口兼容）────────────────────────────────

	onMemoryWriteFailed(handler: (agentId: string, data: { memoryId: string; error: string }) => void): () => void {
		return this._on('memory_write_failed', handler);
	}

	onSubagentStart(parentAgentId: string, task: { taskId: string; description: string; tool?: string }): unknown {
		console.log(`[AgentMemoryV2] Subagent ${task.taskId} started for ${parentAgentId}`);
		return { sessionId: task.taskId };
	}

	onSubagentStop(agentId: string, status: string, result?: unknown, error?: string): boolean {
		if (status === 'completed' && result) {
			fn.coreAdd(this._kv, agentId, `[subagent_completed] ${JSON.stringify(result).slice(0, 200)}`, 5, false).catch(() => {});
		}
		return true;
	}

	// ─── Slot 别名（兼容 V1 命名约定）───────────────────────────────────

	async getSlot(agentId: string, label: string): Promise<string> {
		const s = await slots.slotGet(this._kv, agentId, label);
		return s?.content ?? '';
	}

	setSlot(agentId: string, label: string, content: string): void {
		slots.slotSet(this._kv, agentId, label, content).catch(() => {});
	}

	// ───内部方法 ──────────────────────────────────────────────────────────

	private async _ensureServer(): Promise<void> {
		// 宿主（网关）模式：引擎直接在进程内运行，无需 HTTP 健康检查。
		if (this._hosted) return;
		const now = Date.now();
		if (!this._healthChecked || (!this._serverAvailable && (now - this._lastHealthCheckAt) > 30_000)) {
			this._lastHealthCheckAt = now;
			this._serverAvailable = await checkHealth();
			this._healthChecked = true;
		}
		// Plan C: 索引与检索已下沉到网关，renderer 无需恢复/重建索引。
	}

	/** Plan C: 网关侧索引统计（renderer 不再持有索引）。 */
	private async _serverStats(agentId: string): Promise<{ indexSize: number }> {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
			const resp = await fetch(`${serverBase()}/stats/${encodeURIComponent(agentId)}`, { signal: ctrl.signal });
			clearTimeout(timer);
			if (!resp.ok) return { indexSize: 0 };
			const data = await resp.json() as { indexSize?: number };
			return { indexSize: data.indexSize ?? 0 };
		} catch {
			return { indexSize: 0 };
		}
	}

	dispose(): void {
		this._handlers.clear();
		this._kv.dispose();
	}

	/** 手动 sweep（对齐 agentmemory cron） */
	async sweep(agentId: string): Promise<void> {
		await this._ensureServer();
		await pipe.runFullSweep(this._kv, agentId, agentId, this._tokenBudget);
	}

	/**
	 * 定期维护清扫 — 供 gateway host.mjs 定时器调用，也可由 renderer proxy 手动触发。
	 *
	 * 执行顺序：
	 *   1. runFullSweep（auto-forget / retention evict / consolidation / lesson decay / auto-page）
	 *   2. feat.extractSkill — 从 workflow/pattern 记忆提炼可复用技能 → KV.procedural
	 *   3. autoCrystallize — 晶化值得固化的操作序列
	 *
	 * 提取到技能时通过 this._emit('skill_extracted', ...) 通知订阅者。
	 * 返回摘要对象供调用方（如 proxy）使用。
	 */
	async runMaintenanceSweep(agentId: string, sessionId?: string): Promise<Record<string, unknown>> {
		await this._ensureServer();
		const result: Record<string, unknown> = {};

		// 0. D1 一次性迁移：summaries 中误存的 TeamSharedItem → 全局 team scope（幂等）
		try {
			const migration = await repl.migrateLegacyTeamShared(this._kv, agentId);
			if (migration.migrated > 0) { result.teamMigration = migration; }
		} catch (err: any) {
			result.teamMigrationError = err?.message ?? String(err);
		}

		// 0.5 L1-L3 一次性清洗：客户端管线移除后的历史产物 l1-extract/l2-scene/l3-persona（幂等，§17）
		try {
			const l1l3 = await repl.purgeLegacyL1L3Extractions(this._kv, agentId);
			if (l1l3.purged > 0) { result.l1l3Purge = l1l3; }
		} catch (err: any) {
			result.l1l3PurgeError = err?.message ?? String(err);
		}

		// 1. 全量清扫
		try {
			result.sweep = await pipe.runFullSweep(this._kv, agentId, agentId, this._tokenBudget);
		} catch (err: any) {
			result.sweepError = err?.message ?? String(err);
		}

		// 2. 技能提取（从当前记忆中的 workflow/pattern 提炼）
		try {
			const sid = sessionId ?? `sweep-${Date.now()}`;
			const skill = await feat.extractSkill(this._kv, agentId, sid);
			if (skill) {
				result.skillExtracted = {
					skillId: skill.id,
					title: skill.title,
					trigger: skill.trigger,
					confidence: skill.confidence,
					steps: skill.steps.length,
				};
				this._emit('skill_extracted', {
					agentId,
					data: {
						skillId: skill.id,
						title: skill.title,
						trigger: skill.trigger,
						confidence: skill.confidence,
						steps: skill.steps.length,
					},
				});
			}
		} catch (err: any) {
			result.skillError = err?.message ?? String(err);
		}

		// 3. 自动晶化
		try {
			result.crystallize = await fin.autoCrystallize(this._kv, agentId);
		} catch (err: any) {
			result.crystallizeError = err?.message ?? String(err);
		}

		// 4. 租约清理（接入 amFinal.leaseCleanup：过期 lease 标记 expired）
		try {
			result.leasesCleaned = await fin.leaseCleanup(this._kv, agentId);
		} catch (err: any) {
			result.leaseCleanupError = err?.message ?? String(err);
		}

		// 5. 哨兵评估（接入 amAdvanced.sentinelCheck：threshold/pattern/schedule 条件
		//    评估，命中的标记 triggered 并逐个发出 sentinel_triggered 事件）
		try {
			const sentinelResult = await adv.sentinelCheck(this._kv, agentId);
			result.sentinels = sentinelResult;
			for (const t of sentinelResult.triggered) {
				this._emit('sentinel_triggered', agentId, t);
			}
		} catch (err: any) {
			result.sentinelCheckError = err?.message ?? String(err);
		}

		return result;
	}
}
