/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — runtime projection (M4b)
 *
 *  把一次 run 的 WorkflowEngineEvent 流重放为「波次分层 DAG 投影」：
 *   - 重叠并发（parallel / pipeline 的并发窗口）= 同层 —— 动态扇出的 N 个
 *     agent 在投影图中真实呈现（静态画布做不到，这正是 M4b 的价值）
 *   - 串行 agent 各占一层；层间全连边（超阈值降级为代表连线）
 *   - phase 事件划分阶段边界；agent 归属其 start 时的 phase
 *   - 未收敛的 agent（cancel/worker 死亡）→ outcome 'cancelled'
 *
 *  消费方：
 *   - workflowTool 结果文本摘要（波次表，立即可视反馈）
 *   - projectionArchiveEmitter → controller → workflowStorageService（投影工作流
 *     落盘，工作流列表可打开查看）
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §5.3 M4b。
 *--------------------------------------------------------------------------------------------*/

import type { WorkflowEngineEvent } from './types.js';

export interface IProjectedAgent {
	/** run 内 1-based 序号（agent-start.info.seq）。 */
	readonly seq: number;
	readonly label: string;
	readonly phase?: string;
	/** start 时收敛窗口内未见 end → 'cancelled'。 */
	readonly outcome: 'completed' | 'failed' | 'cancelled';
	readonly layer: number;
}

export interface IWorkflowProjection {
	/** 层数（串行 agent 各一层；重叠并发同层）。 */
	readonly layers: IProjectedAgent[][];
	/** 出现过的 phase 序（去重保序）。 */
	readonly phases: string[];
	readonly agentsStarted: number;
	readonly stopReason: string;
	readonly edges: Array<{ from: number; to: number }>;
}

/** 边数硬上限：超过则降级为代表连线（层间首节点桥），防笛卡尔爆炸。 */
const MAX_PROJECTION_EDGES = 64;

/**
 * 重放事件流构建投影。事件须为同一 run（id 全一致）；乱序容错：
 * agent-end 无对应 start 时忽略；agent-start 重复时保留首个。
 */
export function buildWorkflowProjection(events: readonly WorkflowEngineEvent[]): IWorkflowProjection {
	const agents = new Map<number, IProjectedAgent & { ended: boolean }>();
	const layers: Array<Array<number>> = [];   // 层 → seq 列表（构建期）
	const active = new Set<number>();
	let currentLayer: number[] | undefined;
	const phases: string[] = [];
	let currentPhase: string | undefined;
	let agentsStarted = 0;
	let stopReason = 'completed';

	for (const ev of events) {
		switch (ev.type) {
			case 'phase':
				currentPhase = ev.title;
				if (!phases.includes(ev.title)) { phases.push(ev.title); }
				break;
			case 'agent-start': {
				const info = ev.info;
				if (agents.has(info.seq)) { break; }
				agentsStarted += 1;
				if (active.size === 0) { currentLayer = []; layers.push(currentLayer); }
				currentLayer!.push(info.seq);
				active.add(info.seq);
				agents.set(info.seq, {
					seq: info.seq,
					label: info.label,
					...(info.phase !== undefined ? { phase: info.phase } : currentPhase !== undefined ? { phase: currentPhase } : {}),
					outcome: 'cancelled',
					layer: layers.length - 1,
					ended: false,
				});
				break;
			}
			case 'agent-end': {
				const a = agents.get(ev.info.seq);
				if (!a || a.ended) { break; }
				(a as { ended: boolean }).ended = true;
				(a as { outcome: IProjectedAgent['outcome'] }).outcome = ev.info.outcome;
				active.delete(ev.info.seq);
				break;
			}
			case 'end':
				stopReason = ev.stopReason;
				break;
			default:
				break;
		}
	}

	const seqOfLayer = layers.map(list => list.map(seq => {
		const a = agents.get(seq)!;
		const { seq: _s, label, phase, outcome, layer, ended: _e, ...rest } = a as never as Record<string, never>;
		void _s; void _e; void rest;
		return { seq: a.seq, label, phase: phase as string | undefined, outcome: a.outcome as IProjectedAgent['outcome'], layer } satisfies IProjectedAgent;
	}));

	// 层间边：全连；超阈值降级（层 i 首个 → 层 i+1 全部 + 层 i 全部 → 层 i+1 首个）
	const edges: Array<{ from: number; to: number }> = [];
	let full = true;
	for (let i = 0; i + 1 < layers.length; i++) {
		if (full) {
			for (const f of layers[i]) {
				for (const t of layers[i + 1]) { edges.push({ from: f, to: t }); }
			}
			if (edges.length > MAX_PROJECTION_EDGES) { edges.length = 0; full = false; i = -1; } // 重新以降级模式生成
		} else {
			const a0 = layers[i][0];
			for (const t of layers[i + 1]) { edges.push({ from: a0, to: t }); }
			for (const f of layers[i].slice(1)) { edges.push({ from: f, to: layers[i + 1][0] }); }
		}
	}

	return { layers: seqOfLayer, phases, agentsStarted, stopReason, edges };
}

/** 投影摘要（工具结果文本用）：波次表 + outcome 统计。 */
export function renderProjectionSummary(p: IWorkflowProjection): string {
	const lines: string[] = [];
	if (p.layers.length === 0) { return '运行投影：无 agent 调用'; }
	lines.push(`运行投影（${p.layers.length} 波次 / ${p.agentsStarted} agents${p.phases.length ? ` / phases: ${p.phases.join(' → ')}` : ''}）：`);
	for (let i = 0; i < p.layers.length; i++) {
		const layer = p.layers[i];
		const marks = layer.map(a => `#${a.seq} ${a.label}${a.outcome === 'completed' ? '' : a.outcome === 'failed' ? ' ✗failed' : ' ⊘cancelled'}`);
		lines.push(`  第 ${i + 1} 波 (${layer.length}): ${marks.join('  |  ')}`);
	}
	const failed = p.layers.flat().filter(a => a.outcome === 'failed').length;
	const cancelled = p.layers.flat().filter(a => a.outcome === 'cancelled').length;
	if (failed || cancelled) { lines.push(`  统计：failed=${failed} cancelled=${cancelled}`); }
	return lines.join('\n');
}
