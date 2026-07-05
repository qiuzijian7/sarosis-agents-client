/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 安装服务实现 —— 从 Hub 或本地文件安装 skill 到工作区。
 *
 * 安装目标目录（按优先级）：
 *   1. <projectRoot>/resources/.agents/skills/<skillId>/SKILL.md  —— 应用内置技能区域
 *   2. <workspaceFolder>/.agents/skills/<skillId>/SKILL.md  —— 兜底：当无法解析 projectRoot 时回退
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
	BUILTIN_SKILL_HUBS,
} from '../common/skillHubTypes.js';

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

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
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

	async installFromContent(content: string): Promise<ISkillInstallResult> {
		// 解析 frontmatter 获取 name
		const parsed = this._parseSkillMd(content);
		if (!parsed.name) {
			return { success: false, skillId: '', skillName: '', error: 'SKILL.md must have a "name" field in frontmatter' };
		}

		const skillId = parsed.name.toLowerCase().replace(/\s+/g, '-');

		// 解析目标目录：优先 projectRoot/resources/.agents/skills；失败则回退 workspace
		const targetDir = this._resolveSkillsTargetDir(skillId);
		if (!targetDir) {
			return { success: false, skillId, skillName: parsed.name, error: 'Failed to resolve skill install directory' };
		}
		const targetFile = URI.joinPath(targetDir, 'SKILL.md');

		// 不覆盖已有
		if (await this.fileService.exists(targetFile)) {
			return { success: false, skillId, skillName: parsed.name, error: `Skill "${skillId}" already exists at ${targetDir.toString()}` };
		}

		// 创建目录并写入
		await this.fileService.createFolder(targetDir);
		await this.fileService.writeFile(targetFile, VSBuffer.fromString(content));

		this.logService.info(`[SkillInstall] Skill "${skillId}" installed to ${targetDir.toString()}`);

		// 刷新 registry
		await this.skillRegistry.reload();

		return { success: true, skillId, skillName: parsed.name };
	}

	async uninstallSkill(skillId: string): Promise<boolean> {
		const skill = this.skillRegistry.getSkill(skillId);
		if (!skill) {
			return false;
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
	 * 解析 skill 安装目标目录（与 SkillRegistryService 的 builtin scan 路径对齐）。
	 * 顺序：
	 *   1. FileAccess.asFileUri('vs/../../resources/.agents/skills') —— 最稳，与 vs 源代码 root 同步
	 *   2. <appRoot>/resources/.agents/skills —— Electron dev 启动 appRoot 直接就是项目根
	 *   3. <dirname(appRoot)>/resources/.agents/skills —— 打包模式 appRoot 指向 out/
	 *   4. workspaceFolder/.agents/skills —— 浏览器/远程环境兜底
	 */
	private _resolveSkillsTargetDir(skillId: string): URI | undefined {
		// 1) FileAccess.asFileUri —— 与 SkillRegistry candidate3 一致，最可靠
		try {
			const base = FileAccess.asFileUri('vs/../../resources/.agents/skills');
			return URI.joinPath(base, skillId);
		} catch {
			// ignore, try next
		}

		// 2) <appRoot>/resources/.agents/skills —— Electron dev 模式 appRoot ≡ projectRoot
		try {
			const appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
			if (appRoot) {
				return URI.joinPath(URI.file(appRoot), 'resources', '.agents', 'skills', skillId);
			}
		} catch {
			// ignore
		}

		// 3) 回退：当前 workspaceFolder/.agents/skills
		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (workspaceFolders.length > 0) {
			return URI.joinPath(workspaceFolders[0].uri, '.agents', 'skills', skillId);
		}
		return undefined;
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
						(entry as { id: string }).id = parsed.name.toLowerCase().replace(/\s+/g, '-');
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
				id: (item.name ?? item.id ?? '').toLowerCase().replace(/\s+/g, '-'),
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
						id: name.toLowerCase().replace(/\s+/g, '-'),
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

	private _parseSkillMd(text: string): { name?: string; description?: string; category?: string; activation?: string } {
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
			name: meta.name,
			description: meta.description,
			category: meta.category,
			activation: meta.activation,
		};
	}
}
