/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 注册表实现 —— 见 `common/skills.ts` 接口契约。
 *
 * 加载策略：
 *   1. `_loadBuiltins()`        —— 内置 skill 模块（产品自带，硬编码常量数组）
 *      1a. `BUILTIN_SKILLS`     —— Sarosis 原生核心 skill（4 个，始终加载）
 *      1b. `BUNDLED_SKILLS`     —— 从 Hermes-Agent 迁移的打包 skill（87 个，始终加载）
 *   2. `_scanFolder(roaming)`   —— 全局用户目录 `<userRoamingDataHome>/sarosis/skills/`
 *   3. `_scanAgentSkills(...)`  —— 工作区目录 `<workspaceFolder>/.sarosisworkspace/agents/<agentDir>/skills/`
 *   4. `registerSkill(...)`     —— 运行时由扩展通过 IAgentOSService 注入
 *
 * 后注册的同名 skill 覆盖前者（运行时注入 > 工作区 > 用户 > 内置），
 * 这与 hermes 的 `optional-skills` < `skills` < `~/.hermes/skills` 优先级一致。
 *
 * Skill 文件格式（仿 hermes 与 Claude SKILL.md 标准）：
 *
 *   ---
 *   name: code-review
 *   description: ...
 *   activation: auto
 *   match: [review, refactor, lint]
 *   category: code
 *   recommended_tools: [file_read, shell_exec]
 *   ---
 *   <skill body in markdown>
 */

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WORKSPACE_DATA_DIR, AGENTS_DIR } from '../common/constants.js';
import {
	ISkillRegistry, ISkillDefinition, ISkillActivationContext, ISkillInjection,
	SkillActivation,
} from '../common/skills.js';
import { BUNDLED_SKILLS } from '../common/bundled-skills/bundledSkills.js';
import { ISkillLifecycleService, SkillLifecycleEvent, ISkillLifecyclePayload } from '../common/skillLifecycle.js';

interface IRawFrontmatter {
	name?: unknown;
	description?: unknown;
	activation?: unknown;
	match?: unknown;
	category?: unknown;
	recommended_tools?: unknown;
	recommendedTools?: unknown;
}

const SKILL_DIR_NAME = 'skills';

/**
 * 一组随产品发布的内置 skill。
 * 之所以用常量数组而不是物理文件，是为了在 web/electron 两端零成本可用 ——
 * 无需打包额外资源，也无需走 IFileService 异步加载即可参与首屏。
 */
const BUILTIN_SKILLS: ISkillDefinition[] = [
	{
		id: 'code-review',
		name: 'Code Review',
		description: '对当前 diff/文件进行快速代码评审，关注正确性、风格、可维护性。',
		activation: 'auto',
		match: ['review', 'code review', '评审', '审查代码', 'code-review'],
		category: 'code',
		recommendedTools: ['file_read', 'shell_exec'],
		source: 'builtin',
		enabled: true,
		prompt: [
			'You are running the **code-review** skill.',
			'',
			'Review the relevant code with the following lens, in order:',
			'1. **Correctness** — logic bugs, off-by-one, null handling, race conditions.',
			'2. **Edge cases** — empty input, unicode, large input, concurrent callers.',
			'3. **Readability** — naming, function length, comment density.',
			'4. **Maintainability** — coupling, duplication, dead code, missing tests.',
			'5. **Security & perf** — only call out concrete issues, never hand-wave.',
			'',
			'Output format: a numbered list grouped by file path. Use `path:line` citations.',
			'When you suggest a change, provide a small unified diff so the user can apply it.',
		].join('\n'),
	},
	{
		id: 'commit-message',
		name: 'Commit Message',
		description: '基于当前已暂存改动生成符合 Conventional Commits 的提交信息。',
		activation: 'manual',
		category: 'git',
		recommendedTools: ['shell_exec'],
		source: 'builtin',
			enabled: true,
		prompt: [
			'You are running the **commit-message** skill.',
			'',
			'1. Read the staged diff via `git diff --cached --stat` and `git diff --cached`.',
			'2. Pick a Conventional Commits type (feat/fix/refactor/docs/test/chore/perf/build/ci).',
			'3. Pick a scope from the most-changed top-level directory.',
			'4. Write a subject ≤ 72 chars, imperative mood, no trailing period.',
			'5. Write a body (optional) explaining *why*, not *what*.',
			'',
			'Return ONLY the final commit message in a fenced ```text block. Do not narrate.',
		].join('\n'),
	},
	{
		id: 'be-concise',
		name: 'Be Concise',
		description: '保持简短回答，避免赘述。always 类型。',
		activation: 'always',
		category: 'meta',
		source: 'builtin',
		enabled: true,
		prompt: [
			'Behavioral guidance: keep replies short. Prefer bullet lists over paragraphs.',
			'Cut filler such as "I will now…", "Let me…", "Sure!". Do not restate the question.',
		].join('\n'),
	},
	{
		id: 'plan-then-act',
		name: 'Plan then Act',
		description: '复杂任务先规划后执行 —— 给出步骤后再调用工具。',
		activation: 'auto',
		match: ['refactor', 'rewrite', 'migrate', 'redesign', '架构', '重构'],
		category: 'meta',
		source: 'builtin',
		enabled: true,
		prompt: [
			'You are running the **plan-then-act** skill.',
			'',
			'Before invoking any tool, output a short numbered plan (3-7 steps).',
			'Then mark `--- begin execution ---` on its own line and start the first tool call.',
			'After every tool result, briefly note whether the result confirms or invalidates the plan.',
		].join('\n'),
	},
];

/**
 * 解析极简 YAML frontmatter（不依赖第三方库，只支持我们文档中描述的子集）。
 * 支持：
 *   - `key: value`
 *   - `key: [a, b, c]` 一行内联数组
 *   - `key:` 后跟 `  - item` 缩进数组
 *   - 字符串自动 trim 并去除首尾引号
 */
function parseFrontmatter(text: string): { meta: IRawFrontmatter; body: string } {
	if (!text.startsWith('---')) {
		return { meta: {}, body: text };
	}
	const end = text.indexOf('\n---', 3);
	if (end < 0) {
		return { meta: {}, body: text };
	}
	const headerLines = text.slice(3, end).split('\n');
	const body = text.slice(end + 4).replace(/^\r?\n/, '');

	const meta: Record<string, unknown> = {};
	let pendingArrayKey: string | undefined;
	let pendingArray: string[] | undefined;
	const flushArray = () => {
		if (pendingArrayKey && pendingArray) {
			meta[pendingArrayKey] = pendingArray;
		}
		pendingArrayKey = undefined;
		pendingArray = undefined;
	};

	for (const rawLine of headerLines) {
		const line = rawLine.replace(/\r$/, '');
		if (!line.trim()) {
			continue;
		}
		const arrayItem = /^\s+-\s+(.*)$/.exec(line);
		if (arrayItem && pendingArrayKey) {
			pendingArray!.push(stripQuotes(arrayItem[1].trim()));
			continue;
		}
		const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) {
			continue;
		}
		flushArray();
		const key = kv[1];
		const rawVal = kv[2].trim();
		if (rawVal === '') {
			pendingArrayKey = key;
			pendingArray = [];
			continue;
		}
		const inlineArr = /^\[(.*)\]$/.exec(rawVal);
		if (inlineArr) {
			meta[key] = inlineArr[1].split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
			continue;
		}
		meta[key] = stripQuotes(rawVal);
	}
	flushArray();
	return { meta, body };
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
		return s.slice(1, -1);
	}
	return s;
}

function normalizeActivation(v: unknown): SkillActivation {
	if (v === 'always' || v === 'manual' || v === 'auto') {
		return v;
	}
	return 'manual';
}

function asStringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) { return undefined; }
	return v.filter((x): x is string => typeof x === 'string');
}

export class SkillRegistry extends Disposable implements ISkillRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _skills = new Map<string, ISkillDefinition>();
	private readonly _runtimeSkills = new Map<string, ISkillDefinition>();
	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	readonly onDidChangeSkills: Event<void> = this._onDidChangeSkills.event;

	/** 懒加载 IAgentStudioService —— 避免构造时循环依赖 */
	private _studioService: IAgentStudioService | undefined;
	private get studioService(): IAgentStudioService {
		if (!this._studioService) {
			this._studioService = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentStudioService));
		}
		return this._studioService;
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
	) {
		super();
		this.logService.info('[SkillRegistry] constructor called');
		// 立即填充内置 skill，使 UI 在文件扫描完成前已可显示。
		this._loadBuiltins();
		this.logService.info(`[SkillRegistry] after _loadBuiltins in ctor: ${this._skills.size} skills available synchronously`);
		// 异步扫描磁盘 skill —— 失败不影响内置 skill 可用性。
		this.reload().catch(err => this.logService.warn('[SkillRegistry] initial reload failed', err));
	}

	getSkills(): readonly ISkillDefinition[] {
		this.logService.trace(`[SkillRegistry] getSkills() called, returning ${this._skills.size} skills`);
		return [...this._skills.values()];
	}

	getSkill(id: string): ISkillDefinition | undefined {
		return this._skills.get(id);
	}

	registerSkill(skill: ISkillDefinition): IDisposable {
		const id = skill.id;
		this._runtimeSkills.set(id, { ...skill, source: skill.source ?? 'memory' });
		this._skills.set(id, this._runtimeSkills.get(id)!);
		this._onDidChangeSkills.fire();
		this.logService.info(`[SkillRegistry] runtime skill registered: ${id}`);
		return toDisposable(() => {
			this._runtimeSkills.delete(id);
			// 重新加载，让被覆盖的内置 / 文件 skill 回到 _skills 表。
			this.reload().catch(() => undefined);
		});
	}

	resolveActivations(context: ISkillActivationContext): Promise<readonly ISkillInjection[]> {
		const out: ISkillInjection[] = [];
		const explicit = new Set((context.explicit ?? []).map(s => s.toLowerCase()));
		const userMsg = context.userMessage.toLowerCase();
		const autoSkill = context.autoSkill !== false; // 默认 true

		const matchedNonWorkspace: ISkillDefinition[] = [];

		for (const skill of this._skills.values()) {
			// 首先检查 skill 是否启用
			if (skill.enabled === false) { continue; }

			let take = false;
			if (skill.activation === 'always') {
				take = true;
			} else if (explicit.has(skill.id.toLowerCase())) {
				take = true;
			} else if (skill.activation === 'auto' && skill.match) {
				take = skill.match.some(kw => userMsg.includes(kw.toLowerCase()));
			}
			if (!take) { continue; }

			// autoSkill 关闭时，仅允许 workspace source
			if (!autoSkill && skill.source !== 'workspace') { continue; }

			out.push({
				skill,
				// 与 hermes 一致：以独立 user message 注入，避免 system prompt 失效缓存。
				placement: skill.activation === 'always' ? 'system' : 'user',
				content: this._renderInjection(skill),
			});

			// 记录非 workspace 的匹配 skill，后续自动采纳
			if (autoSkill && skill.source !== 'workspace') {
				matchedNonWorkspace.push(skill);
			}
		}

		// 异步采纳匹配到的非 workspace skill 到 agent 实例目录
		if (matchedNonWorkspace.length > 0 && context.agentId) {
			this._adoptMatchedSkills(context.agentId, matchedNonWorkspace).catch(err =>
				this.logService.warn('[SkillRegistry] auto-adopt failed', err),
			);
		}

		return Promise.resolve(out);
	}

	/**
	 * 自动将匹配到的非 workspace skill 采纳到 agent 实例的 skills 目录。
	 * 仅在 autoSkill 开启时调用。不阻塞 resolveActivations 返回。
	 */
	private async _adoptMatchedSkills(agentId: string, skills: ISkillDefinition[]): Promise<void> {
		for (const skill of skills) {
			try {
				await this.adoptSkillToAgent(agentId, skill.id);
			} catch (err) {
				this.logService.debug(`[SkillRegistry] auto-adopt skill ${skill.id} skipped`, err);
			}
		}
	}

	/** 将一个 skill 采纳到指定 agent 实例的 skills 目录 */
	async adoptSkillToAgent(agentId: string, skillId: string): Promise<void> {
		const skill = this._skills.get(skillId);
		if (!skill) { return; }

		const employee = await this.studioService.getEmployee(agentId);
		if (!employee?.agentDir || !employee.workspaceId) { return; }

		const workspace = await this.studioService.getWorkspace(employee.workspaceId);
		if (!workspace?.path) { return; }

		const dirName = skillId.replace(/[^a-zA-Z0-9_-]/g, '-');
		const skillSubDir = URI.joinPath(
			URI.file(workspace.path), WORKSPACE_DATA_DIR, AGENTS_DIR, employee.agentDir, SKILL_DIR_NAME, dirName,
		);

		// 检查是否已存在
		const skillFile = URI.joinPath(skillSubDir, 'SKILL.md');
		if (await this.fileService.exists(skillFile)) {
			this.logService.debug(`[SkillRegistry] skill ${skillId} already exists in agent dir, skip adopt`);
			return;
		}

		// 创建目录并写入 SKILL.md
		await this.fileService.createFolder(skillSubDir);
		const content = this._renderSkillMdContent(skill);
		await this.fileService.writeFile(skillFile, VSBuffer.fromString(content));

		this.logService.info(`[SkillRegistry] skill ${skillId} adopted to agent ${employee.agentDir}`);

		// Fire skill-added lifecycle event (fire-and-forget)
		const payload: ISkillLifecyclePayload = {
			workspaceId: employee.workspaceId,
			workspacePath: workspace.path,
			agentId: employee.id,
			agentDir: employee.agentDir,
			skillId,
			skillName: skill.name,
			timestamp: new Date().toISOString(),
		};
		void this.skillLifecycleService.fireSkillEvent(SkillLifecycleEvent.Added, payload).catch(err => {
			this.logService.debug(`[SkillRegistry] skill lifecycle event failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	/** 启用指定 skill */
	enableSkill(id: string): void {
		const skill = this._skills.get(id);
		if (skill) {
			// 由于 ISkillDefinition.enabled 不是 readonly，我们可以直接修改
			(skill as { enabled: boolean }).enabled = true;
			this.logService.info(`[SkillRegistry] skill enabled: ${id}`);
			this._onDidChangeSkills.fire();
		}
	}

	/** 禁用指定 skill */
	disableSkill(id: string): void {
		const skill = this._skills.get(id);
		if (skill) {
			(skill as { enabled: boolean }).enabled = false;
			this.logService.info(`[SkillRegistry] skill disabled: ${id}`);
			this._onDidChangeSkills.fire();
		}
	}

	async reload(agentId?: string): Promise<void> {
		this.logService.info(`[SkillRegistry] reload() called, agentId=${agentId ?? '(all)'}`);
		this._skills.clear();
		this._loadBuiltins();
		this.logService.info(`[SkillRegistry] after _loadBuiltins: ${this._skills.size} skills`);

		// 用户全局目录
		try {
			const userDir = URI.joinPath(this.environmentService.userRoamingDataHome, 'sarosis', 'skills');
			this.logService.info(`[SkillRegistry] scanning user dir: ${userDir.toString()}`);
			await this._scanFolder(userDir, 'user');
			this.logService.info(`[SkillRegistry] after user scan: ${this._skills.size} skills`);
		} catch (err) {
			this.logService.debug('[SkillRegistry] no user skills dir', err);
		}

		// 工作区目录 — 每个 agent 实例独立 skills 目录
		try {
			const wsFolders = this.workspaceService.getWorkspace().folders;
			this.logService.info(`[SkillRegistry] workspace folders count: ${wsFolders.length}`);
			for (const f of wsFolders) {
				if (agentId) {
					// 指定 agent 时，只加载该 agent 的 skills
					await this._scanAgentSkills(f.uri, agentId);
				} else {
					// 不指定 agent 时，加载所有 agent 的 skills
					await this._scanAllAgentSkills(f.uri);
				}
			}
			this.logService.info(`[SkillRegistry] after workspace scan: ${this._skills.size} skills`);
		} catch (err) {
			this.logService.debug('[SkillRegistry] no workspace skills', err);
		}

		// 运行时注入的 skill 永远胜出
		for (const [id, skill] of this._runtimeSkills) {
			this._skills.set(id, skill);
		}
		if (this._runtimeSkills.size > 0) {
			this.logService.info(`[SkillRegistry] runtime skills merged: ${this._runtimeSkills.size}`);
		}

		this.logService.info(`[SkillRegistry] reload() complete: total ${this._skills.size} skills`);
		this._onDidChangeSkills.fire();
	}

	// ─── 内部 ────────────────────────────────────────────────

	private _loadBuiltins(): void {
		// 1a. Sarosis 原生核心 skill — 优先加载，ID 不会被覆盖
		for (const s of BUILTIN_SKILLS) {
			this._skills.set(s.id, { ...s, enabled: true });
		}
		this.logService.info(`[SkillRegistry] _loadBuiltins: ${BUILTIN_SKILLS.length} core skills loaded`);
		// 1b. 从 Hermes-Agent 迁移的打包 skill — 同名 ID 不覆盖原生 skill
		let bundledCount = 0;
		for (const s of BUNDLED_SKILLS) {
			if (!this._skills.has(s.id)) {
				this._skills.set(s.id, { ...s, enabled: true });
				bundledCount++;
			}
		}
		this.logService.info(`[SkillRegistry] _loadBuiltins: ${bundledCount}/${BUNDLED_SKILLS.length} bundled skills loaded (${BUNDLED_SKILLS.length - bundledCount} skipped as duplicates)`);
	}

	private async _scanFolder(dir: URI, source: 'user' | 'workspace'): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			this.logService.debug(`[SkillRegistry] _scanFolder: dir not found: ${dir.toString()}`);
			return; // 目录不存在
		}
		if (!stat.isDirectory || !stat.children) {
			this.logService.debug(`[SkillRegistry] _scanFolder: not a dir or no children: ${dir.toString()}`);
			return;
		}

		this.logService.info(`[SkillRegistry] _scanFolder(${source}): scanning ${dir.toString()}, ${stat.children.length} children`);
		let loaded = 0;
		for (const child of stat.children) {
			if (!child.isDirectory) { continue; }
			const skillFile = URI.joinPath(child.resource, 'SKILL.md');
			try {
				const content = await this.fileService.readFile(skillFile);
				const text = content.value.toString();
				const skill = this._parseSkillFile(child.resource, text, source);
				if (skill) {
					this._skills.set(skill.id, skill);
					loaded++;
				} else {
					this.logService.warn(`[SkillRegistry] _scanFolder: parse returned null for ${skillFile.toString()}`);
				}
			} catch {
				// SKILL.md 可缺失，忽略
			}
		}
		this.logService.info(`[SkillRegistry] _scanFolder(${source}): loaded ${loaded} skills from ${dir.toString()}`);
	}

	/**
	 * 扫描指定 agent 实例目录下的 skills：
	 * `<workspaceFolder>/.sarosisworkspace/agents/<agentDir>/skills/<id>/SKILL.md`
	 */
	private async _scanAgentSkills(workspaceUri: URI, targetAgentId: string): Promise<void> {
		// 从 IAgentStudioService 获取 Employee 信息，解析 agentDir
		const employee = await this.studioService.getEmployee(targetAgentId);
		if (!employee?.agentDir || !employee.workspaceId) { return; }

		const workspace = await this.studioService.getWorkspace(employee.workspaceId);
		if (!workspace?.path) { return; }

		const skillsDir = URI.joinPath(
			URI.file(workspace.path), WORKSPACE_DATA_DIR, AGENTS_DIR, employee.agentDir, SKILL_DIR_NAME,
		);
		await this._scanFolder(skillsDir, 'workspace');
	}

	/**
	 * 扫描工作区中所有 agent 实例的 skills 目录。
	 * 遍历 `.sarosisworkspace/agents/` 下每个子目录的 `skills/` 子目录。
	 */
	private async _scanAllAgentSkills(workspaceUri: URI): Promise<void> {
		const agentsDir = URI.joinPath(workspaceUri, WORKSPACE_DATA_DIR, AGENTS_DIR);
		let agentsStat: IFileStat;
		try {
			agentsStat = await this.fileService.resolve(agentsDir);
		} catch {
			return; // .sarosisworkspace/agents/ 不存在
		}
		if (!agentsStat.isDirectory || !agentsStat.children) { return; }

		for (const agentEntry of agentsStat.children) {
			if (!agentEntry.isDirectory) { continue; }
			const skillsDir = URI.joinPath(agentEntry.resource, SKILL_DIR_NAME);
			await this._scanFolder(skillsDir, 'workspace');
		}
	}

	private _parseSkillFile(folder: URI, text: string, source: 'user' | 'workspace'): ISkillDefinition | undefined {
		const { meta, body } = parseFrontmatter(text);
		const name = typeof meta.name === 'string' ? meta.name : undefined;
		if (!name) {
			this.logService.warn(`[SkillRegistry] SKILL.md missing 'name': ${folder.toString()}`);
			return undefined;
		}
		const description = typeof meta.description === 'string' ? meta.description : '';
		const id = name.toLowerCase().replace(/\s+/g, '-');
		return {
			id,
			name,
			description,
			activation: normalizeActivation(meta.activation),
			match: asStringArray(meta.match),
			category: typeof meta.category === 'string' ? meta.category : undefined,
			recommendedTools: asStringArray(meta.recommended_tools) ?? asStringArray(meta.recommendedTools),
			prompt: body.trim(),
			source,
			resource: folder,
			enabled: true, // 默认启用
		};
	}

	private _renderInjection(skill: ISkillDefinition): string {
		// 与 hermes 的 skill_commands.py 一致：明确告诉模型这是一段「skill」内容，
		// 让它把 skill body 作为本轮的执行准则。
		return [
			`### Skill activated: ${skill.name}`,
			skill.description ? `_${skill.description}_` : '',
			'',
			skill.prompt,
		].filter(Boolean).join('\n');
	}

	/**
	 * 将 ISkillDefinition 序列化为标准 SKILL.md 格式（YAML frontmatter + body），
	 * 用于采纳到 agent 实例目录。
	 */
	private _renderSkillMdContent(def: ISkillDefinition): string {
		const lines: string[] = ['---'];
		lines.push(`name: ${def.name}`);
		if (def.description) {
			lines.push(`description: ${def.description}`);
		}
		lines.push(`activation: ${def.activation}`);
		if (def.match && def.match.length > 0) {
			lines.push(`match: [${def.match.join(', ')}]`);
		}
		if (def.category) {
			lines.push(`category: ${def.category}`);
		}
		if (def.recommendedTools && def.recommendedTools.length > 0) {
			lines.push(`recommended_tools: [${def.recommendedTools.join(', ')}]`);
		}
		lines.push('---');
		lines.push('');
		lines.push(def.prompt);
		lines.push('');
		return lines.join('\n');
	}
}
