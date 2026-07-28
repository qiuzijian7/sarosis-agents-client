/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentStudio Dashboard Service — 聚合各服务的真实统计数据供 Dashboard UI 展示
 *
 * 数据来源：
 * - IAgentOSService: Token/压缩/工具调用统计（getDashboardStats）、模型选择、记忆 Provider
 *   （会话面板基于 agentmemory 会话机制：KV.sessions 观察 → 压缩 → KV.summaries 摘要）
 * - ICodebaseGraphService: 代码图谱节点/边数（getIndexStatus）
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentOSService, IAgentOSDashboardStats, IDailyBucket } from '../common/agentOS.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';

export const IAgentStudioDashboardService = createDecorator<IAgentStudioDashboardService>('IAgentStudioDashboardService');

export interface IDashboardKpi {
	label: string;
	value: string;
	unit?: string;
	trend?: { direction: 'up' | 'down' | 'flat'; text: string };
	detail?: string;
	breakdown?: { label: string; color: string }[];
	color: string;
}

export interface IDashboardSession {
	id: string;
	name: string;
	status: 'running' | 'idle' | 'failed' | 'completed' | 'stopped';
	model: string;
	tokens: number;
	turns: number;
	duration: string;
	// ─── agentmemory 会话管线 ───────────────────────────────────
	/** 所属 Agent（跨 agent 聚合时填充） */
	agentId?: string;
	/** 会话观察数（KV.sessions.observationCount） */
	observationCount?: number;
	/** 是否已压缩为 SessionSummary */
	summarized?: boolean;
	/** 压缩摘要标题（已压缩时填充） */
	summaryTitle?: string;
	/** 会话所属项目 */
	project?: string;
}

export interface IDashboardAlert {
	id: string;
	type: 'warning' | 'info' | 'success';
	title: string;
	description: string;
}

export interface IDashboardSkillUsage {
	name: string;
	used: number;
	loaded: number;
}

export interface IDashboardCompressionMetric {
	beforeTokens: number;
	afterTokens: number;
	savedTokens: number;
	savedPercent: number;
	compressionCount: number;
	ineffectiveCount: number;
	cacheLostTokens: number;
}

export interface IDashboardMemoryStat {
	total: number;
	/** Working (Working) — working 记忆 */
	working: number;
	/** Episodic 记忆 */
	episodic: number;
	/** Semantic 记忆 */
	semantic: number;
	/** Procedural 记忆 */
	procedural: number;
	/** 记忆图谱节点数 */
	graphNodes: number;
	/** 记忆图谱边数 */
	graphEdges: number;
	/** 搜索总次数 */
	totalSearches: number;
	/** 零结果搜索次数 */
	zeroResultSearches: number;
	/** 健康状态 */
	healthStatus: string;
}

export interface IDashboardBudget {
	project: string;
	used: number;
	limit: number;
}

export interface IDashboardTokenByModel {
	model: string;
	tokens: number;
	percent: number;
}

export interface IDashboardData {
	kpis: IDashboardKpi[];
	sessions: IDashboardSession[];
	alerts: IDashboardAlert[];
	skills: IDashboardSkillUsage[];
	compression: IDashboardCompressionMetric;
	memory: IDashboardMemoryStat;
	budgets: IDashboardBudget[];
	tokenByModel: IDashboardTokenByModel[];
	graphStats: { nodes: number; edges: number; files: number; project: string; exists: boolean };
	/** 按天聚合的指标数据（支持趋势图），从 SQLite 查询 */
	dailyBuckets: IDailyBucket[];
	lastUpdated: number;
}

export type DashboardDateRange = 'today' | '7d' | '30d' | 'all';

export interface IAgentStudioDashboardService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeData: Event<IDashboardData>;
	getData(): IDashboardData;
	refresh(): Promise<IDashboardData>;
	setDateRange(range: DashboardDateRange): void;
	getDateRange(): DashboardDateRange;
}

// ─── Implementation ─────────────────────────────────────────────────────

export class AgentStudioDashboardService extends Disposable implements IAgentStudioDashboardService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeData = this._register(new Emitter<IDashboardData>());
	readonly onDidChangeData = this._onDidChangeData.event;

	private _cachedData: IDashboardData | undefined;
	private _dateRange: DashboardDateRange = '7d';

	constructor(
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
	) {
		super();
		// 初始空数据
		this._cachedData = this._emptyData();
	}

	getData(): IDashboardData {
		return this._cachedData ?? this._emptyData();
	}

	async refresh(): Promise<IDashboardData> {
		console.info('[Dashboard] refresh() started');
		try {
			this._cachedData = await this._buildData();
			console.info('[Dashboard] refresh() success:', {
				sessions: this._cachedData.sessions.length,
				kpis: this._cachedData.kpis.length,
				skills: this._cachedData.skills.length,
				alerts: this._cachedData.alerts.length,
				totalTokens: this._cachedData.kpis[1]?.value ?? '0',
				memoryTotal: this._cachedData.memory.total,
				graphNodes: this._cachedData.graphStats.nodes,
			});
		} catch (err) {
			console.warn('[Dashboard] refresh() FAILED:', err);
		}
		const data = this._cachedData ?? this._emptyData();
		this._onDidChangeData.fire(data);
		console.info('[Dashboard] onDidChangeData fired');
		return data;
	}

	setDateRange(range: DashboardDateRange): void {
		this._dateRange = range;
		console.info('[Dashboard] setDateRange:', range);
	}

	getDateRange(): DashboardDateRange {
		return this._dateRange;
	}

	// ─── Private: Build Dashboard Data from Real Sources ────────────────

	private async _buildData(): Promise<IDashboardData> {
		// 1. AgentOS 统计
		let osStats: IAgentOSDashboardStats;
		try {
			osStats = this._agentOSService.getDashboardStats();
		} catch (err) {
			console.warn('[Dashboard] getDashboardStats failed:', err);
			osStats = {
				totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0,
				activeModelId: 'unknown', compressionCount: 0, compressionIneffectiveCount: 0,
				compressionBeforeTokens: 0, compressionAfterTokens: 0,
			toolCallCounts: new Map<string, number>(),
		};
		}
		console.info('[Dashboard] osStats:', {
			tokens: osStats.totalInputTokens + osStats.totalOutputTokens + osStats.totalCachedTokens,
			compression: osStats.compressionCount,
			tools: osStats.toolCallCounts.size,
			model: osStats.activeModelId,
		});

		// 2. 会话列表（基于 agentmemory 会话机制：KV.sessions 观察 → 压缩 → SessionSummary）
		let sessions: IDashboardSession[] = [];
		try {
			sessions = await this._buildMemorySessions();
			console.info('[Dashboard] agentmemory sessions loaded:', sessions.length);
		} catch (err) {
			console.warn('[Dashboard] _buildMemorySessions failed:', err);
		}

		// 3. 记忆统计
		let memory: IDashboardMemoryStat = {
			total: 0, working: 0, episodic: 0, semantic: 0, procedural: 0,
			graphNodes: 0, graphEdges: 0, totalSearches: 0, zeroResultSearches: 0, healthStatus: 'N/A',
		};
		try {
			memory = await this._buildMemoryStats();
		} catch (err) {
			console.warn('[Dashboard] _buildMemoryStats failed:', err);
		}

		// 4. 代码图谱统计
		let graphStats = { nodes: 0, edges: 0, files: 0, project: '', exists: false };
		try {
			const idx = this._graphService.getIndexStatus();
			graphStats = {
				nodes: idx.nodeCount,
				edges: idx.edgeCount,
				files: idx.fileCount,
				project: idx.project,
				exists: idx.exists,
			};
			console.info('[Dashboard] graphStats:', graphStats);
		} catch (err) {
			console.warn('[Dashboard] getIndexStatus failed:', err);
		}

		// 5. 工具调用统计 → Skills
		const skills: IDashboardSkillUsage[] = Array.from(osStats.toolCallCounts.entries())
			.map(([name, used]) => ({ name, used, loaded: used }))
			.sort((a, b) => b.used - a.used)
			.slice(0, 12);

		// 6. 压缩指标
		const compression: IDashboardCompressionMetric = {
			beforeTokens: osStats.compressionBeforeTokens,
			afterTokens: osStats.compressionAfterTokens,
			savedTokens: osStats.compressionBeforeTokens - osStats.compressionAfterTokens,
			savedPercent: osStats.compressionBeforeTokens > 0
				? Math.round(((osStats.compressionBeforeTokens - osStats.compressionAfterTokens) / osStats.compressionBeforeTokens) * 100)
				: 0,
			compressionCount: osStats.compressionCount,
			ineffectiveCount: osStats.compressionIneffectiveCount,
			cacheLostTokens: 0, // 暂无缓存失效追踪
		};

		// 7. Token 按模型分布（当前只有一个活跃模型，按 input/output/cached 分解）
		const totalTokens = osStats.totalInputTokens + osStats.totalOutputTokens + osStats.totalCachedTokens;
		const tokenByModel: IDashboardTokenByModel[] = [];
		if (totalTokens > 0) {
			tokenByModel.push(
				{ model: `${osStats.activeModelId} (输入)`, tokens: osStats.totalInputTokens, percent: totalTokens > 0 ? Math.round((osStats.totalInputTokens / totalTokens) * 100) : 0 },
				{ model: `${osStats.activeModelId} (缓存)`, tokens: osStats.totalCachedTokens, percent: totalTokens > 0 ? Math.round((osStats.totalCachedTokens / totalTokens) * 100) : 0 },
				{ model: `${osStats.activeModelId} (输出)`, tokens: osStats.totalOutputTokens, percent: totalTokens > 0 ? Math.round((osStats.totalOutputTokens / totalTokens) * 100) : 0 },
			);
		}

		// 8. 告警（从真实数据推导）
		const alerts = this._buildAlerts(osStats, graphStats, sessions, memory);

		// 9. KPIs
		const runningCount = sessions.filter(s => s.status === 'running').length;
		const summarizedCount = sessions.filter(s => s.summarized).length;

		const kpis: IDashboardKpi[] = [
			{
				label: '代码图谱',
				value: graphStats.exists ? graphStats.nodes.toLocaleString() : '0',
				detail: graphStats.exists ? `${graphStats.edges.toLocaleString()} 边` : '未索引',
				breakdown: graphStats.exists ? [
					{ label: `节点 ${graphStats.nodes.toLocaleString()}`, color: '#0078d4' },
					{ label: `边 ${graphStats.edges.toLocaleString()}`, color: '#4ec9b0' },
				] : [{ label: '点击索引代码库', color: '#858585' }],
				color: '#0078d4',
			},
			{
				label: '记忆会话',
			value: String(sessions.length),
			detail: sessions.length === 0 ? '暂无会话' : (summarizedCount > 0 ? `${summarizedCount} 已压缩` : `${runningCount} 活跃`),
			breakdown: sessions.length > 0 ? [
				{ label: `已压缩 ${summarizedCount}`, color: '#89d185' },
				{ label: `暂存 ${sessions.length - summarizedCount}`, color: '#dcdcaa' },
			] : [{ label: '开始对话后统计', color: '#858585' }],
			color: '#4ec9b0',
		},
			{
				label: 'Token 消耗',
				value: totalTokens > 0 ? (totalTokens / 1000).toFixed(1) : '0',
				unit: totalTokens > 0 ? 'K' : undefined,
				detail: totalTokens > 0 ? osStats.activeModelId : '开始对话后统计',
				breakdown: totalTokens > 0 ? [
					{ label: `输入 ${(osStats.totalInputTokens / 1000).toFixed(1)}K`, color: '#0078d4' },
					{ label: `缓存 ${(osStats.totalCachedTokens / 1000).toFixed(1)}K`, color: '#89d185' },
					{ label: `输出 ${(osStats.totalOutputTokens / 1000).toFixed(1)}K`, color: '#4ec9b0' },
				] : [{ label: osStats.activeModelId, color: '#858585' }],
				color: '#dcdcaa',
			},
			{
				label: '压缩节省',
				value: String(compression.savedPercent),
				unit: compression.compressionCount > 0 ? '%' : undefined,
				detail: compression.compressionCount > 0
					? `节省 ${(compression.savedTokens / 1000).toFixed(1)}K tokens`
					: '尚未触发压缩',
				breakdown: [
					{ label: `压缩 ${compression.compressionCount} 次`, color: '#dcdcaa' },
					{ label: `低效 ${compression.ineffectiveCount} 次`, color: '#f48771' },
				],
				color: '#ce9178',
			},
			{
				label: '记忆 (4-Tier)',
				value: String(memory.total),
				detail: memory.total > 0
					? `E ${memory.episodic} · S ${memory.semantic} · P ${memory.procedural}`
					: '暂无记忆数据',
				breakdown: memory.total > 0 ? [
					{ label: `Working ${memory.working}`, color: '#0078d4' },
					{ label: `Episodic ${memory.episodic}`, color: '#4ec9b0' },
					{ label: `Semantic ${memory.semantic}`, color: '#c586c0' },
					{ label: `Procedural ${memory.procedural}`, color: '#ce9178' },
				] : [],
				color: '#c586c0',
			},
		];

		// 10. 时间序列数据（从 SQLite 查询，按 dateRange 过滤）
		let dailyBuckets: IDailyBucket[] = [];
		try {
			const rangeMs = this._dateRange === 'today' ? 24 * 60 * 60 * 1000
				: this._dateRange === '7d' ? 7 * 24 * 60 * 60 * 1000
					: this._dateRange === '30d' ? 30 * 24 * 60 * 60 * 1000
						: 365 * 24 * 60 * 60 * 1000; // 'all' → 1 year max
			dailyBuckets = await this._agentOSService.queryDashboardDailyBuckets(rangeMs);
			console.info('[Dashboard] dailyBuckets:', dailyBuckets.length, 'days');
		} catch (err) {
			console.warn('[Dashboard] queryDailyBuckets failed:', err);
		}

		// 11. 采集当前快照（fire-and-forget）
		if (this._agentOSService.captureDashboardSnapshot) {
			this._agentOSService.captureDashboardSnapshot({
				sessionCount: sessions.length,
				memoryTotal: memory.total,
				graphNodes: graphStats.nodes,
			}).catch(() => {});
		}

		const result: IDashboardData = {
			kpis,
			sessions,
			alerts,
			skills,
			compression,
			memory,
			budgets: [],
			tokenByModel,
			graphStats,
			dailyBuckets,
			lastUpdated: Date.now(),
		};
		console.info('[Dashboard] _buildData result:', {
			kpi0: kpis[0]?.value, // 会话总数
			kpi1: kpis[1]?.value, // Token 消耗
			kpi2: kpis[2]?.value, // 压缩节省
			kpi3: kpis[3]?.value, // 记忆条数
			sessions: sessions.length,
			skills: skills.length,
			alerts: alerts.length,
			memoryTotal: memory.total,
			graphExists: graphStats.exists,
			graphNodes: graphStats.nodes,
		});
		return result;
	}

	/**
	 * 从 agentmemory 引擎聚合会话管线数据（跨 agent）。
	 * 数据源：KV.sessions（观察注册）+ KV.summaries（压缩摘要）。
	 * 每个会话呈现 观察数 → 是否已压缩为 SessionSummary 的管线状态。
	 */
	private async _buildMemorySessions(): Promise<IDashboardSession[]> {
		const collected: Array<{ rec: any; agentId: string; summary: any; updatedMs: number }> = [];
		const memProvider = this._agentOSService.getActiveMemoryProvider() as any;
		if (!memProvider?.listSessions) {
			console.info('[Dashboard] memProvider.listSessions not available');
			return [];
		}
		const agents: string[] = await memProvider.listAllAgentsWithData?.().catch(() => []) ?? [];
		for (const agentId of agents) {
			let sessions: any[] = [];
			let summaries: any[] = [];
			try {
				[sessions, summaries] = await Promise.all([
					memProvider.listSessions(agentId).catch(() => []),
					memProvider.listSummaries(agentId).catch(() => []),
				]);
			} catch { continue; }
			const summaryById = new Map<string, any>((summaries ?? []).map((s: any) => [s?.sessionId, s]));
			for (const rec of sessions ?? []) {
				const updatedMs = new Date(rec?.updatedAt || rec?.startedAt || 0).getTime();
				collected.push({ rec, agentId, summary: summaryById.get(rec?.id), updatedMs });
			}
		}
		return collected
			.sort((a, b) => b.updatedMs - a.updatedMs)
			.slice(0, 20)
			.map(c => this._convertMemorySession(c.rec, c.agentId, c.summary));
	}

	private _convertMemorySession(
		rec: { id?: string; firstPrompt?: string; observationCount?: number; updatedAt?: string; startedAt?: string; project?: string },
		agentId: string,
		summary: { title?: string } | undefined,
	): IDashboardSession {
		const updatedMs = new Date(rec.updatedAt || rec.startedAt || 0).getTime();
		const diffMin = Math.floor((Date.now() - updatedMs) / 60000);
		const summarized = !!summary;
		const status: IDashboardSession['status'] = summarized ? 'completed' : (diffMin < 5 ? 'running' : 'idle');
		return {
			id: rec.id ?? '',
			name: rec.firstPrompt || rec.id || '未命名会话',
			status,
			model: agentId,
			tokens: 0,
			turns: rec.observationCount ?? 0,
			duration: this._relativeTime(updatedMs),
			agentId,
			observationCount: rec.observationCount ?? 0,
			summarized,
			summaryTitle: summary?.title,
			project: rec.project,
		};
	}

	private _relativeTime(ms: number): string {
		if (!ms || Number.isNaN(ms)) { return '—'; }
		const diffMin = Math.floor((Date.now() - ms) / 60000);
		if (diffMin < 1) { return '刚刚'; }
		if (diffMin < 60) { return `${diffMin}分钟前`; }
		const diffHour = Math.floor(diffMin / 60);
		if (diffHour < 24) { return `${diffHour}小时前`; }
		return `${Math.floor(diffHour / 24)}天前`;
	}

	private async _buildMemoryStats(): Promise<IDashboardMemoryStat> {
		let total = 0;
		let working = 0;
		let episodic = 0;
		let semantic = 0;
		let procedural = 0;
		let graphNodes = 0;
		let graphEdges = 0;
		let totalSearches = 0;
		let zeroResultSearches = 0;
		let healthStatus = 'N/A';

		try {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			console.info('[Dashboard] memProvider:', memProvider ? `${memProvider.id} (${memProvider.name})` : 'null');
			if (memProvider) {
				// 1. 使用 getExtendedStats 获取完整统计（如果 Provider 支持）
				if (memProvider.getExtendedStats) {
					try {
						const ext = memProvider.getExtendedStats('*') as Record<string, unknown>;
						graphNodes = Number(ext['graphNodes']) || 0;
						graphEdges = Number(ext['graphEdges']) || 0;
						totalSearches = Number(ext['totalSearches']) || 0;
						zeroResultSearches = Number(ext['zeroResultSearches']) || 0;
						healthStatus = String(ext['healthStatus'] ?? 'N/A');
						console.info('[Dashboard] getExtendedStats:', { graphNodes, graphEdges, totalSearches, healthStatus });
					} catch (err) { console.warn('[Dashboard] getExtendedStats failed:', err); }
				} else {
					console.info('[Dashboard] getExtendedStats not supported by provider');
				}

			// 2. 搜索全量记忆，按 agentmemory 4 层分类计数
			// 层模型：working→core、semantic/procedural→独立 scope、原生类型(pattern/.../fact)→Episodic 层
			const entries = await memProvider.searchMemory('*', '*');
			total = entries.length;
			console.info('[Dashboard] searchMemory result:', total, 'entries');
			working = 0; episodic = 0; semantic = 0; procedural = 0;
			for (const entry of entries) {
				const t = entry.type as string;
				if (t === 'working') { working++; }
				else if (t === 'semantic') { semantic++; }
				else if (t === 'procedural') { procedural++; }
				else { episodic++; } // 原生类型（pattern/preference/architecture/bug/workflow/fact）归入 Episodic 层
			}
				console.info('[Dashboard] memory 4-Tier:', { working, episodic, semantic, procedural });
			}
		} catch (err) {
			console.warn('[Dashboard] _buildMemoryStats outer catch:', err);
		}

		return {
			total,
			working,
			episodic,
			semantic,
			procedural,
			graphNodes,
			graphEdges,
			totalSearches,
			zeroResultSearches,
			healthStatus,
		};
	}

	private _buildAlerts(
		osStats: { compressionIneffectiveCount: number },
		graphStats: { exists: boolean; nodes: number; files: number; project: string },
		sessions: IDashboardSession[],
		memory: IDashboardMemoryStat,
	): IDashboardAlert[] {
		const alerts: IDashboardAlert[] = [];

		// 压缩低效告警
		if (osStats.compressionIneffectiveCount > 0) {
			alerts.push({
				id: 'comp-ineffective',
				type: 'warning',
				title: '压缩低效',
				description: `${osStats.compressionIneffectiveCount} 次压缩节省 < 10%，可能触发 anti-thrashing 保护`,
			});
		}

		// 记忆健康状态
		if (memory.healthStatus !== 'N/A' && memory.healthStatus !== 'healthy') {
			alerts.push({
				id: 'mem-health',
				type: 'warning',
				title: '记忆系统健康状态',
				description: `当前状态: ${memory.healthStatus}${memory.zeroResultSearches > 0 ? `，${memory.zeroResultSearches} 次零结果搜索` : ''}`,
			});
		}

		// 图谱索引状态
		if (graphStats.exists && graphStats.nodes > 0) {
			alerts.push({
				id: 'graph-indexed',
				type: 'success',
				title: '代码图谱已索引',
				description: `${graphStats.project}: ${graphStats.nodes} 节点, ${graphStats.files} 文件`,
			});
		}

		// 活跃会话通知
		const runningSessions = sessions.filter(s => s.status === 'running');
		if (runningSessions.length > 0) {
			alerts.push({
				id: 'active-sessions',
				type: 'info',
				title: '活跃会话',
				description: `${runningSessions.length} 个会话正在运行`,
			});
		}

		// 如果没有任何告警，显示一个信息提示
		if (alerts.length === 0) {
			alerts.push({
				id: 'no-data',
				type: 'info',
				title: '等待数据',
				description: '开始对话后此处将显示 Agent 运行统计',
			});
		}

		return alerts;
	}

	private _emptyData(): IDashboardData {
		return {
			kpis: [],
			sessions: [],
			alerts: [{ id: 'empty', type: 'info', title: '等待数据', description: '开始对话后此处将显示 Agent 运行统计' }],
			skills: [],
			compression: { beforeTokens: 0, afterTokens: 0, savedTokens: 0, savedPercent: 0, compressionCount: 0, ineffectiveCount: 0, cacheLostTokens: 0 },
			memory: { total: 0, working: 0, episodic: 0, semantic: 0, procedural: 0, graphNodes: 0, graphEdges: 0, totalSearches: 0, zeroResultSearches: 0, healthStatus: 'N/A' },
			budgets: [],
			tokenByModel: [],
			graphStats: { nodes: 0, edges: 0, files: 0, project: '', exists: false },
			dailyBuckets: [],
			lastUpdated: Date.now(),
		};
	}
}
