/*---------------------------------------------------------------------------------------------
 *  结晶化 — 将完成的动作链转化为不可变的结晶摘要。
 *  参考 agentmemory src/functions/crystallize.ts
 *
 *  核心场景：
 *    1. 一个工作流（多个 tool call + intermediate results）完成
 *    2. 提取 narrative（叙述）/ keyOutcomes（关键结果）/ filesAffected（影响文件）/ lessons（经验）
 *    3. 生成不可变 Crystal，关联的 actions 标记为 crystallizedInto
 *
 *  与 ConsolidationPipeline 的区别：
 *    - Consolidation：从短期记忆聚合到 Episodic/Semantic/Procedural
 *    - Crystallize：从完整的动作链（action graph）提取摘要
 *--------------------------------------------------------------------------------------------*/

export interface CrystalDigest {
	narrative: string;
	keyOutcomes: string[];
	filesAffected: string[];
	lessons: string[];
}

export interface Crystal {
	id: string;
	narrative: string;
	keyOutcomes: string[];
	filesAffected: string[];
	lessons: string[];
	sourceActionIds: string[];
	sessionId?: string;
	project?: string;
	createdAt: string;
}

export interface CrystallizeAction {
	id: string;
	title: string;
	description: string;
	status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
	result?: string;
	filesModified?: string[];
	timestamp: number;
	crystallizedInto?: string;
}

export interface ActionEdge {
	sourceActionId: string;
	targetActionId: string;
	type: 'requires' | 'produces' | 'follows' | 'parallel';
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从动作链文本构建 LLM 提示
 */
function buildChainText(actions: CrystallizeAction[], edges: ActionEdge[]): string {
	const lines: string[] = [];
	lines.push('=== Action Chain ===');
	for (const action of actions) {
		lines.push(`\n[${action.id}] ${action.title} (${action.status})`);
		if (action.description) {
			lines.push(`  Description: ${action.description}`);
		}
		if (action.result) {
			lines.push(`  Result: ${action.result.slice(0, 500)}`);
		}
		if (action.filesModified && action.filesModified.length > 0) {
			lines.push(`  Files: ${action.filesModified.join(', ')}`);
		}
	}
	if (edges.length > 0) {
		lines.push('\n=== Dependencies ===');
		for (const edge of edges) {
			lines.push(`${edge.sourceActionId} --${edge.type}--> ${edge.targetActionId}`);
		}
	}
	return lines.join('\n');
}

/**
 * 合成摘要（不依赖 LLM，基于规则提取）
 * 当 LLM 不可用时使用此降级方案
 */
function synthesizeDigest(actions: CrystallizeAction[], edges: ActionEdge[]): CrystalDigest {
	const completedActions = actions.filter(a => a.status === 'done' || a.status === 'cancelled');
	const titles = completedActions.map(a => a.title);
	const narrative = titles.length > 0
		? `完成了 ${titles.length} 个动作：${titles.slice(0, 5).join('、')}${titles.length > 5 ? ' 等' : ''}。`
		: '动作链已完成。';

	const keyOutcomes = completedActions
		.filter(a => a.result)
		.map(a => `${a.title}: ${(a.result ?? '').slice(0, 200)}`)
		.slice(0, 10);

	const filesAffected = Array.from(new Set(
		completedActions.flatMap(a => a.filesModified ?? []),
	));

	const lessons: string[] = [];
	// 从失败动作中提取教训
	const failedActions = actions.filter(a => a.status === 'failed');
	for (const failed of failedActions) {
		lessons.push(`避免重复失败：${failed.title} 失败${failed.result ? `（原因：${failed.result.slice(0, 100)}）` : ''}`);
	}
	// 从成功模式中提取
	const successRate = completedActions.length / (actions.length || 1);
	if (successRate === 1) {
		lessons.push('动作链全部成功完成，可作为标准流程参考');
	}

	return {
		narrative,
		keyOutcomes,
		filesAffected,
		lessons,
	};
}

export class CrystallizeManager {
	private _crystals = new Map<string, Crystal>();

	/**
	 * 结晶化一个动作链
	 *
	 * @param actions 动作列表（必须已完成或取消）
	 * @param edges 动作间的依赖边
	 * @param opts 额外选项
	 * @returns 生成的 Crystal
	 */
	crystallize(
		actions: CrystallizeAction[],
		edges: ActionEdge[],
		opts?: { sessionId?: string; project?: string; customDigest?: CrystalDigest },
	): Crystal | null {
		if (!actions || actions.length === 0) {
			return null;
		}

		// 验证动作状态
		for (const action of actions) {
			if (action.status !== 'done' && action.status !== 'cancelled' && action.status !== 'failed') {
				return null; // 必须是已完成状态
			}
		}

		// 使用自定义 digest 或合成 digest
		const digest = opts?.customDigest ?? synthesizeDigest(actions, edges);

		const crystal: Crystal = {
			id: generateId('crys'),
			narrative: digest.narrative,
			keyOutcomes: digest.keyOutcomes,
			filesAffected: digest.filesAffected,
			lessons: digest.lessons,
			sourceActionIds: actions.map(a => a.id),
			sessionId: opts?.sessionId,
			project: opts?.project,
			createdAt: new Date().toISOString(),
		};

		this._crystals.set(crystal.id, crystal);

		// 标记源动作为已结晶
		for (const action of actions) {
			action.crystallizedInto = crystal.id;
		}

		return crystal;
	}

	/**
	 * 获取 Crystal
	 */
	get(id: string): Crystal | null {
		return this._crystals.get(id) ?? null;
	}

	/**
	 * 列出所有 Crystal
	 */
	list(filter?: { sessionId?: string; project?: string }): Crystal[] {
		let crystals = Array.from(this._crystals.values());
		if (filter?.sessionId) {
			crystals = crystals.filter(c => c.sessionId === filter.sessionId);
		}
		if (filter?.project) {
			crystals = crystals.filter(c => c.project === filter.project);
		}
		return crystals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * 搜索 Crystal（按叙述/关键结果/文件）
	 */
	search(query: string, limit: number = 10): Crystal[] {
		const lower = query.toLowerCase();
		const results: Array<{ crystal: Crystal; score: number }> = [];

		for (const crystal of this._crystals.values()) {
			let score = 0;
			if (crystal.narrative.toLowerCase().includes(lower)) score += 3;
			for (const outcome of crystal.keyOutcomes) {
				if (outcome.toLowerCase().includes(lower)) score += 2;
			}
			for (const file of crystal.filesAffected) {
				if (file.toLowerCase().includes(lower)) score += 1;
			}
			if (score > 0) {
				results.push({ crystal, score });
			}
		}

		return results
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(r => r.crystal);
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalCrystals: number; avgActionsPerCrystal: number; totalLessons: number } {
		const crystals = Array.from(this._crystals.values());
		const avgActions = crystals.length > 0
			? crystals.reduce((sum, c) => sum + c.sourceActionIds.length, 0) / crystals.length
			: 0;
		const totalLessons = crystals.reduce((sum, c) => sum + c.lessons.length, 0);
		return {
			totalCrystals: crystals.length,
			avgActionsPerCrystal: Math.round(avgActions * 10) / 10,
			totalLessons,
		};
	}

	/**
	 * 删除 Crystal
	 */
	delete(id: string): boolean {
		return this._crystals.delete(id);
	}

	/**
	 * 清除所有 Crystal
	 */
	clear(): void {
		this._crystals.clear();
	}
}
