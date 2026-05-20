/*---------------------------------------------------------------------------------------------
 *  Canvas Layout Engine
 *
 *  Multi-strategy layout engine for auto-arranging agents on the workspace canvas.
 *  Uses topological depth from the DAG to position agents in layered rows.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentStudioService } from '../common/agentStudio.js';
import type { OrchestrationPlan } from '../common/types.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Canvas layout constants ─────────────────────────────────────────────────

const CANVAS_ROW_HEIGHT = 220;
const CANVAS_COL_WIDTH = 300;
const CANVAS_ORIGIN_X = 150;
const CANVAS_ORIGIN_Y = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// CanvasLayoutEngine — arranges agents on the workspace canvas based on DAG depth
// ═══════════════════════════════════════════════════════════════════════════════

export class CanvasLayoutEngine {

	constructor(
		private readonly agentStudioService: IAgentStudioService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Auto-arrange agents on the canvas using topological depth from the plan's tasks.
	 * Agents at the same depth are placed in the same row, centered horizontally.
	 */
	async autoArrangeCanvas(plan: OrchestrationPlan): Promise<void> {
		try {
			const employees = await this.agentStudioService.getEmployees(plan.workspaceId);
			const workspace = await this.agentStudioService.getWorkspace(plan.workspaceId);
			if (!workspace) { return; }

			// Use topological depth for layout
			const depthMap = new Map<string, number>();
			for (const task of plan.tasks) {
				if (task.assigneeId) {
					const current = depthMap.get(task.assigneeId) ?? 0;
					depthMap.set(task.assigneeId, Math.max(current, task.depth));
				}
			}

			const depthGroups = new Map<number, string[]>();
			for (const [agentId, depth] of depthMap) {
				if (!depthGroups.has(depth)) { depthGroups.set(depth, []); }
				depthGroups.get(depth)!.push(agentId);
			}

			const nodes = (workspace.layout?.nodes || []).map(n => ({ ...n }));
			const nodeMap = new Map(nodes.map(n => [n.id, n]));
			const maxRowWidth = Math.max(...[...depthGroups.values()].map(g => g.length), 1);

			for (const [depth, agentIds] of [...depthGroups.entries()].sort(([a], [b]) => a - b)) {
				const rowWidth = agentIds.length * CANVAS_COL_WIDTH;
				const totalWidth = maxRowWidth * CANVAS_COL_WIDTH;
				const startX = CANVAS_ORIGIN_X + (totalWidth - rowWidth) / 2;
				const y = CANVAS_ORIGIN_Y + depth * CANVAS_ROW_HEIGHT;

				agentIds.forEach((agentId, index) => {
					const x = startX + index * CANVAS_COL_WIDTH;
					const existing = nodeMap.get(agentId);
					if (existing) {
						existing.position = { x, y };
					} else {
						const emp = employees.find(e => e.id === agentId);
						nodes.push({ id: agentId, type: 'employee', position: { x, y }, data: emp ? { employee: emp } : {} });
					}
				});
			}

			const conns = await this.agentStudioService.getConnections(plan.workspaceId);
			const edges = conns.map(c => ({ id: c.id, source: c.sourceId, target: c.targetId, type: 'connection', data: { label: c.label } }));

			await this.agentStudioService.updateWorkspaceLayout(plan.workspaceId, { nodes, edges, viewport: workspace.layout?.viewport } as never);
		} catch (err) {
			this.logService.warn('[Orchestration] Auto-arrange failed:', err);
		}
	}
}
