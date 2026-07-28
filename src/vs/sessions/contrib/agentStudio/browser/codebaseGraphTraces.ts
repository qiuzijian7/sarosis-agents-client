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

/**
 * 简化 trace 摄入格式（P2 — 兼容上游 `ingest_traces` 的轻量入口）。
 * 适用于没有完整 OTLP span 树、只有调用计数统计的场景：
 *   [{ "caller": "foo", "callee": "bar", "count": 42, "edgeType": "CALLS" }]
 */
export interface SimpleTrace {
	caller: string;
	callee: string;
	count?: number;       // 调用次数，默认 1
	edgeType?: string;    // CALLS | HTTP_CALLS | ASYNC_CALLS | DATA_FLOWS，默认 CALLS
	latencyMs?: number;   // 平均耗时（ms）
	errorRate?: number;   // 0-1
}

/** ingest 后归一化的简化 trace（字段已补全默认值，供内部边生成使用）。 */
interface ResolvedSimpleTrace {
	caller: string;
	callee: string;
	count: number;
	edgeType: string;
	latencyMs?: number;
	errorRate: number;
}

export class TraceIngester {
	private _traces: OtlpSpan[] = [];
	private _simpleTraces: ResolvedSimpleTrace[] = [];

	/**
	 * Ingest OTLP JSON trace data, or a simplified `[{caller,callee,count}]` array.
	 * Returns the number of ingested entries (spans or simple pairs).
	 */
	ingest(jsonData: string): number {
		try {
			const data = JSON.parse(jsonData);

			// Simplified trace format: [{caller, callee, count}]  (P2 — 兼容上游轻量摄入)
			if (Array.isArray(data) && this._isSimpleTraceArray(data)) {
				let added = 0;
				for (const t of data) {
					if (t && typeof t.caller === 'string' && typeof t.callee === 'string') {
						this._simpleTraces.push({
							caller: t.caller,
							callee: t.callee,
							count: typeof t.count === 'number' && t.count > 0 ? Math.floor(t.count) : 1,
							edgeType: typeof t.edgeType === 'string' ? t.edgeType.toUpperCase() : 'CALLS',
							latencyMs: typeof t.latencyMs === 'number' ? t.latencyMs : undefined,
							errorRate: typeof t.errorRate === 'number' ? Math.min(1, Math.max(0, t.errorRate)) : 0,
						});
						added++;
					}
				}
				return added;
			}

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
	 * Convert ingested traces (OTLP + simplified) to graph edges.
	 */
	toGraphEdges(): TraceEdge[] {
		return [...this._otlpToEdges(), ...this._simpleToEdges()];
	}

	/** OTLP span 树 → 调用边（既有逻辑）。 */
	private _otlpToEdges(): TraceEdge[] {
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

	/** 简化 `[{caller,callee,count}]` 格式 → 聚合调用边。 */
	private _simpleToEdges(): TraceEdge[] {
		const edgeMap: Map<string, TraceEdge> = new Map();
		for (const t of this._simpleTraces) {
			const key = `${t.caller}→${t.callee}:${t.edgeType}`;
			const existing = edgeMap.get(key);
			if (existing) {
				const prevCount = existing.count;
				existing.count += t.count;
				if (t.latencyMs != null) {
					existing.latency = (existing.latency * prevCount + t.latencyMs * t.count) / existing.count;
				}
				existing.errorRate = (existing.errorRate * prevCount + t.errorRate * t.count) / existing.count;
			} else {
				edgeMap.set(key, {
					sourceFunction: t.caller,
					targetFunction: t.callee,
					edgeType: t.edgeType,
					latency: t.latencyMs ?? 0,
					count: t.count,
					errorRate: t.errorRate,
					properties: { source: 'runtime-trace-simple', simple: true },
				});
			}
		}
		return Array.from(edgeMap.values());
	}

	/** 判断数组是否为简化 trace 格式（含 caller/callee，且无 OTLP span 字段）。 */
	private _isSimpleTraceArray(arr: any[]): boolean {
		if (arr.length === 0) { return false; }
		const sample = arr[0];
		return !!sample && typeof sample === 'object'
			&& typeof sample.caller === 'string'
			&& typeof sample.callee === 'string'
			&& sample.traceId === undefined
			&& sample.spanId === undefined;
	}

	clear(): void {
		this._traces = [];
		this._simpleTraces = [];
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
