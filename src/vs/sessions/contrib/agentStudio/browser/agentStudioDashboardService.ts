/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentStudio Dashboard Service — 聚合各服务的真实统计数据供 Dashboard UI 展示
 *
 * 数据来源：
 * - IAgentStudioService: 会话列表（getSessions）
 * - IAgentOSService: Token/压缩/工具调用统计（getDashboardStats）、模型选择、记忆 Provider
 * - ICodebaseGraphService: 代码图谱节点/边数（getIndexStatus）
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';
import type { AgentStudioSession } from '../../../common/agentStudioTypes.js';

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
	/** Episodic (Episodic) — episodic 记忆（Episodic 自动提取） */
	episodic: number;
	/** Semantic (Semantic) — scene 场景记忆（Semantic 提取） */
	semantic: number;
	/** Procedural (Procedural) — persona 人格记忆（Procedural 生成） */
	procedural: number;
	/** Episodic Episodic 提取触发次数 */
	episodicExtractionCount: number;
	/** Semantic Semantic 提取触发次数 */
	semanticExtractionCount: number;
	/** Procedural Procedural 生成触发次数 */
	proceduralExtractionCount: number;
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
	lastUpdated: number;
}

export interface IAgentStudioDashboardService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeData: Event<IDashboardData>;
	getData(): IDashboardData;
	refresh(): Promise<IDashboardData>;
}

// ─── Implementation ─────────────────────────────────────────────────────

export class AgentStudioDashboardService extends Disposable implements IAgentStudioDashboardService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeData = this._register(new Emitter<IDashboardData>());
	readonly onDidChangeData = this._onDidChangeData.event;

	private _cachedData: IDashboardData | undefined;

	constructor(
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
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
		try {
			this._cachedData = await this._buildData();
		} catch (err) {
			// 出错时保留上次数据
			console.warn('[Dashboard] refresh failed:', err);
		}
		const data = this._cachedData ?? this._emptyData();
		this._onDidChangeData.fire(data);
		return data;
	}

	// ─── Private: Build Dashboard Data from Real Sources ────────────────

	private async _buildData(): Promise<IDashboardData> {
		// 1. AgentOS 统计
		const osStats = this._agentOSService.getDashboardStats();

		// 2. 会话列表
		let sessions: IDashboardSession[] = [];
		try {
			const rawSessions = await this._agentStudioService.getSessions();
		sessions = rawSessions
			.filter((s: AgentStudioSession) => !s.archived)
			.slice(-20)  // 最近 20 条
			.reverse()   // 最新的在前
			.map((s: AgentStudioSession) => this._convertSession(s, osStats.activeModelId));
		} catch { /* ignore */ }

		// 3. 记忆统计
		const memory = await this._buildMemoryStats(osStats);

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
		} catch { /* ignore */ }

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
		const idleCount = sessions.filter(s => s.status === 'idle').length;

		const kpis: IDashboardKpi[] = [
			{
				label: '会话总数',
				value: String(sessions.length),
				detail: runningCount > 0 ? `${runningCount} 活跃` : '无活跃会话',
				breakdown: [
					{ label: `活跃 ${runningCount}`, color: '#4ec9b0' },
					{ label: `空闲 ${idleCount}`, color: '#dcdcaa' },
				],
				color: '#0078d4',
			},
			{
				label: 'Token 消耗 (累计)',
				value: totalTokens > 0 ? (totalTokens / 1000).toFixed(1) : '0',
				unit: 'K',
				detail: osStats.activeModelId,
				breakdown: [
					{ label: `输入 ${(osStats.totalInputTokens / 1000).toFixed(1)}K`, color: '#0078d4' },
					{ label: `缓存 ${(osStats.totalCachedTokens / 1000).toFixed(1)}K`, color: '#89d185' },
					{ label: `输出 ${(osStats.totalOutputTokens / 1000).toFixed(1)}K`, color: '#4ec9b0' },
				],
				color: '#4ec9b0',
			},
			{
				label: '压缩节省',
				value: String(compression.savedPercent),
				unit: '%',
				detail: compression.compressionCount > 0
					? `节省 ${(compression.savedTokens / 1000).toFixed(1)}K tokens`
					: '尚未触发压缩',
				breakdown: [
					{ label: `压缩 ${compression.compressionCount} 次`, color: '#dcdcaa' },
					{ label: `低效 ${compression.ineffectiveCount} 次`, color: '#f48771' },
				],
				color: '#dcdcaa',
			},
			{
				label: '记忆条数',
				value: String(memory.total),
				detail: `Episodic ${memory.episodic} · Semantic ${memory.semantic} · Procedural ${memory.procedural}`,
				breakdown: [
					{ label: `Working ${memory.working}`, color: '#0078d4' },
					{ label: `Episodic ${memory.episodic}`, color: '#4ec9b0' },
					{ label: `Semantic ${memory.semantic}`, color: '#c586c0' },
					{ label: `Procedural ${memory.procedural}`, color: '#ce9178' },
				],
				color: '#c586c0',
			},
		];

		return {
			kpis,
			sessions,
			alerts,
			skills,
			compression,
			memory,
			budgets: [], // 暂无预算系统，留空
			tokenByModel,
			graphStats,
			lastUpdated: Date.now(),
		};
	}

	private _convertSession(s: AgentStudioSession, modelId: string): IDashboardSession {
		const updatedDate = new Date(s.updatedAt);
		const now = new Date();
		const diffMs = now.getTime() - updatedDate.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		const diffHour = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHour / 24);

		let duration: string;
		if (diffMin < 1) { duration = '刚刚'; }
		else if (diffMin < 60) { duration = `${diffMin}分钟前`; }
		else if (diffHour < 24) { duration = `${diffHour}小时前`; }
		else { duration = `${diffDay}天前`; }

		// 推断状态：5分钟内更新 = running，否则 = idle
		const status: IDashboardSession['status'] = diffMin < 5 ? 'running' : 'idle';

		return {
			id: s.id,
			name: s.name || '未命名会话',
			status,
			model: modelId,
			tokens: 0, // 暂无按会话的 token 统计
			turns: 0,  // 暂无按会话的轮次统计
			duration,
		};
	}

	private async _buildMemoryStats(osStats: {
		episodicExtractionCount: number; semanticExtractionCount: number; proceduralExtractionCount: number;
	}): Promise<IDashboardMemoryStat> {
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
			if (memProvider) {
				// 1. 使用 getExtendedStats 获取完整统计（如果 Provider 支持）
				if (memProvider.getExtendedStats) {
					const ext = memProvider.getExtendedStats('*') as Record<string, unknown>;
					working = Number(ext['shortTerm']) || 0;
					// longTerm 包含 Episodic + Semantic + Procedural，需要用搜索细分
					graphNodes = Number(ext['graphNodes']) || 0;
					graphEdges = Number(ext['graphEdges']) || 0;
					totalSearches = Number(ext['totalSearches']) || 0;
					zeroResultSearches = Number(ext['zeroResultSearches']) || 0;
					healthStatus = String(ext['healthStatus'] ?? 'N/A');
				}

				// 2. 搜索全量记忆，按 4-Tier 分类计数
				const entries = await memProvider.searchMemory('*', '*');
				total = entries.length;
				working = 0; episodic = 0; semantic = 0; procedural = 0;
				for (const entry of entries) {
					const memType = (entry.metadata?.['memoryType'] as string) ?? entry.type;
					switch (entry.type) {
						case 'working':
							working++;
							break;
						case 'episodic':
							// 按 metadata.memoryType 细分 Episodic/Semantic/Procedural
							if (memType === 'scene') {
								semantic++;       // Semantic Semantic
							} else if (memType === 'persona') {
								procedural++;     // Procedural Procedural
							} else {
								episodic++;       // Episodic Episodic (默认)
							}
							break;
					}
				}
			}
		} catch { /* ignore */ }

		return {
			total,
			working,
			episodic,
			semantic,
			procedural,
			episodicExtractionCount: osStats.episodicExtractionCount,
			semanticExtractionCount: osStats.semanticExtractionCount,
			proceduralExtractionCount: osStats.proceduralExtractionCount,
			graphNodes,
			graphEdges,
			totalSearches,
			zeroResultSearches,
			healthStatus,
		};
	}

	private _buildAlerts(
		osStats: { compressionIneffectiveCount: number; episodicExtractionCount: number; semanticExtractionCount: number; proceduralExtractionCount: number },
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

		// Episodic (Episodic) 提取通知
		if (osStats.episodicExtractionCount > 0) {
			alerts.push({
				id: 'l1-extraction',
				type: 'info',
				title: 'Episodic 记忆提取 (Episodic)',
				description: `已触发 ${osStats.episodicExtractionCount} 次 Episodic 自动提取${osStats.semanticExtractionCount > 0 ? `，Semantic 场景提取 ${osStats.semanticExtractionCount} 次` : ''}${osStats.proceduralExtractionCount > 0 ? `，Procedural 人格生成 ${osStats.proceduralExtractionCount} 次` : ''}`,
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
			memory: { total: 0, working: 0, episodic: 0, semantic: 0, procedural: 0, episodicExtractionCount: 0, semanticExtractionCount: 0, proceduralExtractionCount: 0, graphNodes: 0, graphEdges: 0, totalSearches: 0, zeroResultSearches: 0, healthStatus: 'N/A' },
			budgets: [],
			tokenByModel: [],
			graphStats: { nodes: 0, edges: 0, files: 0, project: '', exists: false },
			lastUpdated: Date.now(),
		};
	}
}
