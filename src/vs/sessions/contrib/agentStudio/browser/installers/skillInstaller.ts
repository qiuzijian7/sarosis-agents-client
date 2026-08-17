/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SkillInstaller —— skill 资源的安装器实现。
 *
 * install: 解压目录的 SKILL.md → 写入 ~/.vssaros/skills/{id}/SKILL.md
 *          （回写 storeId/version 到 frontmatter）→ ISkillRegistry.reload()
 * preparePack: 读 ~/.vssaros/skills/{id}/SKILL.md frontmatter → 构造 manifest
 * getInstalledVersion: 从 ISkillRegistry.getSkill(id).version 读取
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISkillRegistry } from '../../common/skills.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import { resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';

const SKILL_SUBDIR = 'skills';

export class SkillInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'skill';

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		) {
		super();
	}

	async install(manifest: PackageManifest, extractedDir: URI, opts?: { force?: boolean }): Promise<IInstallResult> {
		const skillFile = URI.joinPath(extractedDir, 'SKILL.md');
		if (!await this.fileService.exists(skillFile)) {
			throw new Error('包内缺少 SKILL.md');
		}
		const content = (await this.fileService.readFile(skillFile)).value.toString();

		// 回写 storeId/version 到 frontmatter，使该 skill 可被升级检查溯源
		const updated = this.injectFrontmatter(content, { storeId: manifest.id, version: manifest.version });

		// 优先使用已注册技能的实际目录（目录名可能与 id 不同，如 P4Helper vs S1P4HelperSkill）
		const existing = this.skillRegistry.getSkill(manifest.id);
		const targetDir = existing?.resource ?? await this.resolveDir(manifest.id);
		const targetSkillFile = URI.joinPath(targetDir, 'SKILL.md');

		// 检查已存在：非 force 模式拒绝覆盖，force 模式先删除旧目录
		if (await this.fileService.exists(targetSkillFile)) {
			if (!opts?.force) {
				throw new Error(`Skill "${manifest.id}" already exists. Use force=true to overwrite (upgrade).`);
			}
			// force 模式：删除旧目录后重新创建
			try { await this.fileService.del(targetDir, { recursive: true }); } catch { /* ignore */ }
		}

		await this.fileService.createFolder(targetDir);
		await this.fileService.writeFile(targetSkillFile, VSBuffer.fromString(updated));

		// 拷贝支持目录（references/templates/assets/scripts），使目录包技能完整安装
		for (const dirName of SkillInstaller.SUPPORT_DIRS) {
			const srcDir = URI.joinPath(extractedDir, dirName);
			try {
				if (await this.fileService.exists(srcDir)) {
					await this.fileService.copy(srcDir, URI.joinPath(targetDir, dirName), true);
				}
			} catch (e) {
				this.logService.warn(`[SkillInstaller] 拷贝支持目录 ${dirName} 失败: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		await this.skillRegistry.reload();
		this.logService.info(`[SkillInstaller] 安装完成: ${manifest.id} v${manifest.version} → ${targetDir.fsPath}`);

		return { kind: 'skill', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath };
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		// Try to find the skill in the registry to get its actual directory
		// (directory name may differ from skill id)
		const skill = this.skillRegistry.getSkill(localId);
		let localDir: URI;
		if (skill?.resource) {
			localDir = skill.resource;
		} else {
			localDir = await this.resolveDir(localId);
		}
		if (!await this.fileService.exists(localDir)) {
			throw new Error(`skill 目录不存在: ${localDir.fsPath}`);
		}
		const skillFile = URI.joinPath(localDir, 'SKILL.md');
		const content = (await this.fileService.readFile(skillFile)).value.toString();
		const fm = this.parseFrontmatter(content);

		const name = (fm.name as string | undefined) || localId;
		const version = (fm.version as string | undefined) || '1.0.0';
		const description = fm.description as string | undefined;
		const category = fm.category as string | undefined;
		const author = fm.author as string | undefined;

		const manifest: PackageManifest = {
			kind: 'skill',
			id: localId,
			name,
			version,
			description,
			category,
			author,
			files: await this.listPackageFiles(localDir),
			skill: {
				id: localId,
				name,
				description: description || '',
				activation: (fm.activation as 'manual' | 'auto' | 'always') || 'manual',
				match: fm.match as readonly string[] | undefined,
				category,
				version,
				storeId: localId,
			},
		};
		return { localDir, manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		const skill = this.skillRegistry.getSkill(storeId);
		return skill?.version;
	}

	// ── 内部 ──────────────────────────────────────────────────

	/** 技能支持目录（对齐 SkillRegistry.SKILL_SUPPORT_DIRS） */
	private static readonly SUPPORT_DIRS = ['references', 'templates', 'assets', 'scripts', 'tests'] as const;

	private async resolveDir(id: string): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), SKILL_SUBDIR, id);
	}

	/** 列出包内全部文件（SKILL.md + 支持目录文件），用于 manifest.files 准确反映包内容 */
	private async listPackageFiles(localDir: URI): Promise<readonly string[]> {
		const files: string[] = ['SKILL.md'];
		const collect = async (dir: URI, prefix: string, depth: number): Promise<void> => {
			if (depth > 3) { return; }
			try {
				const stat = await this.fileService.resolve(dir);
				if (!stat.isDirectory || !stat.children) { return; }
				for (const child of stat.children) {
					const rel = `${prefix}/${child.name}`;
					if (child.isDirectory) {
						await collect(child.resource, rel, depth + 1);
					} else {
						files.push(rel);
					}
				}
			} catch { /* 支持目录不存在 — 正常 */ }
		};
		for (const dirName of SkillInstaller.SUPPORT_DIRS) {
			await collect(URI.joinPath(localDir, dirName), dirName, 0);
		}
		return files;
	}

	/** 解析 SKILL.md frontmatter 为键值对象 */
	private parseFrontmatter(text: string): Record<string, unknown> {
		const meta: Record<string, unknown> = {};
		if (!text.startsWith('---')) {
			return meta;
		}
		const end = text.indexOf('\n---', 3);
		if (end < 0) {
			return meta;
		}
		const header = text.slice(3, end);
		let currentKey = '';
		for (const rawLine of header.split('\n')) {
			const line = rawLine.replace(/\r$/, '');
			// 数组项:  - value
			const arrItem = /^\s+-\s+(.+)$/.exec(line);
			if (arrItem && currentKey) {
				const arr = (meta[currentKey] as unknown[]) || (meta[currentKey] = []);
				if (Array.isArray(arr)) {
					arr.push(arrItem[1].trim().replace(/^["']|["']$/g, ''));
				}
				continue;
			}
			const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
			if (kv) {
				currentKey = kv[1];
				let val = kv[2].trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (val.startsWith('[') && val.endsWith(']')) {
					meta[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
				} else if (val === '') {
					meta[currentKey] = [];
				} else {
					meta[currentKey] = val;
				}
			}
		}
		return meta;
	}

	/** 向 frontmatter 注入/更新字段（存在则更新值，不存在则添加） */
	private injectFrontmatter(text: string, fields: Record<string, string>): string {
		if (!text.startsWith('---')) {
			const fm = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---', ''].join('\n');
			return fm + text;
		}
		const end = text.indexOf('\n---', 3);
		if (end < 0) {
			return text;
		}
		const header = text.slice(3, end);
		const rest = text.slice(end + 4); // skip \n---
		const lines = header.split('\n');

		// Replace existing fields, track which already exist
		const existing = new Set<string>();
		const updatedLines = lines.map(line => {
			const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line.replace(/\r$/, ''));
			if (kv && fields[kv[1]] !== undefined) {
				existing.add(kv[1]);
				return `${kv[1]}: ${JSON.stringify(fields[kv[1]])}`;
			}
			return line;
		});

		// Add fields that don't exist yet
		const toAdd = Object.entries(fields).filter(([k]) => !existing.has(k));
		const newLines = [...updatedLines, ...toAdd.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)];
		return `---\n${newLines.join('\n')}\n---${rest}`;
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
