/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Config-to-Code Linker — 配置文件到代码的链接。
 *
 * 对标 codebase-memory-mcp 的 pass_configlink.c (14KB C)。
 *
 * 三策略链接：
 * 1. Key→Symbol: 配置键归一化 → 匹配函数名 (置信度 0.6)
 * 2. Dep→Import: 包清单依赖 → 匹配 IMPORTS 边 (置信度 0.8)
 * 3. File→Ref:   源码字符串引用配置文件路径 (置信度 0.9)
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

export interface ConfigLink {
	configNode: number;
	codeNode: number;
	strategy: 'key_to_symbol' | 'dep_to_import' | 'file_to_ref';
	confidence: number;
	detail: string;
}

export function linkConfigToCode(
	store: CodebaseGraphStore,
	project: string,
	configFilePaths: string[],
): ConfigLink[] {
	const links: ConfigLink[] = [];

	// Find config file nodes in the store
	const configNodes: GraphNode[] = [];
	for (const configPath of configFilePaths) {
		const nodes = store.findNodesByFile(project, configPath);
		configNodes.push(...nodes);
	}

	if (configNodes.length === 0) {
		// Create virtual config node if not exists
		// (config files may not have been parsed as code)
	}

	const allNodes = store.getAllNodes().filter(n => n.project === project);

	// ── Strategy 1: Key→Symbol ──
	// For each config key (e.g., "database_url"), find functions with similar names
	for (const configNode of configNodes) {
		const configName = configNode.name.replace(/\.(json|yaml|yml|toml|env)$/, '');
		const normalizedKey = configName.replace(/[_\-\.]/g, '').toLowerCase();

		for (const codeNode of allNodes) {
			if (codeNode.id === configNode.id) { continue; }
			const normalizedCodeName = codeNode.name.replace(/[_\-\.]/g, '').toLowerCase();

			// Check if code name contains config key or vice versa
			if (normalizedCodeName.includes(normalizedKey) && normalizedKey.length > 3) {
				links.push({
					configNode: configNode.id,
					codeNode: codeNode.id,
					strategy: 'key_to_symbol',
					confidence: 0.6,
					detail: `Config key "${configName}" matches symbol "${codeNode.name}"`,
				});
			}
		}
	}

	// ── Strategy 2: Dep→Import ──
	// Parse package manifests and match dependencies to IMPORTS edges
	const manifestNodes = allNodes.filter(n =>
		n.filePath && (
			n.filePath.endsWith('package.json') ||
			n.filePath.endsWith('go.mod') ||
			n.filePath.endsWith('Cargo.toml') ||
			n.filePath.endsWith('requirements.txt') ||
			n.filePath.endsWith('pom.xml')
		)
	);

	for (const manifestNode of manifestNodes) {
		// Get all IMPORTS edges from this manifest
		const importEdges = store.getEdgesBySource(manifestNode.id).filter(e => e.type === 'IMPORTS');

		for (const edge of importEdges) {
			const targetNode = store.getNode(edge.targetId);
			if (!targetNode) { continue; }

			// Check if any config node references this dependency
			for (const configNode of configNodes) {
				// If config node name or properties contain the imported module name
				if (configNode.name.includes(targetNode.name) ||
					(configNode.properties && JSON.stringify(configNode.properties).includes(targetNode.name))) {
					links.push({
						configNode: configNode.id,
						codeNode: targetNode.id,
						strategy: 'dep_to_import',
						confidence: 0.8,
						detail: `Config references dependency "${targetNode.name}"`,
					});
				}
			}
		}
	}

	// ── Strategy 3: File→Ref ──
	// Source code strings that reference config file paths
	for (const codeNode of allNodes) {
		if (!codeNode.properties) { continue; }
		const props = JSON.stringify(codeNode.properties);

		for (const configPath of configFilePaths) {
			const configName = configPath.split(/[/\\]/).pop() || configPath;
			if (props.includes(configName) || props.includes(configPath)) {
				// Find config node for this path
				const configNodesForPath = store.findNodesByFile(project, configPath);
				for (const configNode of configNodesForPath) {
					links.push({
						configNode: configNode.id,
						codeNode: codeNode.id,
						strategy: 'file_to_ref',
						confidence: 0.9,
						detail: `Code references config file "${configName}"`,
					});
				}
			}
		}
	}

	// Deduplicate and sort by confidence
	const seen = new Set<string>();
	const unique = links.filter(l => {
		const key = `${l.configNode}:${l.codeNode}:${l.strategy}`;
		if (seen.has(key)) { return false; }
		seen.add(key);
		return true;
	});

	return unique.sort((a, b) => b.confidence - a.confidence);
}
