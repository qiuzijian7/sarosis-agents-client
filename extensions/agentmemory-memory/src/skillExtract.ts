/*---------------------------------------------------------------------------------------------
 *  技能提取 — 从完成的会话中提取可复用的程序化技能。
 *  参考 agentmemory src/functions/skill-extract.ts
 *
 *  当一个多步骤会话成功完成后，提取：
 *    - trigger: 何时应用此技能
 *    - title: 技能标题
 *    - steps: 具体步骤
 *    - expected_outcome: 预期结果
 *    - tags: 标签
 *
 *  与 Routines（例行任务）的区别：
 *    - Routines：用户显式创建的多步骤编排
 *    - SkillExtract：从会话历史自动提取的可复用模式
 *--------------------------------------------------------------------------------------------*/

export interface ExtractedSkill {
	id: string;
	trigger: string;
	title: string;
	steps: string[];
	expectedOutcome: string;
	tags: string[];
	sourceSessionId: string;
	sourceSummaryId?: string;
	confidence: number;
	usageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface SkillExtractInput {
	sessionId: string;
	summary?: {
		title: string;
		narrative: string;
		keyDecisions: string[];
		filesModified: string[];
		toolsUsed: string[];
	};
	observations: Array<{
		content: string;
		type: string;
		importance: number;
		timestamp: number;
	}>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 触发条件检测模式
const TRIGGER_PATTERNS = [
	{ pattern: /\b(error|bug|fail|crash|exception)\b/i, trigger: '当遇到错误或异常时' },
	{ pattern: /\b(test|coverage|unit)\b/i, trigger: '当需要编写或修复测试时' },
	{ pattern: /\b(deploy|release|publish|ci\/cd)\b/i, trigger: '当需要部署或发布时' },
	{ pattern: /\b(refactor|clean|restructure|migrat)\b/i, trigger: '当需要重构或迁移代码时' },
	{ pattern: /\b(config|setup|init|install)\b/i, trigger: '当需要配置或初始化环境时' },
	{ pattern: /\b(debug|investigate|troubleshoot)\b/i, trigger: '当需要调试或排查问题时' },
	{ pattern: /\b(performance|optim|profil|benchmark)\b/i, trigger: '当需要优化性能时' },
	{ pattern: /\b(security|auth|permission|vulnerab)\b/i, trigger: '当处理安全相关问题时' },
];

function detectTriggers(text: string): string[] {
	const triggers = new Set<string>();
	for (const { pattern, trigger } of TRIGGER_PATTERNS) {
		if (pattern.test(text)) {
			triggers.add(trigger);
		}
	}
	return Array.from(triggers);
}

function extractSteps(observations: Array<{ content: string; type: string; importance: number; timestamp: number }>): string[] {
	// 按时间排序，取重要步骤
	const sorted = observations
		.filter(o => o.importance >= 4)
		.sort((a, b) => a.timestamp - b.timestamp);

	const steps: string[] = [];
	for (const obs of sorted.slice(0, 10)) {
		// 提取动作描述（简化）
		const content = obs.content.slice(0, 200);
		steps.push(content);
	}
	return steps;
}

function extractTags(observations: Array<{ content: string; type: string; importance: number; timestamp: number }>, summary?: SkillExtractInput['summary']): string[] {
	const tags = new Set<string>();

	for (const obs of observations) {
		// 提取技术关键词
		const matches = obs.content.matchAll(/\b(\w{4,})\b/g);
		for (const m of matches) {
			const word = m[1].toLowerCase();
			if (['test', 'build', 'deploy', 'config', 'error', 'cache', 'database', 'api', 'auth', 'router'].includes(word)) {
				tags.add(word);
			}
		}
	}

	if (summary?.toolsUsed) {
		for (const tool of summary.toolsUsed) {
			tags.add(tool.toLowerCase());
		}
	}

	return Array.from(tags).slice(0, 15);
}

function computeConfidence(input: SkillExtractInput): number {
	const obsCount = input.observations.length;
	const importantObs = input.observations.filter(o => o.importance >= 5).length;
	const hasSummary = !!input.summary;

	// 置信度 = 观察数量权重 + 重要观察权重 + 摘要权重
	let confidence = 0;
	if (obsCount >= 5) confidence += 0.3;
	if (obsCount >= 10) confidence += 0.2;
	if (importantObs >= 3) confidence += 0.2;
	if (hasSummary) confidence += 0.15;
	if (input.summary?.keyDecisions.length && input.summary.keyDecisions.length > 0) confidence += 0.15;

	return Math.min(1, confidence);
}

export class SkillExtractor {
	private _skills = new Map<string, ExtractedSkill>();
	private _maxSkills = 200;

	/**
	 * 从会话提取技能
	 */
	extract(input: SkillExtractInput): ExtractedSkill | null {
		if (!input.observations || input.observations.length < 3) {
			return null;  // 观察太少，不值得提取
		}

		// 合并所有文本用于触发检测
		const allText = [
			input.summary?.narrative ?? '',
			input.summary?.title ?? '',
			...input.observations.map(o => o.content),
		].join(' ');

		const triggers = detectTriggers(allText);
		if (triggers.length === 0) {
			return null;  // 无法识别触发条件
		}

		const steps = extractSteps(input.observations);
		if (steps.length < 2) {
			return null;  // 步骤太少
		}

		const tags = extractTags(input.observations, input.summary);
		const confidence = computeConfidence(input);
		if (confidence < 0.3) {
			return null;  // 置信度太低
		}

		const now = new Date().toISOString();
		const title = input.summary?.title ?? `Skill from ${input.sessionId}`;

		const skill: ExtractedSkill = {
			id: generateId('skill'),
			trigger: triggers.join('; '),
			title: title.slice(0, 100),
			steps,
			expectedOutcome: input.summary?.narrative.slice(0, 300) ?? 'Task completed successfully',
			tags,
			sourceSessionId: input.sessionId,
			sourceSummaryId: input.summary ? undefined : undefined,
			confidence,
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		};

		this._skills.set(skill.id, skill);
		if (this._skills.size > this._maxSkills) {
			// 移除最旧的
			const oldest = Array.from(this._skills.values())
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
			if (oldest) this._skills.delete(oldest.id);
		}

		return skill;
	}

	/**
	 * 获取技能
	 */
	get(id: string): ExtractedSkill | null {
		return this._skills.get(id) ?? null;
	}

	/**
	 * 列出所有技能
	 */
	list(filter?: { tags?: string[]; minConfidence?: number }): ExtractedSkill[] {
		let skills = Array.from(this._skills.values());
		if (filter?.minConfidence !== undefined) {
			skills = skills.filter(s => s.confidence >= filter.minConfidence!);
		}
		if (filter?.tags && filter.tags.length > 0) {
			skills = skills.filter(s => filter.tags!.some(t => s.tags.includes(t)));
		}
		return skills.sort((a, b) => b.confidence - a.confidence);
	}

	/**
	 * 搜索技能
	 */
	search(query: string, limit: number = 10): ExtractedSkill[] {
		const lower = query.toLowerCase();
		const results: Array<{ skill: ExtractedSkill; score: number }> = [];

		for (const skill of this._skills.values()) {
			let score = 0;
			if (skill.title.toLowerCase().includes(lower)) score += 3;
			if (skill.trigger.toLowerCase().includes(lower)) score += 2;
			for (const step of skill.steps) {
				if (step.toLowerCase().includes(lower)) score += 1;
			}
			for (const tag of skill.tags) {
				if (tag.includes(lower)) score += 2;
			}
			if (score > 0) {
				results.push({ skill, score });
			}
		}

		return results
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(r => r.skill);
	}

	/**
	 * 标记技能被使用
	 */
	markUsed(id: string): boolean {
		const skill = this._skills.get(id);
		if (!skill) return false;
		skill.usageCount++;
		skill.updatedAt = new Date().toISOString();
		return true;
	}

	/**
	 * 删除技能
	 */
	delete(id: string): boolean {
		return this._skills.delete(id);
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalSkills: number; avgConfidence: number; avgSteps: number; totalUsage: number } {
		const skills = Array.from(this._skills.values());
		const avgConfidence = skills.length > 0
			? skills.reduce((s, sk) => s + sk.confidence, 0) / skills.length
			: 0;
		const avgSteps = skills.length > 0
			? skills.reduce((s, sk) => s + sk.steps.length, 0) / skills.length
			: 0;
		const totalUsage = skills.reduce((s, sk) => s + sk.usageCount, 0);
		return {
			totalSkills: skills.length,
			avgConfidence: Math.round(avgConfidence * 100) / 100,
			avgSteps: Math.round(avgSteps * 10) / 10,
			totalUsage,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._skills.clear();
	}
}
