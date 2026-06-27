/*---------------------------------------------------------------------------------------------
 *  事件总线 — 模块间解耦的发布/订阅事件系统。
 *  参考 agentmemory 的 hook + audit + signal 系统融合
 *
 *  与现有 Signals（Agent 间消息）的区别：
 *    - Signals：Agent 间的消息传递（有目标 Agent）
 *    - EventBus：模块间的内部事件（无目标，广播给所有订阅者）
 *
 *  事件类型：
 *    memory_written   — 记忆写入
 *    memory_searched  — 记忆搜索
 *    memory_deleted   — 记忆删除
 *    session_started  — 会话开始
 *    session_ended    — 会话结束
 *    sweep_completed  — 清理完成
 *    quota_violated   — 配额违规
 *    circuit_opened   — 熔断器开启
 *    health_changed   — 健康状态变化
 *    custom           — 自定义事件
 *--------------------------------------------------------------------------------------------*/

export type EventType =
	| 'memory_written'
	| 'memory_searched'
	| 'memory_deleted'
	| 'memory_reinforced'
	| 'session_started'
	| 'session_ended'
	| 'sweep_completed'
	| 'consolidation_completed'
	| 'contradiction_detected'
	| 'cascade_triggered'
	| 'quota_violated'
	| 'circuit_opened'
	| 'circuit_recovered'
	| 'health_changed'
	| 'sentinel_triggered'
	| 'skill_extracted'
	| 'crystallize_completed'
	| 'routine_completed'
	| 'custom';

export interface MemoryEvent {
	type: EventType;
	timestamp: number;
	source: string;          // 事件来源模块名
	agentId?: string;
	data?: Record<string, unknown>;
}

export type EventHandler = (event: MemoryEvent) => void | Promise<void>;

export interface Subscription {
	id: string;
	eventType: EventType | '*';
	handler: EventHandler;
	once: boolean;
	active: boolean;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class EventBus {
	private _subscriptions = new Map<string, Subscription>();
	private _byType = new Map<EventType, Set<string>>();
	private _wildcardSubs = new Set<string>();  // 订阅 '*' 的 ID
	private _eventHistory: MemoryEvent[] = [];
	private _maxHistory = 500;
	private _emitDepth = 0;
	private _maxEmitDepth = 10;  // 防止递归过深

	/**
	 * 订阅事件
	 */
	on(eventType: EventType | '*', handler: EventHandler): string {
		const id = generateId('sub');
		const sub: Subscription = {
			id,
			eventType,
			handler,
			once: false,
			active: true,
		};
		this._subscriptions.set(id, sub);

		if (eventType === '*') {
			this._wildcardSubs.add(id);
		} else {
			let set = this._byType.get(eventType);
			if (!set) {
				set = new Set();
				this._byType.set(eventType, set);
			}
			set.add(id);
		}

		return id;
	}

	/**
	 * 订阅一次
	 */
	once(eventType: EventType, handler: EventHandler): string {
		const id = generateId('sub-once');
		const sub: Subscription = {
			id,
			eventType,
			handler,
			once: true,
			active: true,
		};
		this._subscriptions.set(id, sub);

		let set = this._byType.get(eventType);
		if (!set) {
			set = new Set();
			this._byType.set(eventType, set);
		}
		set.add(id);

		return id;
	}

	/**
	 * 取消订阅
	 */
	off(subscriptionId: string): boolean {
		const sub = this._subscriptions.get(subscriptionId);
		if (!sub) return false;

		this._subscriptions.delete(subscriptionId);
		if (sub.eventType === '*') {
			this._wildcardSubs.delete(subscriptionId);
		} else {
			this._byType.get(sub.eventType)?.delete(subscriptionId);
		}
		return true;
	}

	/**
	 * 发布事件
	 */
	async emit(event: Omit<MemoryEvent, 'timestamp'>): Promise<void> {
		if (this._emitDepth >= this._maxEmitDepth) {
			console.warn('[EventBus] max emit depth reached, dropping event');
			return;
		}

		const fullEvent: MemoryEvent = {
			...event,
			timestamp: Date.now(),
		};

		// 记录历史
		this._eventHistory.push(fullEvent);
		if (this._eventHistory.length > this._maxHistory) {
			this._eventHistory.shift();
		}

		this._emitDepth++;
		try {
			// 通知类型匹配的订阅者
			const typeSubs = this._byType.get(event.type);
			if (typeSubs) {
				for (const id of typeSubs) {
					const sub = this._subscriptions.get(id);
					if (!sub || !sub.active) continue;
					try {
						await sub.handler(fullEvent);
					} catch (err) {
						console.warn(`[EventBus] handler ${id} failed:`, err);
					}
					if (sub.once) {
						this.off(id);
					}
				}
			}

			// 通知通配符订阅者
			for (const id of this._wildcardSubs) {
				const sub = this._subscriptions.get(id);
				if (!sub || !sub.active) continue;
				try {
					await sub.handler(fullEvent);
				} catch (err) {
					console.warn(`[EventBus] wildcard handler ${id} failed:`, err);
				}
			}
		} finally {
			this._emitDepth--;
		}
	}

	/**
	 * 同步发布（不等待 async handler）
	 */
	emitSync(event: Omit<MemoryEvent, 'timestamp'>): void {
		const fullEvent: MemoryEvent = {
			...event,
			timestamp: Date.now(),
		};

		this._eventHistory.push(fullEvent);
		if (this._eventHistory.length > this._maxHistory) {
			this._eventHistory.shift();
		}

		const typeSubs = this._byType.get(event.type);
		if (typeSubs) {
			for (const id of typeSubs) {
				const sub = this._subscriptions.get(id);
				if (!sub || !sub.active) continue;
				try {
					const result = sub.handler(fullEvent);
					if (result instanceof Promise) {
						result.catch(() => {});
					}
				} catch (err) {
					console.warn(`[EventBus] sync handler ${id} failed:`, err);
				}
				if (sub.once) {
					this.off(id);
				}
			}
		}

		for (const id of this._wildcardSubs) {
			const sub = this._subscriptions.get(id);
			if (!sub || !sub.active) continue;
			try {
				const result = sub.handler(fullEvent);
				if (result instanceof Promise) {
					result.catch(() => {});
				}
			} catch (err) {
				console.warn(`[EventBus] wildcard sync handler ${id} failed:`, err);
			}
		}
	}

	/**
	 * 获取事件历史
	 */
	getHistory(limit: number = 50, type?: EventType): MemoryEvent[] {
		let history = [...this._eventHistory];
		if (type) {
			history = history.filter(e => e.type === type);
		}
		return history.slice(-limit).reverse();
	}

	/**
	 * 获取统计
	 */
	getStats(): {
		totalSubscriptions: number;
		subscriptionsByType: Record<string, number>;
		wildcardSubscriptions: number;
		totalEventsEmitted: number;
	} {
		const byType: Record<string, number> = {};
		for (const [type, set] of this._byType) {
			byType[type] = set.size;
		}
		return {
			totalSubscriptions: this._subscriptions.size,
			subscriptionsByType: byType,
			wildcardSubscriptions: this._wildcardSubs.size,
			totalEventsEmitted: this._eventHistory.length,
		};
	}

	/**
	 * 清除所有订阅
	 */
	clear(): void {
		this._subscriptions.clear();
		this._byType.clear();
		this._wildcardSubs.clear();
		this._eventHistory = [];
	}
}
