/*---------------------------------------------------------------------------------------------
 *  工作记忆 — 当前任务的临时记忆层，会话结束后清除。
 *  参考 agentmemory src/functions/working-memory.ts
 *
 *  与短期记忆不同，工作记忆是：
 *    - 按任务粒度（而非时间窗口）
 *    - 存储当前正在操作的上下文（打开的文件、正在修复的 bug、当前步骤）
 *    - 会话结束后自动清除
 *--------------------------------------------------------------------------------------------*/

export interface WorkingMemoryItem {
	id: string;
	key: string;
	value: string;
	category: 'file' | 'task' | 'context' | 'scratch' | 'note';
	createdAt: number;
	expiresAt?: number;
}

const MAX_ITEMS = 100;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class WorkingMemory {
	private _items = new Map<string, WorkingMemoryItem[]>();

	/** Set a working memory item */
	set(agentId: string, key: string, value: string, category: WorkingMemoryItem['category'] = 'note', ttlMs?: number): void {
		const items = this._items.get(agentId) ?? [];
		// Remove existing item with same key
		const filtered = items.filter(i => i.key !== key);
		filtered.push({
			id: `wm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			key,
			value,
			category,
			createdAt: Date.now(),
			expiresAt: ttlMs ? Date.now() + ttlMs : Date.now() + DEFAULT_TTL_MS,
		});
		// Cap
		while (filtered.length > MAX_ITEMS) filtered.shift();
		this._items.set(agentId, filtered);
	}

	/** Get a working memory item by key */
	get(agentId: string, key: string): string | undefined {
		const items = this._activeItems(agentId);
		return items.find(i => i.key === key)?.value;
	}

	/** Get all working memory items for an agent */
	getAll(agentId: string): WorkingMemoryItem[] {
		return this._activeItems(agentId);
	}

	/** Get items by category */
	getByCategory(agentId: string, category: WorkingMemoryItem['category']): WorkingMemoryItem[] {
		return this._activeItems(agentId).filter(i => i.category === category);
	}

	/** Remove a working memory item */
	remove(agentId: string, key: string): void {
		const items = this._items.get(agentId);
		if (!items) return;
		this._items.set(agentId, items.filter(i => i.key !== key));
	}

	/** Clear all working memory for an agent (on session end) */
	clear(agentId: string): void {
		this._items.delete(agentId);
	}

	/** Clear expired items */
	prune(agentId: string): number {
		const items = this._items.get(agentId);
		if (!items) return 0;
		const now = Date.now();
		const active = items.filter(i => !i.expiresAt || i.expiresAt > now);
		const pruned = items.length - active.length;
		this._items.set(agentId, active);
		return pruned;
	}

	/** Build context string from working memory */
	buildContext(agentId: string): string {
		const items = this._activeItems(agentId);
		if (items.length === 0) return '';
		const parts: string[] = ['## Working Memory (Current Task)'];
		const byCategory = new Map<string, WorkingMemoryItem[]>();
		for (const item of items) {
			const arr = byCategory.get(item.category) ?? [];
			arr.push(item);
			byCategory.set(item.category, arr);
		}
		for (const [cat, catItems] of byCategory) {
			parts.push(`### ${cat} (${catItems.length})`);
			for (const item of catItems) {
				parts.push(`- ${item.key}: ${item.value.slice(0, 100)}`);
			}
		}
		return parts.join('\n');
	}

	private _activeItems(agentId: string): WorkingMemoryItem[] {
		const items = this._items.get(agentId) ?? [];
		const now = Date.now();
		return items.filter(i => !i.expiresAt || i.expiresAt > now);
	}

	get count(): number {
		let total = 0;
		for (const items of this._items.values()) total += items.length;
		return total;
	}
}
