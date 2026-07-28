/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
/**
 * Skill 注册表实现 —— 见 `common/skills.ts` 接口契约。
 *
 * 加载策略（参考 Hermes-Agent 模式）：
 *   1. 异步扫描内置技能目录 `.agents/skills/`（产品自带，文件形式）
 *      - 技能以 `SKILL.md` 文件形式存储在扩展目录下 `.agents/skills/<skill-name>/SKILL.md`
 *      - 参考 Hermes-Agent 的 `skills/` 项目目录模式
 *   2. `_scanFolder(userHome)`   —— 用户全局技能库 `~/.vssaros/saros/skills/`
 *   3. `registerSkill(...)`     —— 运行时由扩展通过 IAgentOSService 注入
 *
 * 后注册的同名 skill 覆盖前者（运行时注入 > 用户 > 内置），
 * 这与 hermes 的 `optional-skills` < `skills` < `~/.hermes/skills` 优先级一致。
 *
 * 架构说明：
 *   - 技能统一存储于用户全局技能库（`~/.vssaros/saros/skills/`）和内置技能目录（`.agents/skills/`）
 *   - 内置技能从 `.agents/skills/` 目录文件加载（参考 Hermes-Agent 模式）
 *   - 好处：技能以文件形式管理，便于版本控制和升级
 *
 * Skill 文件格式（仿 hermes 与 Claude SKILL.md 标准）：
 *
 *   ---
 *   name: code-review
 *   description: ...
 *   activation: auto
 *   match: [review, refactor, lint]
 *   category: code
 *   recommended_tools: [file_read, terminal]
 *   ---
 *   <skill body in markdown>
 */

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { stringHash } from '../../../../base/common/hash.js';
import {
	ISkillRegistry, ISkillDefinition, ISkillActivationContext, ISkillInjection,
	ISkillExecutor, SkillActivation,
} from '../common/skills.js';
import { ISkillLifecycleService, ISkillBatchLifecyclePayload } from '../common/skillLifecycle.js';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../common/workflowStorage.js';
import { AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING } from '../common/constants.js';

/**
 * 计算 skill 内容指纹：基于 prompt 正文生成 8 位十六进制哈希。
 * 用于判断不同目录下同名 skill 是否内容完全一致。
 */
function computeSkillContentHash(prompt: string): string {
	const h = stringHash(prompt.trim(), 0);
	// 转为无符号 32 位整数后输出 8 位十六进制
	return (h >>> 0).toString(16).padStart(8, '0');
}

interface IRawFrontmatter {
	name?: unknown;
	description?: unknown;
	activation?: unknown;
	match?: unknown;
	category?: unknown;
	recommended_tools?: unknown;
	recommendedTools?: unknown;
	storeId?: unknown;
	version?: unknown;
	/** Hermes-Agent 兼容：适用平台 */
	platforms?: unknown;
	/** Hermes-Agent 兼容：分类标签 */
	tags?: unknown;
	/** Hermes-Agent 兼容：关联技能 ID 列表 */
	related_skills?: unknown;
	/** 技能作者 */
	author?: unknown;
	/** 技能许可证 */
	license?: unknown;
	/** Agent Skills 规范：工具面白名单 */
	allowed_tools?: unknown;
	'allowed-tools'?: unknown;
	/** Agent Skills 规范扩展：偏好模型 */
	model?: unknown;
}

/**
 * 一组随产品发布的内置 skill。
 * 之所以用常量数组而不是物理文件，是为了在 web/electron 两端零成本可用 ——
 * 技能现在以文件形式存储在 .agents/skills/ 目录，参考 Hermes-Agent 模式。
 * 无需硬编码，通过 _scanFolder() 扫描加载。
 */

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
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
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
	private readonly _readyPromise: Promise<void>;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioLogService private readonly logService: ILogService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		) {
		super();
		this.logService.info('[SkillRegistry] constructor called');
		// 参考 Hermes-Agent 模式：技能从 skills/ 目录文件异步加载，不再同步硬编码
		// 立即填充已移除 — UI 将在异步扫描完成后可显示
		this.logService.info(`[SkillRegistry] no sync skills - will load async`);
		// workflow → skill 双向打通（A 向）：工作流变更时重扫 workflow 来源 skill。
		// 注意：这会触发一次全量 reload（含磁盘 skill 重扫），工作流数量通常有限，
		// 可接受；后续如需优化可改为增量更新。
		this._register(this.workflowStorageService.onDidChangeWorkflows(() => {
			this.reload().catch(err => this.logService.warn('[SkillRegistry] reload after workflow change failed', err));
		}));

		// 异步扫描磁盘 skill —— 失败不影响内置 skill 可用性。
		this._readyPromise = this.reload().catch(err => this.logService.warn('[SkillRegistry] initial reload failed', err));
	}

	/** 等待初始加载完成 */
	async whenReady(): Promise<void> {
		await this._readyPromise;
	}

	getSkills(): readonly ISkillDefinition[] {
		this.logService.trace(`[SkillRegistry] getSkills() called, returning ${this._skills.size} skills`);
		return [...this._skills.values()];
	}

	getSkill(id: string): ISkillDefinition | undefined {
		return this._skills.get(id);
	}

	/**
	 * 读取技能支持目录（references/templates/assets/scripts）中的文件内容。
	 * 路径安全：必须位于支持目录内，拒绝 `..` 遍历与绝对路径。
	 */
	async readSkillSupportFile(skillId: string, relativePath: string): Promise<string> {
		const skill = this._skills.get(skillId);
		if (!skill || !skill.resource) {
			throw new Error(`Skill not found: "${skillId}"`);
		}
		const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
		const segments = normalized.split('/').filter(s => s.length > 0);
		const topDir = segments[0];
		if (!topDir || !SkillRegistry.SKILL_SUPPORT_DIRS.has(topDir) || segments.includes('..')) {
			throw new Error(`Invalid support file path "${relativePath}": must be inside one of [${[...SkillRegistry.SKILL_SUPPORT_DIRS].join(', ')}]`);
		}
		const fileUri = URI.joinPath(skill.resource, ...segments);
		const content = await this.fileService.readFile(fileUri);
		return content.value.toString();
	}

	registerSkill(skill: ISkillDefinition): IDisposable {
		const id = skill.id;
		const registered: ISkillDefinition = {
			...skill,
			source: skill.source ?? 'memory',
			contentHash: skill.contentHash ?? computeSkillContentHash(skill.prompt),
		};
		this._runtimeSkills.set(id, registered);
		this._skills.set(id, registered);
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
		const required = new Set((context.required ?? []).map(s => s.toLowerCase()));
		const userMsg = context.userMessage.toLowerCase();

		for (const skill of this._skills.values()) {
			// 首先检查 skill 是否启用
			if (skill.enabled === false) { continue; }

			let take = false;
			if (required.has(skill.id.toLowerCase())) {
				// 强制加载：agent 配置中指定的技能，无论 activation 模式都必须注入
				take = true;
			} else if (skill.activation === 'always') {
				take = true;
			} else if (explicit.has(skill.id.toLowerCase())) {
				take = true;
			} else if (skill.activation === 'auto' && skill.match) {
				take = skill.match.some(kw => userMsg.includes(kw.toLowerCase()));
			}
			if (!take) { continue; }

			out.push({
				skill,
				// * required（agent 配置强制加载）→ system placement，确保：
				//   1. 经过 agentDriverService 的 500-char 内联/截断路径（长技能仅放摘要 + read_skill 指引）
				//   2. Knot AG-UI 路径通过 background_knowledge 到达模型（user placement 会被丢弃）
				//   3. BVOK/direct 路径通过 system message 到达模型
				// * activation='always' → system placement（与 required 一致）
				// * 其余（explicit/auto 命中）→ user placement（独立 user message，避免 system prompt 失效缓存）
				placement: (required.has(skill.id.toLowerCase()) || skill.activation === 'always') ? 'system' : 'user',
				content: this._renderInjection(skill),
				// 可执行型 skill（workflow 来源）携带 executor，供 ExecutionProvider 触发执行而非注入文本
				executor: skill.executor,
			});
		}

		return Promise.resolve(out);
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

	async reload(): Promise<void> {
		this.logService.info(`[SkillRegistry] reload() called`);
		// 调试信息：打印 _VSCODE_FILE_ROOT 和 appRoot 帮助诊断路径问题
		try {
			this.logService.info(`[SkillRegistry] _VSCODE_FILE_ROOT: ${(globalThis as any)._VSCODE_FILE_ROOT ?? 'undefined'}`);
		} catch { /* ignore */ }
		try {
			this.logService.info(`[SkillRegistry] env.appRoot: ${(this.environmentService as INativeEnvironmentService).appRoot ?? 'undefined'}`);
		} catch { /* ignore */ }
		this._skills.clear();
		// 参考 Hermes-Agent 模式：技能从 .agents/skills/ 目录扫描加载，不再硬编码
		// this._loadBuiltins(); // 已移除 - 技能现在从 .agents/skills/ 目录文件加载

		// 内置技能目录（产品自带的 resources/.agents/skills/）
		// 尝试多个候选路径以兼容不同运行环境（开发/打包、桌面/浏览器）
		try {
			const candidates: URI[] = [];

			// 候选1（最稳）：FileAccess.asFileUri —— 基于 vs 源码根目录推算 resources 兄弟目录
			// 适用所有运行模式（dev / electron-packaged / browser），与 install 路径解析保持一致
			try {
				const uri1 = FileAccess.asFileUri('vs/../../resources/.agents/skills');
				this.logService.info(`[SkillRegistry] candidate1 (FileAccess): ${uri1.toString()}`);
				candidates.push(uri1);
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate1 failed: ${e}`);
			}

			// 候选2：appRoot 直接拼 resources（Electron dev 模式 appRoot ≡ projectRoot）
			let appRoot: string | undefined;
			try {
				appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
				this.logService.info(`[SkillRegistry] appRoot: ${appRoot}`);
				if (appRoot) {
					const uri2 = URI.joinPath(URI.file(appRoot), 'resources', '.agents', 'skills');
					this.logService.info(`[SkillRegistry] candidate2 (appRoot/resources): ${uri2.toString()}`);
					if (!candidates.some(c => c.toString() === uri2.toString())) {
						candidates.push(uri2);
					}
				}
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate2 failed: ${e}`);
			}

			// 候选3：打包模式下 appRoot 可能是 out/ 子目录，需要往上一级
			try {
				if (appRoot) {
					const projectRoot = path.dirname(appRoot);
					const uri3 = URI.joinPath(URI.file(projectRoot), 'resources', '.agents', 'skills');
					this.logService.info(`[SkillRegistry] candidate3 (dirname(appRoot)/resources): ${uri3.toString()}`);
					if (!candidates.some(c => c.toString() === uri3.toString())) {
						candidates.push(uri3);
					}
				}
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate3 failed: ${e}`);
			}

			// 去重（URI 字符串比较）
			const uniqueCandidates = candidates.filter((c, i, arr) =>
				arr.findIndex(c2 => c.toString() === c2.toString()) === i
			);
			this.logService.info(`[SkillRegistry] unique candidates: ${uniqueCandidates.map(c => c.toString()).join(' | ')}`);

			// 不再 break —— 扫描所有存在的候选目录，避免漏掉错位安装的 skill
			let scannedAny = false;
			for (const builtinDir of uniqueCandidates) {
				this.logService.info(`[SkillRegistry] trying builtin dir: ${builtinDir.toString()}`);
				try {
					await this.fileService.stat(builtinDir);
					this.logService.info(`[SkillRegistry] stat OK, scanning builtin skills: ${builtinDir.toString()}`);
					await this._scanFolder(builtinDir, 'builtin');
					this.logService.info(`[SkillRegistry] after builtin scan (${builtinDir.toString()}): ${this._skills.size} skills`);
					scannedAny = true;
				} catch (e) {
					this.logService.info(`[SkillRegistry] builtin dir not found or scan failed: ${builtinDir.toString()}, error: ${e}`);
				}
			}
			if (!scannedAny) {
				this.logService.info(`[SkillRegistry] no builtin skills dir found. tried: ${uniqueCandidates.map(c => c.toString()).join(' | ')}`);
			}
		} catch (err) {
			this.logService.error('[SkillRegistry] builtin skills scan failed', err);
		}

		// 用户全局技能库（统一使用 ~/.vssaros/saros/ 路径，不扫描工作区）
		try {
			const userDataRoot = userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
			const userDir = resolveSarosPath(userDataRoot, SarosPath.skills);
			this.logService.info(`[SkillRegistry] scanning user skills: ${userDir.toString()}`);
			await this._scanFolder(userDir, 'user');
			this.logService.info(`[SkillRegistry] after user scan: ${this._skills.size} skills`);
		} catch (err) {
			this.logService.info('[SkillRegistry] user skills scan failed or dir not found', err);
		}

		// workflow → skill 双向打通（A 向）：把工作流注册为可执行 skill
		await this._loadWorkflowSkills();

		// 运行时注入的 skill 永远胜出
		for (const [id, skill] of this._runtimeSkills) {
			this._skills.set(id, skill);
		}
		if (this._runtimeSkills.size > 0) {
			this.logService.info(`[SkillRegistry] runtime skills merged: ${this._runtimeSkills.size}`);
		}

		this.logService.info(`[SkillRegistry] reload() complete: total ${this._skills.size} skills`);
		this._onDidChangeSkills.fire();

		// Fire a batch Synced event so external consumers (e.g. knot-agui) can
		// re-sync their local skill mirrors after any reload (install, uninstall,
		// filesystem changes, etc.).
		this._fireBatchSyncedEvent();
	}

	/**
	 * Fire a batch synced event with all current user skill IDs.
	 * This triggers external consumers (like knot-cli sync) to do a full
	 * reconciliation of their skill mirror directories.
	 *
	 * Note: Skills are now stored only in user global directory (~/.vssaros/saros/skills/),
	 * so we fire event with user skill IDs only.
	 */
	private _fireBatchSyncedEvent(): void {
		const userSkillIds = [...this._skills.values()]
			.filter(s => s.source === 'user' || s.source === 'marketplace')
			.map(s => s.id);

		if (userSkillIds.length === 0) { return; }

		// Use empty workspacePath to indicate this is a user-global event
		const payload: ISkillBatchLifecyclePayload = {
			workspacePath: '',
			agentId: '',
			skillIds: userSkillIds,
			timestamp: new Date().toISOString(),
		};

		void this.skillLifecycleService.fireBatchEvent(payload).catch(err => {
			this.logService.debug(`[SkillRegistry] batch synced event failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	// ─── 内部 ────────────────────────────────────────────────

	// _loadBuiltins() 已移除 - 技能现在从 skills/ 目录文件加载（参考 Hermes-Agent 模式）

	// ─── 技能子文件夹递归扫描（对齐 Hermes-Agent `os.walk` + `iter_skill_index_files`）────

	/**
	 * 递归扫描时永久跳过的目录名（对齐 Hermes-Agent `EXCLUDED_SKILL_DIRS`）。
	 * VCS、依赖缓存、构建产物 — 不包含技能文件。
	 */
	private static readonly EXCLUDED_SKILL_DIRS = new Set([
		'.git', '.github', '.hub', '.archive', '.venv', 'venv',
		'node_modules', 'site-packages', '__pycache__', '.tox',
		'.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
		'out', 'dist', 'build', '.vscode', '.codebuddy',
	]);

	/**
	 * 技能内部的辅助目录 — 当父目录已存在 SKILL.md 时跳过递扫。
	 * 对齐 Hermes-Agent `SKILL_SUPPORT_DIRS`。
	 * 这些目录包含渐进披露数据（references/templates/assets/scripts），不是独立技能。
	 */
	private static readonly SKILL_SUPPORT_DIRS = new Set([
		'references', 'templates', 'assets', 'scripts', 'tests',
	]);

	/**
	 * 递归扫描目录，发现所有嵌套子目录中的 SKILL.md 技能文件。
	 *
	 * 对齐 Hermes-Agent `iter_skill_index_files()` + `os.walk()`：
	 *   1. 从根目录递归遍历所有子目录
	 *   2. 每个目录查找 SKILL.md，找到则 parseSkill
	 *   3. 自动跳过 EXCLUDED_SKILL_DIRS 中的目录
	 *   4. 当遇到目录下有 SKILL.md 时，跳过其 SKILL_SUPPORT_DIRS 子目录
	 *   5. category 自动从相对路径提取：skills/code/review/SKILL.md → category "code"
	 *
	 * @param dir 根目录 URI
	 * @param source 来源标识（builtin / user）
	 * @param depth 当前递归深度（内部使用，外部不传）
	 * @param parentHasSkill 父目录是否已找到 SKILL.md（用于 support dirs 剪枝）
	 * @param relativePath 从根目录到当前 dir 的相对路径段（数组）
	 */
	private async _scanFolderRecursive(
		dir: URI,
		source: 'user' | 'builtin',
		depth: number = 0,
		parentHasSkill: boolean = false,
		relativePath: string[] = [],
	): Promise<number> {
		// 深度保护：最多 10 层（防御性编程）
		if (depth > 10) {
			this.logService.warn(`[SkillRegistry] _scanFolderRecursive: max depth reached at ${dir.toString()}`);
			return 0;
		}

		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			if (depth === 0) {
				this.logService.debug(`[SkillRegistry] _scanFolderRecursive: dir not found: ${dir.toString()}`);
			}
			return 0;
		}

		if (!stat.isDirectory || !stat.children) {
			return 0;
		}

		// ① 检查当前目录是否有 SKILL.md
		let thisDirHasSkill = false;
		const skillFile = URI.joinPath(dir, 'SKILL.md');
		try {
			const content = await this.fileService.readFile(skillFile);
			const text = content.value.toString();
			// 从路径提取 category（对齐 Hermes `_get_category_from_path`）
			// e.g. skills/code/review/ → category "code"
			if (!relativePath.length && depth === 0) {
				// 根目录本身有 SKILL.md（特殊：focal skill）
			}
			const parsedSkill = this._parseSkillFile(dir, text, source);
			if (parsedSkill) {
				// 自动从路径推断 category（如果 frontmatter 未显式设置）
				let skill = parsedSkill;
				if (!skill.category && relativePath.length > 0) {
					skill = { ...skill, category: relativePath[0] }; // 最顶层的子文件夹名作为 category
				}
				// 内置技能默认分类
				if (!skill.category && source === 'builtin') {
					skill = { ...skill, category: 'utility' };
				}
				// 索引支持目录文件（references/templates/assets/scripts），供模型按需读取（渐进披露）
				const supportFiles = await this._listSupportFiles(dir);
				if (supportFiles.length > 0) {
					skill = { ...skill, supportFiles };
				}
				if (this._skills.has(skill.id)) {
					const existing = this._skills.get(skill.id)!;
					this.logService.info(`[SkillRegistry] Skill "${skill.id}" overwritten: ${existing.source} → ${skill.source} (from ${dir.fsPath})`);
				}
				this._skills.set(skill.id, skill);
				thisDirHasSkill = true;
				this.logService.debug(`[SkillRegistry] _scanFolderRecursive: loaded skill "${skill.id}" (depth=${depth}, cat="${skill.category ?? '-'}", path="${relativePath.join('/')}")`);
			}
		} catch {
			// SKILL.md 不存在 — 继续往下扫描子目录
		}

		// ② 递归扫描子目录
		let loaded = thisDirHasSkill ? 1 : 0;
		for (const child of stat.children) {
			if (!child.isDirectory) { continue; }

			const dirName = child.name;
			// 跳过排除目录
			if (SkillRegistry.EXCLUDED_SKILL_DIRS.has(dirName)) { continue; }
			// 如果当前目录有 SKILL.md，跳过其 support 子目录
			if (thisDirHasSkill && SkillRegistry.SKILL_SUPPORT_DIRS.has(dirName)) { continue; }
			// 如果父目录有 SKILL.md 且当前是 support dir，跳过
			if (parentHasSkill && SkillRegistry.SKILL_SUPPORT_DIRS.has(dirName)) { continue; }

			loaded += await this._scanFolderRecursive(
				child.resource,
				source,
				depth + 1,
				thisDirHasSkill,
				depth === 0 ? [dirName] : [...relativePath, dirName],
			);
		}

		return loaded;
	}

	/**
	 * 旧版单层扫描方法（已废弃 — 内部委托给 _scanFolderRecursive）。
	 * 保留签名兼容性，行为已改为递归扫描。
	 */
	private async _scanFolder(dir: URI, source: 'user' | 'builtin'): Promise<void> {
		const loaded = await this._scanFolderRecursive(dir, source);
		this.logService.info(`[SkillRegistry] _scanFolder(${source}): loaded ${loaded} skills from ${dir.toString()} (recursive)`);
	}

	/**
	 * 列出技能目录下支持文件夹（references/templates/assets/scripts）中的文件，
	 * 返回相对技能根目录的路径列表（如 "references/api.md"、"scripts/tools/run.py"）。
	 * 对齐 Agent Skills 规范的渐进披露：支持目录内容在扫描时索引、按需读取。
	 */
	private async _listSupportFiles(skillDir: URI): Promise<string[]> {
		const files: string[] = [];
		const collect = async (dir: URI, prefix: string, depth: number): Promise<void> => {
			if (depth > 3) { return; } // 防御性深度限制
			let stat: IFileStat;
			try {
				stat = await this.fileService.resolve(dir);
			} catch {
				return; // 支持目录不存在 — 正常情况
			}
			if (!stat.isDirectory || !stat.children) { return; }
			for (const child of stat.children) {
				const rel = `${prefix}/${child.name}`;
				if (child.isDirectory) {
					await collect(child.resource, rel, depth + 1);
				} else {
					files.push(rel);
				}
			}
		};
		for (const dirName of SkillRegistry.SKILL_SUPPORT_DIRS) {
			await collect(URI.joinPath(skillDir, dirName), dirName, 0);
		}
		return files.sort();
	}

	private _parseSkillFile(folder: URI, text: string, source: 'user' | 'builtin'): ISkillDefinition | undefined {
		const { meta, body } = parseFrontmatter(text);
		let name = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : undefined;
		if (!name) {
			// SKILL.md 缺少 name 时回退到文件夹名：避免技能被静默丢弃，也消除告警噪声。
			const fallbackName = path.basename(folder.fsPath).trim();
			if (!fallbackName) {
				this.logService.warn(`[SkillRegistry] SKILL.md missing 'name' and folder name unusable: ${folder.toString()}`);
				return undefined;
			}
			this.logService.debug(`[SkillRegistry] SKILL.md missing 'name', falling back to folder name "${fallbackName}": ${folder.toString()}`);
			name = fallbackName;
		}
		const description = typeof meta.description === 'string' ? meta.description : '';
		const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').replace(/-+/g, '-');
		const prompt = body.trim();
		// 如果 SKILL.md frontmatter 含有 storeId，说明是商城下载的，标记为 marketplace
		const hasStoreId = typeof meta.storeId === 'string' && meta.storeId.length > 0;
		const effectiveSource = (hasStoreId && source === 'user') ? 'marketplace' : source;
		return {
			id,
			name,
			description,
			activation: normalizeActivation(meta.activation),
			match: asStringArray(meta.match),
			category: typeof meta.category === 'string' ? meta.category : undefined,
			recommendedTools: asStringArray(meta.recommended_tools) ?? asStringArray(meta.recommendedTools),
			prompt,
			source: effectiveSource,
			resource: folder,
			contentHash: computeSkillContentHash(prompt),
			enabled: true, // 默认启用
			version: typeof meta.version === 'string' ? meta.version : (source === 'builtin' ? '1.0.0' : undefined),
			storeId: typeof meta.storeId === 'string' ? meta.storeId : undefined,
			platforms: asStringArray(meta.platforms),
			tags: asStringArray(meta.tags),
			relatedSkills: asStringArray(meta.related_skills),
			author: typeof meta.author === 'string' ? meta.author : undefined,
			license: typeof meta.license === 'string' ? meta.license : undefined,
			allowedTools: asStringArray(meta.allowed_tools) ?? asStringArray(meta['allowed-tools']),
			model: typeof meta.model === 'string' ? meta.model : undefined,
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
			// allowed-tools（Agent Skills 规范）：prompt 级工具面约束
			skill.allowedTools && skill.allowedTools.length > 0
				? `\n**Tool restriction**: while following this skill, only use these tools: ${skill.allowedTools.join(', ')}. Do not use any other tools.`
				: '',
		].filter(Boolean).join('\n');
	}

	// ─── workflow → skill 双向打通（A 向）──────────────────────────────

	/**
	 * 把已存储的工作流注册为「可执行型 skill」。
	 *
	 * 设计要点：
	 * - id 直接复用 workflow.id，保证 `/skill <wf-id>` 与 workflow 一一对应。
	 * - activation 默认 'manual'：避免 auto/always 误触发重型多 agent 工作流。
	 * - executor 指向 workflow，ExecutionProvider 在触发时据其运行工作流而非注入文本。
	 * - contentHash 基于节点图 JSON 计算（workflow 无 SKILL.md 正文）。
	 *
	 * 注意：本方法是「注册视图」，仅把 workflow 暴露到 skill 列表，
	 * 不移动/复制任何文件；真正的执行逻辑在 P1（ExecutionProvider 改造）接入。
	 */
	private async _loadWorkflowSkills(): Promise<void> {
		try {
			// P4: 开关控制是否把工作流暴露为 skill（缓解暴露面过大风险）。
			// 默认开启；在 settings.json 设 sessions.agentStudio.skills.includeWorkflows=false 可关闭。
			const includeWorkflows = this.configurationService.getValue<boolean>(AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING);
			if (includeWorkflows === false) {
				this.logService.info('[SkillRegistry] workflow→skill bridge disabled by setting (agentStudio.skills.includeWorkflows=false), skipping');
				return;
			}
			const workflows = await this.workflowStorageService.listWorkflows();
			this.logService.info(`[SkillRegistry] loading ${workflows.length} workflow(s) as skills`);
			for (const wf of workflows) {
				const id = wf.id;
				const description = wf.description || wf.name;
				const prompt = wf.useGuide?.trim()
					|| wf.description?.trim()
					|| `This is a workflow skill. Executing it runs the workflow "${wf.name}".`;
				const skill: ISkillDefinition = {
					id,
					name: wf.name,
					description,
					activation: 'manual',
					prompt,
					source: 'workflow',
					workflowId: wf.id,
					executor: { kind: 'workflow', workflowId: wf.id } as ISkillExecutor,
					contentHash: this._computeWorkflowContentHash(wf),
					enabled: true,
					version: wf.version,
					category: wf.category || 'workflow',
				};
				this._skills.set(id, skill);
			}
		} catch (err) {
			this.logService.info('[SkillRegistry] workflow skills load failed', err);
		}
	}

	/**
	 * 基于工作流节点图生成内容指纹，用于跨重载去重/变更检测。
	 * workflow 无 SKILL.md 正文，故以 id/name/description/节点图作为指纹源。
	 */
	private _computeWorkflowContentHash(wf: IStoredWorkflow): string {
		const fingerprint = JSON.stringify({
			id: wf.id,
			name: wf.name,
			description: wf.description,
			nodes: wf.nodes ?? [],
			connections: wf.connections ?? [],
		});
		const h = stringHash(fingerprint, 0);
		return (h >>> 0).toString(16).padStart(8, '0');
	}
}
