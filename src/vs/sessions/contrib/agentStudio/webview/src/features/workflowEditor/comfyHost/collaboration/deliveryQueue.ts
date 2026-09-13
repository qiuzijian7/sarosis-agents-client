/**
 * 租约式结果回灌队列 —— 子任务产物**确定性**交回父节点。
 *
 * ## 问题（本项目现状）
 *
 * 画布子代理（`runAgentNode` → `createWorkflowChildPort`）的结果只有一个去处：
 * 「await 返回 → 写本节点快照」。这意味着：
 *   - 父节点若在子任务运行期间还需要别的东西（如用户在 UI 上追加了要求），
 *     没有通道传达——子代理只收到**启动时**的那一份 prompt；
 *   - 多个子任务结果回灌的**顺序不确定**（谁先完成谁先写），无法表达「按依赖序合并」；
 *   - 执行中断/重启后，「哪些结果已交付」无记录，可能重复交付（副作用重复）。
 *
 * ## 设计（来源：openclaw `agent-steering-queue.ts`）
 *
 * 把「结果交付」建模成**带租约的状态机**：
 *   `pending → in_progress(leased) → delivered`（或 `discarded`）
 *   - `lease(to, leaseId)`：原子领取（只有 pending 能被领走），返回给父节点本轮消费；
 *   - `ack(ids)`：确认交付成功；
 *   - `release(leaseId)`：交付失败归还（回 pending，可重试）；
 *   - `reclaimStale()`：租约超时自动回收（父节点崩溃/卡住时结果不会永久卡在 in_progress）；
 *   - `leaseId` 幂等：同一租约重复 ack/release 无副作用。
 *
 * 关键收益：**交付状态可持久化、可重放、顺序确定**（按 enqueue 序领取），
 * 与 openclaw 用它解决「子代理完成结果何时/以什么顺序注入父上下文」同一目的。
 */

export type DeliveryStatus = 'pending' | 'in_progress' | 'delivered' | 'discarded';

export interface DeliveryItem {
	id: string;
	/** 产出方（子任务/子节点 id）。 */
	from: string;
	/** 交付目标（父节点/父 agent id）。 */
	to: string;
	content: string;
	status: DeliveryStatus;
	/** 当前租约 id（in_progress 时存在）。 */
	leaseId?: string;
	/** 租约时间戳（ms，由注入的 now() 提供）。 */
	leasedAt?: number;
	/** 交付尝试次数（release 会 +1，用于识别反复失败的交付）。 */
	attempts: number;
	/** 业务透传（如 taskId / nodeId / kind）。 */
	metadata?: Record<string, unknown>;
}

export interface DeliveryQueue {
	enqueue(item: Omit<DeliveryItem, 'status' | 'attempts'> & { status?: DeliveryStatus }): DeliveryItem;
	/** 只读查看待交付项（不占用租约）。 */
	peek(to: string): DeliveryItem[];
	/** 原子领取（pending → in_progress），按 enqueue 序。 */
	lease(to: string, leaseId: string): DeliveryItem[];
	/** 确认交付（in_progress → delivered）。返回实际变更数。 */
	ack(ids: readonly string[]): number;
	/** 归还租约（in_progress → pending，attempts+1）。返回归还数。 */
	release(leaseId: string): number;
	/** 回收陈旧租约（leasedAt 早于 ttl）→ pending。返回回收数。 */
	reclaimStale(): number;
	discard(ids: readonly string[]): number;
	list(filter?: { to?: string; status?: DeliveryStatus }): DeliveryItem[];
	stats(): Record<DeliveryStatus, number>;
}

export interface DeliveryQueueOptions {
	/** 租约有效期（ms），默认 5 分钟（对齐 openclaw 陈旧租约回收窗口）。 */
	leaseTtlMs?: number;
	/** 单条内容字符上限（超出截断，避免注入父上下文时爆炸），默认 6000。 */
	maxContentChars?: number;
	/** 时间源（测试可注入）。 */
	now?: () => number;
}

export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_CONTENT_CHARS = 6000;

export function createDeliveryQueue(opts: DeliveryQueueOptions = {}): DeliveryQueue {
	const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const maxChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
	const now = opts.now ?? (() => Date.now());
	const items: DeliveryItem[] = [];
	let seq = 0;

	const find = (id: string): DeliveryItem | undefined => items.find(i => i.id === id);

	const queue: DeliveryQueue = {
		enqueue(item) {
			const content = item.content.length > maxChars
				? `${item.content.slice(0, maxChars)}…[truncated]`
				: item.content;
			const created: DeliveryItem = {
				...item,
				content,
				status: item.status ?? 'pending',
				attempts: 0,
			};
			items.push(created);
			return created;
		},
		peek: (to) => items.filter(i => i.to === to && i.status === 'pending'),
		lease(to, leaseId) {
			const leased: DeliveryItem[] = [];
			for (const item of items) {
				if (item.to !== to || item.status !== 'pending') { continue; }
				item.status = 'in_progress';
				item.leaseId = leaseId;
				item.leasedAt = now();
				leased.push(item);
			}
			return leased;
		},
		ack(ids) {
			const want = new Set(ids);
			let n = 0;
			for (const item of items) {
				if (!want.has(item.id) || item.status !== 'in_progress') { continue; }
				item.status = 'delivered';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				n++;
			}
			return n;
		},
		release(leaseId) {
			let n = 0;
			for (const item of items) {
				if (item.status !== 'in_progress' || item.leaseId !== leaseId) { continue; }
				item.status = 'pending';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				item.attempts++;
				n++;
			}
			return n;
		},
		reclaimStale() {
			const cutoff = now() - ttl;
			let n = 0;
			for (const item of items) {
				if (item.status !== 'in_progress') { continue; }
				if ((item.leasedAt ?? 0) > cutoff) { continue; }
				item.status = 'pending';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				n++;
			}
			return n;
		},
		discard(ids) {
			const want = new Set(ids);
			let n = 0;
			for (const item of items) {
				if (!want.has(item.id) || item.status === 'delivered' || item.status === 'discarded') { continue; }
				item.status = 'discarded';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				n++;
			}
			return n;
		},
		list(filter) {
			return items.filter(i =>
				(!filter?.to || i.to === filter.to) && (!filter?.status || i.status === filter.status));
		},
		stats() {
			const out: Record<DeliveryStatus, number> = { pending: 0, in_progress: 0, delivered: 0, discarded: 0 };
			for (const i of items) { out[i.status]++; }
			return out;
		},
	};
	void seq;
	void find;
	return queue;
}
