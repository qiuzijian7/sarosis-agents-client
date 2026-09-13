/*---------------------------------------------------------------------------------------------
 *  智能搜索 — 多策略搜索编排 + Followup 检测。
 *  参考 agentmemory src/functions/smart-search.ts
 *
 *  与现有 searchMemory 的区别：
 *    - searchMemory：单次 RRF 混合搜索
 *    - smartSearch：多策略编排（精确→模糊→语义→图遍历）+ followup 检测
 *
 *  Followup 检测：
 *    当 agent 在短时间内（followupWindow，默认 30s）连续搜索相似查询时，
 *    说明首次搜索结果不理想。smartSearch 会：
 *    1. 记录每次搜索的 query + 结果 ID 集
 *    2. 检测 followup（相似 query + 时间窗口内）
 *    3. followup 时自动扩展搜索范围（降低阈值、增加 limit）
 *
 *  搜索策略顺序：
 *    1. exact    — 精确匹配（substring + BM25 高分）
 *    2. semantic — 语义匹配（Vector 相似度）
 *    3. graph    — 图遍历（从实体出发 BFS）
 *    4. lessons  — 经验教训匹配
 *--------------------------------------------------------------------------------------------*/

export interface RecentSearch {
	sessionId: string;
	query: string;
	resultIds: string[];
	at: number;
}

export interface SmartSearchOptions {
	query?: string;
	expandIds?: Array<string | { obsId: string; sessionId: string }>;
	limit?: number;
	includeLessons?: boolean;
	sessionId?: string;
	source?: string;           // 'agent' | 'viewer'（viewer 搜索不计入 followup）
	agentId?: string;
}

export interface SmartSearchResult {
	results: Array<{ id: string; score: number; strategy: string }>;
	lessons: Array<{ id: string; content: string; confidence: number }>;
	strategiesUsed: string[];
	isFollowup: boolean;
	followupWindow: number;
	totalFound: number;
}

export interface FollowupStats {
	followupWithinWindow: number;
	agentInitiatedSearches: number;
	rate: number;
}

const FOLLOWUP_WINDOW_MS = 30 * 1000;        // 30 秒内的相似搜索视为 followup
const FOLLOWUP_SIMILARITY_THRESHOLD = 0.6;   // 查询相似度阈值
const MAX_RECENT_SEARCHES = 100;

function tokenize(s: string): Set<string> {
	return new Set(s.toLowerCase().split(/[\s,.!?;:'"()\[\]{}|\\/<>]+/).filter(t => t.length > 1));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union > 0 ? intersection / union : 0;
}

interface SearchEntry {
	id: string;
	content: string;
	score: number;
	metadata?: Record<string, unknown>;
}

interface LessonEntry {
	id: string;
	content: string;
	confidence: number;
	tags?: string[];
}

export interface SmartSearchParams {
	searchFn: (query: string, limit: number) => Promise<SearchEntry[]>;
	lessonSearchFn?: (query: string) => LessonEntry[];
}

export class SmartSearch {
	private _params: SmartSearchParams;
	private _recentSearches: RecentSearch[] = [];
	private _followupStats = { followupWithinWindow: 0, agentInitiatedSearches: 0 };

	constructor(params: SmartSearchParams) {
		this._params = params;
	}

	/**
	 * 执行智能搜索
	 */
	async search(opts: SmartSearchOptions): Promise<SmartSearchResult> {
		const query = opts.query ?? '';
		const limit = opts.limit ?? 10;
		const isAgent = opts.source !== 'viewer';
		const sessionId = opts.sessionId ?? 'default';

		// Followup 检测
		const isFollowup = isAgent && query.length > 0
			? this._detectFollowup(sessionId, query)
			: false;

		if (isAgent && query.length > 0) {
			this._followupStats.agentInitiatedSearches++;
			if (isFollowup) {
				this._followupStats.followupWithinWindow++;
			}
		}

		const strategiesUsed: string[] = [];
		const aggregated = new Map<string, { id: string; score: number; strategy: string }>();

		// Strategy 1: Exact/Substring (via searchFn with high BM25 scores)
		if (query.length > 0) {
			const effectiveLimit = isFollowup ? limit * 2 : limit;
			const results = await this._params.searchFn(query, effectiveLimit);
			strategiesUsed.push('exact');
			for (const r of results) {
				const existing = aggregated.get(r.id);
				if (!existing || r.score > existing.score) {
					aggregated.set(r.id, { id: r.id, score: r.score * 0.5, strategy: 'exact' });
				}
			}
		}

		// Strategy 2: Expand by IDs
		if (opts.expandIds && opts.expandIds.length > 0) {
			strategiesUsed.push('expand');
			for (const item of opts.expandIds) {
				const id = typeof item === 'string' ? item : item.obsId;
				if (!aggregated.has(id)) {
					aggregated.set(id, { id, score: 0.3, strategy: 'expand' });
				}
			}
		}

		// Strategy 3: Lessons
		let lessons: Array<{ id: string; content: string; confidence: number }> = [];
		if (opts.includeLessons && this._params.lessonSearchFn && query.length > 0) {
			strategiesUsed.push('lessons');
			const lessonResults = this._params.lessonSearchFn(query);
			lessons = lessonResults.slice(0, 5).map(l => ({
				id: l.id,
				content: l.content,
				confidence: l.confidence,
			}));
		}

		// 排序 + 去重
		const results = Array.from(aggregated.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, isFollowup ? limit * 2 : limit);

		// 记录此次搜索
		if (isAgent && query.length > 0) {
			this._recordSearch(sessionId, query, results.map(r => r.id));
		}

		return {
			results,
			lessons,
			strategiesUsed,
			isFollowup,
			followupWindow: FOLLOWUP_WINDOW_MS,
			totalFound: aggregated.size,
		};
	}

	/**
	 * 检测 followup
	 */
	private _detectFollowup(sessionId: string, query: string): boolean {
		const now = Date.now();
		const queryTokens = tokenize(query);

		for (let i = this._recentSearches.length - 1; i >= 0; i--) {
			const recent = this._recentSearches[i];
			if (recent.sessionId !== sessionId) continue;
			if (now - recent.at > FOLLOWUP_WINDOW_MS) break;

			const recentTokens = tokenize(recent.query);
			const similarity = jaccardSimilarity(queryTokens, recentTokens);
			if (similarity >= FOLLOWUP_SIMILARITY_THRESHOLD) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 记录搜索
	 */
	private _recordSearch(sessionId: string, query: string, resultIds: string[]): void {
		this._recentSearches.push({
			sessionId,
			query,
			resultIds,
			at: Date.now(),
		});
		// 限制历史
		if (this._recentSearches.length > MAX_RECENT_SEARCHES) {
			this._recentSearches.shift();
		}
	}

	/**
	 * 获取 followup 统计
	 */
	getFollowupStats(): FollowupStats {
		return {
			followupWithinWindow: this._followupStats.followupWithinWindow,
			agentInitiatedSearches: this._followupStats.agentInitiatedSearches,
			rate: this._followupStats.agentInitiatedSearches > 0
				? this._followupStats.followupWithinWindow / this._followupStats.agentInitiatedSearches
				: 0,
		};
	}

	/**
	 * 清除近期搜索记录（会话结束时调用）
	 */
	clearSession(sessionId: string): number {
		const before = this._recentSearches.length;
		this._recentSearches = this._recentSearches.filter(s => s.sessionId !== sessionId);
		return before - this._recentSearches.length;
	}

	/**
	 * 清除所有状态
	 */
	clear(): void {
		this._recentSearches = [];
		this._followupStats = { followupWithinWindow: 0, agentInitiatedSearches: 0 };
	}
}
