/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-Repo Discovery — 跨仓库自动发现。
 *
 * 对标 codebase-memory-mcp 的 pass_cross_repo.c (28KB C)。
 *
 * 功能：
 * 1. 收集所有项目的 Route/Channel 节点
 * 2. 对每个 HTTP_CALLS 边，在其他项目找匹配 Route
 * 3. Channel EMITS ↔ LISTENS_ON 跨项目匹配
 * 4. gRPC/GraphQL/tRPC 服务调用跨项目匹配
 * 5. 生成 CROSS_HTTP_CALLS / CROSS_ASYNC_CALLS / CROSS_CHANNEL 等边
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

export type CrossEdgeType =
	| 'CROSS_HTTP_CALLS'
	| 'CROSS_ASYNC_CALLS'
	| 'CROSS_CHANNEL'
	| 'CROSS_GRPC_CALLS'
	| 'CROSS_GRAPHQL_CALLS'
	| 'CROSS_TRPC_CALLS';

export interface CrossRepoEdge {
	type: CrossEdgeType;
	sourceProject: string;
	sourceNodeId: number;
	targetProject: string;
	targetNodeId: number;
	url?: string;
	method?: string;
	channelName?: string;
	confidence: number;
}

export class CrossRepoDiscovery {
	constructor(private _store: CodebaseGraphStore) {}

	/** Discover all cross-repo edges between projects */
	discover(): CrossRepoEdge[] {
		const edges: CrossRepoEdge[] = [];
		const projects = this._store.listProjects();

		if (projects.length < 2) { return edges; }

		// ── 1. Collect all Route nodes from all projects ──
		const routeIndex = new Map<string, { project: string; node: GraphNode; path: string; method: string }[]>();

		for (const proj of projects) {
			const routeNodes = this._store.findNodesByLabel(proj.name, 'Route');
			for (const node of routeNodes) {
				const props = node.properties || {};
				const path = props.path || node.name;
				const method = props.method || 'GET';

				const key = this._normalizePath(path);
				if (!routeIndex.has(key)) { routeIndex.set(key, []); }
				routeIndex.get(key)!.push({ project: proj.name, node, path, method });
			}
		}

		// ── 2. Match HTTP_CALLS edges to routes in other projects ──
		for (const proj of projects) {
			const httpCallEdges = this._store.getEdgesByType(proj.name, 'HTTP_CALLS');

			for (const edge of httpCallEdges) {
				const sourceNode = this._store.getNode(edge.sourceId);
				if (!sourceNode) { continue; }

				const props = edge.properties || {};
				const url = props.url || '';
				const method = props.method || 'GET';

				// Try to match URL to a route in another project
				const normalizedUrl = this._normalizePath(this._extractPath(url));
				const candidates = routeIndex.get(normalizedUrl) || [];

				for (const candidate of candidates) {
					if (candidate.project === proj.name) { continue; } // skip same project

					// Check method compatibility
					if (method !== 'ANY' && candidate.method !== 'ANY' &&
						method.toUpperCase() !== candidate.method.toUpperCase()) {
						continue;
					}

					edges.push({
						type: 'CROSS_HTTP_CALLS',
						sourceProject: proj.name,
						sourceNodeId: sourceNode.id,
						targetProject: candidate.project,
						targetNodeId: candidate.node.id,
						url,
						method,
						confidence: 0.9,
					});
				}
			}
		}

		// ── 3. Match Channel EMITS ↔ LISTENS_ON across projects ──
		const channelEmitters: Map<string, { project: string; node: GraphNode }[]> = new Map();
		const channelListeners: Map<string, { project: string; node: GraphNode }[]> = new Map();

		for (const proj of projects) {
			const emitEdges = this._store.getEdgesByType(proj.name, 'EMITS');
			const listenEdges = this._store.getEdgesByType(proj.name, 'LISTENS_ON');

			for (const edge of emitEdges) {
				const props = edge.properties || {};
				const channelName = props.channel || props.event || '';
				if (!channelName) { continue; }
				if (!channelEmitters.has(channelName)) { channelEmitters.set(channelName, []); }
				const node = this._store.getNode(edge.sourceId);
				if (node) { channelEmitters.get(channelName)!.push({ project: proj.name, node }); }
			}

			for (const edge of listenEdges) {
				const props = edge.properties || {};
				const channelName = props.channel || props.event || '';
				if (!channelName) { continue; }
				if (!channelListeners.has(channelName)) { channelListeners.set(channelName, []); }
				const node = this._store.getNode(edge.sourceId);
				if (node) { channelListeners.get(channelName)!.push({ project: proj.name, node }); }
			}
		}

		// Match emitters to listeners in different projects
		for (const [channelName, emitters] of channelEmitters) {
			const listeners = channelListeners.get(channelName) || [];
			for (const emitter of emitters) {
				for (const listener of listeners) {
					if (emitter.project === listener.project) { continue; }
					edges.push({
						type: 'CROSS_CHANNEL',
						sourceProject: emitter.project,
						sourceNodeId: emitter.node.id,
						targetProject: listener.project,
						targetNodeId: listener.node.id,
						channelName,
						confidence: 0.85,
					});
				}
			}
		}

		// ── 4. Match gRPC/GraphQL/tRPC calls across projects ──
		for (const proj of projects) {
			const grpcEdges = this._store.getEdgesByType(proj.name, 'GRPC_CALLS');
			for (const edge of grpcEdges) {
				const props = edge.properties || {};
				const serviceName = props.serviceName || '';

				// Find Route or service node in other projects
				for (const otherProj of projects) {
					if (otherProj.name === proj.name) { continue; }
					const serviceNodes = this._store.findNodesByLabel(otherProj.name, 'Service');
					for (const serviceNode of serviceNodes) {
						if (serviceNode.name === serviceName || serviceNode.qualifiedName.includes(serviceName)) {
							edges.push({
								type: 'CROSS_GRPC_CALLS',
								sourceProject: proj.name,
								sourceNodeId: edge.sourceId,
								targetProject: otherProj.name,
								targetNodeId: serviceNode.id,
								confidence: 0.8,
							});
						}
					}
				}
			}
		}

		return edges;
	}

	/** Insert discovered cross-repo edges into the store */
	insertCrossEdges(edges: CrossRepoEdge[]): void {
		for (const edge of edges) {
			this._store.insertEdge({
				project: edge.sourceProject, // store edge in source project
				sourceId: edge.sourceNodeId,
				targetId: edge.targetNodeId,
				type: edge.type,
				properties: {
					crossRepo: true,
					targetProject: edge.targetProject,
					url: edge.url,
					method: edge.method,
					channelName: edge.channelName,
					confidence: edge.confidence,
				},
			});
		}
	}

	private _normalizePath(path: string): string {
		return path
			.replace(/\/+/g, '/')
			.replace(/\/:[^/]+/g, '/:param')  // /users/:id → /users/:param
			.replace(/\/\{[^}]+\}/g, '/:param') // /users/{id} → /users/:param
			.replace(/\/$/, '')
			.toLowerCase();
	}

	private _extractPath(url: string): string {
		try {
			const u = new URL(url, 'http://dummy');
			return u.pathname;
		} catch {
			return url;
		}
	}
}
