/*---------------------------------------------------------------------------------------------
 *  Unit tests for generateFlow — the pure "one sentence → connected image-gen graph" builder
 *  (docs/Agent-画布编排设计方案.md P0 → canvas_generate tool).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildGenerateFlow, resolveRouting } from '../../webview/src/features/workflowEditor/comfyHost/generateFlow.js';

suite('generateFlow — buildGenerateFlow', () => {

	test('single variant creates Prompt → ModelImageGen with prompt text', () => {
		const r = buildGenerateFlow('a cyberpunk cat');
		assert.strictEqual(r.nodes.length, 2);
		assert.strictEqual(r.entryIds.length, 1);
		assert.strictEqual(r.promptIds.length, 1);
		const prompt = r.nodes.find(n => n.id === r.promptIds[0]);
		const gen = r.nodes.find(n => n.id === r.entryIds[0]);
		assert.strictEqual(prompt?.type, 'Sarosis.Prompt');
		assert.strictEqual(gen?.type, 'Sarosis.ModelImageGen');
		assert.strictEqual(prompt?.data.prompt, 'a cyberpunk cat');
		assert.strictEqual(gen?.data.prompt, 'a cyberpunk cat');
		assert.strictEqual(r.edges.length, 1);
		assert.strictEqual(r.edges[0].source, r.promptIds[0]);
		assert.strictEqual(r.edges[0].target, r.entryIds[0]);
		assert.strictEqual(r.edges[0].sourceHandle, 'output');
		assert.strictEqual(r.edges[0].targetHandle, 'prompt');
	});

	test('multi-variant creates N prompt/image pairs with unique ids', () => {
		const r = buildGenerateFlow('a landscape', {
			variants: [{ prompt: 'mountain' }, { prompt: 'ocean' }, { prompt: 'forest' }],
		});
		assert.strictEqual(r.nodes.length, 6);
		assert.strictEqual(r.entryIds.length, 3);
		assert.strictEqual(r.promptIds.length, 3);
		assert.strictEqual(r.edges.length, 3);
		const uniqueIds = new Set([...r.promptIds, ...r.entryIds]);
		assert.strictEqual(uniqueIds.size, 6, 'all node ids unique');
		// Each variant prompt flows into its own gen node.
		for (let i = 0; i < 3; i++) {
			const gen = r.nodes.find(n => n.id === r.entryIds[i]);
			const prompt = r.nodes.find(n => n.id === r.promptIds[i]);
			assert.strictEqual(gen?.data.prompt, ['mountain', 'ocean', 'forest'][i]);
			assert.strictEqual(prompt?.data.prompt, ['mountain', 'ocean', 'forest'][i]);
		}
	});

	test('explicit provider/model is written into every gen node', () => {
		const r = buildGenerateFlow('x', { providerId: 'p1', modelId: 'm1', count: 2 });
		for (const id of r.entryIds) {
			const gen = r.nodes.find(n => n.id === id);
			assert.strictEqual(gen?.data.providerId, 'p1');
			assert.strictEqual(gen?.data.modelId, 'm1');
		}
		assert.deepStrictEqual(r.routing, { providerId: 'p1', modelId: 'm1' });
	});

	test('auto-routes from authenticated providers when explicit is absent', () => {
		const providers = [
			{ id: 'unauth', authStatus: 'anonymous' },
			{ id: 'auth', authStatus: 'authenticated', models: [{ id: 'img1', supportsImageGen: true }] },
		];
		const r = buildGenerateFlow('y', { providers });
		const gen = r.nodes.find(n => n.id === r.entryIds[0]);
		assert.strictEqual(gen?.data.providerId, 'auth');
		assert.strictEqual(gen?.data.modelId, 'img1');
		assert.deepStrictEqual(r.routing, { providerId: 'auth', modelId: 'img1' });
	});

	test('no routing when no explicit provider and nothing authenticated', () => {
		const r = buildGenerateFlow('z');
		const gen = r.nodes.find(n => n.id === r.entryIds[0]);
		assert.strictEqual(gen?.data.providerId, '');
		assert.strictEqual(gen?.data.modelId, '');
		assert.deepStrictEqual(r.routing, {});
	});

	test('negativePrompt and size flow into gen nodes', () => {
		const r = buildGenerateFlow('x', { negativePrompt: 'blurry, low quality', size: '768x768' });
		const gen = r.nodes.find(n => n.id === r.entryIds[0]);
		assert.strictEqual(gen?.data.negativePrompt, 'blurry, low quality');
		assert.strictEqual(gen?.data.size, '768x768');
	});

	test('existing graph is preserved and new ids do not collide', () => {
		const existing = {
			nodes: [
				{ id: 'prompt-1', type: 'Sarosis.Prompt', position: { x: 0, y: 0 }, data: { label: 'Prompt-1' } },
				{ id: 'model-image-gen-1', type: 'Sarosis.ModelImageGen', position: { x: 0, y: 0 }, data: { label: 'ModelImageGen-1' } },
			],
			edges: [{ id: 'e1', source: 'prompt-1', target: 'model-image-gen-1' }],
		};
		const r = buildGenerateFlow('x', { existing, seed: 0 });
		assert.strictEqual(r.nodes.length, existing.nodes.length + 2);
		assert.strictEqual(r.edges.length, existing.edges.length + 1);
		// Existing nodes are preserved in the output.
		assert.ok(r.nodes.some(n => n.id === 'prompt-1'));
		assert.ok(r.nodes.some(n => n.id === 'model-image-gen-1'));
		// Newly generated ids do not collide with existing ids.
		const existingIds = new Set(existing.nodes.map(n => n.id));
		for (const id of [...r.promptIds, ...r.entryIds]) {
			assert.ok(!existingIds.has(id), `new id ${id} must not collide`);
		}
	});

	test('chainAfterId links the upstream node to the first prompt', () => {
		const existing = {
			nodes: [{ id: 'up', type: 'Sarosis.Prompt', position: { x: 0, y: 0 }, data: { label: '上游' } }],
			edges: [],
		};
		const r = buildGenerateFlow('x', { existing, chainAfterId: 'up' });
		const chainEdge = r.edges.find(e => e.source === 'up');
		assert.ok(chainEdge, 'chain edge exists');
		assert.strictEqual(chainEdge?.target, r.promptIds[0]);
	});

	test('chainAfterId is ignored when upstream does not exist', () => {
		const r = buildGenerateFlow('x', { chainAfterId: 'ghost' });
		assert.strictEqual(r.edges.length, 1, 'only the prompt→gen edge exists');
	});

	test('layout positions variants in columns and gen right of prompt', () => {
		const r = buildGenerateFlow('x', { variants: [{}, {}], origin: { x: 100, y: 200 } });
		const [p0, g0] = [r.nodes[0], r.nodes[1]];
		const [p1, g1] = [r.nodes[2], r.nodes[3]];
		assert.strictEqual(p0.position.x, 100);
		assert.strictEqual(p1.position.x, 400, 'second column offset by 300');
		assert.strictEqual(g0.position.x, 100 + 220, 'gen right of its prompt');
		assert.ok(g1.position.x > p1.position.x);
	});
});

suite('generateFlow — resolveRouting', () => {

	test('explicit wins even when a provider could auto-route', () => {
		const providers = [{ id: 'a', authStatus: 'authenticated', models: [{ id: 'm', supportsImageGen: true }] }];
		assert.deepStrictEqual(resolveRouting({ providerId: 'e', modelId: 'em', providers }), { providerId: 'e', modelId: 'em' });
	});

	test('auto-route uses the first authenticated image-gen provider', () => {
		const providers = [
			{ id: 'a', authStatus: 'authenticated', models: [{ id: 'm1', supportsImageGen: false }, { id: 'm2', supportsImageGen: true }] },
		];
		assert.deepStrictEqual(resolveRouting({ providers }), { providerId: 'a', modelId: 'm2' });
	});

	test('partial explicit (only providerId) does NOT half-route', () => {
		const providers = [{ id: 'a', authStatus: 'authenticated', models: [{ id: 'm', supportsImageGen: true }] }];
		// providerId without modelId → falls through to auto-route (no half config).
		assert.deepStrictEqual(resolveRouting({ providerId: 'p', providers }), { providerId: 'a', modelId: 'm' });
	});

	test('empty providers → empty routing', () => {
		assert.deepStrictEqual(resolveRouting({ providers: [] }), {});
	});
});
