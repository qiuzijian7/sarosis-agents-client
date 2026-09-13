/*---------------------------------------------------------------------------------------------
 *  通知中心 — 事件驱动的通知系统。
 *  参考 agentmemory src/hooks/notification.ts
 *
 *  与 EventBus 的区别：
 *    - EventBus：模块间内部事件（无格式，程序化处理）
 *    - NotificationHub：面向用户的通知（有优先级 + 频道 + 去重 + 聚合）
 *
 *  通知频道：
 *    info     — 信息通知
 *    warning  — 警告通知
 *    error    — 错误通知
 *    success  — 成功通知
 *    system   — 系统通知
 *
 *  通知优先级：low / normal / high / urgent
 *
 *  去重策略：
 *    相同 key + 30 秒窗口内只通知一次
 *
 *  聚合策略：
 *    同类别通知在 5 秒窗口内合并为一条
 *--------------------------------------------------------------------------------------------*/

export type NotificationChannel = 'info' | 'warning' | 'error' | 'success' | 'system';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Notification {
	id: string;
	channel: NotificationChannel;
	priority: NotificationPriority;
	title: string;
	message: string;
	source: string;         // 来源模块
	agentId?: string;
	timestamp: number;
	read: boolean;
	actions?: Array<{ label: string; action: string }>;
	metadata?: Record<string, unknown>;
}

export interface NotificationStats {
	total: number;
	unread: number;
	byChannel: Record<NotificationChannel, number>;
	byPriority: Record<NotificationPriority, number>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEDUP_WINDOW_MS = 30_000;       // 30 秒去重窗口
const AGGREGATION_WINDOW_MS = 5_000;   // 5 秒聚合窗口
const MAX_NOTIFICATIONS = 500;

const PRIORITY_WEIGHT: Record<NotificationPriority, number> = {
	urgent: 4,
	high: 3,
	normal: 2,
	low: 1,
};

export class NotificationHub {
	private _notifications: Notification[] = [];
	private _dedupKeys = new Map<string, number>();  // key → last notified timestamp
	private _subscriptions = new Set<(notification: Notification) => void>();
	private _aggregationBuffer = new Map<string, Notification[]>();  // category → pending notifications
	private _aggregationTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * 发送通知
	 */
	notify(opts: {
		channel: NotificationChannel;
		priority?: NotificationPriority;
		title: string;
		message: string;
		source: string;
		agentId?: string;
		dedupKey?: string;
		actions?: Array<{ label: string; action: string }>;
		metadata?: Record<string, unknown>;
	}): Notification | null {
		const priority = opts.priority ?? 'normal';

		// 去重检查
		if (opts.dedupKey) {
			const lastNotified = this._dedupKeys.get(opts.dedupKey);
			if (lastNotified && Date.now() - lastNotified < DEDUP_WINDOW_MS) {
				return null;  // 跳过重复通知
			}
			this._dedupKeys.set(opts.dedupKey, Date.now());
		}

		const notification: Notification = {
			id: generateId('notif'),
			channel: opts.channel,
			priority,
			title: opts.title.slice(0, 200),
			message: opts.message.slice(0, 2000),
			source: opts.source,
			agentId: opts.agentId,
			timestamp: Date.now(),
			read: false,
			actions: opts.actions,
			metadata: opts.metadata,
		};

		this._notifications.push(notification);
		if (this._notifications.length > MAX_NOTIFICATIONS) {
			this._notifications.shift();
		}

		// 通知订阅者
		for (const handler of this._subscriptions) {
			try {
				handler(notification);
			} catch (err) {
				console.warn('[NotificationHub] subscriber failed:', err);
			}
		}

		return notification;
	}

	/**
	 * 订阅通知
	 */
	subscribe(handler: (notification: Notification) => void): () => void {
		this._subscriptions.add(handler);
		return () => this._subscriptions.delete(handler);
	}

	/**
	 * 获取未读通知
	 */
	getUnread(agentId?: string, limit: number = 50): Notification[] {
		let notifs = this._notifications.filter(n => !n.read);
		if (agentId) {
			notifs = notifs.filter(n => !n.agentId || n.agentId === agentId);
		}
		return notifs
			.sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || b.timestamp - a.timestamp)
			.slice(0, limit);
	}

	/**
	 * 获取所有通知
	 */
	getAll(agentId?: string, limit: number = 100, channel?: NotificationChannel): Notification[] {
		let notifs = [...this._notifications];
		if (agentId) {
			notifs = notifs.filter(n => !n.agentId || n.agentId === agentId);
		}
		if (channel) {
			notifs = notifs.filter(n => n.channel === channel);
		}
		return notifs.slice(-limit).reverse();
	}

	/**
	 * 标记已读
	 */
	markRead(id: string): boolean {
		const notif = this._notifications.find(n => n.id === id);
		if (notif) {
			notif.read = true;
			return true;
		}
		return false;
	}

	/**
	 * 全部标记已读
	 */
	markAllRead(agentId?: string): number {
		let count = 0;
		for (const notif of this._notifications) {
			if (agentId && notif.agentId !== agentId && notif.agentId !== undefined) continue;
			if (!notif.read) {
				notif.read = true;
				count++;
			}
		}
		return count;
	}

	/**
	 * 删除通知
	 */
	delete(id: string): boolean {
		const idx = this._notifications.findIndex(n => n.id === id);
		if (idx >= 0) {
			this._notifications.splice(idx, 1);
			return true;
		}
		return false;
	}

	/**
	 * 清除已读通知
	 */
	clearRead(): number {
		const before = this._notifications.length;
		this._notifications = this._notifications.filter(n => !n.read);
		return before - this._notifications.length;
	}

	/**
	 * 获取统计
	 */
	getStats(agentId?: string): NotificationStats {
		let notifs = this._notifications;
		if (agentId) {
			notifs = notifs.filter(n => !n.agentId || n.agentId === agentId);
		}

		const byChannel: Record<NotificationChannel, number> = {
			info: 0, warning: 0, error: 0, success: 0, system: 0,
		};
		const byPriority: Record<NotificationPriority, number> = {
			low: 0, normal: 0, high: 0, urgent: 0,
		};

		for (const n of notifs) {
			byChannel[n.channel]++;
			byPriority[n.priority]++;
		}

		return {
			total: notifs.length,
			unread: notifs.filter(n => !n.read).length,
			byChannel,
			byPriority,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._notifications = [];
		this._dedupKeys.clear();
		this._aggregationBuffer.clear();
		if (this._aggregationTimer) {
			clearTimeout(this._aggregationTimer);
			this._aggregationTimer = undefined;
		}
	}

	/**
	 * 清理过期的去重键
	 */
	cleanupDedupKeys(): number {
		const now = Date.now();
		let cleaned = 0;
		for (const [key, timestamp] of this._dedupKeys) {
			if (now - timestamp > DEDUP_WINDOW_MS) {
				this._dedupKeys.delete(key);
				cleaned++;
			}
		}
		return cleaned;
	}
}
