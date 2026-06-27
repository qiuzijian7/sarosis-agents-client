/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph Buffer — 并行管线中间层。
 *
 * 对标 codebase-memory-mcp 的 graph_buffer.c (56KB C)。
 *
 * 设计目的：
 * 1. 并行管线中每个 worker 独立写入 gbuf，最后 merge 到主 gbuf
 * 2. 原子 ID 分配（per-gbuf 自增，merge 时重映射）
 * 3. 批量 dump 到 CodebaseGraphStore
 * 4. properties_json 增量更新
 *
 * 生命周期：
 *   worker gbuf → mergeInto(main gbuf) → dumpToStore(store)
 */

import type { GraphNode, GraphEdge } from './codebaseGraphStore.js';

export interface GraphBufferNode {
	localId: number;           // per-gbuf local ID
	label: string;
	name: string;
	qualifiedName: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
	properties?: Record<string, any>;
}

export interface GraphBufferEdge {
	localSourceId: number;     // references local node IDs
	localTargetId: number;
	type: string;
	properties?: Record<string, any>;
}

export class GraphBuffer {
	private _nodes: Map<number, GraphBufferNode> = new Map();
	private _edges: GraphBufferEdge[] = [];
	private _nextLocalId = 1;
	private _qnIndex: Map<string, number> = new Map();  // qualifiedName → localId

	/** Add a node to the buffer. Returns local ID. */
	addNode(label: string, name: string, qualifiedName: string, opts?: {
		filePath?: string;
		startLine?: number;
		endLine?: number;
		properties?: Record<string, any>;
	}): number {
		// Dedup by qualifiedName within this buffer
		const existing = this._qnIndex.get(qualifiedName);
		if (existing !== undefined) { return existing; }

		const localId = this._nextLocalId++;
		const node: GraphBufferNode = {
			localId,
			label,
			name,
			qualifiedName,
			...opts,
		};
		this._nodes.set(localId, node);
		this._qnIndex.set(qualifiedName, localId);
		return localId;
	}

	/** Add an edge to the buffer. */
	addEdge(localSourceId: number, localTargetId: number, type: string, properties?: Record<string, any>): void {
		this._edges.push({ localSourceId, localTargetId, type, properties });
	}

	/** Merge this buffer into a destination buffer. Returns ID mapping (src localId → dst localId). */
	mergeInto(dst: GraphBuffer): Map<number, number> {
		const idMap = new Map<number, number>();

		// Merge nodes
		for (const node of this._nodes.values()) {
			const dstLocalId = dst.addNode(node.label, node.name, node.qualifiedName, {
				filePath: node.filePath,
				startLine: node.startLine,
				endLine: node.endLine,
				properties: node.properties,
			});
			idMap.set(node.localId, dstLocalId);
		}

		// Merge edges (remap local IDs)
		for (const edge of this._edges) {
			const srcId = idMap.get(edge.localSourceId);
			const tgtId = idMap.get(edge.localTargetId);
			if (srcId !== undefined && tgtId !== undefined) {
				dst.addEdge(srcId, tgtId, edge.type, edge.properties);
			}
		}

		return idMap;
	}

	/**
	 * Dump buffer contents to CodebaseGraphStore.
	 * Returns the mapping from local IDs to store (global) IDs.
	 */
	dumpToStore(
		store: { upsertNode: (n: any) => GraphNode; insertEdge: (e: any) => GraphEdge | null },
		project: string,
	): Map<number, number> {
		const idMap = new Map<number, number>();  // localId → store globalId

		// Dump nodes
		for (const node of this._nodes.values()) {
			const storeNode = store.upsertNode({
				project,
				label: node.label,
				name: node.name,
				qualifiedName: node.qualifiedName,
				filePath: node.filePath,
				startLine: node.startLine,
				endLine: node.endLine,
				properties: node.properties,
			});
			idMap.set(node.localId, storeNode.id);
		}

		// Dump edges (remap local IDs to store global IDs)
		for (const edge of this._edges) {
			const sourceId = idMap.get(edge.localSourceId);
			const targetId = idMap.get(edge.localTargetId);
			if (sourceId !== undefined && targetId !== undefined) {
				store.insertEdge({
					project,
					sourceId,
					targetId,
					type: edge.type,
					properties: edge.properties,
				});
			}
		}

		return idMap;
	}

	/** Clear the buffer. */
	clear(): void {
		this._nodes.clear();
		this._edges = [];
		this._nextLocalId = 1;
		this._qnIndex.clear();
	}

	/** Get buffer size. */
	get size(): { nodes: number; edges: number } {
		return { nodes: this._nodes.size, edges: this._edges.length };
	}

	/** Get all nodes (for iteration). */
	getNodes(): IterableIterator<GraphBufferNode> {
		return this._nodes.values();
	}

	/** Get all edges. */
	getEdges(): GraphBufferEdge[] {
		return this._edges;
	}

	/** Find a node by qualified name within this buffer. */
	findByQN(qualifiedName: string): GraphBufferNode | undefined {
		const localId = this._qnIndex.get(qualifiedName);
		return localId !== undefined ? this._nodes.get(localId) : undefined;
	}

	/** Serialize to JSON for debugging. */
	toJSON(): any {
		return {
			nodes: Array.from(this._nodes.values()),
			edges: this._edges,
			nextLocalId: this._nextLocalId,
		};
	}
}
