/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * BundledResourceService — 从 JSON 文件加载内置 MCP 预设和工具定义。
 *
 * 资源位置（按优先级）：
 *   1. 用户覆盖：~/.vssaros/saros/mcp-presets/*.json
 *   2. 内置资源：扩展安装目录/resources/.agents/mcp-presets/*.json
 *   3. Hardcoded fallback：bundledMcpPresets.ts 中的 BUNDLED_MCP_PRESETS
 *
 * 工具定义同理，从 ~/.vssaros/saros/tools/*.json 和
 * 扩展安装目录/resources/.agents/tools/*.json 加载。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
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
		const jsonPresets = await this._loadJsonFromUserDir('mcp-presets');
		if (jsonPresets.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${jsonPresets.length} MCP presets from user dir`);
			const presets = jsonPresets as IMcpServerPreset[];
			setMcpPresets(presets);
			return presets;
		}

		// Fallback to hardcoded
		this._logService.info('[BundledResource] Using hardcoded MCP presets');
		return [...BUNDLED_MCP_PRESETS];
	}

	private async _loadToolDefinitions(): Promise<IToolDefinition[]> {
		const jsonTools = await this._loadJsonFromUserDir('tools');
		if (jsonTools.length > 0) {
			this._logService.info(`[BundledResource] Loaded ${jsonTools.length} tool definitions from user dir`);
			return jsonTools as IToolDefinition[];
		}

		// Fallback to hardcoded
		this._logService.info('[BundledResource] Using hardcoded tool definitions');
		return [...BUNDLED_TOOL_DEFINITIONS];
	}

	/**
	 * 从 ~/.vssaros/saros/{subdir}/*.json 加载 JSON 文件。
	 */
	private async _loadJsonFromUserDir(subdir: string): Promise<unknown[]> {
		try {
			const dir = resolveSarosPath(this._getSarosRoot(), subdir);

			let children: { resource: URI; name: string; isDirectory?: boolean }[];
			try {
				const stat = await this._fileService.resolve(dir);
				children = stat.children ?? [];
			} catch {
				// 目录不存在
				return [];
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
			this._logService.error('[BundledResource] Error loading from user dir', err);
			return [];
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromPath(this._envService.userDataPath);
	}
}
