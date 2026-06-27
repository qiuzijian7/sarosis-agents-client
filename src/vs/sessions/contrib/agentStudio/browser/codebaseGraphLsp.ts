/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LSP Type Inference — 跨文件类型感知调用解析。
 *
 * 对标 codebase-memory-mcp 的 pass_lsp_cross.c。
 * 使用 VS Code 的 Language Feature API 进行类型推断：
 * - provideDefinition: 获取标识符的定义位置
 * - provideTypeDefinition: 获取类型定义
 * - provideImplementation: 获取接口实现
 */

import { URI } from '../../../../base/common/uri.js';
import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

export interface TypeResolution {
	nodeId: number;
	resolvedType?: string;
	resolvedDefinitionNodeId?: number;
	confidence: number;  // 0-1
}

// ─── Cross-Language LSP Registry (对标 CBMCrossLspRegistries) ────────────

export interface CrossLspRegistry {
	language: string;
	moduleExports: Map<string, Set<number>>;   // moduleName → nodeIds
	typeDefinitions: Map<string, number>;       // typeName → nodeId
	importAliases: Map<string, string>;         // alias → realPath
	defIndex: Map<string, Map<string, number>>; // module → (name → nodeId)
}

/** Per-language cross-file definition index builder + call resolver */
export class LspCrossResolver {
	private _registries: Map<string, CrossLspRegistry> = new Map();
	private _globalDefIndex: Map<string, number[]> = new Map();  // name → nodeIds (global)

	/** Build per-language registries from all nodes in the store */
	buildDefIndex(store: CodebaseGraphStore, project: string): void {
		this._registries.clear();
		this._globalDefIndex.clear();

		const allNodes = store.getAllNodes().filter(n => n.project === project);

		for (const node of allNodes) {
			// Build global name → nodeId index
			const nameKey = node.name;
			if (!this._globalDefIndex.has(nameKey)) {
				this._globalDefIndex.set(nameKey, []);
			}
			this._globalDefIndex.get(nameKey)!.push(node.id);

			// Determine language from file extension
			const lang = this._detectLanguage(node.filePath || '');
			if (!lang) { continue; }

			// Get or create per-language registry
			let registry = this._registries.get(lang);
			if (!registry) {
				registry = {
					language: lang,
					moduleExports: new Map(),
					typeDefinitions: new Map(),
					importAliases: new Map(),
					defIndex: new Map(),
				};
				this._registries.set(lang, registry);
			}

			// Index by module (directory of file)
			const modulePath = this._getModulePath(node.filePath || '');
			if (modulePath) {
				if (!registry.defIndex.has(modulePath)) {
					registry.defIndex.set(modulePath, new Map());
				}
				registry.defIndex.get(modulePath)!.set(node.name, node.id);
			}

			// Index type definitions
			if (node.label === 'class' || node.label === 'interface' || node.label === 'type' || node.label === 'enum') {
				registry.typeDefinitions.set(node.name, node.id);
			}

			// Index module exports
			if (node.label === 'function' || node.label === 'class' || node.label === 'variable') {
				if (!registry.moduleExports.has(modulePath)) {
					registry.moduleExports.set(modulePath, new Set());
				}
				registry.moduleExports.get(modulePath)!.add(node.id);
			}
		}
	}

	/** Resolve a call from (filePath, calleeName) → target nodeId */
	resolveCall(filePath: string, calleeName: string, language?: string): number | undefined {
		const lang = language || this._detectLanguage(filePath);

		// Strategy 1: Check per-language registry for module-scoped resolution
		if (lang) {
			const registry = this._registries.get(lang);
			if (registry) {
				// Try exact name match in same module
				const modulePath = this._getModulePath(filePath);
				if (modulePath) {
					const moduleDefs = registry.defIndex.get(modulePath);
					if (moduleDefs && moduleDefs.has(calleeName)) {
						return moduleDefs.get(calleeName);
					}
				}

				// Try type definition match
				if (registry.typeDefinitions.has(calleeName)) {
					return registry.typeDefinitions.get(calleeName);
				}
			}
		}

		// Strategy 2: Global name index (fallback)
		const globalMatches = this._globalDefIndex.get(calleeName);
		if (globalMatches && globalMatches.length > 0) {
		// For now, return the first match (could be improved with proximity scoring)
			return globalMatches[0];
		}

		return undefined;
	}

	/** Resolve an import path to a module */
	resolveImport(importPath: string, fromFile: string, language?: string): number[] {
		const lang = language || this._detectLanguage(fromFile);
		if (!lang) { return []; }

		const registry = this._registries.get(lang);
		if (!registry) { return []; }

		// Try to find the module in the def index
		const normalizedPath = importPath.replace(/['"]/g, '');
		const moduleDefs = registry.defIndex.get(normalizedPath);
		if (moduleDefs) {
			return Array.from(moduleDefs.values());
		}

		// Try with extensions
		for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs']) {
			const withExt = normalizedPath + ext;
			const defs = registry.defIndex.get(withExt);
			if (defs) { return Array.from(defs.values()); }
		}

		return [];
	}

	/** Get all resolved definitions for a name */
	getDefinitionsForName(name: string): number[] {
		return this._globalDefIndex.get(name) || [];
	}

	/** Get registry for a language */
	getRegistry(language: string): CrossLspRegistry | undefined {
		return this._registries.get(language);
	}

	/** Get all loaded languages */
	getLoadedLanguages(): string[] {
		return Array.from(this._registries.keys());
	}

	private _detectLanguage(filePath: string): string | undefined {
		const ext = filePath.split('.').pop()?.toLowerCase();
		const extMap: Record<string, string> = {
			ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
			mjs: 'javascript', cjs: 'javascript',
			py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
			c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
			cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
		};
		return ext ? extMap[ext] : undefined;
	}

	private _getModulePath(filePath: string): string {
		const normalized = filePath.replace(/\\/g, '/');
		const parts = normalized.split('/');
		parts.pop(); // remove filename
		return parts.join('/');
	}
}

export class LspTypeInference {
	private _commandService: any;

	constructor(commandService: any) {
		this._commandService = commandService;
	}

	/**
	 * Resolve call targets using VS Code's definition provider.
	 * This replaces the naive name-matching approach with precise type-aware resolution.
	 */
	async resolveCallTargets(
		store: CodebaseGraphStore,
		project: string,
		callerNode: GraphNode,
		calleeName: string
	): Promise<TypeResolution[]> {
		if (!callerNode.filePath || !callerNode.startLine) {
			return [];
		}

		const results: TypeResolution[] = [];

		try {
			// Use VS Code's definition provider to find where the callee is defined
			const uri = URI.file(callerNode.filePath);
			const position = { line: callerNode.startLine - 1, character: 0 };

			// Execute definition provider
			const definitions = await this._commandService.executeCommand(
				'vscode.executeDefinitionProvider', uri, position
			);

			if (definitions && Array.isArray(definitions)) {
				for (const def of definitions) {
					if (def.uri && def.range) {
						const defFilePath = def.uri.fsPath || def.uri.path;
						const defLine = def.range.start.line + 1;

						// Find the node at this definition location
						const nodes = store.findNodesByFile(project, defFilePath);
						const defNode = nodes.find(n =>
							n.startLine !== undefined &&
							n.startLine <= defLine &&
							(n.endLine || Infinity) >= defLine
						);

						if (defNode) {
							results.push({
								nodeId: callerNode.id,
								resolvedDefinitionNodeId: defNode.id,
								resolvedType: defNode.label,
								confidence: 0.95,
							});
						}
					}
				}
			}
		} catch {
			// Fallback to name matching if LSP is not available
			const nameMatches = store.search({
				project,
				namePattern: calleeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
				label: 'function',
				limit: 5,
			});

			for (const match of nameMatches.nodes) {
				results.push({
					nodeId: callerNode.id,
					resolvedDefinitionNodeId: match.id,
					confidence: 0.5,
				});
			}
		}

		return results;
	}

	/**
	 * Resolve interface implementations.
	 */
	async resolveImplementations(
		store: CodebaseGraphStore,
		project: string,
		interfaceNode: GraphNode
	): Promise<GraphNode[]> {
		if (!interfaceNode.filePath || !interfaceNode.startLine) {
			return [];
		}

		try {
			const uri = URI.file(interfaceNode.filePath);
			const position = { line: interfaceNode.startLine - 1, character: 0 };

			const implementations = await this._commandService.executeCommand(
				'vscode.executeImplementationProvider', uri, position
			);

			if (implementations && Array.isArray(implementations)) {
				const result: GraphNode[] = [];
				for (const impl of implementations) {
					if (impl.uri && impl.range) {
						const implFilePath = impl.uri.fsPath || impl.uri.path;
						const implLine = impl.range.start.line + 1;
						const nodes = store.findNodesByFile(project, implFilePath);
						const implNode = nodes.find(n =>
							n.startLine !== undefined &&
							n.startLine <= implLine &&
							(n.endLine || Infinity) >= implLine
						);
						if (implNode) { result.push(implNode); }
					}
				}
				return result;
			}
		} catch { /* LSP not available */ }

		return [];
	}
}
