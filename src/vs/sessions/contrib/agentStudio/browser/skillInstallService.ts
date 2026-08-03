/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 安装服务实现 —— 从 Hub 或本地文件安装 skill 到工作区。
 *
 * 安装目标目录（统一）：~/.vssaros/skills/<skillId>/SKILL.md —— 用户全局技能库，
 * 与 SkillRegistry 用户扫描目录、版本管理（.git）一致。
 *
 * 技能身份模型（复刻 Hermes-Agent，见 common/skillId.ts）：
 *   - id 解析单点真源：frontmatter 显式 `id` 合法时优先，否则从 name slug 派生；
 *   - 重复 id 一律拒绝导入（registry 占用 + 磁盘目标双重检查）；
 *   - 安装溯源记录于 ~/.vssaros/skills/.hub/lock.json（source/contentHash/时间戳）。
 *
 * 安装流程：
 *   1. 获取 SKILL.md 内容（从远程 URL 下载或读取本地文件）
 *   2. 解析 frontmatter 生成 skill ID
 *   3. 写入目标目录（不覆盖已有）
 *   4. 触发 ISkillRegistry.reload() 刷新
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ISkillRegistry, ISkillDefinition } from '../common/skills.js';
import { ISkillLifecycleService, SkillLifecycleEvent, ISkillLifecyclePayload } from '../common/skillLifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import {
	ISkillInstallService,
	ISkillHubDefinition,
	ISkillHubEntry,
	ISkillInstallResult,
	ISkillFolderUploadFile,
	ISkillInstallEvent,
	BUILTIN_SKILL_HUBS,
} from '../common/skillHubTypes.js';
import { ISkillVersionService, SkillVersionService } from './skillVersionService.js';
import { resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { isValidSkillId, resolveSkillId, slugifySkillId } from '../common/skillId.js';
import { parseGitSkillUrl, selectSkillRootFromPaths } from '../common/skillGitInstall.js';
import { gitCloneRepo, gitUnavailableReason, isGitAvailable } from './gitVersionCore.js';
import { stringHash } from '../../../../base/common/hash.js';

/** GitHub API 返回的目录条目 */
interface IGitHubTreeEntry {
	readonly path: string;
	readonly mode: string;
	readonly type: 'blob' | 'tree';
	readonly sha: string;
	readonly url?: string;
}

/** GitHub API 返回的目录列表 */
interface IGitHubTreeResponse {
	readonly tree: IGitHubTreeEntry[];
	readonly truncated: boolean;
}

/** 精简后的 Knot 商城条目（与 resources/.agents/knot-skills-market.json 一致） */
interface IKnotBundleItem {
	id: string;
	name: string;
	title: string;
	desc: string;
	creator: string;
	type: string;
	ver: string;
	dl: number;
	tags: string[];
}

export class SkillInstallService extends Disposable implements ISkillInstallService {
	declare readonly _serviceBrand: undefined;

	private readonly _hubs: ISkillHubDefinition[] = [...BUILTIN_SKILL_HUBS];
	private readonly _cachedEntries = new Map<string, ISkillHubEntry[]>();
	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries: Event<void> = this._onDidChangeEntries.event;

	private readonly _onDidInstallSkill = this._register(new Emitter<ISkillInstallEvent>());
	readonly onDidInstallSkill: Event<ISkillInstallEvent> = this._onDidInstallSkill.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ISkillVersionService private readonly skillVersionService: SkillVersionService,
	) {
		super();
	}

	getHubs(): readonly ISkillHubDefinition[] {
		return this._hubs;
	}

	getCachedEntries(hubId: string): readonly ISkillHubEntry[] {
		return this._cachedEntries.get(hubId) ?? [];
	}

	async fetchHubEntries(hubId: string): Promise<readonly ISkillHubEntry[]> {
		const hub = this._hubs.find(h => h.id === hubId);
		if (!hub) {
			return [];
		}

		try {
			let entries: ISkillHubEntry[];
			switch (hub.type) {
				case 'github':
					entries = await this._fetchGitHubEntries(hub);
					break;
				case 'url':
					entries = await this._fetchUrlEntries(hub);
					break;
				case 'local':
					entries = await this._fetchLocalEntries(hub);
					break;
				case 'knot-bundle':
					entries = await this._fetchKnotBundleEntries(hub);
					break;
				default:
					this.logService.warn(`[SkillInstall] Hub type '${hub.type}' not supported yet`);
					entries = [];
			}

			// 标记已安装状态
			const installed = this._getInstalledSkillIds();
			for (const entry of entries) {
				entry.installed = installed.has(entry.id);
			}

			// 仅在拿到非空结果时缓存，避免临时失败把 UI 永久卡在 "0 个技能"
			if (entries.length > 0) {
				this._cachedEntries.set(hubId, entries);
			} else {
				this._cachedEntries.delete(hubId);
				this.logService.warn(`[SkillInstall] hub '${hubId}' returned 0 entries (not cached)`);
			}
			this._onDidChangeEntries.fire();
			return entries;
		} catch (err) {
			this.logService.error(`[SkillInstall] Failed to fetch hub '${hubId}':`, err);
			return [];
		}
	}

	async refreshAll(): Promise<void> {
		this._cachedEntries.clear();
		const results = await Promise.allSettled(
			this._hubs.map(hub => this.fetchHubEntries(hub.id))
		);
		this.logService.info(`[SkillInstall] Refreshed ${results.length} hubs`);
		this._onDidChangeEntries.fire();
	}

	async installFromHub(hubId: string, entryId: string): Promise<ISkillInstallResult> {
		const entries = this._cachedEntries.get(hubId) ?? [];
		const entry = entries.find(e => e.id === entryId);
		if (!entry) {
			return { success: false, skillId: entryId, skillName: entryId, error: 'Entry not found in cache. Fetch hub first.' };
		}

		try {
			// Knot bundle 中的条目没有真实可下载的 SKILL.md —— 自动合成一个
			if (entry.contentUrl.startsWith('knot-bundle://')) {
				const synthesized = this._synthesizeKnotSkillMd(entry);
				return await this.installFromContent(synthesized);
			}
			// 下载 SKILL.md 内容
			const content = await this._fetchContent(entry.contentUrl);
			if (!content) {
				return { success: false, skillId: entryId, skillName: entry.name, error: 'Failed to download SKILL.md content' };
			}
			return await this.installFromContent(content);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId: entryId, skillName: entry.name, error: msg };
		}
	}

	async installFromFile(filePath: string): Promise<ISkillInstallResult> {
		try {
			const uri = URI.file(filePath);
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			return await this.installFromContent(text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId: '', skillName: '', error: `Failed to read file: ${msg}` };
		}
	}

	/**
	 * 从本地文件夹安装 skill：选中包含 SKILL.md 的文件夹，
	 * 整体复制到 `~/.vssaros/skills/<id>/`（过滤垃圾文件），并初始化 .git。
	 *
 * 与 installFromFile/installFromContent 的区别：
 *   - 后两者只复制单个 SKILL.md 内容（丢失 scripts/references 等配套文件）；
 *   - 本方法复制整个文件夹。三者目标目录一致：~/.vssaros/skills（用户技能库）。
 *
 * 目录约定：`resources/.agents/skills` 仅存放产品内置技能（registry 只读扫描），
 * 用户安装/创建的技能一律写入 `~/.vssaros/skills`，运行时不得写内置区。
	 */
		async installFromFolder(folderUri: URI): Promise<ISkillInstallResult> {
		try {
			// 1. 校验文件夹内有 SKILL.md
			const skillFile = URI.joinPath(folderUri, 'SKILL.md');
			if (!await this.fileService.exists(skillFile)) {
				return { success: false, skillId: '', skillName: '', error: '所选文件夹中没有 SKILL.md' };
			}
			// 2. 解析 frontmatter 获取 name
			const content = (await this.fileService.readFile(skillFile)).value.toString();
		const parsed = this._parseSkillMd(content);
		if (!parsed.name) {
			return { success: false, skillId: '', skillName: '', error: 'SKILL.md 缺少 frontmatter 的 name 字段' };
		}
		const skillId = this._resolveInstallSkillId(parsed);
		if (!skillId) {
			return { success: false, skillId: '', skillName: parsed.name, error: `无法从名称 "${parsed.name}" 生成有效技能 ID（需含小写字母/数字），请在 frontmatter 显式指定 id 字段` };
		}

		// 3. 目标目录：~/.vssaros/skills/<id>（与商城安装/版本管理一致）
		const targetDir = resolveSarosPath(this._getSarosRoot(), 'skills', skillId);
		// 重复 id 检查：已加载进 registry 或磁盘目标已存在 → 不允许导入
		if (this._isSkillIdTaken(skillId) || await this.fileService.exists(URI.joinPath(targetDir, 'SKILL.md'))) {
			return { success: false, skillId, skillName: parsed.name, error: `技能 ID "${skillId}" 已存在，无法重复导入` };
		}

		// 4. 整体复制文件夹（过滤 .git/__pycache__/*.pyc 等垃圾）
		await this._copyDirFiltered(folderUri, targetDir);
		await this._recordSkillInstall(skillId, 'folder', content);

			// 5. 初始化 .git（best-effort，不阻塞安装）
			try {
				await this.skillVersionService.init(skillId);
			} catch (gitErr) {
				this.logService.warn(`[SkillInstall] git init 失败（不影响安装）: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`);
			}

			this.logService.info(`[SkillInstall] Skill "${skillId}" 从文件夹安装到 ${targetDir.fsPath}`);
			await this.skillRegistry.reload();
			this._onDidInstallSkill.fire({ skillId, skillName: parsed.name });
		return { success: true, skillId, skillName: parsed.name };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId: '', skillName: '', error: msg };
		}
	}

	/**
	 * 从 webkitdirectory 上传的文件列表安装 skill。
	 * 与 installFromFolder 逻辑一致，但输入为内存中的文件内容（不依赖原生对话框/IPC，沙箱安全）。
	 */
		async installFromFolderUpload(files: readonly ISkillFolderUploadFile[]): Promise<ISkillInstallResult> {
		try {
			if (files.length === 0) {
				return { success: false, skillId: '', skillName: '', error: '未选择任何文件' };
			}
			// 过滤垃圾文件/目录（.git/__pycache__/*.pyc 等，按路径段判断）
			const kept: { segments: string[]; data: Uint8Array }[] = [];
			for (const f of files) {
				const segments = f.relativePath.split('/').filter(s => s.length > 0);
				if (segments.length === 0) { continue; }
				if (segments.some(s => this._isJunkEntry(s))) { continue; }
				kept.push({ segments, data: f.data });
			}
			// 校验根目录有 SKILL.md
			const skillMd = kept.find(k => k.segments.length === 1 && k.segments[0].toLowerCase() === 'skill.md');
			if (!skillMd) {
				return { success: false, skillId: '', skillName: '', error: '所选文件夹中没有 SKILL.md' };
			}
		const parsed = this._parseSkillMd(VSBuffer.wrap(skillMd.data).toString());
		if (!parsed.name) {
			return { success: false, skillId: '', skillName: '', error: 'SKILL.md 缺少 frontmatter 的 name 字段' };
		}
		const skillId = this._resolveInstallSkillId(parsed);
		if (!skillId) {
			return { success: false, skillId: '', skillName: parsed.name, error: `无法从名称 "${parsed.name}" 生成有效技能 ID（需含小写字母/数字），请在 frontmatter 显式指定 id 字段` };
		}

		const targetDir = resolveSarosPath(this._getSarosRoot(), 'skills', skillId);
			// 重复 id 检查：已加载进 registry 或磁盘目标已存在 → 不允许导入
			if (this._isSkillIdTaken(skillId) || await this.fileService.exists(URI.joinPath(targetDir, 'SKILL.md'))) {
				return { success: false, skillId, skillName: parsed.name, error: `技能 ID "${skillId}" 已存在，无法重复导入` };
			}

		await this.fileService.createFolder(targetDir);
		for (const k of kept) {
			if (k.segments.length > 1) {
				await this.fileService.createFolder(URI.joinPath(targetDir, ...k.segments.slice(0, -1)));
			}
			await this.fileService.writeFile(URI.joinPath(targetDir, ...k.segments), VSBuffer.wrap(k.data));
		}
		await this._recordSkillInstall(skillId, 'folder-upload', VSBuffer.wrap(skillMd.data).toString());

			// 初始化 .git（best-effort，不阻塞安装）
			try {
				await this.skillVersionService.init(skillId);
			} catch (gitErr) {
				this.logService.warn(`[SkillInstall] git init 失败（不影响安装）: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`);
			}

			this.logService.info(`[SkillInstall] Skill "${skillId}" 从文件夹上传安装到 ${targetDir.fsPath}（${kept.length} 个文件）`);
			await this.skillRegistry.reload();
			this._onDidInstallSkill.fire({ skillId, skillName: parsed.name });
		return { success: true, skillId, skillName: parsed.name };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId: '', skillName: '', error: msg };
		}
	}

	/**
	 * 从 git 仓库安装技能：浅克隆（主进程 isomorphic-git，经 IPC）→ 定位 SKILL.md → 复制到 ~/.vssaros/skills/<id>。
	 * URL 解析与技能目录选择是纯逻辑（common/skillGitInstall.ts），便于单测。
	 */
	async installFromGit(rawUrl: string): Promise<ISkillInstallResult> {
		const parsedUrl = parseGitSkillUrl(rawUrl);
		if (!parsedUrl.ok) {
			return { success: false, skillId: '', skillName: '', error: parsedUrl.error };
		}
		if (!isGitAvailable(this.logService)) {
			return { success: false, skillId: '', skillName: '', error: `Git 不可用：${gitUnavailableReason() ?? '未知原因'}` };
		}

		// 克隆到暂存区（.hub 下，registry 扫描已排除 .hub）
		const stagingDir = URI.joinPath(resolveSarosPath(this._getSarosRoot(), 'skills'), '.hub', 'clone-staging', `${Date.now()}`);
		try {
			await gitCloneRepo(stagingDir.fsPath, parsedUrl.value.cloneUrl);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.fileService.del(stagingDir, { recursive: true }).catch(() => undefined);
			return { success: false, skillId: '', skillName: '', error: `克隆失败：${msg}` };
		}

		try {
			// 收集仓库内所有 SKILL.md（限深 4，跳过垃圾/隐藏目录）
			const skillMds: string[] = [];
			await this._collectSkillMds(stagingDir, stagingDir, skillMds, 0);
			const selection = selectSkillRootFromPaths(skillMds, parsedUrl.value.subdir);
			if (!selection.ok) {
				return { success: false, skillId: '', skillName: '', error: selection.error };
			}

			const skillDir = selection.dir === '.' ? stagingDir : URI.joinPath(stagingDir, ...selection.dir.split('/'));
			const skillFile = URI.joinPath(skillDir, 'SKILL.md');
			const content = (await this.fileService.readFile(skillFile)).value.toString();
			const parsed = this._parseSkillMd(content);
			if (!parsed.name) {
				return { success: false, skillId: '', skillName: '', error: 'SKILL.md 缺少 frontmatter 的 name 字段' };
			}
			const skillId = this._resolveInstallSkillId(parsed);
			if (!skillId) {
				return { success: false, skillId: '', skillName: parsed.name, error: `无法从名称 "${parsed.name}" 生成有效技能 ID（需含小写字母/数字），请在 frontmatter 显式指定 id 字段` };
			}

			const targetDir = resolveSarosPath(this._getSarosRoot(), 'skills', skillId);
			// 重复 id 检查：已加载进 registry 或磁盘目标已存在 → 不允许导入
			if (this._isSkillIdTaken(skillId) || await this.fileService.exists(URI.joinPath(targetDir, 'SKILL.md'))) {
				return { success: false, skillId, skillName: parsed.name, error: `技能 ID "${skillId}" 已存在，无法重复导入` };
			}

			await this._copyDirFiltered(skillDir, targetDir);
			await this._recordSkillInstall(skillId, 'git', content);

			// 初始化 .git（best-effort，不阻塞安装）
			try {
				await this.skillVersionService.init(skillId);
			} catch (gitErr) {
				this.logService.warn(`[SkillInstall] git init 失败（不影响安装）: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`);
			}

			this.logService.info(`[SkillInstall] Skill "${skillId}" 从 git 安装到 ${targetDir.fsPath}（${parsedUrl.value.cloneUrl}）`);
			await this.skillRegistry.reload();
			this._onDidInstallSkill.fire({ skillId, skillName: parsed.name });
			return { success: true, skillId, skillName: parsed.name };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId: '', skillName: '', error: msg };
		} finally {
			// 清理暂存区（best-effort）
			await this.fileService.del(stagingDir, { recursive: true }).catch(() => undefined);
		}
	}

	/** 递归收集目录下所有 SKILL.md 的相对路径（POSIX，相对 root；限深 4，跳过垃圾/隐藏目录） */
	private async _collectSkillMds(root: URI, dir: URI, out: string[], depth: number): Promise<void> {
		if (depth > 4) { return; }
		let stat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			return;
		}
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				if (this._isJunkEntry(child.name) || child.name.startsWith('.')) { continue; }
				await this._collectSkillMds(root, child.resource, out, depth + 1);
			} else if (child.name.toLowerCase() === 'skill.md') {
				out.push(path.relative(root.fsPath, child.resource.fsPath).replace(/\\/g, '/'));
			}
		}
	}

	/** 递归复制目录，跳过垃圾文件/目录（.git/__pycache__/*.pyc/node_modules 等） */
	private async _copyDirFiltered(src: URI, dest: URI): Promise<void> {
		await this.fileService.createFolder(dest);
		const stat = await this.fileService.resolve(src);
		for (const child of stat.children ?? []) {
			if (this._isJunkEntry(child.name)) { continue; }
			const childDest = URI.joinPath(dest, child.name);
			if (child.isDirectory) {
				await this._copyDirFiltered(child.resource, childDest);
			} else {
				const data = await this.fileService.readFile(child.resource);
				await this.fileService.writeFile(childDest, data.value);
			}
		}
	}

	/** 判定是否为应过滤的垃圾文件/目录名 */
	private _isJunkEntry(name: string): boolean {
		const lower = name.toLowerCase();
		if (['.git', '.svn', '.hg', '__pycache__', 'node_modules', '.ds_store', 'thumbs.db'].includes(lower)) { return true; }
		if (lower.endsWith('.pyc') || lower.endsWith('.pyo')) { return true; }
		return false;
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}

	async installFromContent(content: string): Promise<ISkillInstallResult> {
	// 解析 frontmatter 获取 name（id 解析走单点真源：显式 id 优先，否则 name slug）
	const parsed = this._parseSkillMd(content);
	if (!parsed.name) {
		return { success: false, skillId: '', skillName: '', error: 'SKILL.md must have a "name" field in frontmatter' };
	}

	const skillId = this._resolveInstallSkillId(parsed);
	if (!skillId) {
		return { success: false, skillId: '', skillName: parsed.name, error: `无法从名称 "${parsed.name}" 生成有效技能 ID（需含小写字母/数字），请在 frontmatter 显式指定 id 字段` };
	}

	// 目标目录与文件夹导入/版本管理一致：~/.vssaros/skills/<id>
	// （历史实现写到内置 resources/.agents/skills 是错位——会污染产品内置区且与卸载/版本管理路径不一致）
	const targetDir = resolveSarosPath(this._getSarosRoot(), 'skills', skillId);
	const targetFile = URI.joinPath(targetDir, 'SKILL.md');

	// 重复 id 检查：已加载进 registry 或磁盘目标已存在 → 不允许导入
	if (this._isSkillIdTaken(skillId) || await this.fileService.exists(targetFile)) {
		return { success: false, skillId, skillName: parsed.name, error: `技能 ID "${skillId}" 已存在，无法重复导入` };
	}

	// 创建目录并写入
	await this.fileService.createFolder(targetDir);
	await this.fileService.writeFile(targetFile, VSBuffer.fromString(content));
	await this._recordSkillInstall(skillId, 'content', content);

	this.logService.info(`[SkillInstall] Skill "${skillId}" installed to ${targetDir.toString()}`);

	// 刷新 registry
	await this.skillRegistry.reload();

	this._onDidInstallSkill.fire({ skillId, skillName: parsed.name });
	return { success: true, skillId, skillName: parsed.name };
}

	async uninstallSkill(skillId: string): Promise<boolean> {
		const skill = this.skillRegistry.getSkill(skillId);
		if (!skill) {
			return false;
		}

		// 内置技能不可卸载
		if (skill.source === 'builtin') {
			this.logService.warn(`[SkillInstall] uninstallSkill("${skillId}"): rejected — builtin skill is read-only`);
			throw new Error(`内置技能 "${skillId}" 不允许卸载。`);
		}

		if (!skill.resource) {
			return false;
		}

		try {
			// 删除 skill 目录
			const skillFile = URI.joinPath(skill.resource, 'SKILL.md');
			if (await this.fileService.exists(skillFile)) {
				await this.fileService.del(skillFile, { recursive: false });
			}
			// 尝试删除空目录
			try {
				await this.fileService.del(skill.resource, { recursive: true });
			} catch {
				// 目录可能非空，忽略
			}

		this.logService.info(`[SkillInstall] Skill "${skillId}" uninstalled`);
		await this._removeSkillLockEntry(skillId);
		await this.skillRegistry.reload();

			// Fire skill-removed lifecycle event so external consumers (e.g. knot-cli sync)
			// can remove stale entries from their own skill directories.
			const workspacePath = this._getFirstWorkspacePath();
			if (workspacePath) {
				const payload: ISkillLifecyclePayload = {
					workspacePath,
					agentId: '',
					skillId,
					skillName: skill.name,
					timestamp: new Date().toISOString(),
				};
				void this.skillLifecycleService.fireSkillEvent(SkillLifecycleEvent.Removed, payload).catch(err => {
					this.logService.debug(`[SkillInstall] lifecycle Removed event failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
				});
			}

			return true;
		} catch (err) {
			this.logService.error(`[SkillInstall] Failed to uninstall skill "${skillId}":`, err);
			return false;
		}
	}

	async renameSkill(skillId: string, newName: string, newId?: string): Promise<ISkillInstallResult> {
		try {
			const skill = this.skillRegistry.getSkill(skillId);
			if (!skill) {
				return { success: false, skillId, skillName: '', error: `Skill "${skillId}" 不存在` };
			}
			if (!skill.resource) {
				return { success: false, skillId, skillName: '', error: '无法获取 skill 目录路径' };
			}

			const trimmed = newName.trim();
			if (trimmed.length === 0 || trimmed.length > 120) {
				return { success: false, skillId, skillName: '', error: '名称长度必须在 1-120 个字符之间' };
			}

			// id 解析（单点真源 common/skillId.ts）：显式 newId 优先（须合法），否则按 name slug 化
			const explicitId = newId?.trim().toLowerCase();
			let newSkillId: string;
			if (explicitId) {
				if (!isValidSkillId(explicitId)) {
					return { success: false, skillId, skillName: trimmed, error: `Slug "${explicitId}" 不合法：须以小写字母开头，仅含小写字母/数字/-/_` };
				}
				newSkillId = explicitId;
			} else {
				newSkillId = slugifySkillId(trimmed);
				if (!newSkillId) {
					return { success: false, skillId, skillName: trimmed, error: `无法从名称 "${trimmed}" 生成有效技能 ID（需含小写字母/数字），请显式指定 slug` };
				}
			}

			// id 未变：仅更新显示名（并同步 frontmatter，修复历史上此处不落盘导致改名丢失的问题）
			if (newSkillId === skillId) {
				await this._updateSkillMdIdentity(URI.joinPath(skill.resource, 'SKILL.md'), trimmed, explicitId, newSkillId);
				this.logService.info(`[SkillInstall] Skill "${skillId}" display name updated to "${trimmed}"`);
				await this.skillRegistry.reload();
				return { success: true, skillId, skillName: trimmed };
			}

			// 重复 id 检查：registry 已占用或磁盘目标已存在 → 不允许改名覆盖
			const targetDir = resolveSarosPath(this._getSarosRoot(), 'skills', newSkillId);
			if (this._isSkillIdTaken(newSkillId) || await this.fileService.exists(targetDir)) {
				return { success: false, skillId, skillName: trimmed, error: `目标 slug "${newSkillId}" 已存在` };
			}

			// 移动目录（Windows 下目录被 AV/资源管理器/句柄占用时 rename 会 EPERM，带重试+复制删除兜底）
			await this._moveDirWithFallback(skill.resource, targetDir);

			// 更新 SKILL.md frontmatter（name + id 权威键对齐）
			await this._updateSkillMdIdentity(URI.joinPath(targetDir, 'SKILL.md'), trimmed, explicitId, newSkillId);

			this.logService.info(`[SkillInstall] Skill "${skillId}" renamed to "${newSkillId}" ("${trimmed}")`);
			await this._renameSkillLockEntry(skillId, newSkillId);
			await this.skillRegistry.reload();

			return { success: true, skillId: newSkillId, skillName: trimmed };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, skillId, skillName: '', error: msg };
		}
	}

	async setSkillVersion(skillId: string, version: string): Promise<boolean> {
		try {
			const skill = this.skillRegistry.getSkill(skillId);
			if (!skill?.resource) {
				return false;
			}
			const skillMdUri = URI.joinPath(skill.resource, 'SKILL.md');
			if (!await this.fileService.exists(skillMdUri)) {
				return false;
			}
			let content = (await this.fileService.readFile(skillMdUri)).value.toString();
			if (/^\s*version\s*:.*$/m.test(content)) {
				content = content.replace(/^(\s*version\s*:\s*).*$/m, (_m, p1: string) => `${p1}${version}`);
			} else if (/^\s*name\s*:.*$/m.test(content)) {
				// 无 version 行 → 插到 name 行之后，保持 frontmatter 可读性
				content = content.replace(/^(\s*name\s*:.*)$/m, (m0: string) => `${m0}\nversion: ${version}`);
			} else {
				content = content.replace(/^---\r?\n/, (m0: string) => `${m0}version: ${version}\n`);
			}
			await this.fileService.writeFile(skillMdUri, VSBuffer.fromString(content));
			await this.skillRegistry.reload();
			return true;
		} catch (err) {
			this.logService.warn(`[SkillInstall] setSkillVersion 失败: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * 更新 SKILL.md frontmatter 的 name 与 id 字段（对齐 Hermes identifier 语义）：
	 *  - name：替换为新显示名（保留原引号风格，函数式替换避免 `$` 被当反向引用）；
	 *  - id：显式指定时写入/更新为权威键；未指定时移除旧 `id:` 行，
	 *    保持「目录名 ≡ registry 派生 id」不变式，防止显式 id 残留导致加载 id 漂移。
	 */
	private async _updateSkillMdIdentity(skillMdUri: URI, name: string, explicitId: string | undefined, resolvedId: string): Promise<void> {
		if (!await this.fileService.exists(skillMdUri)) {
			return;
		}
		let content = (await this.fileService.readFile(skillMdUri)).value.toString();
		content = content.replace(
			/^(\s*name\s*:\s*)(['"]?)(.*)\2\s*$/m,
			(_m, p1: string, q: string) => `${p1}${q}${name}${q}`
		);
		if (explicitId) {
			if (/^\s*id\s*:.*$/m.test(content)) {
				content = content.replace(/^(\s*id\s*:\s*).*$/m, (_m, p1: string) => `${p1}${resolvedId}`);
			} else if (/^\s*name\s*:.*$/m.test(content)) {
				// 插到 name 行之后，保持 frontmatter 可读性
				content = content.replace(/^(\s*name\s*:.*)$/m, (m0: string) => `${m0}\nid: ${resolvedId}`);
			} else {
				content = content.replace(/^---\r?\n/, (m0: string) => `${m0}id: ${resolvedId}\n`);
			}
		} else {
			content = content.replace(/^[ \t]*id[ \t]*:[^\r\n]*(\r?\n|$)/m, '');
		}
		await this.fileService.writeFile(skillMdUri, VSBuffer.fromString(content));
	}

	/**
	 * Windows 下 `rename` 目录在源目录存在打开句柄（AV/Defender 实时扫描、资源管理器
	 * 预览、`.git` 占用等）时会抛 EPERM/EACCES/EBUSY。处理策略：
	 * 1. 先短暂退避重试 `move`，吸收瞬时锁；
	 * 2. 仍失败则回退为「复制 + 删除」——逐文件复制不依赖源目录句柄可重命名，规避该限制。
	 */
	private async _moveDirWithFallback(source: URI, target: URI): Promise<void> {
		const isRetryable = (err: unknown): boolean => {
			const msg = err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err);
			return /EPERM|EACCES|EBUSY|ENOTEMPTY|access|denied|locked|busy/i.test(msg);
		};

		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.fileService.move(source, target);
				return;
			} catch (err) {
				lastErr = err;
				if (!isRetryable(err)) {
					throw err;
				}
				// 150/300ms 退避，等待瞬时锁释放
				await new Promise<void>(resolve => setTimeout(resolve, 150 * (attempt + 1)));
			}
		}

		this.logService.warn(`[SkillInstall] rename EPERM after retries, fallback to copy+delete: ${source.toString()} -> ${target.toString()}`);
		try {
			await this.fileService.copy(source, target);
			await this.fileService.del(source, { recursive: true });
		} catch (err) {
			// 兜底也失败时抛原始 move 错误，便于定位真实锁源
			throw lastErr ?? err;
		}
	}

	/** 导入/安装前判断技能 id 是否已被占用（命中则不允许导入）：
	 *  - 已加载进 SkillRegistry（含大小写不敏感兜底），或
	 *  - 磁盘目标目录已存在 SKILL.md。
	 *  防止重复 id 覆盖既有技能。 */
	private _isSkillIdTaken(skillId: string): boolean {
		if (this.skillRegistry.getSkill(skillId)) {
			return true;
		}
		const lower = skillId.toLowerCase();
		if (this.skillRegistry.getSkills().some((s: ISkillDefinition) => s.id.toLowerCase() === lower)) {
			return true;
		}
		return false;
	}

	isInstalled(skillId: string): boolean {
		return this._getInstalledSkillIds().has(skillId);
	}

	// ─── 内部 ────────────────────────────────────────────────

	private _getFirstWorkspacePath(): string | undefined {
		const folders = this.workspaceService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	private _getInstalledSkillIds(): Set<string> {
		return new Set(this.skillRegistry.getSkills().map((s: ISkillDefinition) => s.id));
	}

	/**
	 * 从内置 JSON 文件读取 Knot 商城条目。
	 * 数据文件：resources/.agents/knot-skills-market.json
	 * 兼容多种运行环境（开发/打包、桌面/浏览器），使用与 SkillRegistryService 一致的多候选路径策略。
	 */
	private async _fetchKnotBundleEntries(hub: ISkillHubDefinition): Promise<ISkillHubEntry[]> {
		const candidates: URI[] = [];

		// 候选1（最稳）：FileAccess.asFileUri —— 与 SkillRegistry 内置扫描路径对齐
		try {
			const uri1 = FileAccess.asFileUri('vs/../../resources/.agents/knot-skills-market.json');
			candidates.push(uri1);
		} catch (e) {
			this.logService.info(`[SkillInstall] knot-bundle: candidate1 failed: ${e}`);
		}

		// 候选2：appRoot 直接拼 resources（Electron dev 模式 appRoot ≡ projectRoot）
		try {
			const appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
			this.logService.info(`[SkillInstall] knot-bundle: appRoot=${appRoot ?? 'undefined'}`);
			if (appRoot) {
				const uri2 = URI.joinPath(URI.file(appRoot), 'resources', '.agents', 'knot-skills-market.json');
				if (!candidates.some(c => c.toString() === uri2.toString())) {
					candidates.push(uri2);
				}
			}
		} catch (e) {
			this.logService.info(`[SkillInstall] knot-bundle: candidate2 failed: ${e}`);
		}

		// 候选3：打包模式下 appRoot 可能是 out/ 子目录，往上一级
		try {
			const appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
			if (appRoot) {
				const projectRoot = path.dirname(appRoot);
				const uri3 = URI.joinPath(URI.file(projectRoot), 'resources', '.agents', 'knot-skills-market.json');
				if (!candidates.some(c => c.toString() === uri3.toString())) {
					candidates.push(uri3);
				}
			}
		} catch (e) {
			this.logService.info(`[SkillInstall] knot-bundle: candidate3 failed: ${e}`);
		}

		// 去重
		const unique = candidates.filter((c, i, arr) =>
			arr.findIndex(c2 => c.toString() === c2.toString()) === i
		);
		this.logService.info(`[SkillInstall] knot-bundle: candidates=${unique.map(c => c.toString()).join(' | ')}`);

		for (const dataFile of unique) {
			try {
				if (!(await this.fileService.exists(dataFile))) {
					this.logService.info(`[SkillInstall] knot-bundle: not found ${dataFile.toString()}`);
					continue;
				}
				const content = await this.fileService.readFile(dataFile);
				const text = content.value.toString();
				const items: IKnotBundleItem[] = JSON.parse(text);
				if (!Array.isArray(items)) {
					this.logService.warn(`[SkillInstall] knot-bundle: not an array (${dataFile.toString()})`);
					continue;
				}
				this.logService.info(`[SkillInstall] knot-bundle: loaded ${items.length} entries from ${dataFile.toString()}`);
				return items.map(it => ({
					id: it.name || it.id,
					name: it.title || it.name || it.id,
					description: it.desc ?? '',
					category: (it.tags && it.tags.length > 0) ? it.tags[0] : undefined,
					hubId: hub.id,
					// 占位 contentUrl —— installFromHub 检测到 knot-bundle:// 前缀走合成路径
					contentUrl: `knot-bundle://${it.id}`,
					author: it.creator,
					version: it.ver,
					downloadCount: it.dl,
					tags: it.tags,
				}));
			} catch (err) {
				this.logService.warn(`[SkillInstall] knot-bundle: read failed ${dataFile.toString()}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		this.logService.error('[SkillInstall] knot-bundle: no readable data file found in any candidate');
		return [];
	}

	/**
	 * 为 Knot Bundle 条目合成最小可用的 SKILL.md（因为商城 zip 包不直接暴露 SKILL.md 文本）。
	 */
	private _synthesizeKnotSkillMd(entry: ISkillHubEntry): string {
		// frontmatter `name` 是用户在技能列表里看到的显示名 —— 必须用 entry.name（对齐商城展示），
		// 而不是 entry.id（id 是去重用的全局唯一标识，例：galeqin-1772594770）。
		// id 单独通过 `source_id` 字段保留，便于溯源。
		const sourceId = entry.id.replace(/[^A-Za-z0-9_-]/g, '-');
		const displayName = (entry.name ?? entry.id).trim() || sourceId;
		const desc = (entry.description ?? '').replace(/\r?\n/g, ' ').trim();
		const tags = (entry.tags ?? []).map(t => t.trim()).filter(Boolean);
		const lines = [
			'---',
			`name: ${JSON.stringify(displayName)}`,
			`description: ${JSON.stringify(desc || displayName)}`,
			'activation: manual',
		];
		if (tags.length > 0) {
			lines.push(`category: ${tags[0]}`);
		}
		if (entry.author) {
			lines.push(`author: ${entry.author}`);
		}
		if (entry.version) {
			lines.push(`version: ${entry.version}`);
		}
		lines.push('source: knot-market');
		lines.push(`source_id: ${sourceId}`);
		lines.push('---');
		lines.push('');
		lines.push(`# ${entry.name}`);
		lines.push('');
		if (desc) {
			lines.push(desc);
			lines.push('');
		}
		lines.push(`> 此技能由 Knot 技能商城导入。使用前请到 Knot 平台 (https://knot.woa.com/skill/detail/${entry.id}) 阅读完整文档。`);
		return lines.join('\n');
	}

	private async _fetchGitHubEntries(hub: ISkillHubDefinition): Promise<ISkillHubEntry[]> {
		// 解析 owner/repo
		const repoSlug = this._parseGitHubSlug(hub.url);
		if (!repoSlug) {
			this.logService.warn(`[SkillInstall] Invalid GitHub URL: ${hub.url}`);
			return [];
		}

		const branch = hub.branch ?? 'main';
		const skillsPath = hub.skillsPath ?? '/';

		// 使用 GitHub Git Trees API 获取目录列表
		const treeUrl = `https://api.github.com/repos/${repoSlug}/git/trees/${branch}${skillsPath === '/' ? '' : ':' + skillsPath.replace(/^\//, '')}?recursive=1`;

		const response = await this.requestService.request({
			type: 'GET',
			url: treeUrl,
			callSite: 'skillInstallService.fetchGitHubEntries',
		}, CancellationToken.None);

		const text = await asText(response);
		if (!text) {
			return [];
		}

		let data: IGitHubTreeResponse;
		try {
			data = JSON.parse(text);
		} catch {
			return [];
		}

		const entries: ISkillHubEntry[] = [];
		const basePath = skillsPath === '/' ? '' : skillsPath.replace(/^\//, '');

		for (const item of data.tree) {
			// 只看 SKILL.md 文件
			if (item.type !== 'blob' || !item.path.endsWith('SKILL.md')) {
				continue;
			}

			// 路径: skills/<id>/SKILL.md 或 <id>/SKILL.md
			const relativePath = basePath ? item.path.slice(basePath.length + 1) : item.path;
			const parts = relativePath.split('/');
			// 期望格式: <skillDir>/SKILL.md
			if (parts.length < 2 || parts[parts.length - 1] !== 'SKILL.md') {
				continue;
			}

			const dirName = parts[0];
			const rawUrl = `https://raw.githubusercontent.com/${repoSlug}/${branch}/${basePath ? basePath + '/' : ''}${relativePath}`;

			// 从目录名生成默认名称
			const name = dirName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

			entries.push({
				id: dirName,
				name,
				description: `Skill from ${hub.name}`,
				hubId: hub.id,
				contentUrl: rawUrl,
			});
		}

		// 尝试获取每个 SKILL.md 的 frontmatter 以填充 name/description
		// 为避免过多请求，仅获取前 20 个
		const toFetch = entries.slice(0, 20);
		await Promise.allSettled(toFetch.map(async (entry) => {
			try {
				const content = await this._fetchContent(entry.contentUrl);
				if (content) {
				const parsed = this._parseSkillMd(content);
				if (parsed.name) {
					(entry as { name: string }).name = parsed.name;
					(entry as { id: string }).id = resolveSkillId(parsed.id, parsed.name) || entry.id;
				}
					if (parsed.description) {
						(entry as { description: string }).description = parsed.description;
					}
					if (parsed.category) {
						(entry as { category: string }).category = parsed.category;
					}
					if (parsed.activation) {
						(entry as { activation: string }).activation = parsed.activation;
					}
				}
			} catch {
				// 忽略单个获取失败
			}
		}));

		return entries;
	}

	private async _fetchUrlEntries(hub: ISkillHubDefinition): Promise<ISkillHubEntry[]> {
		try {
			const response = await this.requestService.request({
				type: 'GET',
				url: hub.url,
				callSite: 'skillInstallService.fetchUrlEntries',
			}, CancellationToken.None);
			const text = await asText(response);
			if (!text) {
				return [];
			}
			const data = JSON.parse(text);
			// 期望格式: Array<{ name, description, url, category? }>
			if (!Array.isArray(data)) {
				return [];
			}
			return data.map((item: any) => ({
				id: resolveSkillId(typeof item.id === 'string' ? item.id : undefined, item.name ?? item.id ?? ''),
				name: item.name ?? item.id ?? '',
				description: item.description ?? '',
				category: item.category,
				activation: item.activation,
				hubId: hub.id,
				contentUrl: item.url ?? item.contentUrl ?? '',
			})).filter((e: ISkillHubEntry) => e.id && e.contentUrl);
		} catch {
			return [];
		}
	}

	private async _fetchLocalEntries(hub: ISkillHubDefinition): Promise<ISkillHubEntry[]> {
		try {
			const dir = URI.file(hub.url);
			const stat = await this.fileService.resolve(dir);
			if (!stat.isDirectory || !stat.children) {
				return [];
			}

			const entries: ISkillHubEntry[] = [];
			for (const child of stat.children) {
				if (!child.isDirectory) {
					continue;
				}
				const skillFile = URI.joinPath(child.resource, 'SKILL.md');
				try {
					const content = await this.fileService.readFile(skillFile);
					const text = content.value.toString();
					const parsed = this._parseSkillMd(text);
					const name = parsed.name ?? child.name;
					entries.push({
						id: resolveSkillId(parsed.id, name),
						name,
						description: parsed.description ?? '',
						category: parsed.category,
						activation: parsed.activation,
						hubId: hub.id,
						contentUrl: skillFile.toString(),
					});
				} catch {
					// SKILL.md not found, skip
				}
			}
			return entries;
		} catch {
			return [];
		}
	}

	private async _fetchContent(url: string): Promise<string | undefined> {
		try {
			// 判断是本地路径还是远程 URL
			if (url.startsWith('file://') || url.startsWith('vscode-file://') || (!url.startsWith('http://') && !url.startsWith('https://'))) {
				const uri = URI.parse(url);
				const content = await this.fileService.readFile(uri);
				return content.value.toString();
			}

			const response = await this.requestService.request({
				type: 'GET',
				url,
				callSite: 'skillInstallService.fetchContent',
			}, CancellationToken.None);
			const text = await asText(response);
			return text ?? undefined;
		} catch (err) {
			this.logService.warn(`[SkillInstall] Failed to fetch content from ${url}:`, err);
			return undefined;
		}
	}

	private _parseGitHubSlug(url: string): string | undefined {
		// 支持 "owner/repo" 或 "https://github.com/owner/repo"
		const shortMatch = /^([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)$/.exec(url);
		if (shortMatch) {
			return shortMatch[1];
		}
		const fullMatch = /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/.exec(url);
		if (fullMatch) {
			return fullMatch[1];
		}
		return undefined;
	}

	private _parseSkillMd(text: string): { id?: string; name?: string; description?: string; category?: string; activation?: string } {
		if (!text.startsWith('---')) {
			return {};
		}
		const end = text.indexOf('\n---', 3);
		if (end < 0) {
			return {};
		}
		const headerLines = text.slice(3, end).split('\n');
		const meta: Record<string, string> = {};
		for (const rawLine of headerLines) {
			const line = rawLine.replace(/\r$/, '');
			const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
			if (kv) {
				const key = kv[1];
				let val = kv[2].trim();
				// 去引号
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				meta[key] = val;
			}
		}
		return {
			id: meta.id,
			name: meta.name,
			description: meta.description,
			category: meta.category,
			activation: meta.activation,
		};
	}

	/**
	 * 解析安装用技能 id（单点真源 common/skillId.ts，对齐 Hermes identifier 语义）：
	 * frontmatter 显式 `id` 合法时优先，否则从 name slug 派生。
	 * 返回 undefined 表示无法得到有效 id（纯非 ASCII 名且未显式指定 id）。
	 */
	private _resolveInstallSkillId(parsed: { id?: string; name?: string }): string | undefined {
		if (!parsed.name) {
			return undefined;
		}
		const id = resolveSkillId(parsed.id, parsed.name);
		return id || undefined;
	}

	// ─── 安装溯源 lock（复刻 Hermes `skills/.hub/lock.json`）──────────────

	/** lock 文件路径：`<skillsRoot>/.hub/lock.json`（`.hub` 已在 registry 扫描排除表中） */
	private _getSkillLockUri(): URI {
		return URI.joinPath(resolveSarosPath(this._getSarosRoot(), 'skills'), '.hub', 'lock.json');
	}

	private async _readSkillLock(): Promise<{ version: number; installed: Record<string, ISkillLockEntry> }> {
		try {
			const content = await this.fileService.readFile(this._getSkillLockUri());
			const data = JSON.parse(content.value.toString());
			if (data && typeof data === 'object' && data.installed && typeof data.installed === 'object') {
				return { version: 1, installed: data.installed };
			}
		} catch {
			// 文件不存在或损坏 — 返回空表
		}
		return { version: 1, installed: {} };
	}

	private async _writeSkillLock(lock: { version: number; installed: Record<string, ISkillLockEntry> }): Promise<void> {
		const uri = this._getSkillLockUri();
		await this.fileService.createFolder(URI.joinPath(uri, '..'));
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(lock, null, 2) + '\n'));
	}

	/**
	 * 记录安装溯源（best-effort，失败仅警告不阻塞安装）。
	 * 用途：来源/内容指纹/安装时间留痕，支撑后续升级检测与安全卸载。
	 */
	private async _recordSkillInstall(skillId: string, source: string, skillMdContent: string): Promise<void> {
		try {
			const lock = await this._readSkillLock();
			const now = new Date().toISOString();
			const existing = lock.installed[skillId];
			const contentHash = (stringHash(skillMdContent.trim(), 0) >>> 0).toString(16).padStart(8, '0');
			lock.installed[skillId] = {
				source,
				identifier: skillId,
				contentHash,
				installPath: skillId,
				installedAt: existing?.installedAt ?? now,
				updatedAt: now,
			};
			await this._writeSkillLock(lock);
		} catch (err) {
			this.logService.warn(`[SkillInstall] lock 记录失败（不影响安装）: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 卸载/重命名时移除或迁移 lock 条目（best-effort） */
	private async _removeSkillLockEntry(skillId: string): Promise<void> {
		try {
			const lock = await this._readSkillLock();
			if (skillId in lock.installed) {
				delete lock.installed[skillId];
				await this._writeSkillLock(lock);
			}
		} catch (err) {
			this.logService.warn(`[SkillInstall] lock 条目移除失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _renameSkillLockEntry(oldId: string, newId: string): Promise<void> {
		try {
			const lock = await this._readSkillLock();
			const entry = lock.installed[oldId];
			if (entry) {
				delete lock.installed[oldId];
				lock.installed[newId] = { ...entry, identifier: newId, installPath: newId, updatedAt: new Date().toISOString() };
				await this._writeSkillLock(lock);
			}
		} catch (err) {
			this.logService.warn(`[SkillInstall] lock 条目迁移失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** lock.json 单条记录（对齐 Hermes HubLockFile entry：source/identifier/contentHash/installPath/时间戳） */
interface ISkillLockEntry {
	source: string;
	identifier: string;
	contentHash: string;
	installPath: string;
	installedAt: string;
	updatedAt: string;
}
