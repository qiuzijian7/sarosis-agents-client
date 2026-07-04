/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow Tools — stored workflow management tools for the LLM.
 * Extracted from builtinToolProvider.ts for maintainability.
 */

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IWorkflowStorageService, IStoredWorkflow } from '../../../common/workflowStorage.js';
import type { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { workflowAppliedEmitter } from './workflowShared.js';

export interface WorkflowToolContext {
	register(definition: { definition: any; handler: any }): void;
	studioService: IAgentStudioService;
	workflowStorageService: IWorkflowStorageService;
	logService: ILogService;
}

const WORKFLOW_NODE_SCHEMA = {
	nodeTypes: [
		{ type: 'start', label: 'Start', description: 'Entry point of the workflow' },
		{ type: 'agent', label: 'Agent', description: 'Execute an agent action' },
		{ type: 'branch', label: 'Branch', description: 'Conditional branch' },
		{ type: 'askUser', label: 'Ask User', description: 'Ask user for input' },
		{ type: 'end', label: 'End', description: 'End of workflow' },
	],
};

export function registerWorkflowTools(ctx: WorkflowToolContext): void {
	const resolveWorkspaceId = (): string | undefined => {
		return ctx.studioService.getActiveWorkspaceId();
	};

	// ── workflow_list ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'workflow_list',
			description: 'List all workflows in the current workspace. Returns workflow IDs, names, and descriptions.',
			inputSchema: {
				type: 'object',
				properties: {},
				required: [],
			},
			category: 'workflow',
			source: 'saros.builtin-tools',
		},
		handler: async (_args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const wsId = resolveWorkspaceId();
			if (!wsId) {
				return [{ type: 'text', text: 'No active workspace. Please select a workspace first.' }];
			}
			try {
				const workflows = await ctx.workflowStorageService.listWorkflows(wsId);
				if (workflows.length === 0) {
					return [{ type: 'text', text: 'No workflows found in the current workspace. Create one first using the Workflow Editor.' }];
				}
				const summary = workflows.map(w => ({
					id: w.id,
					name: w.name || '(unnamed)',
					description: w.description || '',
					nodeCount: w.nodes?.length ?? 0,
					connectionCount: w.connections?.length ?? 0,
				}));
				return [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `workflow_list error: ${msg}` }];
			}
		},
	});

	// ── workflow_get ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'workflow_get',
			description: 'Get the full state of a specific workflow by ID. Returns all nodes, edges, and metadata. ' +
				'Use this before modifying a workflow so you can see the current structure.',
			inputSchema: {
				type: 'object',
				properties: {
					workflow_id: { type: 'string', description: 'The workflow ID (from workflow_list).' },
				},
				required: ['workflow_id'],
			},
			category: 'workflow',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const wsId = resolveWorkspaceId();
			if (!wsId) {
				return [{ type: 'text', text: 'No active workspace.' }];
			}
			const workflowId = args['workflow_id'] as string | undefined;
			if (!workflowId) {
				return [{ type: 'text', text: 'workflow_get error: workflow_id is required.' }];
			}
			try {
				const wf = await ctx.workflowStorageService.getWorkflow(workflowId, wsId);
				if (!wf) {
					return [{ type: 'text', text: `Workflow "${workflowId}" not found.` }];
				}
				// Return a clean summary for AI consumption
				const summary = {
					id: wf.id,
					name: wf.name,
					description: wf.description,
					nodes: wf.nodes ?? [],
					connections: wf.connections ?? [],
				};
				return [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `workflow_get error: ${msg}` }];
			}
		},
	});

	// ── workflow_get_schema ─────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'workflow_get_schema',
			description: 'Get the schema of all available workflow node types, INCLUDING the list of ' +
				'available agents you can reference. Use this to understand what node types are available, ' +
				'their required data fields, valid agentId values, and positioning guidelines before creating or modifying a workflow.',
			inputSchema: {
				type: 'object',
				properties: {},
				required: [],
			},
			category: 'workflow',
			source: 'saros.builtin-tools',
		},
		handler: async () => {
			// Dynamically fetch available agents so the AI knows valid agentId values
			let availableAgents: Array<{ id: string; name: string; role: string; model: string }> = [];
			try {
				const agents = await ctx.studioService.getAgents();
				availableAgents = agents.map(a => ({
					id: a.id,
					name: a.name,
					role: a.role,
					model: a.model,
				}));
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] workflow_get_schema: failed to fetch agents:', err);
			}

			// Enhance the agent node type description to reference available agents
			const enhancedNodeTypes = WORKFLOW_NODE_SCHEMA.nodeTypes.map((nt: any) => {
				if (nt.type === 'agent') {
					const agentIds = availableAgents.map(a => a.id).join(', ');
					return {
						...nt,
						description: nt.description +
							` IMPORTANT: agentId MUST be one of: [${agentIds || '(no agents available — ask the user to create one first)'}]. ` +
							'Use the exact agent.id value. If the user wants an agent node but the right agent does not exist, ' +
							'ask them to create it first.',
						dataSchema: {
							...nt.dataSchema,
							agentId: `string — one of: [${agentIds || '(none)'}]`,
							agentConfig: '{ modelId?: string (the model to use for this step), tools?: string[], memory?: string }',
						},
					};
				}
				return nt;
			});

			const schema = {
				...WORKFLOW_NODE_SCHEMA,
				nodeTypes: enhancedNodeTypes,
				availableAgents,
			};

			return [{ type: 'text', text: JSON.stringify(schema, null, 2) }];
		},
	});

	// ── workflow_apply ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'workflow_apply',
			description: 'Apply a complete workflow definition (all nodes and connections) to create or replace a workflow. ' +
				'IMPORTANT: Always include the Start and End nodes. Provide ALL nodes and connections — this replaces the entire workflow. ' +
				'Use this for major structural changes. For small edits, get the current workflow via workflow_get, modify it, and apply.\n\n' +
				'NODE FORMAT (CRITICAL): Each node must have id, type, position, and a data object containing all content.\n' +
				'Example: { "id":"dev","type":"agent","position":{"x":320,"y":200},"data":{"label":"Coder","agentId":"coder","agentConfig":{"modelId":"claude-sonnet-4-20250514"}} }\n' +
				'DO NOT put label/agentId/agentConfig at the top level — they go inside data.',
			inputSchema: {
				type: 'object',
				properties: {
					workflow_id: { type: 'string', description: 'The workflow ID to update (from workflow_list).' },
					name: { type: 'string', description: 'Workflow name (optional, preserved if omitted).' },
					description: { type: 'string', description: 'Workflow description (optional, preserved if omitted).' },
					nodes: {
						type: 'array',
						description: 'All nodes. Each node: { id(string), type(string), position({x,y}), data({label, ...typeFields}) }. ' +
							'CRITICAL: put label/agentId/agentConfig/other content inside `data`, NOT at top level.',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'Unique node id' },
								type: { type: 'string', description: 'Node type from workflow_get_schema' },
								position: {
									type: 'object',
									properties: { x: { type: 'number' }, y: { type: 'number' } },
									required: ['x', 'y'],
								},
								data: {
									type: 'object',
									description: 'Content fields: label (required), plus type-specific fields (agentId, agentConfig, prompt, etc.)',
								},
							},
							required: ['id', 'type', 'position'],
						},
					},
					connections: {
						type: 'array',
						description: 'All connections (edges) between nodes. Each connection: id (string), from (source node id), to (target node id). ' +
							'CRITICAL for multi-port nodes (ifElse/switch/condition/askUser): MUST also include fromPort (string). ' +
							'ifElse/condition: fromPort is "branch-0" or "branch-1". switch: "branch-0", "branch-1", etc. askUser: "option-0", "option-1", etc.',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'Unique edge id' },
								from: { type: 'string', description: 'Source node id' },
								to: { type: 'string', description: 'Target node id' },
								fromPort: { type: 'string', description: 'Required for multi-port nodes (branch-0, option-0, etc.)' },
							},
							required: ['id', 'from', 'to'],
						},
					},
					change_description: { type: 'string', description: 'Brief description of what changed (for user feedback).' },
				},
				required: ['workflow_id', 'nodes', 'connections'],
			},
			category: 'workflow',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, _agentId?: string) => {
			const wsId = resolveWorkspaceId();
			if (!wsId) {
				return [{ type: 'text', text: 'workflow_apply error: No active workspace.' }];
			}

			const workflowId = args['workflow_id'] as string | undefined;
			if (!workflowId) {
				return [{ type: 'text', text: 'workflow_apply error: workflow_id is required.' }];
			}

			const nodes = args['nodes'] as Array<Record<string, unknown>> | undefined;
			const connections = args['connections'] as Array<Record<string, unknown>> | undefined;
			const name = args['name'] as string | undefined;
			const description = args['description'] as string | undefined;
			/* changeDescription removed */
			const changeDescription: string | undefined = undefined;

			if (!Array.isArray(nodes)) {
				return [{ type: 'text', text: 'workflow_apply error: nodes must be an array.' }];
			}
			if (!Array.isArray(connections)) {
				return [{ type: 'text', text: 'workflow_apply error: connections must be an array.' }];
			}

			try {
				// Validate: must have Start and End nodes
				const hasStart = nodes.some(n => n.type === 'start' || n.id === 'start');
				const hasEnd = nodes.some(n => n.type === 'end' || n.id === 'end');
				if (!hasStart || !hasEnd) {
					return [{ type: 'text', text: 'workflow_apply validation error: Workflow must have both a Start node and an End node.' }];
				}

				// Normalize node format: AI may send fields (label, agentId, agentConfig etc.)
				// at the top level instead of nested inside `data`. Move them into `data`
				// so loadWorkflow() in the webview sees them correctly.
				const fixups: string[] = [];
				const KNOWN_META_KEYS = new Set(['id', 'type', 'position', 'parentId', 'style', 'data', 'name']);
				for (const node of nodes) {
					const data = (node.data as Record<string, unknown>) || {};
					let hasMoved = false;
					const movedFields: string[] = [];
					for (const key of Object.keys(node)) {
						if (!KNOWN_META_KEYS.has(key) && !(key in data)) {
							data[key] = node[key];
							movedFields.push(key);
							hasMoved = true;
						}
					}
					if (hasMoved) {
						fixups.push(`Node "${node.id}" (${node.type}): moved ${movedFields.join(', ')} into data`);
					}
					if (hasMoved || Object.keys(data).length > 0) {
						(node as Record<string, unknown>).data = data;
					}
					// Ensure label is always set (fallback to id)
					if (!data.label) {
						data.label = (node.name as string) || (node.id as string) || (node.type as string);
						(node as Record<string, unknown>).data = data;
						fixups.push(`Node "${node.id}": set label="${data.label}" (was missing)`);
					}
				}

				// Auto-populate agent node configs from the workflow's bound agent.
				// AI may forget to set agentConfig.providerId / modelId; we fill them here
				// as a server-side guarantee so agent nodes never show "No provider selected".
				try {
					const existingWf = await ctx.workflowStorageService.getWorkflow(workflowId, wsId);
					if (existingWf?.agentId) {
						const workflowAgent = await ctx.studioService.getAgent(existingWf.agentId);
						if (workflowAgent?.model) {
							const defaultModelId = typeof workflowAgent.model === 'string'
								? workflowAgent.model
								: Array.isArray(workflowAgent.model)
									? workflowAgent.model[0]
									: (workflowAgent.model as { primary: string })?.primary;
							const defaultProviderId = (workflowAgent as any).providerId || '';

							for (const node of nodes) {
								if (node.type === 'agent') {
									const data = (node.data as Record<string, unknown>) || {};
									if (!data.agentId) {
										data.agentId = existingWf.agentId;
										fixups.push(`Node "${node.id}" (agent): auto-set agentId="${existingWf.agentId}"`);
									}
									const cfg = (data.agentConfig as Record<string, unknown>) || {};
									if (!cfg.providerId && !cfg.modelId) {
										data.agentConfig = {
											providerId: defaultProviderId || '',
											modelId: defaultModelId || '',
										};
										fixups.push(`Node "${node.id}" (agent): auto-set agentConfig={ providerId:"${defaultProviderId || ''}", modelId:"${defaultModelId || ''}" }`);
									} else if (!cfg.modelId && defaultModelId) {
										cfg.modelId = defaultModelId;
										data.agentConfig = cfg;
										fixups.push(`Node "${node.id}" (agent): auto-set modelId="${defaultModelId}" (was missing)`);
									} else if (cfg.modelId && !cfg.providerId && defaultProviderId) {
										cfg.providerId = defaultProviderId;
										data.agentConfig = cfg;
										fixups.push(`Node "${node.id}" (agent): auto-set providerId="${defaultProviderId}" (was missing)`);
									}
									(node as Record<string, unknown>).data = data;
								}
							}
						}
					}
				} catch {
					// Non-fatal: if we can't resolve the agent, proceed with whatever the AI provided
				}

				// v6: Auto-default prompt templates for AI-generated workflow nodes.
				//   - All nodes with a `data.prompt` field get a placeholder when empty.
				//   - The FIRST prompt-bearing node (in BFS order from Start) defaults to `{{input}}`.
				//   - All other prompt-bearing nodes default to `{{$prev.output}}` (most recent upstream output).
				try {
					const PROMPT_NODE_TYPES = new Set(['prompt', 'agent']);
					const promptBearing: string[] = [];  // node ids in BFS order
					const seen = new Set<string>(['start']);
					const queue: string[] = ['start'];
					// Build adjacency list once for the BFS
					const adj = new Map<string, string[]>();
					for (const c of connections as Array<{ from: string; to: string }>) {
						const list = adj.get(c.from) ?? [];
						list.push(c.to);
						adj.set(c.from, list);
					}
					while (queue.length > 0) {
						const cur = queue.shift()!;
						for (const next of adj.get(cur) ?? []) {
							if (seen.has(next)) { continue; }
							seen.add(next);
							const nn = nodes.find(n => n.id === next);
							if (nn && PROMPT_NODE_TYPES.has(nn.type as string)) {
								promptBearing.push(next);
							}
							queue.push(next);
						}
					}

					for (let i = 0; i < promptBearing.length; i++) {
						const nid = promptBearing[i];
						const node = nodes.find(n => n.id === nid);
						if (!node) { continue; }
						const data = (node.data as Record<string, unknown>) || {};
						const currentPrompt = (data.prompt as string | undefined) ?? '';
						if (currentPrompt.trim().length > 0) { continue; }  // AI explicitly set it
						const defaultTpl = i === 0
							? '{{input}}'                       // first prompt-bearing node
							: '{{$prev.output}}';               // all others
						data.prompt = defaultTpl;
						(node as Record<string, unknown>).data = data;
						fixups.push(
							`Node "${nid}" (${node.type}): auto-set prompt="${defaultTpl}" ` +
							`(${i === 0 ? 'first prompt node → {{input}}' : 'downstream → {{$prev.output}}'})`,
						);
					}
				} catch (err) {
					// Non-fatal — proceed without the prompt defaults.
					ctx.logService.warn('[BuiltinTools] workflow_apply: prompt template defaulting failed', err);
				}

				// Build the patch
				const patch: Partial<IStoredWorkflow> = {
					nodes: nodes as unknown as IStoredWorkflow['nodes'],
					connections: connections as unknown as IStoredWorkflow['connections'],
				};
				if (name !== undefined) { patch.name = name; }
				if (description !== undefined) { patch.description = description; }

				const updated = await ctx.workflowStorageService.updateWorkflow(workflowId, patch, wsId);

				// Notify the controller to push changes to the webview
			workflowAppliedEmitter.fire({ workflow: updated, description: changeDescription });

				const nodeCount = nodes.length;
				const connCount = connections.length;
				let resultText = `Workflow "${updated.name || workflowId}" updated successfully. ${nodeCount} nodes, ${connCount} connections applied.`;
				if (fixups.length > 0) {
					resultText += '\n\n[Format fixes applied — please use the correct format next time to avoid these automatic corrections:]';
					for (const f of fixups) {
						resultText += `\n  • ${f}`;
					}
					resultText += '\n\nReminder: put all content fields (label, agentId, agentConfig, etc.) inside the `data` object in each node.';
				}
				return [{ type: 'text', text: resultText }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `workflow_apply error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerWorkflowTools: 4 workflow tools registered (list/get/schema/apply)');
}
