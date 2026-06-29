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
 *   2. `_scanFolder(userHome)`   —— 用户全局技能库 `~/.saros/skills/`
 *   3. `registerSkill(...)`     —— 运行时由扩展通过 IAgentOSService 注入
 *
 * 后注册的同名 skill 覆盖前者（运行时注入 > 用户 > 内置），
 * 这与 hermes 的 `optional-skills` < `skills` < `~/.hermes/skills` 优先级一致。
 *
 * 架构说明：
 *   - 技能统一存储于用户全局技能库（`~/.saros/skills/`）和内置技能目录（`.agents/skills/`）
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
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { stringHash } from '../../../../base/common/hash.js';
import {
	ISkillRegistry, ISkillDefinition, ISkillActivationContext, ISkillInjection,
	SkillActivation,
} from '../common/skills.js';
import { ISkillLifecycleService, ISkillBatchLifecyclePayload } from '../common/skillLifecycle.js';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';

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
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this.logService.info('[SkillRegistry] constructor called');
		// 参考 Hermes-Agent 模式：技能从 skills/ 目录文件异步加载，不再同步硬编码
		// 立即填充已移除 — UI 将在异步扫描完成后可显示
		this.logService.info(`[SkillRegistry] no sync skills - will load async`);
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
		const userMsg = context.userMessage.toLowerCase();

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

			out.push({
				skill,
				// 与 hermes 一致：以独立 user message 注入，避免 system prompt 失效缓存。
				placement: skill.activation === 'always' ? 'system' : 'user',
				content: this._renderInjection(skill),
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

		// 用户全局技能库（统一使用 ~/.saros/ 路径，不扫描工作区）
		try {
			const userHome = await this.pathService.userHome();
			const userDir = URI.joinPath(userHome, '.saros', 'skills');
			this.logService.info(`[SkillRegistry] scanning user skills: ${userDir.toString()}`);
			await this._scanFolder(userDir, 'user');
			this.logService.info(`[SkillRegistry] after user scan: ${this._skills.size} skills`);
		} catch (err) {
			this.logService.info('[SkillRegistry] user skills scan failed or dir not found', err);
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
	 * Note: Skills are now stored only in user global directory (~/.saros/skills/),
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

	private async _scanFolder(dir: URI, source: 'user' | 'builtin'): Promise<void> {
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

		this.logService.debug(`[SkillRegistry] _scanFolder(${source}): scanning ${dir.toString()}, ${stat.children.length} children`);
		let loaded = 0;
		for (const child of stat.children) {
			if (!child.isDirectory) { continue; }
			const skillFile = URI.joinPath(child.resource, 'SKILL.md');
			this.logService.debug(`[SkillRegistry] _scanFolder: checking ${skillFile.toString()}`);
			try {
				const content = await this.fileService.readFile(skillFile);
				const text = content.value.toString();
				this.logService.debug(`[SkillRegistry] _scanFolder: read ${text.length} chars from ${skillFile.toString()}`);
				const skill = this._parseSkillFile(child.resource, text, source);
				if (skill) {
					if (this._skills.has(skill.id)) {
						const existing = this._skills.get(skill.id)!;
						this.logService.info(`[SkillRegistry] Skill "${skill.id}" overwritten: ${existing.source} → ${skill.source} (from ${child.resource.fsPath})`);
					}
					this._skills.set(skill.id, skill);
					loaded++;
					this.logService.debug(`[SkillRegistry] _scanFolder: loaded skill ${skill.id}`);
				} else {
					this.logService.warn(`[SkillRegistry] _scanFolder: parse returned null for ${skillFile.toString()}`);
				}
			} catch (e) {
				// SKILL.md 可缺失，忽略
				this.logService.debug(`[SkillRegistry] _scanFolder: readFile failed for ${skillFile.toString()}: ${e}`);
			}
		}
		this.logService.info(`[SkillRegistry] _scanFolder(${source}): loaded ${loaded} skills from ${dir.toString()}`);
	}

	private _parseSkillFile(folder: URI, text: string, source: 'user' | 'builtin'): ISkillDefinition | undefined {
		const { meta, body } = parseFrontmatter(text);
		const name = typeof meta.name === 'string' ? meta.name : undefined;
		if (!name) {
			this.logService.warn(`[SkillRegistry] SKILL.md missing 'name': ${folder.toString()}`);
			return undefined;
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
			version: typeof meta.version === 'string' ? meta.version : undefined,
			storeId: typeof meta.storeId === 'string' ? meta.storeId : undefined,
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
}
