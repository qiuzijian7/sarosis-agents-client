/*---------------------------------------------------------------------------------------------
 *  团队记忆 — 多 Agent 间的记忆共享与协调。
 *  参考 agentmemory src/functions/team.ts
 *
 *  在多 Agent 场景下（主 Agent + 子 Agent，或并行 Agent），
 *  需要共享关键记忆、模式和观察结果。
 *
 *  核心能力：
 *    1. shareItem(itemId, type) — 共享记忆到团队
 *    2. getFeed(limit) — 获取团队记忆流
 *    3. getTeamProfile() — 团队画像
 *    4. broadcast(message) — 广播通知
 *
 *  共享类型：
 *    - memory: 长期记忆
 *    - pattern: 模式
 *    - observation: 观察
 *--------------------------------------------------------------------------------------------*/

export type SharedItemType = 'memory' | 'pattern' | 'observation';

export interface TeamSharedItem {
	id: string;
	sharedBy: string;           // agentId
	sharedAt: string;
	type: SharedItemType;
	content: string;
	metadata?: Record<string, unknown>;
	project: string;
	visibility: 'shared' | 'private' | 'team_only';
	expiresAt?: string;
}

export interface TeamProfile {
	teamId: string;
	memberIds: string[];
	totalSharedItems: number;
	itemsByType: Record<SharedItemType, number>;
	lastActivityAt: string;
	topContributors: Array<{ agentId: string; contributionCount: number }>;
	topTopics: string[];
}

export interface TeamConfig {
	teamId: string;
	userId: string;
	memberIds: string[];
}

export interface BroadcastMessage {
	id: string;
	from: string;
	content: string;
	timestamp: string;
	readBy: string[];
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TeamMemoryManager {
	private _config: TeamConfig;
	private _sharedItems: TeamSharedItem[] = [];
	private _broadcasts: BroadcastMessage[] = [];
	private _maxItems = 1000;
	private _maxBroadcasts = 100;

	constructor(config: TeamConfig) {
		this._config = config;
	}

	/**
	 * 共享一个条目到团队
	 */
	shareItem(opts: {
		itemId: string;
		itemType: SharedItemType;
		content: string;
		metadata?: Record<string, unknown>;
		project?: string;
		visibility?: 'shared' | 'private' | 'team_only';
		expiresInMs?: number;
	}): TeamSharedItem {
		const now = new Date();
		const item: TeamSharedItem = {
			id: generateId('ts'),
			sharedBy: this._config.userId,
			sharedAt: now.toISOString(),
			type: opts.itemType,
			content: opts.content.slice(0, 10000),
			metadata: {
				...opts.metadata,
				originalItemId: opts.itemId,
			},
			project: opts.project ?? '',
			visibility: opts.visibility ?? 'shared',
			expiresAt: opts.expiresInMs ? new Date(now.getTime() + opts.expiresInMs).toISOString() : undefined,
		};

		this._sharedItems.push(item);
		if (this._sharedItems.length > this._maxItems) {
			this._sharedItems.shift();
		}

		return item;
	}

	/**
	 * 获取团队记忆流（按时间倒序）
	 */
	getFeed(opts?: {
		limit?: number;
		type?: SharedItemType;
		since?: string;
		project?: string;
	}): TeamSharedItem[] {
		let items = [...this._sharedItems];

		// 过滤已过期
		const now = Date.now();
		items = items.filter(i => !i.expiresAt || new Date(i.expiresAt).getTime() > now);

		if (opts?.type) {
			items = items.filter(i => i.type === opts.type);
		}
		if (opts?.project) {
			items = items.filter(i => i.project === opts.project);
		}
		if (opts?.since) {
			const sinceTs = new Date(opts.since).getTime();
			items = items.filter(i => new Date(i.sharedAt).getTime() > sinceTs);
		}

		items.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));

		return items.slice(0, opts?.limit ?? 50);
	}

	/**
	 * 获取团队画像
	 */
	getProfile(): TeamProfile {
		const now = new Date().toISOString();
		const itemsByType: Record<SharedItemType, number> = { memory: 0, pattern: 0, observation: 0 };
		const contributorCounts = new Map<string, number>();
		const topicCounts = new Map<string, number>();

		for (const item of this._sharedItems) {
			itemsByType[item.type]++;
			contributorCounts.set(item.sharedBy, (contributorCounts.get(item.sharedBy) ?? 0) + 1);
			const concepts = (item.metadata?.['concepts'] as string[]) ?? [];
			for (const c of concepts) {
				topicCounts.set(c, (topicCounts.get(c) ?? 0) + 1);
			}
		}

		const topContributors = Array.from(contributorCounts.entries())
			.map(([agentId, contributionCount]) => ({ agentId, contributionCount }))
			.sort((a, b) => b.contributionCount - a.contributionCount)
			.slice(0, 10);

		const topTopics = Array.from(topicCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([topic]) => topic);

		return {
			teamId: this._config.teamId,
			memberIds: this._config.memberIds,
			totalSharedItems: this._sharedItems.length,
			itemsByType,
			lastActivityAt: this._sharedItems.length > 0
				? this._sharedItems[this._sharedItems.length - 1].sharedAt
				: now,
			topContributors,
			topTopics,
		};
	}

	/**
	 * 广播消息
	 */
	broadcast(from: string, content: string): BroadcastMessage {
		const msg: BroadcastMessage = {
			id: generateId('bc'),
			from,
			content: content.slice(0, 5000),
			timestamp: new Date().toISOString(),
			readBy: [from],
		};
		this._broadcasts.push(msg);
		if (this._broadcasts.length > this._maxBroadcasts) {
			this._broadcasts.shift();
		}
		return msg;
	}

	/**
	 * 获取未读广播
	 */
	getUnreadBroadcasts(agentId: string, limit: number = 20): BroadcastMessage[] {
		return this._broadcasts
			.filter(b => !b.readBy.includes(agentId))
			.slice(-limit);
	}

	/**
	 * 标记广播已读
	 */
	markBroadcastRead(broadcastId: string, agentId: string): boolean {
		const msg = this._broadcasts.find(b => b.id === broadcastId);
		if (msg && !msg.readBy.includes(agentId)) {
			msg.readBy.push(agentId);
			return true;
		}
		return false;
	}

	/**
	 * 删除共享条目
	 */
	unshare(itemId: string): boolean {
		const idx = this._sharedItems.findIndex(i => i.id === itemId);
		if (idx >= 0) {
			this._sharedItems.splice(idx, 1);
			return true;
		}
		return false;
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._sharedItems = [];
		this._broadcasts = [];
	}
}
