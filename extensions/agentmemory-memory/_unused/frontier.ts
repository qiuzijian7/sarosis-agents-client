/*---------------------------------------------------------------------------------------------
 *  前沿检测 — 识别未阻塞、可立即执行的动作。
 *  参考 agentmemory src/functions/frontier.ts
 *
 *  在多步骤工作流中，"前沿"是指当前可以开始执行的动做。
 *  某个动作被阻塞的原因：
 *    1. 依赖的 prerequisite 动作未完成
 *    2. 被未通过的 checkpoint 门控
 *    3. 与正在执行的动作冲突
 *
 *  核心能力：
 *    1. compute(actions, edges, checkpoints) — 计算前沿列表
 *    2. 按优先级/紧急度排序
 *    3. 支持租约过滤（已被其他 agent 认领的动作可排除）
 *--------------------------------------------------------------------------------------------*/

export interface FrontierAction {
	id: string;
	title: string;
	description?: string;
	status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
	priority: number;           // 1-10, 10 = 最高
	urgency: number;            // 1-10, 10 = 最紧急
	project?: string;
	createdAt: number;
	updatedAt?: number;
}

export interface FrontierEdge {
	sourceActionId: string;
	targetActionId: string;
	type: 'requires' | 'gated_by' | 'conflicts_with';
}

export interface FrontierCheckpoint {
	id: string;
	name: string;
	status: 'pending' | 'passed' | 'failed' | 'expired';
}

export interface FrontierLease {
	actionId: string;
	agentId: string;
	expiresAt: number;
	status: 'active' | 'expired' | 'released';
}

export interface FrontierItem {
	action: FrontierAction;
	score: number;
	blockers: string[];
	leased: boolean;
	leasedByMe: boolean;
}

export interface FrontierOptions {
	project?: string;
	agentId?: string;
	limit?: number;
	includeLeasedByOthers?: boolean;
}

function computeScore(action: FrontierAction, now: number): number {
	const ageDays = (now - action.createdAt) / (1000 * 60 * 60 * 24);
	const ageBoost = Math.min(0.3, ageDays * 0.05);
	return action.priority * 0.4 + action.urgency * 0.3 + ageBoost * 0.3;
}

export class FrontierDetector {
	/**
	 * 计算前沿（未阻塞可执行的动作）
	 */
	compute(
		actions: FrontierAction[],
		edges: FrontierEdge[],
		checkpoints: FrontierCheckpoint[],
		leases: FrontierLease[],
		opts: FrontierOptions = {},
	): FrontierItem[] {
		const now = Date.now();

		// 构建索引
		const actionMap = new Map<string, FrontierAction>();
		for (const a of actions) actionMap.set(a.id, a);

		const checkpointMap = new Map<string, FrontierCheckpoint>();
		for (const cp of checkpoints) checkpointMap.set(cp.id, cp);

		const activeLeaseMap = new Map<string, FrontierLease>();
		for (const lease of leases) {
			if (lease.status === 'active' && lease.expiresAt > now) {
				activeLeaseMap.set(lease.actionId, lease);
			}
		}

		// 按动作分组边
		const edgesFrom = new Map<string, FrontierEdge[]>();
		for (const edge of edges) {
			const list = edgesFrom.get(edge.sourceActionId) ?? [];
			list.push(edge);
			edgesFrom.set(edge.sourceActionId, list);
		}

		const frontier: FrontierItem[] = [];

		for (const action of actions) {
			// 跳过已完成的
			if (action.status === 'done' || action.status === 'cancelled') continue;
			// 项目过滤
			if (opts.project && action.project !== opts.project) continue;

			const blockers: string[] = [];

			// 检查 requires 依赖
			const fromEdges = edgesFrom.get(action.id) ?? [];
			for (const edge of fromEdges) {
				if (edge.type === 'requires') {
					const dep = actionMap.get(edge.targetActionId);
					if (dep && dep.status !== 'done') {
						blockers.push(`requires:${dep.id}:${dep.title}`);
					}
				} else if (edge.type === 'gated_by') {
					const cp = checkpointMap.get(edge.targetActionId);
					if (cp && cp.status !== 'passed') {
						blockers.push(`checkpoint:${cp.id}:${cp.name}`);
					}
				} else if (edge.type === 'conflicts_with') {
					const other = actionMap.get(edge.targetActionId);
					if (other && other.status === 'running') {
						blockers.push(`conflict:${other.id}:${other.title}`);
					}
				}
			}

			if (blockers.length > 0) continue;

			// 检查租约
			const lease = activeLeaseMap.get(action.id);
			const leasedByOther = lease && opts.agentId && lease.agentId !== opts.agentId;
			if (leasedByOther && !opts.includeLeasedByOthers) continue;

			const score = computeScore(action, now);

			frontier.push({
				action,
				score,
				blockers,
				leased: !!lease,
				leasedByMe: lease?.agentId === opts.agentId,
			});
		}

		// 按分数排序
		frontier.sort((a, b) => b.score - a.score);

		const limit = opts.limit ?? 20;
		return frontier.slice(0, limit);
	}

	/**
	 * 获取被阻塞的动作及其阻塞原因
	 */
	getBlocked(
		actions: FrontierAction[],
		edges: FrontierEdge[],
		checkpoints: FrontierCheckpoint[],
	): Array<{ action: FrontierAction; blockers: string[] }> {
		const actionMap = new Map<string, FrontierAction>();
		for (const a of actions) actionMap.set(a.id, a);
		const checkpointMap = new Map<string, FrontierCheckpoint>();
		for (const cp of checkpoints) checkpointMap.set(cp.id, cp);

		const edgesFrom = new Map<string, FrontierEdge[]>();
		for (const edge of edges) {
			const list = edgesFrom.get(edge.sourceActionId) ?? [];
			list.push(edge);
			edgesFrom.set(edge.sourceActionId, list);
		}

		const blocked: Array<{ action: FrontierAction; blockers: string[] }> = [];

		for (const action of actions) {
			if (action.status === 'done' || action.status === 'cancelled') continue;

			const blockers: string[] = [];
			const fromEdges = edgesFrom.get(action.id) ?? [];
			for (const edge of fromEdges) {
				if (edge.type === 'requires') {
					const dep = actionMap.get(edge.targetActionId);
					if (dep && dep.status !== 'done') {
						blockers.push(`requires:${dep.id}:${dep.title}`);
					}
				} else if (edge.type === 'gated_by') {
					const cp = checkpointMap.get(edge.targetActionId);
					if (cp && cp.status !== 'passed') {
						blockers.push(`checkpoint:${cp.id}:${cp.name}`);
					}
				} else if (edge.type === 'conflicts_with') {
					const other = actionMap.get(edge.targetActionId);
					if (other && other.status === 'running') {
						blockers.push(`conflict:${other.id}:${other.title}`);
					}
				}
			}

			if (blockers.length > 0) {
				blocked.push({ action, blockers });
			}
		}

		return blocked;
	}
}
