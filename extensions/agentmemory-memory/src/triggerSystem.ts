/*---------------------------------------------------------------------------------------------
 *  触发器系统 — 事件驱动的动作触发。
 *  1:1 复刻 agentmemory src/triggers/api.ts + events.ts
 *
 *  核心概念：
 *    Trigger = 事件 topic → 回调函数
 *    当某个 topic 的事件发生时，所有订阅该 topic 的触发器被执行。
 *
 *  内置触发器：
 *    session.started   → 加载上下文
 *    session.stopped    → 生成摘要 + 固化
 *    observation       → 写入记忆
 *    task.completed    → 结晶化 + 技能提取
 *--------------------------------------------------------------------------------------------*/

export type TriggerTopic =
	| 'session.started'
	| 'session.stopped'
	| 'observation'
	| 'task.completed'
	| 'tool.use.pre'
	| 'tool.use.post'
	| 'tool.failure'
	| 'compact.pre'
	| 'commit.post'
	| 'subagent.start'
	| 'subagent.stop'
	| 'custom';

export interface TriggerConfig {
	id: string;
	topic: TriggerTopic;
	handler: (payload: TriggerPayload) => void | Promise<void>;
	priority: number;
	enabled: boolean;
	once: boolean;
}

export interface TriggerPayload {
	topic: TriggerTopic;
	sessionId?: string;
	agentId?: string;
	project?: string;
	cwd?: string;
	timestamp: number;
	data?: Record<string, unknown>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TriggerSystem {
	private _triggers = new Map<string, TriggerConfig>();
	private _byTopic = new Map<TriggerTopic, string[]>();
	private _stats = { totalFired: 0, totalErrors: 0 };

	/**
	 * 注册触发器
	 */
	register(topic: TriggerTopic, handler: (payload: TriggerPayload) => void | Promise<void>, opts?: { priority?: number; once?: boolean }): string {
		const id = generateId('trigger');
		const config: TriggerConfig = {
			id,
			topic,
			handler,
			priority: opts?.priority ?? 50,
			enabled: true,
			once: opts?.once ?? false,
		};
		this._triggers.set(id, config);

		const list = this._byTopic.get(topic) ?? [];
		list.push(id);
		this._byTopic.set(topic, list);

		return id;
	}

	/**
	 * 注销触发器
	 */
	unregister(id: string): boolean {
		const config = this._triggers.get(id);
		if (!config) return false;
		this._triggers.delete(id);
		const list = this._byTopic.get(config.topic);
		if (list) {
			const idx = list.indexOf(id);
			if (idx >= 0) list.splice(idx, 1);
		}
		return true;
	}

	/**
	 * 触发事件
	 */
	async fire(topic: TriggerTopic, payload: Omit<TriggerPayload, 'topic' | 'timestamp'>): Promise<void> {
		const fullPayload: TriggerPayload = {
			...payload,
			topic,
			timestamp: Date.now(),
		};

		const triggerIds = this._byTopic.get(topic) ?? [];
		if (triggerIds.length === 0) return;

		// 按优先级排序
		const triggers = triggerIds
			.map(id => this._triggers.get(id))
			.filter((t): t is TriggerConfig => t !== undefined && t.enabled)
			.sort((a, b) => b.priority - a.priority);

		const toRemove: string[] = [];

		for (const trigger of triggers) {
			try {
				await trigger.handler(fullPayload);
				this._stats.totalFired++;
				if (trigger.once) {
					toRemove.push(trigger.id);
				}
			} catch (err) {
				this._stats.totalErrors++;
				console.warn(`[TriggerSystem] handler ${trigger.id} failed:`, err);
			}
		}

		for (const id of toRemove) {
			this.unregister(id);
		}
	}

	/**
	 * 同步触发（不等待 async handler）
	 */
	fireSync(topic: TriggerTopic, payload: Omit<TriggerPayload, 'topic' | 'timestamp'>): void {
		const fullPayload: TriggerPayload = {
			...payload,
			topic,
			timestamp: Date.now(),
		};

		const triggerIds = this._byTopic.get(topic) ?? [];
		const triggers = triggerIds
			.map(id => this._triggers.get(id))
			.filter((t): t is TriggerConfig => t !== undefined && t.enabled)
			.sort((a, b) => b.priority - a.priority);

		const toRemove: string[] = [];

		for (const trigger of triggers) {
			try {
				const result = trigger.handler(fullPayload);
				if (result instanceof Promise) {
					result.catch(() => {});
				}
				this._stats.totalFired++;
				if (trigger.once) {
					toRemove.push(trigger.id);
				}
			} catch (err) {
				this._stats.totalErrors++;
			}
		}

		for (const id of toRemove) {
			this.unregister(id);
		}
	}

	/**
	 * 启用/禁用触发器
	 */
	setEnabled(id: string, enabled: boolean): boolean {
		const config = this._triggers.get(id);
		if (!config) return false;
		config.enabled = enabled;
		return true;
	}

	/**
	 * 列出触发器
	 */
	list(topic?: TriggerTopic): Array<{ id: string; topic: TriggerTopic; priority: number; enabled: boolean; once: boolean }> {
		let configs = Array.from(this._triggers.values());
		if (topic) {
			configs = configs.filter(c => c.topic === topic);
		}
		return configs.map(c => ({ id: c.id, topic: c.topic, priority: c.priority, enabled: c.enabled, once: c.once }));
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalTriggers: number; totalFired: number; totalErrors: number; triggersByTopic: Record<string, number> } {
		const byTopic: Record<string, number> = {};
		for (const [topic, ids] of this._byTopic) {
			byTopic[topic] = ids.length;
		}
		return {
			totalTriggers: this._triggers.size,
			totalFired: this._stats.totalFired,
			totalErrors: this._stats.totalErrors,
			triggersByTopic: byTopic,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._triggers.clear();
		this._byTopic.clear();
		this._stats = { totalFired: 0, totalErrors: 0 };
	}
}
