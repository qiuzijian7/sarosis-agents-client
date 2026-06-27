/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Path Alias Resolver — 路径别名解析。
 *
 * 对标 codebase-memory-mcp 的 path_alias.c (16KB C)。
 *
 * 功能：
 * 1. 解析 tsconfig.json / jsconfig.json 的 compilerOptions.paths + baseUrl
 * 2. 将 `@/lib/auth` 等别名解析为仓库相对路径
 * 3. 支持通配符 `*` 匹配
 * 4. 目录作用域 — 最近祖先配置生效
 *
 * 示例：
 *   tsconfig.json: { "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }
 *   import { auth } from '@/lib/auth'
 *   → 解析为 src/lib/auth
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, join, normalize } from '../../../../base/common/path.js';

export interface PathAlias {
	pattern: string;      // "@/*"
	replacement: string;  // "src/*"
	baseUrl: string;      // "."
	configPath: string;   // path to tsconfig.json
}

interface ConfigEntry {
	configPath: string;    // absolute path to tsconfig.json
	configDir: string;     // directory containing tsconfig.json
	baseUrl: string;
	aliases: PathAlias[];
}

export class PathAliasResolver {
	private _configs: ConfigEntry[] = [];
	private _loaded = false;

	constructor(private _fileService: IFileService) {}

	/** Load tsconfig.json/jsconfig.json from workspace root */
	async loadFromWorkspace(rootPath: string): Promise<void> {
		this._configs = [];
		this._loaded = true;

		// Find all tsconfig.json / jsconfig.json files (root + nested)
		const configFiles = await this._findConfigFiles(rootPath);

		for (const configPath of configFiles) {
			try {
				const config = await this._parseConfig(configPath);
				if (config) {
					this._configs.push(config);
				}
			} catch { /* ignore invalid configs */ }
		}

		// Sort by directory depth (deepest first for closest-ancestor matching)
		this._configs.sort((a, b) => b.configDir.length - a.configDir.length);
	}

	/** Resolve an import path alias to a relative file path */
	resolveAlias(importPath: string, fromFile: string): string | undefined {
		if (!this._loaded || this._configs.length === 0) { return undefined; }

		// Find the closest config (nearest ancestor)
		const fromDir = dirname(fromFile);
		const config = this._findConfigForFile(fromDir);
		if (!config) { return undefined; }

		for (const alias of config.aliases) {
			const result = this._matchAlias(alias, importPath, config);
			if (result) { return result; }
		}

		return undefined;
	}

	/** Find config for a given file (closest ancestor) */
	findConfigForFile(filePath: string): ConfigEntry | undefined {
		return this._findConfigForFile(dirname(filePath));
	}

	private _findConfigForFile(dir: string): ConfigEntry | undefined {
		for (const config of this._configs) {
			if (dir.startsWith(config.configDir)) {
				return config;
			}
		}
		return undefined;
	}

	/** Match import path against alias pattern */
	private _matchAlias(alias: PathAlias, importPath: string, config: ConfigEntry): string | undefined {
		// Convert pattern to regex: "@/*" → "^@/(.*)$"
		const patternRegex = new RegExp('^' + alias.pattern.replace(/\*/g, '(.*)') + '$');
		const match = importPath.match(patternRegex);
		if (!match) { return undefined; }

		// Replace wildcard in replacement
		let resolved = alias.replacement;
		for (let i = 1; i < match.length; i++) {
			resolved = resolved.replace('*', match[i]);
		}

		// Join with baseUrl
		const fullBase = alias.baseUrl
			? join(config.configDir, alias.baseUrl)
			: config.configDir;

		return normalize(join(fullBase, resolved));
	}

	/** Parse a tsconfig.json / jsconfig.json file */
	private async _parseConfig(configPath: string): Promise<ConfigEntry | null> {
		try {
			const content = await this._fileService.readFile(URI.file(configPath));
			const json = JSON.parse(content.value.toString());

			const compilerOptions = json.compilerOptions || {};
			const baseUrl = compilerOptions.baseUrl || '.';
			const paths = compilerOptions.paths || {};

			const aliases: PathAlias[] = [];
			for (const [pattern, replacements] of Object.entries(paths)) {
				if (Array.isArray(replacements) && replacements.length > 0) {
					aliases.push({
						pattern,
						replacement: replacements[0],
						baseUrl,
						configPath,
					});
				}
			}

			if (aliases.length === 0) { return null; }

			return {
				configPath,
				configDir: dirname(configPath),
				baseUrl,
				aliases,
			};
		} catch {
			return null;
		}
	}

	/** Find all tsconfig.json/jsconfig.json files in workspace */
	private async _findConfigFiles(rootPath: string): Promise<string[]> {
		const results: string[] = [];
		await this._scanForConfigs(URI.file(rootPath), results, 0);
		return results;
	}

	private async _scanForConfigs(dirUri: URI, results: string[], depth: number): Promise<void> {
		if (depth > 10) { return; } // max depth

		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) { return; }

			for (const child of stat.children) {
				if (child.name === 'tsconfig.json' || child.name === 'jsconfig.json') {
					results.push(child.resource.fsPath);
				}
				if (child.isDirectory && !child.name.startsWith('.') && child.name !== 'node_modules') {
					await this._scanForConfigs(child.resource, results, depth + 1);
				}
			}
		} catch { /* ignore */ }
	}

	/** Get all loaded aliases (for debugging) */
	getLoadedAliases(): PathAlias[] {
		return this._configs.flatMap(c => c.aliases);
	}
}
