/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Trace Ingestion — OTLP 运行时 trace 摄入，增强知识图谱。
 *
 * 对标 codebase-memory-mcp 的 ingest_traces MCP 工具。
 * 解析 OpenTelemetry span 数据，将运行时调用关系添加为图边。
 */

import type { CodebaseGraphStore } from './codebaseGraphStore.js';

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
	startTime: number;  // nanoseconds
	endTime: number;
	attributes: { [key: string]: string };
	status: { code: string; message?: string };
	resource?: { [key: string]: string };
}

export interface TraceEdge {
	sourceFunction: string;
	targetFunction: string;
	edgeType: string;  // CALLS, HTTP_CALLS, ASYNC_CALLS, DATA_FLOWS
	latency: number;   // average ms
	count: number;      // number of traces
	errorRate: number; // 0-1
	properties: Record<string, any>;
}

export class TraceIngester {
	private _traces: OtlpSpan[] = [];

	/**
	 * Ingest OTLP JSON trace data.
	 */
	ingest(jsonData: string): number {
		try {
			const data = JSON.parse(jsonData);
			const spans: OtlpSpan[] = [];

			// Handle OTLP JSON format
			if (data.resourceSpans) {
				for (const rs of data.resourceSpans) {
					const resource = rs.resource?.attributes?.reduce((acc: any, attr: any) => {
						acc[attr.key] = attr.value?.stringValue || attr.value?.intValue?.toString() || '';
						return acc;
					}, {});

					for (const ss of rs.scopeSpans || []) {
						for (const span of ss.spans || []) {
							spans.push(this._parseSpan(span, resource));
						}
					}
				}
			}
			// Handle flat array format
			else if (Array.isArray(data)) {
				for (const span of data) {
					spans.push(this._parseSpan(span));
				}
			}

			this._traces.push(...spans);
			return spans.length;
		} catch { return 0; }
	}

	private _parseSpan(span: any, resource?: { [key: string]: string }): OtlpSpan {
		const attributes: { [key: string]: string } = {};
		if (span.attributes) {
			for (const attr of span.attributes) {
				attributes[attr.key] = attr.value?.stringValue || attr.value?.intValue?.toString() || '';
			}
		}

		return {
			traceId: span.traceId || '',
			spanId: span.spanId || '',
			parentSpanId: span.parentSpanId,
			name: span.name || 'unknown',
			kind: this._parseSpanKind(span.kind),
			startTime: parseInt(span.startTimeUnixNano || span.startTime || '0'),
			endTime: parseInt(span.endTimeUnixNano || span.endTime || '0'),
			attributes,
			status: { code: span.status?.code || 'OK', message: span.status?.message },
			resource,
		};
	}

	private _parseSpanKind(kind: number | string): OtlpSpan['kind'] {
		const map: { [key: string]: OtlpSpan['kind'] } = {
			'0': 'unspecified', '1': 'internal', '2': 'server', '3': 'client',
			'4': 'producer', '5': 'consumer',
		};
		return map[String(kind)] || 'internal';
	}

	/**
	 * Convert ingested traces to graph edges.
	 */
	toGraphEdges(): TraceEdge[] {
		const edgeMap: Map<string, TraceEdge> = new Map();

		// Build span tree
		const spanById: Map<string, OtlpSpan> = new Map();
		for (const span of this._traces) {
			spanById.set(span.spanId, span);
		}

		for (const span of this._traces) {
			if (!span.parentSpanId) { continue; }
			const parent = spanById.get(span.parentSpanId);
			if (!parent) { continue; }

			const key = `${parent.name}→${span.name}:${span.kind}`;
			const existing = edgeMap.get(key);

			const latency = span.endTime > span.startTime
				? (span.endTime - span.startTime) / 1_000_000  // ns to ms
				: 0;

			if (existing) {
				existing.count++;
				existing.latency = (existing.latency * (existing.count - 1) + latency) / existing.count;
				if (span.status.code !== 'OK') { existing.errorRate = (existing.errorRate * (existing.count - 1) + 1) / existing.count; }
			} else {
				const edgeType = span.kind === 'client' ? 'HTTP_CALLS' :
					span.kind === 'producer' || span.kind === 'consumer' ? 'ASYNC_CALLS' : 'CALLS';
				edgeMap.set(key, {
					sourceFunction: parent.name,
					targetFunction: span.name,
					edgeType,
					latency,
					count: 1,
					errorRate: span.status.code !== 'OK' ? 1 : 0,
					properties: {
						traceId: span.traceId,
						attributes: span.attributes,
						resource: span.resource,
					},
				});
			}
		}

		return Array.from(edgeMap.values());
	}

	clear(): void {
		this._traces = [];
	}

	get spanCount(): number { return this._traces.length; }

	/**
	 * Write trace edges to the graph store (P1 enhancement).
	 * Creates CALLS/HTTP_CALLS/ASYNC_CALLS edges with runtime telemetry properties.
	 */
	writeToStore(store: CodebaseGraphStore, project: string): number {
		const edges = this.toGraphEdges();
		let written = 0;

		for (const edge of edges) {
			// Find source and target nodes by function name
			const sourceNodes = store.search({
				project,
				namePattern: escapeRegex(edge.sourceFunction),
				limit: 5,
			});
			const targetNodes = store.search({
				project,
				namePattern: escapeRegex(edge.targetFunction),
				limit: 5,
			});

			if (sourceNodes.nodes.length > 0 && targetNodes.nodes.length > 0) {
				const inserted = store.insertEdge({
					project,
					sourceId: sourceNodes.nodes[0].id,
					targetId: targetNodes.nodes[0].id,
					type: edge.edgeType,
					properties: {
						source: 'runtime-trace',
						latencyMs: edge.latency,
						callCount: edge.count,
						errorRate: edge.errorRate,
						traceAttributes: edge.properties?.attributes,
					},
				});
				if (inserted) { written++; }
			}
		}

		return written;
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
