/*---------------------------------------------------------------------------------------------
 *  网格协调 — 分布式多 Agent 协调。
 *  参考 agentmemory src/functions/mesh.ts
 *
 *  与 TeamMemory 的区别：
 *    - TeamMemory：集中式团队记忆共享（共享池 + 广播）
 *    - MeshCoord：去中心化网格协调（节点发现 + 消息路由 + 任务分发）
 *
 *  核心能力：
 *    1. registerNode(agentId, capabilities) — 注册节点
 *    2. discoverNodes(capability?) — 发现节点
 *    3. routeMessage(from, to, message) — 路由消息
 *    4. distributeTask(task, strategy) — 分发任务
 *    5. getMeshTopology() — 获取网格拓扑
 *
 *  分发策略：
 *    round-robin — 轮询
 *    least-busy  — 最少负载
 *    capability  — 按能力匹配
 *    random      — 随机
 *--------------------------------------------------------------------------------------------*/

export interface MeshNode {
	agentId: string;
	capabilities: string[];
	status: 'online' | 'offline' | 'busy';
	load: number;           // 0-1 负载
	registeredAt: number;
	lastHeartbeat: number;
	metadata?: Record<string, unknown>;
}

export interface MeshMessage {
	id: string;
	from: string;
	to: string;              // 'broadcast' or agentId
	content: string;
	type: 'task' | 'result' | 'query' | 'notification' | 'heartbeat';
	timestamp: number;
	delivered?: boolean;
}

export interface TaskDistribution {
	taskId: string;
	assignedTo: string;
	strategy: DistributionStrategy;
	reason: string;
}

export type DistributionStrategy = 'round-robin' | 'least-busy' | 'capability' | 'random';

export interface MeshTopology {
	totalNodes: number;
	onlineNodes: number;
	busyNodes: number;
	offlineNodes: number;
	avgLoad: number;
	capabilities: Record<string, number>;  // capability → node count
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const HEARTBEAT_TIMEOUT_MS = 60 * 1000;  // 60 秒无心跳视为离线

export class MeshCoordinator {
	private _nodes = new Map<string, MeshNode>();
	private _messages: MeshMessage[] = [];
	private _distributionIndex = 0;  // round-robin 计数器
	private _maxMessages = 1000;

	/**
	 * 注册节点
	 */
	registerNode(agentId: string, capabilities: string[] = [], metadata?: Record<string, unknown>): MeshNode {
		const now = Date.now();
		const existing = this._nodes.get(agentId);
		const node: MeshNode = {
			agentId,
			capabilities,
			status: 'online',
			load: existing?.load ?? 0,
			registeredAt: existing?.registeredAt ?? now,
			lastHeartbeat: now,
			metadata: { ...existing?.metadata, ...metadata },
		};
		this._nodes.set(agentId, node);
		return node;
	}

	/**
	 * 注销节点
	 */
	unregisterNode(agentId: string): boolean {
		return this._nodes.delete(agentId);
	}

	/**
	 * 心跳更新
	 */
	heartbeat(agentId: string, load?: number): boolean {
		const node = this._nodes.get(agentId);
		if (!node) return false;
		node.lastHeartbeat = Date.now();
		if (load !== undefined) {
			node.load = Math.max(0, Math.min(1, load));
		}
		node.status = node.load > 0.8 ? 'busy' : 'online';
		return true;
	}

	/**
	 * 发现节点
	 */
	discoverNodes(capability?: string, onlineOnly: boolean = true): MeshNode[] {
		const now = Date.now();
		let nodes = Array.from(this._nodes.values());

		// 更新离线状态
		for (const node of nodes) {
			if (now - node.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
				node.status = 'offline';
			}
		}

		if (onlineOnly) {
			nodes = nodes.filter(n => n.status !== 'offline');
		}
		if (capability) {
			nodes = nodes.filter(n => n.capabilities.includes(capability));
		}
		return nodes;
	}

	/**
	 * 路由消息
	 */
	routeMessage(from: string, to: string, content: string, type: MeshMessage['type'] = 'notification'): MeshMessage | null {
		const message: MeshMessage = {
			id: generateId('msg'),
			from,
			to,
			content: content.slice(0, 10000),
			type,
			timestamp: Date.now(),
		};

		if (to === 'broadcast') {
			// 广播给所有在线节点
			for (const node of this._nodes.values()) {
				if (node.agentId !== from && node.status !== 'offline') {
					message.delivered = true;
				}
			}
		} else {
			const target = this._nodes.get(to);
			message.delivered = target?.status !== 'offline';
		}

		this._messages.push(message);
		if (this._messages.length > this._maxMessages) {
			this._messages.shift();
		}

		return message;
	}

	/**
	 * 获取节点的消息
	 */
	getMessages(agentId: string, limit: number = 50): MeshMessage[] {
		return this._messages
			.filter(m => m.to === agentId || m.to === 'broadcast')
			.slice(-limit)
			.reverse();
	}

	/**
	 * 分发任务
	 */
	distributeTask(taskId: string, requiredCapability?: string, strategy: DistributionStrategy = 'least-busy'): TaskDistribution | null {
		const candidates = this.discoverNodes(requiredCapability).filter(n => n.status === 'online');

		if (candidates.length === 0) {
			return null;
		}

		let assignedTo: string;
		let reason: string;

		switch (strategy) {
			case 'round-robin': {
				const idx = this._distributionIndex % candidates.length;
				assignedTo = candidates[idx].agentId;
				this._distributionIndex++;
				reason = `round-robin index ${idx}`;
				break;
			}
			case 'least-busy': {
				const sorted = candidates.sort((a, b) => a.load - b.load);
				assignedTo = sorted[0].agentId;
				reason = `least busy (load=${sorted[0].load.toFixed(2)})`;
				break;
			}
			case 'capability': {
				// 选择能力最匹配的（能力数最多的）
				const sorted = candidates.sort((a, b) => b.capabilities.length - a.capabilities.length);
				assignedTo = sorted[0].agentId;
				reason = `most capable (${sorted[0].capabilities.length} capabilities)`;
				break;
			}
			case 'random': {
				assignedTo = candidates[Math.floor(Math.random() * candidates.length)].agentId;
				reason = 'random selection';
				break;
			}
		}

		// 标记为忙碌
		const node = this._nodes.get(assignedTo);
		if (node) {
			node.status = 'busy';
			node.load = Math.min(1, node.load + 0.2);
		}

		return { taskId, assignedTo, strategy, reason };
	}

	/**
	 * 获取网格拓扑
	 */
	getMeshTopology(): MeshTopology {
		const now = Date.now();
		const nodes = Array.from(this._nodes.values());

		// 更新离线状态
		for (const node of nodes) {
			if (now - node.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
				node.status = 'offline';
			}
		}

		const online = nodes.filter(n => n.status === 'online');
		const busy = nodes.filter(n => n.status === 'busy');
		const offline = nodes.filter(n => n.status === 'offline');

		const capabilities: Record<string, number> = {};
		for (const node of online) {
			for (const cap of node.capabilities) {
				capabilities[cap] = (capabilities[cap] ?? 0) + 1;
			}
		}

		const avgLoad = online.length > 0
			? online.reduce((s, n) => s + n.load, 0) / online.length
			: 0;

		return {
			totalNodes: nodes.length,
			onlineNodes: online.length,
			busyNodes: busy.length,
			offlineNodes: offline.length,
			avgLoad: Math.round(avgLoad * 100) / 100,
			capabilities,
		};
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalNodes: number; totalMessages: number; topology: MeshTopology } {
		return {
			totalNodes: this._nodes.size,
			totalMessages: this._messages.length,
			topology: this.getMeshTopology(),
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._nodes.clear();
		this._messages = [];
		this._distributionIndex = 0;
	}
}
