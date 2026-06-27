/*---------------------------------------------------------------------------------------------
 *  诊断 — 记忆系统健康检查。
 *  参考 agentmemory src/functions/diagnostics.ts
 *
 *  检查索引完整性、维度一致性、存储状态等。
 *--------------------------------------------------------------------------------------------*/

import type { BM25Index } from './bm25Index.js';
import type { VectorIndex } from './vectorIndex.js';
import type { KnowledgeGraph } from './knowledgeGraph.js';
import type { AuditLog } from './auditLog.js';

export interface DiagnosticCheck {
	name: string;
	category: string;
	status: 'pass' | 'warn' | 'fail';
	message: string;
	fixable: boolean;
}

export interface DiagnosticResult {
	checks: DiagnosticCheck[];
	overallStatus: 'healthy' | 'degraded' | 'critical';
	summary: string;
}

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	strength: number;
	supersededBy?: string;
	metadata?: Record<string, unknown>;
}

export class Diagnostics {
	run(opts: {
		longTermCount: number;
		shortTermCount: number;
		bm25?: BM25Index;
		vector?: VectorIndex;
		graph?: KnowledgeGraph;
		audit?: AuditLog;
		longEntries: InternalEntry[];
		serverAvailable: boolean;
		pendingWrites: number;
	}): DiagnosticResult {
		const checks: DiagnosticCheck[] = [];

		// 1. Server health
		checks.push({
			name: 'File Server',
			category: 'infrastructure',
			status: opts.serverAvailable ? 'pass' : 'warn',
			message: opts.serverAvailable ? '文件服务器运行中' : '文件服务器不可用（内存模式）',
			fixable: false,
		});

		// 2. BM25 index consistency
		if (opts.bm25) {
			const bm25Size = opts.bm25.size;
			const expectedSize = opts.longEntries.filter(e => !e.supersededBy).length;
			const ratio = expectedSize > 0 ? bm25Size / expectedSize : 1;
			checks.push({
				name: 'BM25 Index',
				category: 'index',
				status: ratio > 0.9 ? 'pass' : ratio > 0.5 ? 'warn' : 'fail',
				message: `BM25 索引 ${bm25Size} 条，期望 ${expectedSize} 条 (${Math.round(ratio * 100)}%)`,
				fixable: true,
			});
		}

		// 3. Vector index consistency
		if (opts.vector) {
			const vecSize = opts.vector.size;
			const expectedSize = opts.longEntries.filter(e => !e.supersededBy).length;
			const ratio = expectedSize > 0 ? vecSize / expectedSize : 1;
			checks.push({
				name: 'Vector Index',
				category: 'index',
				status: ratio > 0.9 ? 'pass' : ratio > 0.5 ? 'warn' : 'fail',
				message: `向量索引 ${vecSize} 条，期望 ${expectedSize} 条 (${Math.round(ratio * 100)}%)`,
				fixable: true,
			});
		}

		// 4. Graph stats
		if (opts.graph) {
			const nodeCount = opts.graph.nodeCount;
			const edgeCount = opts.graph.edgeCount;
			checks.push({
				name: 'Knowledge Graph',
				category: 'graph',
				status: nodeCount > 0 ? 'pass' : 'warn',
				message: `图谱: ${nodeCount} 节点, ${edgeCount} 边`,
				fixable: false,
			});
		}

		// 5. Strength distribution
		let high = 0, mid = 0, low = 0, evicted = 0;
		for (const e of opts.longEntries) {
			if (e.supersededBy) { evicted++; continue; }
			if (e.strength > 0.5) high++;
			else if (e.strength > 0.2) mid++;
			else low++;
		}
		const lowRatio = opts.longEntries.length > 0 ? low / opts.longEntries.length : 0;
		checks.push({
			name: 'Strength Distribution',
			category: 'lifecycle',
			status: lowRatio < 0.2 ? 'pass' : lowRatio < 0.4 ? 'warn' : 'fail',
			message: `高=${high} 中=${mid} 低=${low} 已取代=${evicted}（低强度占比 ${Math.round(lowRatio * 100)}%）`,
			fixable: true,
		});

		// 6. Pending writes
		checks.push({
			name: 'Pending Writes',
			category: 'persistence',
			status: opts.pendingWrites === 0 ? 'pass' : 'warn',
			message: opts.pendingWrites === 0 ? '无待写入' : `${opts.pendingWrites} 个 agent 待写入`,
			fixable: true,
		});

		// 7. Audit log
		if (opts.audit) {
			const auditCount = opts.audit.count;
			checks.push({
				name: 'Audit Trail',
				category: 'observability',
				status: auditCount > 0 ? 'pass' : 'warn',
				message: `审计日志 ${auditCount} 条`,
				fixable: false,
			});
		}

		// 8. Memory count
		const totalMemories = opts.longTermCount + opts.shortTermCount;
		checks.push({
			name: 'Memory Count',
			category: 'storage',
			status: totalMemories < 5000 ? 'pass' : 'warn',
			message: `长期=${opts.longTermCount} 短期=${opts.shortTermCount} 总计=${totalMemories}`,
			fixable: false,
		});

		// Overall status
		const failCount = checks.filter(c => c.status === 'fail').length;
		const warnCount = checks.filter(c => c.status === 'warn').length;
		const overallStatus = failCount > 0 ? 'critical' : warnCount > 2 ? 'degraded' : 'healthy';

		const summary = `${checks.filter(c => c.status === 'pass').length}/${checks.length} checks passed`
			+ (warnCount > 0 ? `, ${warnCount} warnings` : '')
			+ (failCount > 0 ? `, ${failCount} failures` : '');

		return { checks, overallStatus, summary };
	}
}
