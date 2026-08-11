/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canvas Tools — "Agent-driven canvas" tools (docs/Agent-画布编排设计方案.md P0).
 *
 * These tools operate on the LiteGraph workflow canvas that lives in the webview.
 * The host bridges them via canvasOpsBridge (request → workflow.canvasOps event →
 * webview applyCanvasOps → workflow.canvasOpsResult request → resolve).
 *
 * Node type vocabulary is the registry's namespaced types (Sarosis.Prompt,
 * Sarosis.ModelImageGen, Sarosis.ProviderPicker, ComfyTV.*, ComfyUI native names).
 */

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import { requestCanvasOps, type CanvasOp } from './canvasOpsBridge.js';
import { canvasContextStore } from '../../messageEnrichment/canvasContextStore.js';

export interface CanvasToolContext {
	register(definition: { definition: any; handler: any }): void;
	logService: ILogService;
}

/** Generic success text for op batches (avoids leaking raw JSON to the LLM). */
function opsSummaryText(summary: string, ok: boolean, extra?: string): string {
	const lines = summary ? summary.split('\n').map(l => `  - ${l}`).join('\n') : '  - (empty batch)';
	return ok
		? `画布操作已应用：\n${lines}${extra ? `\n${extra}` : ''}`
		: `画布操作失败：\n${lines}${extra ? `\n${extra}` : ''}`;
}

export function registerCanvasTools(ctx: CanvasToolContext): void {
	// ── canvas_apply_ops ────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'canvas_apply_ops',
			description: 'Apply an atomic batch of operations to the workflow canvas. ' +
				'Ops run atomically — if any op fails the WHOLE batch is rolled back. ' +
				'Requires the workflow canvas (workflow editor panel) to be open.\n\n' +
				'OPS (op + fields):\n' +
				'  add_node    { type, id?, label?, position?{x,y}, data? } — create a node. type examples: "Sarosis.Prompt", "Sarosis.ModelImageGen", "Sarosis.ProviderPicker".\n' +
				'  update_node { node, patch } — patch node data (node = id or label).\n' +
				'  delete_node { node } — delete a node and its connections.\n' +
				'  connect     { source, target, sourceHandle?, targetHandle? } — connect two nodes (port types are validated).\n' +
				'  disconnect  { source, target, sourceHandle?, targetHandle? } — remove a connection.\n' +
				'  select      { node } — select a node (null clears selection).\n\n' +
				'Node references accept id, exact label, or case-insensitive label.',
			inputSchema: {
				type: 'object',
				properties: {
					ops: {
						type: 'array',
						description: 'Ordered batch of canvas operations. Each has an `op` field plus op-specific fields.',
						items: {
							type: 'object',
							properties: {
								op: { type: 'string', enum: ['add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'select'] },
								type: { type: 'string', description: 'Node type for add_node (e.g. Sarosis.ModelImageGen)' },
								id: { type: 'string', description: 'Optional explicit node id' },
								label: { type: 'string', description: 'Optional display label (defaults to auto-name)' },
								node: { type: 'string', description: 'Node reference (id or label) for update/delete/select' },
								source: { type: 'string', description: 'Source node reference for connect/disconnect' },
								target: { type: 'string', description: 'Target node reference for connect/disconnect' },
								sourceHandle: { type: 'string', description: 'Source port name (e.g. output)' },
								targetHandle: { type: 'string', description: 'Target port name (e.g. prompt)' },
								position: {
									type: 'object',
									description: 'Optional node position { x, y }',
									properties: { x: { type: 'number' }, y: { type: 'number' } },
								},
								patch: { type: 'object', description: 'Data fields to merge for update_node' },
								data: { type: 'object', description: 'Initial data fields for add_node' },
							},
							required: ['op'],
						},
					},
				},
				required: ['ops'],
			},
			category: 'canvas',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const ops = args.ops as CanvasOp[] | undefined;
			if (!Array.isArray(ops) || ops.length === 0) {
				return [{ type: 'text', text: 'canvas_apply_ops error: ops must be a non-empty array.' }];
			}
			try {
				const result = await requestCanvasOps(ops);
				const summary = (result.results ?? []).map(r => r.summary).join('\n');
				const extra = result.selectedNodeId ? `已选中节点: ${result.selectedNodeId}` : undefined;
				return [{ type: 'text', text: opsSummaryText(summary, result.ok, extra) }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `canvas_apply_ops error: ${msg}` }];
			}
		},
	});

	// ── canvas_generate ──────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'canvas_generate',
			description: 'Semantic image generation on the canvas: create Prompt + ModelImageGen nodes ' +
				'(optionally N variants), auto-connect them, auto-route provider/model, and run. ' +
				'Call this instead of manually adding prompt/image nodes one by one.\n\n' +
				'For each variant it creates a Sarosis.Prompt → Sarosis.ModelImageGen pair. ' +
				'Requires the workflow canvas to be open.',
			inputSchema: {
				type: 'object',
				properties: {
					goal: { type: 'string', description: 'What to generate (becomes the prompt text).' },
					provider_id: { type: 'string', description: 'Optional explicit provider id (defaults to auto-route).' },
					model_id: { type: 'string', description: 'Optional explicit model id (defaults to auto-route).' },
					negative_prompt: { type: 'string', description: 'Optional negative prompt applied to all variants.' },
					size: { type: 'string', description: 'Image size, e.g. 1024x1024.' },
					variants: {
						type: 'array',
						description: 'Optional per-variant prompts (creates one image node each).',
						items: {
							type: 'object',
							properties: {
								prompt: { type: 'string', description: 'Variant prompt (defaults to goal).' },
								label: { type: 'string', description: 'Optional prompt node label.' },
							},
						},
					},
					run: { type: 'boolean', description: 'Run the generated flow immediately after building (default false).' },
					layout: { type: 'boolean', description: 'Auto-layout the canvas after building (default false).' },
				},
				required: ['goal'],
			},
			category: 'canvas',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			// The semantic flow build (buildGenerateFlow) lives in the webview
			// (DOM-free, unit-tested). This tool delegates to the webview via a
			// dedicated op: the webview's handler calls buildGenerateFlow and
			// applies the result. That keeps the source of truth on the canvas side.
			const wantsRun = args.run === true;
			const ops: CanvasOp[] = [{
				op: 'add_node',
				type: '__generate_flow__',
				data: {
					goal: args.goal,
					providerId: args.provider_id,
					modelId: args.model_id,
					negativePrompt: args.negative_prompt,
					size: args.size,
					variants: args.variants,
					run: wantsRun,
					layout: args.layout === true,
				},
			}];
			try {
				const result = await requestCanvasOps(ops);
				const summary = (result.results ?? []).map(r => r.summary).join('\n');
				return [{
					type: 'text',
					text: result.ok
						? `已生成画布流程：\n${summary}${wantsRun ? '\n（已在画布中执行，可用 canvas_get_task_status 查询结果）' : '\n（如需执行可再次调用本工具并设 run:true）'}`
						: `canvas_generate 失败：${result.error ?? summary}`,
				}];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `canvas_generate error: ${msg}` }];
			}
		},
	});

	// ── canvas_get_task_status ───────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'canvas_get_task_status',
			description: 'Query the current workflow canvas state after a canvas_* run: ' +
				'node results (success/error, durations), any failure message, and the ' +
				'last canvas ops summary. Use this to verify what actually ran before ' +
				'continuing. Requires the workflow canvas to be open and a canvas_* ' +
				'op batch to have been applied.',
			inputSchema: {
				type: 'object',
				properties: {
					workflow_id: { type: 'string', description: 'Optional workflow id (defaults to the active one).' },
				},
			},
			category: 'canvas',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const workflowId = typeof args.workflow_id === 'string' ? args.workflow_id : 'default';
			const snapshot = canvasContextStore.get(workflowId);
			if (!snapshot) {
				return [{
					type: 'text',
					text: `canvas_get_task_status: 工作流 "${workflowId}" 暂无画布状态记录（请先执行 canvas_apply_ops / canvas_generate，且 workflow 画布处于打开状态）。`,
				}];
			}
			const lines: string[] = [`画布状态（${new Date(snapshot.updatedAt).toLocaleTimeString()}）:`];
			for (const n of snapshot.nodes) {
				const stateLabel = n.runState === 'success' ? '成功'
					: n.runState === 'error' ? '失败'
					: n.runState === 'running' ? '运行中' : '待执行';
				const err = n.runState === 'error' && n.errorMsg ? `：${n.errorMsg}` : '';
				lines.push(`  - ${n.label} [${n.type}] → ${stateLabel}${err}`);
			}
			if (snapshot.lastOpsSummary?.length) {
				lines.push('最近画布操作:');
				for (const s of snapshot.lastOpsSummary) { lines.push(`  ${s}`); }
			}
			return [{ type: 'text', text: lines.join('\n') }];
		},
	});

	// ── canvas_get_state ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'canvas_get_state',
			description: 'Read the current workflow canvas structure: all nodes (label, type, run state) ' +
				'and connections (source → target). Use this BEFORE planning canvas edits so you ' +
				'can reference existing nodes by label. Requires the workflow canvas to be open and ' +
				'a canvas_* op batch to have been applied.',
			inputSchema: {
				type: 'object',
				properties: {
					workflow_id: { type: 'string', description: 'Optional workflow id (defaults to the active one).' },
				},
			},
			category: 'canvas',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const workflowId = typeof args.workflow_id === 'string' ? args.workflow_id : 'default';
			const snapshot = canvasContextStore.get(workflowId);
			if (!snapshot) {
				return [{
					type: 'text',
					text: `canvas_get_state: 工作流 "${workflowId}" 暂无画布快照（请先执行 canvas_apply_ops / canvas_generate，且 workflow 画布处于打开状态）。`,
				}];
			}
			return [{ type: 'text', text: formatCanvasStateText(snapshot) }];
		},
	});

	// ── canvas_reverse_prompt ───────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'canvas_reverse_prompt',
			description: 'Describe an image already on the canvas: pick a ModelImageGen node that has an ' +
				'upstream IMAGE, and the model will write a detailed generation prompt back into that node\'s ' +
				'prompt field (reverse prompt). Requires the workflow canvas to be open.',
			inputSchema: {
				type: 'object',
				properties: {
					node: { type: 'string', description: 'Target node id or label (e.g. "图像-1").' },
				},
				required: ['node'],
			},
			category: 'canvas',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const target = typeof args.node === 'string' ? args.node : '';
			if (!target) {
				return [{ type: 'text', text: 'canvas_reverse_prompt error: node is required.' }];
			}
			const ops: CanvasOp[] = [{
				op: 'add_node',
				type: '__reverse_prompt__',
				id: target,
				data: { target },
			}];
			try {
				const result = await requestCanvasOps(ops);
				if (result.ok) {
					const summary = (result.results ?? []).map(r => r.summary).join('\n');
					return [{ type: 'text', text: `反推提示词完成：\n${summary}` }];
				}
				return [{ type: 'text', text: `canvas_reverse_prompt 失败：${result.error ?? '未知错误'}` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `canvas_reverse_prompt error: ${msg}` }];
			}
		},
	});

	// ── canvas_undo / canvas_redo ────────────────────────────────────────
	const registerUndoRedo = (name: 'canvas_undo' | 'canvas_redo', op: 'undo' | 'redo', pastTense: string, description: string) => {
		ctx.register({
			definition: {
				name,
				description,
				inputSchema: {
					type: 'object',
					properties: {
						steps: { type: 'number', description: `Steps to ${op} (default 1).` },
					},
				},
				category: 'canvas',
				source: 'saros.builtin-tools',
			},
			handler: async (args: Record<string, unknown>) => {
				const steps = typeof args.steps === 'number' && args.steps > 0 ? Math.floor(args.steps) : 1;
				const ops: CanvasOp[] = Array.from({ length: steps }, () => ({ op } as CanvasOp));
				try {
					const result = await requestCanvasOps(ops);
					const summary = (result.results ?? []).map(r => r.summary).join('\n');
					return [{ type: 'text', text: result.ok ? `已${pastTense}：\n${summary}` : `canvas_${op} 失败：${result.error ?? summary}` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `canvas_${op} error: ${msg}` }];
				}
			},
		});
	};
	registerUndoRedo(
		'canvas_undo', 'undo', '撤销',
		'Undo the last canvas operation batch (single step per batch, e.g. a canvas_apply_ops or canvas_generate). Requires the workflow canvas to be open.',
	);
	registerUndoRedo(
		'canvas_redo', 'redo', '重做',
		'Redo a previously undone canvas operation batch. Requires the workflow canvas to be open.',
	);

	ctx.logService.info('[BuiltinTools] registerCanvasTools: 7 canvas tools registered (apply_ops/generate/get_task_status/get_state/undo/redo/reverse_prompt)');
}

/**
 * Format a canvas snapshot into tool text: node inventory + connections.
 * Pure + exported for unit tests.
 */
export function formatCanvasStateText(snapshot: import('../../messageEnrichment/canvasContextStore.js').CanvasContextSnapshot): string {
	const lines: string[] = [`画布节点（${snapshot.nodes.length} 个，${new Date(snapshot.updatedAt).toLocaleTimeString()}）:`];
	for (const n of snapshot.nodes) {
		const stateLabel = n.runState === 'success' ? '成功'
			: n.runState === 'error' ? '失败'
			: n.runState === 'running' ? '运行中' : '待执行';
		const err = n.runState === 'error' && n.errorMsg ? `：${n.errorMsg}` : '';
		lines.push(`  - ${n.label} [${n.type}] → ${stateLabel}${err}`);
	}
	if (snapshot.edges?.length) {
		lines.push(`连线（${snapshot.edges.length} 条）:`);
		for (const e of snapshot.edges) {
			const lhs = e.sourceHandle ? `${e.source}::${e.sourceHandle}` : e.source;
			const rhs = e.targetHandle ? `${e.target}::${e.targetHandle}` : e.target;
			lines.push(`  ${lhs} → ${rhs}`);
		}
	} else {
		lines.push('连线: 无');
	}
	return lines.join('\n');
}
