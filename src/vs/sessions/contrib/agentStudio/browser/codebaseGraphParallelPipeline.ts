/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parallel Pipeline — 三阶段并行管线。
 *
 * 对标 codebase-memory-mcp 的 pass_parallel.c (115KB C)。
 *
 * 三阶段：
 * - Phase 3A: 并行提取（per-worker GraphBuffer，文件级隔离）
 * - Phase 3B: 串行注册表构建（合并 GraphBuffer + 构建名称索引）
 * - Phase 4:  并行调用/用法/语义解析（基于注册表）
 *
 * VS Code renderer 进程无真线程，使用 Promise.all 分批实现 IO 并发。
 */

import { GraphBuffer } from './codebaseGraphBuffer.js';
import { CodebaseGraphStore } from './codebaseGraphStore.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface IPipelineConfig {
	mode: 'fast' | 'moderate' | 'full';
	excludeDirs: string[];
	enableUsages: boolean;
	enableSemanticEdges: boolean;
	enableSimilarity: boolean;
	enableTests: boolean;
}

export interface IPipelineResult {
	filesProcessed: number;
	nodesExtracted: number;
	edgesExtracted: number;
	duration: number;
}

export type FileParserFn = (
	filePath: string,
	token: CancellationToken,
) => Promise<{ nodes: any[]; edges: any[] }>;

export class ParallelPipeline {
	private readonly _batchSize: number;

	constructor(
		private _logService: ILogService,
		batchSize: number = 8,
	) {
		this._batchSize = batchSize;
	}

	/**
	 * Run the three-phase parallel pipeline.
	 *
	 * @param files Files to parse
	 * @param parseFile Function that parses a single file into nodes+edges
	 * @param store Target store to dump results
	 * @param project Project name
	 * @param config Pipeline config
	 * @param token Cancellation token
	 */
	async run(
		files: string[],
		parseFile: FileParserFn,
		store: CodebaseGraphStore,
		project: string,
		config: IPipelineConfig,
		token: CancellationToken,
	): Promise<IPipelineResult> {
		const startTime = Date.now();
		const LOG_TAG = '[ParallelPipeline]';

		// ─── Phase 3A: Parallel Extract ──────────────────────────────────
		this._logService.info(LOG_TAG, `Phase 3A: Extracting ${files.length} files (batch=${this._batchSize})...`);

		const workerBuffers: GraphBuffer[] = [];
		const batches = this._chunk(files, this._batchSize);
		let filesProcessed = 0;

		for (const batch of batches) {
			if (token.isCancellationRequested) { break; }

			// Parse all files in batch concurrently (IO parallelism)
			const batchResults = await Promise.all(
				batch.map(async (filePath) => {
					try {
						const result = await parseFile(filePath, token);
						return { filePath, result, error: undefined as string | undefined };
					} catch (err: any) {
						return { filePath, result: { nodes: [], edges: [] }, error: err?.message || String(err) };
					}
				})
			);

			// Each file gets its own GraphBuffer (worker isolation)
			for (const { filePath, result, error } of batchResults) {
				if (error) {
					this._logService.debug(LOG_TAG, `Parse failed: ${filePath}: ${error}`);
					continue;
				}

				const gbuf = new GraphBuffer();
				for (const node of result.nodes) {
					gbuf.addNode(node.type || node.label || 'unknown', node.name, node.qualifiedName || node.id, {
						filePath: node.filePath,
						startLine: node.startLine,
						endLine: node.endLine,
						properties: node.properties,
					});
				}
				for (const edge of result.edges) {
					// Edges may reference nodes by string ID — need to resolve to local IDs
					// For now, store edges as-is; they'll be matched in Phase 3B
					const srcNode = gbuf.findByQN(edge.source);
					const tgtNode = gbuf.findByQN(edge.target);
					if (srcNode && tgtNode) {
						gbuf.addEdge(srcNode.localId, tgtNode.localId, edge.type);
					}
				}

				workerBuffers.push(gbuf);
				filesProcessed++;
			}

			if (filesProcessed % 100 < this._batchSize) {
				this._logService.info(LOG_TAG, `  Progress: ${filesProcessed}/${files.length} files`);
			}
		}

		// ─── Phase 3B: Serial Merge + Registry Build ─────────────────────
		this._logService.info(LOG_TAG, `Phase 3B: Merging ${workerBuffers.length} buffers...`);

		const mainBuffer = new GraphBuffer();
		for (const gbuf of workerBuffers) {
			gbuf.mergeInto(mainBuffer);
			gbuf.clear(); // Free memory
		}

		this._logService.info(LOG_TAG, `  Merged: ${mainBuffer.size.nodes} nodes, ${mainBuffer.size.edges} edges`);

		// ─── Phase 4: Parallel Resolve (calls/usages/semantic) ───────────
		// In the original C implementation, this resolves call targets using
		// the global name index. In our TS implementation, edge matching
		// happens in codebaseGraphService._matchCallsToDefinitions().
		// Here we just dump to store.

		this._logService.info(LOG_TAG, `Phase 4: Dumping to store...`);
		mainBuffer.dumpToStore(store, project);

		const nodesExtracted = mainBuffer.size.nodes;
		const edgesExtracted = mainBuffer.size.edges;

		mainBuffer.clear();

		const duration = (Date.now() - startTime) / 1000;
		this._logService.info(LOG_TAG, `Complete: ${filesProcessed} files, ${nodesExtracted} nodes, ${edgesExtracted} edges (${duration.toFixed(1)}s)`);

		return {
			filesProcessed,
			nodesExtracted,
			edgesExtracted,
			duration,
		};
	}

	/** Split array into chunks */
	private _chunk<T>(arr: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < arr.length; i += size) {
			chunks.push(arr.slice(i, i + size));
		}
		return chunks;
	}

	/** Get default pipeline config for a mode */
	static getDefaultConfig(mode: 'fast' | 'moderate' | 'full'): IPipelineConfig {
		switch (mode) {
			case 'fast':
				return { mode: 'fast', excludeDirs: [], enableUsages: false, enableSemanticEdges: false, enableSimilarity: false, enableTests: true };
			case 'moderate':
				return { mode: 'moderate', excludeDirs: [], enableUsages: true, enableSemanticEdges: false, enableSimilarity: false, enableTests: true };
			case 'full':
				return { mode: 'full', excludeDirs: [], enableUsages: true, enableSemanticEdges: true, enableSimilarity: true, enableTests: true };
		}
	}
}
