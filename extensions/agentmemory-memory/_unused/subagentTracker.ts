/*---------------------------------------------------------------------------------------------
 *  子代理追踪 — 追踪子代理的生命周期和委托关系。
 *  参考 agentmemory src/hooks/subagent-start.ts + subagent-stop.ts
 *
 *  核心场景：
 *    1. 主 Agent 派生子 Agent 执行子任务
 *    2. 追踪 parent → child 关系
 *    3. 子 Agent 完成时合并结果到父 Agent
 *    4. 子 Agent 失败时记录错误到父 Agent
 *
 *  核心能力：
 *    1. startSubagent(parentId, task) — 启动子代理
 *    2. stopSubagent(agentId, result) — 停止子代理
 *    3. getChildren(parentId) — 获取子代理列表
 *    4. getDelegationTree(agentId) — 获取委托树
 *    5. getLineage(agentId) — 获取祖先链
 *--------------------------------------------------------------------------------------------*/

export interface SubagentRecord {
	agentId: string;
	parentAgentId: string | null;
	task: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	result?: string;
	error?: string;
	depth: number;            // 委托深度（根=0）
	memoryCount?: number;     // 子代理产生的记忆数
}

export interface DelegationNode {
	agentId: string;
	task: string;
	status: SubagentRecord['status'];
	depth: number;
	children: DelegationNode[];
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SubagentTracker {
	private _agents = new Map<string, SubagentRecord>();
	private _children = new Map<string, string[]>();  // parentId → childIds
	private _maxDepth = 5;  // 最大委托深度

	/**
	 * 启动子代理
	 */
	start(parentAgentId: string | null, task: string, opts?: { maxDepth?: number }): SubagentRecord | null {
		// 检查深度限制
		let depth = 0;
		if (parentAgentId) {
			const parent = this._agents.get(parentAgentId);
			if (parent) {
				depth = parent.depth + 1;
			}
			const maxDepth = opts?.maxDepth ?? this._maxDepth;
			if (depth > maxDepth) {
				return null;  // 超过最大深度
			}
		}

		const agentId = generateId('subagent');
		const record: SubagentRecord = {
			agentId,
			parentAgentId,
			task: task.slice(0, 500),
			status: 'running',
			startedAt: Date.now(),
			depth,
		};

		this._agents.set(agentId, record);

		if (parentAgentId) {
			const children = this._children.get(parentAgentId) ?? [];
			children.push(agentId);
			this._children.set(parentAgentId, children);
		}

		return record;
	}

	/**
	 * 停止子代理
	 */
	stop(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean {
		const record = this._agents.get(agentId);
		if (!record) return false;

		record.status = status;
		record.completedAt = Date.now();
		record.durationMs = record.completedAt - record.startedAt;
		if (result !== undefined) record.result = result.slice(0, 2000);
		if (error !== undefined) record.error = error.slice(0, 1000);

		return true;
	}

	/**
	 * 更新子代理记忆数
	 */
	updateMemoryCount(agentId: string, count: number): boolean {
		const record = this._agents.get(agentId);
		if (!record) return false;
		record.memoryCount = count;
		return true;
	}

	/**
	 * 获取子代理记录
	 */
	get(agentId: string): SubagentRecord | null {
		return this._agents.get(agentId) ?? null;
	}

	/**
	 * 获取直接子代理
	 */
	getChildren(parentId: string): SubagentRecord[] {
		const childIds = this._children.get(parentId) ?? [];
		return childIds
			.map(id => this._agents.get(id))
			.filter((r): r is SubagentRecord => r !== undefined);
	}

	/**
	 * 获取委托树
	 */
	getDelegationTree(rootId: string): DelegationNode | null {
		const root = this._agents.get(rootId);
		if (!root) return null;

		const buildNode = (agentId: string): DelegationNode => {
			const record = this._agents.get(agentId)!;
			const children = this.getChildren(agentId);
			return {
				agentId,
				task: record.task,
				status: record.status,
				depth: record.depth,
				children: children.map(c => buildNode(c.agentId)),
			};
		};

		return buildNode(rootId);
	}

	/**
	 * 获取祖先链（从根到当前）
	 */
	getLineage(agentId: string): SubagentRecord[] {
		const lineage: SubagentRecord[] = [];
		let current = this._agents.get(agentId);
		while (current) {
			lineage.unshift(current);
			current = current.parentAgentId ? this._agents.get(current.parentAgentId) : undefined;
		}
		return lineage;
	}

	/**
	 * 获取正在运行的子代理
	 */
	getRunning(): SubagentRecord[] {
		return Array.from(this._agents.values()).filter(a => a.status === 'running');
	}

	/**
	 * 获取某深度的所有代理
	 */
	getByDepth(depth: number): SubagentRecord[] {
		return Array.from(this._agents.values()).filter(a => a.depth === depth);
	}

	/**
	 * 获取统计
	 */
	getStats(): {
		totalAgents: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
		avgDurationMs: number;
		maxDepth: number;
	} {
		const agents = Array.from(this._agents.values());
		const completed = agents.filter(a => a.status === 'completed');
		const durations = completed
			.map(a => a.durationMs ?? 0)
			.filter(d => d > 0);
		const maxDepth = agents.reduce((max, a) => Math.max(max, a.depth), 0);

		return {
			totalAgents: agents.length,
			running: agents.filter(a => a.status === 'running').length,
			completed: completed.length,
			failed: agents.filter(a => a.status === 'failed').length,
			cancelled: agents.filter(a => a.status === 'cancelled').length,
			avgDurationMs: durations.length > 0
				? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
				: 0,
			maxDepth,
		};
	}

	/**
	 * 清除已完成/失败的代理（保留最近 N 条）
	 */
	cleanup(maxKeep: number = 100): number {
		const before = this._agents.size;
		const agents = Array.from(this._agents.values());

		// 保留正在运行的 + 最近完成的
		const running = agents.filter(a => a.status === 'running');
		const finished = agents
			.filter(a => a.status !== 'running')
			.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
			.slice(0, maxKeep);

		const keepIds = new Set([...running, ...finished].map(a => a.agentId));

		for (const [id] of this._agents) {
			if (!keepIds.has(id)) {
				this._agents.delete(id);
			}
		}

		// 清理孤儿 children 引用
		for (const [parentId, childIds] of this._children) {
			this._children.set(parentId, childIds.filter(id => keepIds.has(id)));
		}

		return before - this._agents.size;
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._agents.clear();
		this._children.clear();
	}
}
