/*---------------------------------------------------------------------------------------------
 *  Unit tests for WorkflowExecutionService._executeComfyNode — the Comfy/ComfyStage
 *  execution path (E group).
 *
 *  Verifies:
 *   - Comfy nodes are skipped (warn) when no delegate is registered
 *   - bindings are pre-resolved via {{var}} against upstream node outputs
 *   - the delegate is invoked with resolved values + executionId
 *   - results are written back to nodeState.output (summary or JSON)
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert';
import { WorkflowExecutionService } from '../../browser/workflowExecutionService.js';
import type { IComfyExecutionDelegate } from '../../common/comfyBridge.js';

// ─── Mocks (mirror workflowExecutionService.test.ts) ─────────────────────────

function makeLogService() {
	const noop = () => { /* intentionally empty */ };
	const warnings: string[] = [];
	return {
		_serviceBrand: undefined,
		warnings,
		trace: noop, debug: noop, info: noop,
		warn: (msg: string) => warnings.push(msg),
		error: noop, dispose: noop, getLevel: () => 0, setLevel: noop,
		onDidChangeLogLevel: () => ({ dispose() {} }),
	};
}

function makeAgentChatService() {
	return {
		_serviceBrand: undefined,
		createAgentSession: async () => ({ id: 's1' }),
		appendMessage: async () => { /* noop */ },
	};
}

function makeWorkflowStorage(workflow: unknown) {
	return {
		_serviceBrand: undefined,
		getWorkflow: async () => workflow,
	};
}

function buildService(deps: {
	log?: ReturnType<typeof makeLogService>;
	chat?: unknown;
	storage: ReturnType<typeof makeWorkflowStorage>;
}) {
	const log = deps.log ?? makeLogService();
	const chat = deps.chat ?? makeAgentChatService();
	return {
		svc: new WorkflowExecutionService(
			log as any,
			chat as any,
			deps.storage as any,
			{} as any, // fileService
			{} as any, // workspaceRegistry
			{} as any, // skillRegistry
		) as any,
		log,
	};
}

// ─── Workflow + execution state fixtures ─────────────────────────────────────

const WORKFLOW = {
	id: 'wf-comfy',
	name: 'Comfy Workflow',
	agentId: 'owner-1',
	breakpoints: [],
	nodes: [],
	edges: [],
};

function makeState() {
	// executionState shape used by _executeComfyNode
	return {
		executionId: 'exec-1',
		nodeStates: new Map<string, { output: unknown }>(),
		context: {} as Record<string, unknown>,
	};
}

function comfyNode(overrides: Record<string, unknown> = {}) {
	return {
		id: 'n-comfy',
		type: 'comfy',
		name: 'Comfy',
		position: { x: 0, y: 0 },
		data: {
			label: '文生图',
			comfy: { mode: 'workflow', workflowId: 'wf-img' },
			bindings: {
				prompt: 'main_prompt',
				label: '{{n-prompt.output}}',
				seed: '',
			},
			defaults: { seed: 42 },
		},
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite('WorkflowExecutionService Comfy node execution', () => {

	suite('no delegate registered', () => {

		test('skips the node with a warning', async () => {
			const { svc, log } = buildService({ storage: makeWorkflowStorage(WORKFLOW) });
			const state = makeState();
			await svc._executeComfyNode(state, WORKFLOW, comfyNode());
			assert.strictEqual(state.nodeStates.get('n-comfy'), undefined);
			assert.ok(log.warnings.some(w => w.includes('no Comfy execution delegate')), 'should warn about missing delegate');
		});
	});

	suite('delegate registered', () => {

		test('invokes delegate with resolved bindings + executionId', async () => {
			const { svc } = buildService({ storage: makeWorkflowStorage(WORKFLOW) });
			const state = makeState();
			state.nodeStates.set('n-prompt', { output: '黄昏森林' });
			state.nodeStates.set('n-comfy', { output: undefined });

			const calls: Array<{ node: unknown; input: unknown; ctx: unknown }> = [];
			const delegate: IComfyExecutionDelegate = {
				execute: async (node, input, ctx) => {
					calls.push({ node, input, ctx });
					return { outputs: { image: 'img:abc' }, summary: '生成完成' };
				},
			};
			svc.setComfyExecutionDelegate(delegate);

			await svc._executeComfyNode(state, WORKFLOW, comfyNode());

			assert.strictEqual(calls.length, 1);
			const { input, ctx } = calls[0];
			// {{n-prompt.output}} resolved from upstream
			assert.strictEqual(input.values['label'], '黄昏森林');
			// non-{{}} bindings pass through unchanged (host layer only handles {{var}})
			assert.strictEqual(input.values['prompt'], 'main_prompt');
			// empty binding → default fallback
			assert.strictEqual(input.values['seed'], 42);
			assert.strictEqual(ctx.executionId, 'exec-1');
			// output written back
			assert.strictEqual(state.nodeStates.get('n-comfy')?.output, '生成完成');
		});

		test('writes JSON.stringify(outputs) when no summary', async () => {
			const { svc } = buildService({ storage: makeWorkflowStorage(WORKFLOW) });
			const state = makeState();
			state.nodeStates.set('n-comfy', { output: undefined });
			const delegate: IComfyExecutionDelegate = {
				execute: async () => ({ outputs: { image: ['a.png'] } }),
			};
			svc.setComfyExecutionDelegate(delegate);
			await svc._executeComfyNode(state, WORKFLOW, comfyNode());
			assert.strictEqual(state.nodeStates.get('n-comfy')?.output, JSON.stringify({ image: ['a.png'] }));
		});

		test('propagates delegate errors to the caller', async () => {
			const { svc } = buildService({ storage: makeWorkflowStorage(WORKFLOW) });
			const state = makeState();
			const delegate: IComfyExecutionDelegate = {
				execute: async () => { throw new Error('ComfyUI timeout'); },
			};
			svc.setComfyExecutionDelegate(delegate);
			await assert.rejects(() => svc._executeComfyNode(state, WORKFLOW, comfyNode()), /ComfyUI timeout/);
		});

		test('stage mode nodes also route through the delegate', async () => {
			const { svc } = buildService({ storage: makeWorkflowStorage(WORKFLOW) });
			const state = makeState();
			state.nodeStates.set('n-stage', { output: undefined });
			const delegate: IComfyExecutionDelegate = {
				execute: async (_node, _input, _ctx) => ({ outputs: { audio: 'a.wav' }, summary: 'stage ok' }),
			};
			svc.setComfyExecutionDelegate(delegate);
			const stageNode = comfyNode({
				id: 'n-stage',
				type: 'comfyStage',
				data: { comfy: { mode: 'stage', stageClass: 'ComfyTV.TTSStage' }, bindings: {} },
			});
			await svc._executeComfyNode(state, WORKFLOW, stageNode);
			assert.strictEqual(state.nodeStates.get('n-stage')?.output, 'stage ok');
		});
	});
});
