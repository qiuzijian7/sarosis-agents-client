/**
 * 交付队列 —— 带租约的状态机，用于把消息安全地注入运行中的 agent 循环。
 *
 * ## 要解决的问题
 *
 * agent 循环运行期间，外部（用户继续输入 / 子代理完成 / 其他 agent 委派）
 * 可能产生新消息。朴素的「推一个数组」有三个失效模式：
 *   1. **重复投递** —— 注入后进程重启 / 重试，同一条被投两次，副作用翻倍；
 *   2. **崩溃丢失** —— 消息已被取走但注入未完成，进程死掉后该消息永久消失；
 *   3. **永久卡死** —— 消费方崩溃，消息卡在「处理中」无人回收。
 *
 * 故把注入建模成**带租约的状态机**：
 *   `pending → in_progress(leased) → delivered`（或 `discarded`）
 *   - `lease(to, leaseId)`：原子领取（只有 pending 能被领走），按 enqueue 序；
 *   - `ack(ids)`：确认注入成功；
 *   - `release(leaseId)`：注入失败归还（回 pending，attempts+1，可重试）；
 *   - `reclaimStale()`：租约超时自动回收（消费方崩溃时消息不会永久卡在 in_progress）；
 *   - `leaseId` 幂等：同一租约重复 ack/release 无副作用。
 *
 * ## 与 pi 的关系
 *
 * pi 的 steering/follow-up 队列（`packages/agent/src/agent-loop.ts:168/194-196/201-209`）
 * 是进程内数组，靠「进程不崩溃」的假设规避上述问题。本项目有持久化 checkpoint
 * 体系，不应退回弱保证，故采用租约模型。
 *
 * 实现来源与 `webview/src/features/workflowEditor/comfyHost/collaboration/deliveryQueue.ts`
 * 同源（openclaw `agent-steering-queue.ts`），但此处为 host 侧自有实现：
 * webview 与 browser 是不同构建目标，不能互相 import。
 */

export type DeliveryStatus = 'pending' | 'in_progress' | 'delivered' | 'discarded';

export interface DeliveryItem {
	readonly id: string;
	/** 产出方（子任务 / 子 agent / 用户输入来源）。 */
	readonly from: string;
	/** 交付目标（父 agent id），lease 按此过滤。 */
	readonly to: string;
	/** 交付内容；超出 maxContentChars 会被截断，避免注入时撑爆上下文。 */
	content: string;
	status: DeliveryStatus;
	/** 当前租约 id（in_progress 时存在）。 */
	leaseId?: string;
	/** 租约时间戳（ms，由注入的 now() 提供）。 */
	leasedAt?: number;
	/** 交付尝试次数（release 会 +1，用于识别反复失败的交付）。 */
	attempts: number;
	/** 业务透传（如 taskId / nodeId / kind）。 */
	readonly metadata?: Record<string, unknown>;
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
	/** 丢弃（不可再交付）。返回实际变更数。 */
	discard(ids: readonly string[]): number;
	list(filter?: { to?: string; status?: DeliveryStatus }): DeliveryItem[];
	stats(): Record<DeliveryStatus, number>;
}

export interface DeliveryQueueOptions {
	/** 租约有效期（ms），默认 5 分钟。 */
	leaseTtlMs?: number;
	/**
	 * 单条内容字符上限，默认 6000。
	 *
	 * 为什么需要：注入内容会直接进模型上下文，单条失控的长文本可能挤掉
	 * 工具结果与既有对话。
	 */
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

	return {
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
			let changed = 0;
			for (const item of items) {
				if (!want.has(item.id) || item.status !== 'in_progress') { continue; }
				item.status = 'delivered';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				changed++;
			}
			return changed;
		},

		release(leaseId) {
			let changed = 0;
			for (const item of items) {
				if (item.status !== 'in_progress' || item.leaseId !== leaseId) { continue; }
				item.status = 'pending';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				item.attempts++;
				changed++;
			}
			return changed;
		},

		reclaimStale() {
			const cutoff = now() - ttl;
			let changed = 0;
			for (const item of items) {
				if (item.status !== 'in_progress') { continue; }
				if ((item.leasedAt ?? 0) > cutoff) { continue; }
				item.status = 'pending';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				changed++;
			}
			return changed;
		},

		discard(ids) {
			const want = new Set(ids);
			let changed = 0;
			for (const item of items) {
				if (!want.has(item.id) || item.status === 'delivered' || item.status === 'discarded') { continue; }
				item.status = 'discarded';
				item.leaseId = undefined;
				item.leasedAt = undefined;
				changed++;
			}
			return changed;
		},

		list(filter) {
			return items.filter(i =>
				(!filter?.to || i.to === filter.to) && (!filter?.status || i.status === filter.status));
		},

		stats() {
			const out: Record<DeliveryStatus, number> = { pending: 0, in_progress: 0, delivered: 0, discarded: 0 };
			for (const item of items) { out[item.status]++; }
			return out;
		},
	};
}
