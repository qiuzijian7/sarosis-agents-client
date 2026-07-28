/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Routine / Crystal / Facet Memory Tools — 接入 AgentMemory 引擎的高阶记忆能力。
 *
 *   memory_routine — 可复用工作流：创建/列出/获取/运行/推进步骤/查询状态/冻结/删除
 *   memory_crystal — 已完成行动链结晶：手动结晶/列出/获取/自动结晶
 *   memory_facet   — 多维标签：打标签/按维度查询/获取/移除/统计/列维度
 *
 * 所有调用经 IAgentOSService.getActiveMemoryProvider()（AgentMemoryProviderV2 代理，
 * 未声明方法由代理的 Proxy 兜底转发到网关）。注入通道仍走 buildContext 的策展块。
 */

import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface RoutineCrystalFacetToolContext {
	register(registration: IBuiltinToolRegistration): void;
	agentOS: IAgentOSService;
	logService: ILogService;
}

/** 取活跃 provider 并做 any 化（高级方法不在 IMemoryProvider 接口上声明，由代理转发） */
function memProvider(ctx: RoutineCrystalFacetToolContext): any | undefined {
	return ctx.agentOS.getActiveMemoryProvider() as any;
}

function noProvider(): [{ type: 'text'; text: string }] {
	return [{ type: 'text', text: 'error: no memory provider available (AgentMemory gateway not running?)' }];
}

export function registerRoutineCrystalFacetTools(ctx: RoutineCrystalFacetToolContext): void {
	const source = 'saros.builtin-tools';

	// ── memory_routine ─────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_routine',
			description: 'Reusable multi-step workflows (routines). Create a routine from ordered steps, run it, advance each step with a result as you execute, and query run status. A run auto-completes when its last step is marked done. Use to codify repeatable procedures (e.g. "release flow") so you can rerun them consistently.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['create', 'list', 'get', 'run', 'step', 'status', 'freeze', 'delete'], description: 'Routine action' },
					routine_id: { type: 'string', description: 'Routine ID (get/run/freeze/delete)' },
					name: { type: 'string', description: 'Routine name (create)' },
					description: { type: 'string', description: 'Routine description (create)' },
					steps: {
						type: 'array', description: 'Ordered steps (create)',
						items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } } },
					},
					frozen: { type: 'boolean', description: 'Freeze/unfreeze (freeze, default true)' },
					run_id: { type: 'string', description: 'Run ID (step/status)' },
					step_order: { type: 'number', description: 'Step index starting at 0 (step)' },
					step_status: { type: 'string', enum: ['done', 'failed', 'skipped', 'running'], description: 'Step outcome (step)' },
					result: { type: 'string', description: 'Short result summary (step)' },
					error: { type: 'string', description: 'Error message when step_status=failed (step)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_routine error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				switch (action) {
					case 'create': {
						const name = args['name'] as string | undefined;
						const steps = (args['steps'] as any[]) ?? [];
						if (!name || steps.length === 0) { return [{ type: 'text', text: 'memory_routine create: name and non-empty steps[] required' }]; }
						const r = await mp.createRoutine({ agentId, name, description: args['description'] as string, steps });
						return [{ type: 'text', text: `Created routine "${r?.name ?? name}" (id ${r?.id ?? '?'}, ${r?.steps?.length ?? steps.length} steps).` }];
					}
					case 'list': {
						const list = (await mp.getRoutines(agentId)) ?? [];
						if (!list.length) { return [{ type: 'text', text: 'No routines registered.' }]; }
						const lines = list.map((r: any) => `- [${r.id}] ${r.name} (${r.steps?.length ?? 0} steps) frozen=${r.frozen !== false} ${r.description ?? ''}`);
						return [{ type: 'text', text: `Routines (${list.length}):\n${lines.join('\n')}` }];
					}
					case 'get': {
						const id = args['routine_id'] as string | undefined;
						if (!id) { return [{ type: 'text', text: 'memory_routine get: routine_id required' }]; }
						const r = await mp.getRoutine(agentId, id);
						if (!r) { return [{ type: 'text', text: `Routine ${id} not found.` }]; }
						const lines = (r.steps ?? []).map((s: any) => `  ${s.order}. ${s.title}${s.description ? ` — ${s.description}` : ''}`);
						return [{ type: 'text', text: `Routine ${r.name} (id ${r.id}, frozen=${r.frozen !== false}):\n${lines.join('\n')}` }];
					}
					case 'run': {
						const id = args['routine_id'] as string | undefined;
						if (!id) { return [{ type: 'text', text: 'memory_routine run: routine_id required' }]; }
						const run = await mp.runRoutine(agentId, id);
						return [{ type: 'text', text: `Started run ${run?.id ?? '?'} of routine ${id}. Now execute each step and report progress via action=step (run_id=${run?.id ?? '?'}).` }];
					}
					case 'step': {
						const runId = args['run_id'] as string | undefined;
						const stepOrder = Number(args['step_order']);
						const stepStatus = (args['step_status'] as string) ?? 'done';
						if (!runId || Number.isNaN(stepOrder)) { return [{ type: 'text', text: 'memory_routine step: run_id and step_order required' }]; }
						const run = await mp.routineStepUpdate(agentId, runId, stepOrder, stepStatus, args['result'] as string, args['error'] as string);
						if (!run) { return [{ type: 'text', text: `Run ${runId} not found.` }]; }
						return [{ type: 'text', text: `Step ${stepOrder} → ${stepStatus}. Run ${run.id} status=${run.status}, currentStep=${run.currentStep}${run.completedAt ? `, completedAt=${run.completedAt}` : ''}.` }];
					}
					case 'status': {
						const runId = args['run_id'] as string | undefined;
						if (!runId) { return [{ type: 'text', text: 'memory_routine status: run_id required' }]; }
						const s = await mp.routineStatus(agentId, runId);
						return [{ type: 'text', text: JSON.stringify(s?.progress ?? s, null, 2) }];
					}
					case 'freeze': {
						const id = args['routine_id'] as string | undefined;
						if (!id) { return [{ type: 'text', text: 'memory_routine freeze: routine_id required' }]; }
						const r = await mp.routineFreeze(agentId, id, args['frozen'] !== false);
						return r?.success
							? [{ type: 'text', text: `Routine ${id} frozen=${r.routine?.frozen !== false}.` }]
							: [{ type: 'text', text: `Freeze failed: ${r?.error ?? 'unknown error'}` }];
					}
					case 'delete': {
						const id = args['routine_id'] as string | undefined;
						if (!id) { return [{ type: 'text', text: 'memory_routine delete: routine_id required' }]; }
						const ok = await mp.routineDelete(agentId, id);
						return [{ type: 'text', text: ok ? `Routine ${id} (and its runs) deleted.` : `Routine ${id} not found.` }];
					}
					default:
						return [{ type: 'text', text: `memory_routine error: unknown action "${action}"` }];
				}
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_routine failed:', err);
				return [{ type: 'text', text: `memory_routine failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_crystal ─────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_crystal',
			description: 'Crystallize completed action chains into immutable, reusable summaries (crystals), or list/get/auto-crystallize. Crystals capture a narrative, key outcomes, files affected, and lessons from a finished workflow for future reference.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['create', 'list', 'get', 'auto'], description: 'Crystal action' },
					action_id: { type: 'string', description: 'Source action ID (create)' },
					crystal_id: { type: 'string', description: 'Crystal ID (get)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_crystal error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				switch (action) {
					case 'create': {
						const actionId = args['action_id'] as string | undefined;
						if (!actionId) { return [{ type: 'text', text: 'memory_crystal create: action_id required' }]; }
						const c = await mp.crystallize(agentId, actionId);
						return c
							? [{ type: 'text', text: `Crystallized action ${actionId} → crystal ${c.id ?? '?'}: ${String(c.narrative ?? '').slice(0, 200)}` }]
							: [{ type: 'text', text: `Crystallize: action ${actionId} not found.` }];
					}
					case 'list': {
						const list = (await mp.crystalList(agentId)) ?? [];
						if (!list.length) { return [{ type: 'text', text: 'No crystals yet.' }]; }
						const lines = list.slice(0, 20).map((c: any) => `- [${c.id}] ${String(c.narrative ?? '').slice(0, 120)}${c.filesAffected?.length ? ` (files: ${c.filesAffected.slice(0, 3).join(',')})` : ''}`);
						return [{ type: 'text', text: `Crystals (${list.length}):\n${lines.join('\n')}` }];
					}
					case 'get': {
						const id = args['crystal_id'] as string | undefined;
						if (!id) { return [{ type: 'text', text: 'memory_crystal get: crystal_id required' }]; }
						const c = await mp.crystalGet(agentId, id);
						if (!c) { return [{ type: 'text', text: `Crystal ${id} not found.` }]; }
						const parts = [`${c.narrative ?? ''}`];
						if (c.keyOutcomes?.length) { parts.push(`Outcomes: ${c.keyOutcomes.join('; ')}`); }
						if (c.filesAffected?.length) { parts.push(`Files: ${c.filesAffected.join(', ')}`); }
						if (c.lessons?.length) { parts.push(`Lessons: ${c.lessons.join('; ')}`); }
						return [{ type: 'text', text: parts.join('\n') }];
					}
					case 'auto': {
						const n = await mp.autoCrystallize(agentId);
						return [{ type: 'text', text: `Auto-crystallize created ${typeof n === 'number' ? n : JSON.stringify(n)} crystal(s).` }];
					}
					default:
						return [{ type: 'text', text: `memory_crystal error: unknown action "${action}"` }];
				}
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_crystal failed:', err);
				return [{ type: 'text', text: `memory_crystal failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_facet ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_facet',
			description: 'Multi-dimensional tags (facets) for memories/files/sessions. Tag a target with dimension:value pairs, then query targets by dimension (optionally value), fetch a target\'s facets, remove a tag, or inspect dimension stats. Use to organize and filter memories across orthogonal axes.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['tag', 'query', 'get', 'untag', 'stats', 'dimensions'], description: 'Facet action' },
					target_id: { type: 'string', description: 'Target ID (tag/get/untag)' },
					target_type: { type: 'string', enum: ['memory', 'file', 'session', 'routine', 'crystal'], description: 'Target type (tag)' },
					dimension: { type: 'string', description: 'Facet dimension, e.g. project/domain/status (tag/query/get/untag)' },
					value: { type: 'string', description: 'Facet value (tag; optional filter for query)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_facet error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				switch (action) {
					case 'tag': {
						const targetId = args['target_id'] as string | undefined;
						const dimension = args['dimension'] as string | undefined;
						const value = args['value'] as string | undefined;
						if (!targetId || !dimension || !value) { return [{ type: 'text', text: 'memory_facet tag: target_id, dimension and value required' }]; }
						const f = await mp.facetTag(agentId, targetId, (args['target_type'] as string) ?? 'memory', dimension, value);
						return [{ type: 'text', text: `Tagged ${targetId}: ${dimension}=${value} (facet ${f?.id ?? '?'}).` }];
					}
					case 'query': {
						const dimension = args['dimension'] as string | undefined;
						if (!dimension) { return [{ type: 'text', text: 'memory_facet query: dimension required' }]; }
						const list = (await mp.facetQuery(agentId, dimension, args['value'] as string)) ?? [];
						if (!list.length) { return [{ type: 'text', text: `No facets for dimension "${dimension}".` }]; }
						const lines = list.slice(0, 20).map((f: any) => `- ${f.targetId} (${f.targetType ?? 'memory'}): ${f.dimension}=${f.value}`);
						return [{ type: 'text', text: `Facets [${dimension}] (${list.length}):\n${lines.join('\n')}` }];
					}
					case 'get': {
						const targetId = args['target_id'] as string | undefined;
						const dimension = args['dimension'] as string | undefined;
						if (!targetId || !dimension) { return [{ type: 'text', text: 'memory_facet get: target_id and dimension required' }]; }
						const f = await mp.facetGet(agentId, targetId, dimension);
						return f ? [{ type: 'text', text: JSON.stringify(f) }] : [{ type: 'text', text: `No ${dimension} facet on ${targetId}.` }];
					}
					case 'untag': {
						const targetId = args['target_id'] as string | undefined;
						const dimension = args['dimension'] as string | undefined;
						if (!targetId || !dimension) { return [{ type: 'text', text: 'memory_facet untag: target_id and dimension required' }]; }
						const ok = await mp.facetUntag(agentId, targetId, dimension);
						return [{ type: 'text', text: ok ? `Removed ${dimension} facet from ${targetId}.` : `No ${dimension} facet on ${targetId}.` }];
					}
					case 'stats': {
						const s = await mp.facetStats(agentId);
						return [{ type: 'text', text: JSON.stringify(s) }];
					}
					case 'dimensions': {
						const d = (await mp.facetDimensions(agentId)) ?? [];
						return [{ type: 'text', text: `Dimensions (${d.length}): ${d.join(', ') || '(none)'}` }];
					}
					default:
						return [{ type: 'text', text: `memory_facet error: unknown action "${action}"` }];
				}
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_facet failed:', err);
				return [{ type: 'text', text: `memory_facet failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerRoutineCrystalFacetTools: 3 memory tools registered (routine/crystal/facet)');
}
