/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extended Passes — 扩展解析 Pass 集合。
 *
 * 包含：pass_usages, pass_tests, pass_similarity, pass_compile_commands。
 * 对标 codebase-memory-mcp 的 pass_usages.c, pass_tests.c, pass_similarity.c, pass_compile_commands.c。
 */

import { PipelineEdge } from './codebaseGraphPipeline.js';

// ─── Pass: Usages (变量/类型引用边) ─────────────────────────────────────────

export function passUsages(rootNode: any, filePath: string, fileId: string): PipelineEdge[] {
	const edges: PipelineEdge[] = [];

	const visit = (node: any) => {
		// Type references: variable with type annotation
		if (node.type === 'type_annotation' || node.type === 'type_identifier') {
			const typeName = node.text;
			if (typeName && typeName[0] === typeName[0].toUpperCase()) {
				// Likely a type reference
				const callerId = _findEnclosingDef(node, filePath);
				edges.push({ source: callerId, target: `usage:${typeName}`, type: 'USAGE' });
			}
		}

		// New expressions: new ClassName()
		if (node.type === 'new_expression') {
			const ctorNode = node.childForFieldName('constructor');
			if (ctorNode) {
				const callerId = _findEnclosingDef(node, filePath);
				edges.push({ source: callerId, target: `usage:${ctorNode.text}`, type: 'USAGE' });
			}
		}

		// Member access: obj.method (potential usage)
		if (node.type === 'member_expression' || node.type === 'field_expression') {
			const propNode = node.childForFieldName('property') || node.childForFieldName('field');
			if (propNode && propNode.type === 'property_identifier') {
				// Only track if it's a method call (parent is call_expression)
				if (node.parent && node.parent.type === 'call_expression') {
					const callerId = _findEnclosingDef(node, filePath);
					edges.push({ source: callerId, target: `usage:${propNode.text}`, type: 'USAGE' });
				}
			}
		}

		for (const child of node.children || []) { visit(child); }
	};

	visit(rootNode);
	return edges;
}

// ─── Pass: Tests (测试文件/函数检测) ───────────────────────────────────────────

export interface TestInfo {
	filePath: string;
	isTestFile: boolean;
	testFunctions: { name: string; startLine: number }[];
	testSuites: { name: string; startLine: number }[];
}

export function passTests(rootNode: any, filePath: string): TestInfo {
	const testFunctions: { name: string; startLine: number }[] = [];
	const testSuites: { name: string; startLine: number }[] = [];
	const isTestFile = /\.(test|spec)\.(ts|js|py|go|rs|java|rb|cs|php)$/i.test(filePath) ||
		filePath.includes('/test/') || filePath.includes('/tests/') || filePath.includes('__tests__/');

	const visit = (node: any) => {
		// Jest/Vitest/Mocha: test('name', fn) or it('name', fn)
		if (node.type === 'call_expression') {
			const funcNode = node.childForFieldName('function');
			if (funcNode && (funcNode.type === 'identifier' || funcNode.type === 'member_expression')) {
				const funcName = funcNode.type === 'identifier' ? funcNode.text :
					(funcNode.childForFieldName('property')?.text || '');
				if (/^(test|it|describe|beforeEach|afterEach|beforeAll|afterAll)$/i.test(funcName)) {
					const args = node.childForFieldName('arguments');
					if (args && args.children && args.children[0]) {
						const firstArg = args.children[0];
						if (firstArg.type === 'string' || firstArg.type === 'string_literal') {
							const testName = firstArg.text.replace(/['"`]/g, '');
							if (funcName === 'describe') {
								testSuites.push({ name: testName, startLine: node.startPosition?.row + 1 || 0 });
							} else {
								testFunctions.push({ name: testName, startLine: node.startPosition?.row + 1 || 0 });
							}
						}
					}
				}
			}
		}

		// Python: def test_*
		if (node.type === 'function_definition') {
			const nameNode = node.childForFieldName('name');
			if (nameNode && nameNode.text.startsWith('test_')) {
				testFunctions.push({ name: nameNode.text, startLine: node.startPosition?.row + 1 || 0 });
			}
		}

		// Go: func TestXxx
		if (node.type === 'function_declaration') {
			const nameNode = node.childForFieldName('name');
			if (nameNode && nameNode.text.startsWith('Test')) {
				testFunctions.push({ name: nameNode.text, startLine: node.startPosition?.row + 1 || 0 });
			}
		}

		for (const child of node.children || []) { visit(child); }
	};

	visit(rootNode);
	return { filePath, isTestFile, testFunctions, testSuites };
}

// ─── Pass: Similarity (MinHash 近似克隆检测) ──────────────────────────────────

export interface SimilarityResult {
	sourceId: string;
	targetId: string;
	similarity: number;  // 0-1 Jaccard similarity
}

const NUM_HASHES = 128;
const HASH_SEEDS: number[] = Array.from({ length: NUM_HASHES }, (_, i) => (i + 1) * 2654435761);

/**
 * Compute MinHash signature for a function body.
 * Uses token n-grams as shingles.
 */
export function computeMinHash(sourceCode: string): number[] {
	const tokens = _tokenize(sourceCode);
	const shingles = _shingles(tokens, 3);
	const signature = new Array(NUM_HASHES).fill(Infinity);

	for (const shingle of shingles) {
		const hash = _hashString(shingle);
		for (let i = 0; i < NUM_HASHES; i++) {
			const h = (hash ^ HASH_SEEDS[i]) >>> 0;
			if (h < signature[i]) { signature[i] = h; }
		}
	}

	return signature;
}

/**
 * Compare two MinHash signatures via Jaccard similarity.
 */
export function minHashSimilarity(sigA: number[], sigB: number[]): number {
	if (sigA.length !== sigB.length || sigA.length === 0) { return 0; }
	let matches = 0;
	for (let i = 0; i < sigA.length; i++) {
		if (sigA[i] === sigB[i]) { matches++; }
	}
	return matches / sigA.length;
}

/**
 * Find similar functions (approximate clones).
 */
export function findSimilarFunctions(
	functions: { id: string; source: string }[],
	threshold: number = 0.7
): SimilarityResult[] {
	const signatures = functions.map(f => ({ id: f.id, sig: computeMinHash(f.source) }));
	const results: SimilarityResult[] = [];

	for (let i = 0; i < signatures.length; i++) {
		for (let j = i + 1; j < signatures.length; j++) {
			const sim = minHashSimilarity(signatures[i].sig, signatures[j].sig);
			if (sim >= threshold) {
				results.push({
					sourceId: signatures[i].id,
					targetId: signatures[j].id,
					similarity: sim,
				});
			}
		}
	}

	return results.sort((a, b) => b.similarity - a.similarity);
}

// ─── Pass: Compile Commands (C/C++ 精确头文件解析) ───────────────────────────

export interface CompileCommand {
	directory: string;
	file: string;
	arguments: string[];
	includes: string[];
	defines: { [key: string]: string };
}

/**
 * Parse compile_commands.json for C/C++ precise header resolution.
 */
export function parseCompileCommands(jsonContent: string): CompileCommand[] {
	try {
		const data = JSON.parse(jsonContent) as any[];
		return data.map(entry => {
			const args = entry.arguments || (entry.command ? entry.command.split(/\s+/) : []);
			const includes: string[] = [];
			const defines: { [key: string]: string } = {};

			for (let i = 0; i < args.length; i++) {
				if (args[i] === '-I' && i + 1 < args.length) {
					includes.push(args[++i]);
				} else if (args[i].startsWith('-I')) {
					includes.push(args[i].substring(2));
				} else if (args[i] === '-D' && i + 1 < args.length) {
					const def = args[++i];
					const [key, ...valParts] = def.split('=');
					defines[key] = valParts.join('=') || '1';
				} else if (args[i].startsWith('-D')) {
					const def = args[i].substring(2);
					const [key, ...valParts] = def.split('=');
					defines[key] = valParts.join('=') || '1';
				}
			}

			return {
				directory: entry.directory || '',
				file: entry.file || '',
				arguments: args,
				includes,
				defines,
			};
		});
	} catch { return []; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _findEnclosingDef(node: any, filePath: string): string {
	let current = node.parent;
	while (current) {
		if (['function_declaration', 'function_definition', 'method_definition', 'method_declaration', 'function_item'].includes(current.type)) {
			const nameNode = current.childForFieldName('name');
			if (nameNode) { return `${filePath}::${nameNode.text}`; }
		}
		current = current.parent;
	}
	return `file:${filePath}`;
}

function _tokenize(code: string): string[] {
	return code
		.replace(/\/\/[^\n]*/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/#[^\n]*/g, '')
		.split(/[\s{}()\[\];,.<>:='"`!?@#$%^&*+\-|\\/]+/)
		.filter(t => t.length > 0)
		.map(t => t.toLowerCase());
}

function _shingles(tokens: string[], n: number): string[] {
	const shingles: string[] = [];
	for (let i = 0; i <= tokens.length - n; i++) {
		shingles.push(tokens.slice(i, i + n).join(' '));
	}
	return shingles.length > 0 ? shingles : [tokens.join(' ')];
}

function _hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return hash >>> 0;
}
