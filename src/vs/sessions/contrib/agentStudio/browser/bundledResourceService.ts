/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * BundledResourceService — 从 JSON 文件加载内置 MCP 预设和工具定义。
 *
 * 资源位置（按优先级）：
 *   1. 用户覆盖：~/.vssaros/mcp-presets/*.json
 *   2. 内置资源：resources/.agents/mcp-presets/*.json
 *   3. Hardcoded fallback：bundledMcpPresets.ts 中的 BUNDLED_MCP_PRESETS
 *
 * 工具定义同理，从 ~/.vssaros/tools/*.json 和 resources/.agents/tools/*.json 加载。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMcpServerPreset, BUNDLED_MCP_PRESETS, setMcpPresets } from '../common/bundled-tools/bundledMcpPresets.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../common/bundled-tools/bundledTools.js';
import { IToolDefinition } from '../common/providers.js';
import { resolveSarosPath, userDataRootFromPath } from '../common/sarosPaths.js';

export interface IBundledResourceService {
	readonly _serviceBrand: undefined;
	getMcpPresets(): Promise<IMcpServerPreset[]>;
	getToolDefinitions(): Promise<IToolDefinition[]>;
}

export class BundledResourceService extends Disposable implements IBundledResourceService {
	readonly _serviceBrand: undefined;

	private _mcpPresets: IMcpServerPreset[] | undefined;
	private _toolDefs: IToolDefinition[] | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _envService: INativeEnvironmentService,
	) {
		super();
	}

	async getMcpPresets(): Promise<IMcpServerPreset[]> {
		if (this._mcpPresets) { return this._mcpPresets; }
		this._mcpPresets = await this._loadMcpPresets();
		return this._mcpPresets;
	}

	async getToolDefinitions(): Promise<IToolDefinition[]> {
		if (this._toolDefs) { return this._toolDefs; }
		this._toolDefs = await this._loadToolDefinitions();
		return this._toolDefs;
	}

	private async _loadMcpPresets(): Promise<IMcpServerPreset[]> {
		// 1. 用户覆盖：~/.vssaros/mcp-presets/*.json
		const userPresets = await this._loadJsonFromDir(resolveSarosPath(this._getSarosRoot(), 'mcp-presets'));
		if (userPresets.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${userPresets.length} MCP presets from user dir`);
			const presets = userPresets as IMcpServerPreset[];
			setMcpPresets(presets);
			return presets;
		}

		// 2. 内置资源：resources/.agents/mcp-presets/*.json
		const builtinPresets = await this._loadJsonFromFirstExisting(this._getBuiltinResourceCandidates('mcp-presets'));
		if (builtinPresets.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${builtinPresets.length} MCP presets from builtin resources`);
			const presets = builtinPresets as IMcpServerPreset[];
			setMcpPresets(presets);
			return presets;
		}

		// 3. Hardcoded fallback
		this._logService.info('[BundledResource] Using hardcoded MCP presets');
		return [...BUNDLED_MCP_PRESETS];
	}

	private async _loadToolDefinitions(): Promise<IToolDefinition[]> {
		// 1. 用户覆盖：~/.vssaros/tools/*.json
		const userTools = await this._loadJsonFromDir(resolveSarosPath(this._getSarosRoot(), 'tools'));
		if (userTools.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${userTools.length} tool definitions from user dir`);
			return userTools as IToolDefinition[];
		}

		// 2. 内置资源：resources/.agents/tools/*.json
		const builtinTools = await this._loadJsonFromFirstExisting(this._getBuiltinResourceCandidates('tools'));
		if (builtinTools.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${builtinTools.length} tool definitions from builtin resources`);
			return builtinTools as IToolDefinition[];
		}

		// 3. Hardcoded fallback
		this._logService.info('[BundledResource] Using hardcoded tool definitions');
		return [...BUNDLED_TOOL_DEFINITIONS];
	}

	/**
	 * 从单个目录加载所有 *.json 文件。目录不存在或解析失败返回 []。
	 */
	private async _loadJsonFromDir(dir: URI): Promise<unknown[]> {
		try {
			let children: { resource: URI; name: string; isDirectory?: boolean }[];
			try {
				const stat = await this._fileService.resolve(dir);
				children = stat.children ?? [];
			} catch {
				return []; // 目录不存在
			}

			const results: unknown[] = [];
			for (const child of children) {
				if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
				try {
					const content = await this._fileService.readFile(child.resource);
					const parsed = JSON.parse(content.value.toString());
					if (parsed && typeof parsed === 'object') {
						results.push(parsed);
					}
				} catch (err) {
					this._logService.warn('[BundledResource] Failed to parse', child.name, err);
				}
			}
			return results;
		} catch (err) {
			this._logService.error('[BundledResource] Error loading JSON dir', err);
			return [];
		}
	}

	/** 依次尝试多个候选目录，返回第一个非空目录的加载结果。 */
	private async _loadJsonFromFirstExisting(dirs: URI[]): Promise<unknown[]> {
		for (const dir of dirs) {
			const results = await this._loadJsonFromDir(dir);
			if (results.length > 0) { return results; }
		}
		return [];
	}

	/**
	 * 内置资源目录（resources/.agents/{subdir}/）的多候选路径，
	 * 兼容 dev / electron-packaged / browser 运行模式（与 SkillRegistry 策略一致）。
	 */
	private _getBuiltinResourceCandidates(subdir: string): URI[] {
		const candidates: URI[] = [];
		try {
			candidates.push(FileAccess.asFileUri(`vs/../../resources/.agents/${subdir}`));
		} catch { /* ignore */ }
		const appRoot = this._envService.appRoot;
		if (appRoot) {
			const uri2 = URI.joinPath(URI.file(appRoot), 'resources', '.agents', subdir);
			if (!candidates.some(c => c.toString() === uri2.toString())) { candidates.push(uri2); }
			const uri3 = URI.joinPath(URI.file(path.dirname(appRoot)), 'resources', '.agents', subdir);
			if (!candidates.some(c => c.toString() === uri3.toString())) { candidates.push(uri3); }
		}
		return candidates;
	}

	private _getSarosRoot(): URI {
		return userDataRootFromPath(this._envService.userDataPath);
	}
}
