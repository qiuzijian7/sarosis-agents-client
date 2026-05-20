/*---------------------------------------------------------------------------------------------
 *  Task Decomposer
 *
 *  Type-based goal decomposition strategy ported from Ruflo queen-coordinator.
 *  Detects task type from goal text, then applies a template or delimiter-based split.
 *--------------------------------------------------------------------------------------------*/

import type { PlanTask } from '../common/types.js';
import { PlanTaskStatus } from '../common/types.js';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ─── Type-based decomposition templates (ported from Ruflo queen) ────────────

interface DecompTemplate {
	phases: Array<{ suffix: string; role: string; agentName: string }>;
	sequential: boolean;
}

const DECOMP_TEMPLATES: Record<string, DecompTemplate> = {
	coding: {
		phases: [
			{ suffix: '设计与规划', role: 'Architect', agentName: 'Designer' },
			{ suffix: '实现', role: 'Software Developer', agentName: 'Developer' },
			{ suffix: '测试', role: 'QA Engineer', agentName: 'QA Tester' },
		],
		sequential: true,
	},
	testing: {
		phases: [
			{ suffix: '测试分析', role: 'QA Analyst', agentName: 'QA Analyst' },
			{ suffix: '测试执行', role: 'QA Engineer', agentName: 'QA Tester' },
		],
		sequential: true,
	},
	research: {
		phases: [
			{ suffix: '信息收集', role: 'Researcher', agentName: 'Researcher' },
			{ suffix: '分析总结', role: 'Analyst', agentName: 'Analyst' },
		],
		sequential: true,
	},
	deployment: {
		phases: [
			{ suffix: '构建打包', role: 'Build Engineer', agentName: 'Builder' },
			{ suffix: '部署发布', role: 'DevOps Engineer', agentName: 'DevOps' },
		],
		sequential: true,
	},
};

// ─── Helper: ID generation ───────────────────────────────────────────────────

function generateId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ─── Helper: DFS cycle detection ────────────────────────────────────────────

function wouldCreateCycle(tasks: PlanTask[], taskId: string, newDependency: string): boolean {
	const depsMap = new Map(tasks.map(t => [t.id, new Set(t.dependencies)]));
	const visited = new Set<string>();
	const stack = [newDependency];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === taskId) { return true; }
		if (visited.has(current)) { continue; }
		visited.add(current);
		const deps = depsMap.get(current);
		if (deps) { stack.push(...deps); }
	}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TaskDecomposer — stateless utility class for goal decomposition
// ═══════════════════════════════════════════════════════════════════════════════

export class TaskDecomposer {

	/**
	 * Decompose a goal string into one or more PlanTasks.
	 * Uses type detection + template matching (Ruflo pattern).
	 */
	decomposeGoal(goal: string, existingAgentNames: Set<string>): PlanTask[] {
		const now = new Date().toISOString();
		const goalLower = goal.toLowerCase();

		// Detect task type from content
		const taskType = this._detectTaskType(goalLower);

		// Simple task — short description, no decomposition needed (Ruflo: desc < 200 chars)
		const isSimple = goal.length < 80 && !this._hasMultipleParts(goalLower);
		if (isSimple) {
			return [this._createTask({
				title: goal.slice(0, 80),
				description: goal,
				agentName: this._inferAgentName(goal, 0),
				role: this._inferRole(goal),
				existingAgentNames,
				deps: [],
				priority: 2,
				now,
			})];
		}

		// Check if we have a decomposition template for this type
		const template = DECOMP_TEMPLATES[taskType];
		if (template) {
			return this._decomposeWithTemplate(goal, template, existingAgentNames, now);
		}

		// Fallback: split by natural-language delimiters
		return this._decomposeByDelimiters(goal, existingAgentNames, now);
	}

	private _detectTaskType(text: string): string {
		if (/cod(?:e|ing)|implement|开发|编码|编程|写代码|实现/.test(text)) { return 'coding'; }
		if (/test|测试|qa|验证/.test(text)) { return 'testing'; }
		if (/research|调研|研究|分析/.test(text)) { return 'research'; }
		if (/deploy|部署|发布|上线/.test(text)) { return 'deployment'; }
		return 'generic';
	}

	private _hasMultipleParts(text: string): boolean {
		return /[,，;；、]|\band\b|\bthen\b|然后|接着|之后|并且|同时/.test(text);
	}

	private _decomposeWithTemplate(
		goal: string, template: DecompTemplate, existing: Set<string>, now: string,
	): PlanTask[] {
		const tasks: PlanTask[] = [];
		let prevId: string | undefined;

		for (let i = 0; i < template.phases.length; i++) {
			const phase = template.phases[i];
			const deps: string[] = [];
			if (template.sequential && prevId) {
				// Cycle-safe: validate before adding dependency
				if (!wouldCreateCycle(tasks, prevId, prevId)) {
					deps.push(prevId);
				}
			}

			const task = this._createTask({
				title: `${phase.suffix}: ${goal.slice(0, 50)}`,
				description: `[${phase.suffix}] ${goal}`,
				agentName: phase.agentName,
				role: phase.role,
				existingAgentNames: existing,
				deps,
				priority: i + 1,
				now,
			});
			tasks.push(task);
			prevId = task.id;
		}
		return tasks;
	}

	private _decomposeByDelimiters(goal: string, existing: Set<string>, now: string): PlanTask[] {
		const separators = /[,，;；、]|\band\b|\bthen\b|然后|接着|之后/gi;
		const parts = goal.split(separators).map(p => p.trim()).filter(p => p.length > 3);

		if (parts.length <= 1) {
			return [this._createTask({
				title: goal.slice(0, 80),
				description: goal,
				agentName: this._inferAgentName(goal, 0),
				role: this._inferRole(goal),
				existingAgentNames: existing,
				deps: [],
				priority: 2,
				now,
			})];
		}

		const hasSequential = /then|接着|然后|之后|最后/.test(goal.toLowerCase());
		const tasks: PlanTask[] = [];
		let prevId: string | undefined;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const deps: string[] = [];
			if (hasSequential && prevId) {
				// Cycle-safe: validate before adding dependency
				if (!wouldCreateCycle(tasks, part /* new task placeholder */, prevId)) {
					deps.push(prevId);
				}
			}

			const task = this._createTask({
				title: part.slice(0, 60) + (part.length > 60 ? '...' : ''),
				description: part,
				agentName: this._inferAgentName(part, i),
				role: this._inferRole(part),
				existingAgentNames: existing,
				deps,
				priority: i + 1,
				now,
			});
			tasks.push(task);
			if (hasSequential) { prevId = task.id; }
		}
		return tasks;
	}

	private _createTask(opts: {
		title: string; description: string; agentName: string; role: string;
		existingAgentNames: Set<string>; deps: string[]; priority: number; now: string;
	}): PlanTask {
		return {
			id: generateId('orch_task'),
			title: opts.title,
			description: opts.description,
			status: PlanTaskStatus.Pending,
			dependencies: opts.deps,
			assigneeName: opts.agentName,
			assigneeRole: opts.role,
			autoCreateAgent: !opts.existingAgentNames.has(opts.agentName.toLowerCase()),
			priority: opts.priority,
			depth: 0, // computed later by topological sort
			retryCount: 0,
			maxRetries: DEFAULT_MAX_RETRIES,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			createdAt: opts.now,
		};
	}

	private _inferAgentName(text: string, index: number): string {
		const d = text.toLowerCase();
		if (/design|设计|ui|界面|ux/.test(d)) { return 'Designer'; }
		if (/test|测试|qa/.test(d)) { return 'QA Tester'; }
		if (/doc|文档|document/.test(d)) { return 'Technical Writer'; }
		if (/review|审核|检查|code.?review/.test(d)) { return 'Reviewer'; }
		if (/deploy|部署|发布|ci.?cd/.test(d)) { return 'DevOps'; }
		if (/database|数据库|db|数据|sql/.test(d)) { return 'Data Engineer'; }
		if (/api|backend|后端|服务端|server/.test(d)) { return 'Backend Developer'; }
		if (/frontend|前端|page|页面|css|html/.test(d)) { return 'Frontend Developer'; }
		if (/arch|架构|设计方案/.test(d)) { return 'Architect'; }
		return `Worker ${index + 1}`;
	}

	private _inferRole(text: string): string {
		const d = text.toLowerCase();
		if (/design|设计/.test(d)) { return 'Designer'; }
		if (/test|测试/.test(d)) { return 'QA Engineer'; }
		if (/doc|文档/.test(d)) { return 'Technical Writer'; }
		if (/review|审核/.test(d)) { return 'Code Reviewer'; }
		if (/deploy|部署/.test(d)) { return 'DevOps Engineer'; }
		if (/arch|架构/.test(d)) { return 'Software Architect'; }
		return 'Software Developer';
	}
}
