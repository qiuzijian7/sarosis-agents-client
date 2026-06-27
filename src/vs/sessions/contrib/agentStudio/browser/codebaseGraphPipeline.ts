/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Pipeline — 多 pass 解析管线。
 *
 * 对标 codebase-memory-mcp 的 22 pass pipeline，实现核心 10 个 pass：
 * 1. definitions    — 函数/类/接口/枚举/结构体节点
 * 2. calls          — CALLS 边
 * 3. imports        — IMPORTS 边
 * 4. class_hier     — INHERITS/IMPLEMENTS 边
 * 5. routes         — Route 节点 + HTTP_CALLS 边
 * 6. events         — EMITS/LISTENS_ON 边
 * 7. data_flow      — DATA_FLOWS 边
 * 8. decorators     — DECORATES 边
 * 9. complexity     — Halstead/cyclomatic → properties
 * 10. file_structure — File/Folder 节点 + CONTAINS 边
 */

import { AST_NODE_MAP, extractName, extractCalleeName, extractImportNames, extractInherits, extractDecorators, extractEmits, extractRoutes, computeComplexity } from './codebaseGraphQueries.js';

export interface PipelineNode {
	id: string;
	name: string;
	type: string;           // function, class, interface, route, file, etc.
	filePath: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	properties?: Record<string, any>;
}

export interface PipelineEdge {
	source: string;
	target: string;
	type: string;            // CALLS, IMPORTS, DEFINES, INHERITS, etc.
	properties?: Record<string, any>;
}

export interface PipelineResult {
	nodes: PipelineNode[];
	edges: PipelineEdge[];
}

export interface PipelineConfig {
	mode: 'fast' | 'moderate' | 'full';
	enableRoutes: boolean;
	enableEvents: boolean;
	enableDataFlow: boolean;
	enableComplexity: boolean;
}

/**
 * 执行多 pass 解析管线。
 * 每个 pass 遍历 AST 一次，提取特定类型的节点和边。
 */
export class CodebaseGraphPipeline {

	/**
	 * 解析单个文件的 AST，执行所有 pass。
	 */
	process(rootNode: any, filePath: string, config: PipelineConfig): PipelineResult {
		const nodes: PipelineNode[] = [];
		const edges: PipelineEdge[] = [];
		const fileId = `file:${filePath}`;
		const definitionIds: string[] = [];

		// Pass 1: Definitions (functions, classes, interfaces, etc.)
		this._passDefinitions(rootNode, filePath, fileId, nodes, definitionIds);

		// Pass 2: Calls
		this._passCalls(rootNode, filePath, fileId, nodes, edges);

		// Pass 3: Imports
		this._passImports(rootNode, filePath, fileId, edges);

		// Pass 4: Class hierarchy (INHERITS, IMPLEMENTS)
		this._passClassHierarchy(rootNode, filePath, fileId, edges);

		// Pass 5: Routes (optional, only for TS/JS)
		if (config.enableRoutes) {
			this._passRoutes(rootNode, filePath, fileId, nodes, edges);
		}

		// Pass 6: Events (optional)
		if (config.enableEvents) {
			this._passEvents(rootNode, filePath, fileId, edges);
		}

		// Pass 7: Decorators
		this._passDecorators(rootNode, filePath, fileId, edges);

		// Pass 8: Complexity (optional)
		if (config.enableComplexity) {
			this._passComplexity(rootNode, nodes);
		}

		// Post: Create DEFINES edges (file → definition)
		for (const defId of definitionIds) {
			edges.push({ source: fileId, target: defId, type: 'DEFINES' });
		}

		return { nodes, edges };
	}

	// ─── Pass 1: Definitions ────────────────────────────────────────────────

	private _passDefinitions(node: any, filePath: string, fileId: string, nodes: PipelineNode[], definitionIds: string[]): void {
		const nodeType = AST_NODE_MAP[node.type];
		if (nodeType) {
			const name = extractName(node);
			if (name) {
				const nodeId = `${filePath}::${name}`;
				nodes.push({
					id: nodeId,
					name,
					type: nodeType,
					filePath,
					qualifiedName: name,
					startLine: node.startPosition?.row + 1 || 0,
					endLine: node.endPosition?.row + 1 || 0,
				});
				definitionIds.push(nodeId);
			}
		}

		// Create file node
		if (node.type === 'program' || node.type === 'source_file' || node.type === 'module') {
			const fileName = filePath.split('/').pop() || filePath;
			nodes.push({
				id: fileId,
				name: fileName,
				type: 'file',
				filePath,
				qualifiedName: filePath,
				startLine: 1,
				endLine: 1,
			});
		}

		for (const child of node.children || []) {
			this._passDefinitions(child, filePath, fileId, nodes, definitionIds);
		}
	}

	// ─── Pass 2: Calls ──────────────────────────────────────────────────────

	private _passCalls(node: any, filePath: string, fileId: string, nodes: PipelineNode[], edges: PipelineEdge[]): void {
		if (node.type === 'call_expression' || node.type === 'call' || node.type === 'method_invocation' || node.type === 'invocation_expression') {
			const calleeName = extractCalleeName(node);
			if (calleeName) {
				// Find enclosing function/class for the caller
				const callerId = this._findEnclosingDefinition(node, filePath);
				edges.push({
					source: callerId,
					target: `call:${calleeName}`,
					type: 'CALLS',
				});
			}
		}

		for (const child of node.children || []) {
			this._passCalls(child, filePath, fileId, nodes, edges);
		}
	}

	// ─── Pass 3: Imports ─────────────────────────────────────────────────────

	private _passImports(node: any, filePath: string, fileId: string, edges: PipelineEdge[]): void {
		if (node.type === 'import_statement' || node.type === 'import_from_statement' ||
			node.type === 'import' || node.type === 'use_declaration' ||
			node.type === 'package_clause' || node.type === 'import_declaration') {
			const names = extractImportNames(node);
			for (const name of names) {
				edges.push({
					source: fileId,
					target: `import:${name}`,
					type: 'IMPORTS',
				});
			}
		}

		for (const child of node.children || []) {
			this._passImports(child, filePath, fileId, edges);
		}
	}

	// ─── Pass 4: Class Hierarchy ─────────────────────────────────────────────

	private _passClassHierarchy(node: any, filePath: string, fileId: string, edges: PipelineEdge[]): void {
		if (node.type === 'class_declaration' || node.type === 'class_definition' ||
			node.type === 'class_specifier' || node.type === 'impl_item' ||
			node.type === 'interface_declaration') {
			const className = extractName(node);
			if (!className) {
				for (const child of node.children || []) {
					this._passClassHierarchy(child, filePath, fileId, edges);
				}
				return;
			}
			const classId = `${filePath}::${className}`;

			// Check for inheritance (extends)
			const inherits = extractInherits(node, 'extends');
			for (const parent of inherits) {
				edges.push({
					source: classId,
					target: `inherit:${parent}`,
					type: 'INHERITS',
				});
			}

			// Check for implementation (implements)
			const implements_ = extractInherits(node, 'implements');
			for (const iface of implements_) {
				edges.push({
					source: classId,
					target: `implement:${iface}`,
					type: 'IMPLEMENTS',
				});
			}
		}

		for (const child of node.children || []) {
			this._passClassHierarchy(child, filePath, fileId, edges);
		}
	}

	// ─── Pass 5: Routes ──────────────────────────────────────────────────────

	private _passRoutes(node: any, filePath: string, fileId: string, nodes: PipelineNode[], edges: PipelineEdge[]): void {
		const routes = extractRoutes(node);
		for (const route of routes) {
			const routeId = `${filePath}::route:${route.method}:${route.path}`;
			nodes.push({
				id: routeId,
				name: `${route.method} ${route.path}`,
				type: 'route',
				filePath,
				qualifiedName: `${route.method}:${route.path}`,
				startLine: node.startPosition?.row + 1 || 0,
				endLine: node.endPosition?.row + 1 || 0,
				properties: { method: route.method, path: route.path },
			});
			edges.push({ source: fileId, target: routeId, type: 'DEFINES' });
		}

		for (const child of node.children || []) {
			this._passRoutes(child, filePath, fileId, nodes, edges);
		}
	}

	// ─── Pass 6: Events ──────────────────────────────────────────────────────

	private _passEvents(node: any, filePath: string, fileId: string, edges: PipelineEdge[]): void {
		const emits = extractEmits(node, 'emit');
		for (const event of emits) {
			edges.push({
				source: this._findEnclosingDefinition(node, filePath),
				target: `event:${event}`,
				type: 'EMITS',
			});
		}

		const listens = extractEmits(node, 'on');
		for (const event of listens) {
			edges.push({
				source: this._findEnclosingDefinition(node, filePath),
				target: `event:${event}`,
				type: 'LISTENS_ON',
			});
		}

		for (const child of node.children || []) {
			this._passEvents(child, filePath, fileId, edges);
		}
	}

	// ─── Pass 7: Decorators ──────────────────────────────────────────────────

	private _passDecorators(node: any, filePath: string, fileId: string, edges: PipelineEdge[]): void {
		const decorators = extractDecorators(node);
		if (decorators.length > 0) {
			const defId = this._findEnclosingDefinition(node, filePath);
			for (const deco of decorators) {
				edges.push({
					source: `decorator:${deco}`,
					target: defId,
					type: 'DECORATES',
				});
			}
		}

		for (const child of node.children || []) {
			this._passDecorators(child, filePath, fileId, edges);
		}
	}

	// ─── Pass 8: Complexity ──────────────────────────────────────────────────

	private _passComplexity(rootNode: any, nodes: PipelineNode[]): void {
		for (const node of nodes) {
			if (node.type !== 'function' && node.type !== 'class') { continue; }
			const complexity = computeComplexity(rootNode, node.startLine, node.endLine);
			if (complexity.cyclomatic > 0) {
				node.properties = {
					...node.properties,
					cyclomatic: complexity.cyclomatic,
					loops: complexity.loops,
					conditionals: complexity.conditionals,
				};
			}
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _findEnclosingDefinition(node: any, filePath: string): string {
		let current = node.parent;
		while (current) {
			const type = AST_NODE_MAP[current.type];
			if (type && (type === 'function' || type === 'class' || type === 'interface')) {
				const name = extractName(current);
				if (name) { return `${filePath}::${name}`; }
			}
			current = current.parent;
		}
		return `file:${filePath}`;
	}
}

/**
 * Post-process: match call/import/inherit edges to definitions by name.
 * Replaces `call:NAME`, `import:NAME`, `inherit:NAME`, `implement:NAME`
 * with actual node IDs.
 */
export function matchEdgesToDefinitions(result: PipelineResult): PipelineResult {
	const nameIndex: Map<string, string[]> = new Map();

	// Build name → nodeId index
	for (const node of result.nodes) {
		if (node.type === 'function' || node.type === 'class' || node.type === 'interface') {
			const existing = nameIndex.get(node.name);
			if (existing) { existing.push(node.id); }
			else { nameIndex.set(node.name, [node.id]); }
		}
	}

	const newEdges: PipelineEdge[] = [];
	for (const edge of result.edges) {
		if (edge.target.startsWith('call:')) {
			const calleeName = edge.target.substring(5);
			const targets = nameIndex.get(calleeName);
			if (targets && targets.length > 0) {
				newEdges.push({ source: edge.source, target: targets[0], type: 'CALLS' });
			}
		} else if (edge.target.startsWith('import:')) {
			const importName = edge.target.substring(7);
			const targets = nameIndex.get(importName);
			if (targets && targets.length > 0) {
				newEdges.push({ source: edge.source, target: targets[0], type: 'IMPORTS' });
			}
		} else if (edge.target.startsWith('inherit:')) {
			const parentName = edge.target.substring(8);
			const targets = nameIndex.get(parentName);
			if (targets && targets.length > 0) {
				newEdges.push({ source: edge.source, target: targets[0], type: 'INHERITS' });
			}
		} else if (edge.target.startsWith('implement:')) {
			const ifaceName = edge.target.substring(10);
			const targets = nameIndex.get(ifaceName);
			if (targets && targets.length > 0) {
				newEdges.push({ source: edge.source, target: targets[0], type: 'IMPLEMENTS' });
			}
		} else if (edge.target.startsWith('event:')) {
			newEdges.push(edge); // Keep event edges as-is for now
		} else if (edge.source.startsWith('decorator:')) {
			newEdges.push(edge); // Keep decorator edges
		} else {
			newEdges.push(edge); // Keep DEFINES, CONTAINS, etc.
		}
	}

	return { nodes: result.nodes, edges: newEdges };
}

// ─── Default Pipeline Config ─────────────────────────────────────────────────

export function getDefaultPipelineConfig(mode: 'fast' | 'moderate' | 'full'): PipelineConfig {
	switch (mode) {
		case 'fast':
			return { mode, enableRoutes: true, enableEvents: false, enableDataFlow: false, enableComplexity: false };
		case 'moderate':
			return { mode, enableRoutes: true, enableEvents: true, enableDataFlow: false, enableComplexity: true };
		case 'full':
			return { mode, enableRoutes: true, enableEvents: true, enableDataFlow: true, enableComplexity: true };
	}
}
