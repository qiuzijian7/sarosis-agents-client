/*---------------------------------------------------------------------------------------------
 *  Unit tests for the <canvas_context> tag pipeline (docs/Agent-画布编排设计方案.md P0):
 *  - CanvasContextStore: set/get/expiry/bounds.
 *  - formatCanvasContextContent: node rendering, truncation, lastOpsSummary.
 *  - CanvasContextTagProvider: resolves workflowId, returns null without snapshot.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CanvasContextStore, type CanvasContextSnapshot } from '../../browser/messageEnrichment/canvasContextStore.js';
import { formatCanvasContextContent, CanvasContextTagProvider } from '../../browser/messageEnrichment/builtinTagProviders.js';
import { formatCanvasStateText } from '../../browser/providers/tool/canvasTools.js';

function snapshot(overrides: Partial<CanvasContextSnapshot> = {}): CanvasContextSnapshot {
	return {
		nodes: [
			{ id: 'n1', label: '图像-1', type: 'Sarosis.ModelImageGen', runState: 'success', durationMs: 1234 },
			{ id: 'n2', label: '提示-1', type: 'Sarosis.Prompt', runState: 'idle' },
			{ id: 'n3', label: '图像-2', type: 'Sarosis.ModelImageGen', runState: 'error', errorMsg: '接口超时' },
		],
		lastOpsSummary: ['added node 图像-1 (Sarosis.ModelImageGen)', 'connected 提示-1 → 图像-1'],
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

suite('CanvasContextStore', () => {

	test('set then get returns the snapshot', () => {
		const store = new CanvasContextStore();
		store.set('wf-1', snapshot());
		assert.ok(store.get('wf-1'));
		assert.strictEqual(store.get('wf-1')!.nodes.length, 3);
	});

	test('unknown workflow returns undefined', () => {
		const store = new CanvasContextStore();
		assert.strictEqual(store.get('nope'), undefined);
	});

	test('clear removes the snapshot', () => {
		const store = new CanvasContextStore();
		store.set('wf-1', snapshot());
		store.clear('wf-1');
		assert.strictEqual(store.get('wf-1'), undefined);
	});

	test('clearAll empties the store', () => {
		const store = new CanvasContextStore();
		store.set('wf-1', snapshot());
		store.set('wf-2', snapshot());
		store.clearAll();
		assert.strictEqual(store.size, 0);
	});

	test('expired snapshot (older than TTL) is dropped on read', () => {
		const store = new CanvasContextStore();
		const old = snapshot({ updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
		store.set('wf-1', old);
		assert.strictEqual(store.get('wf-1'), undefined);
	});

	test('prune on set removes expired entries', () => {
		const store = new CanvasContextStore();
		store.set('wf-1', snapshot({ updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
		store.set('wf-2', snapshot()); // triggers _prune
		assert.strictEqual(store.get('wf-1'), undefined);
		assert.ok(store.get('wf-2'));
	});
});

suite('formatCanvasContextContent', () => {

	test('renders each node with state label', () => {
		const text = formatCanvasContextContent(snapshot());
		assert.ok(text.includes('- 图像-1 [Sarosis.ModelImageGen] → 成功，耗时 1234ms'));
		assert.ok(text.includes('- 提示-1 [Sarosis.Prompt] → 待执行'));
		assert.ok(text.includes('- 图像-2 [Sarosis.ModelImageGen] → 失败，错误: 接口超时'));
	});

	test('lists lastOpsSummary', () => {
		const text = formatCanvasContextContent(snapshot());
		assert.ok(text.includes('最近画布操作:'));
		assert.ok(text.includes('  added node 图像-1 (Sarosis.ModelImageGen)'));
	});

	test('truncates nodes beyond maxNodes', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			id: `n${i}`, label: `节点-${i}`, type: 'Sarosis.Prompt', runState: 'idle' as const,
		}));
		const text = formatCanvasContextContent({ nodes: many, updatedAt: new Date().toISOString() }, { maxNodes: 30 });
		assert.ok(text.includes('节点-29'));
		assert.ok(!text.includes('节点-39'));
		assert.ok(text.includes('另有 10 个节点未列出'));
	});

	test('empty canvas yields a placeholder line', () => {
		const text = formatCanvasContextContent({ nodes: [], updatedAt: new Date().toISOString() });
		assert.ok(text.includes('画布当前无节点'));
	});

	test('XML-injectable content has no raw < > &', () => {
		const text = formatCanvasContextContent(snapshot({
			nodes: [{
				id: 'x', label: 'A&B<C>', type: 'Sarosis.Prompt', runState: 'error', errorMsg: 'fail<&>',
			}],
		}));
		assert.ok(!text.includes('<C>'));
		assert.ok(!text.includes('fail<'));
	});
});

suite('CanvasContextTagProvider', () => {

	test('builds content from the workflowId-scoped snapshot', () => {
		const store = {
			get(id: string) { return id === 'wf-9' ? snapshot() : undefined; },
		};
		const provider = new CanvasContextTagProvider();
		provider.store = store;
		const content = provider.buildContent({
			request: { agentId: 'agent', workflowTrigger: { workflowId: 'wf-9' } } as never,
		});
		assert.ok(content);
		assert.ok(content!.includes('图像-1'));
	});

	test('returns null when the workflow has no snapshot', () => {
		const store = { get: () => undefined };
		const provider = new CanvasContextTagProvider();
		provider.store = store;
		const content = provider.buildContent({
			request: { agentId: 'agent', workflowTrigger: { workflowId: 'wf-0' } } as never,
		});
		assert.strictEqual(content, null);
	});

	test('falls back to default workflowId without workflowTrigger', () => {
		const store = { get: (id: string) => id === 'default' ? snapshot() : undefined };
		const provider = new CanvasContextTagProvider();
		provider.store = store;
		const content = provider.buildContent({ request: { agentId: 'agent' } } as never);
		assert.ok(content);
	});
});

suite('formatCanvasStateText (canvas_get_state)', () => {

	test('lists node inventory with run state', () => {
		const s = snapshot({ edges: [{ id: 'e1', source: 'n1', target: 'n2' }] });
		const text = formatCanvasStateText(s);
		assert.ok(text.includes('画布节点（3 个'));
		assert.ok(text.includes('- 图像-1 [Sarosis.ModelImageGen] → 成功'));
		assert.ok(text.includes('- 图像-2 [Sarosis.ModelImageGen] → 失败：接口超时'));
	});

	test('lists connections with port handles', () => {
		const s = snapshot({ edges: [
			{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'prompt' },
		] });
		const text = formatCanvasStateText(s);
		assert.ok(text.includes('连线（1 条）'));
		assert.ok(text.includes('n1::output → n2::prompt'));
	});

	test('renders "连线: 无" when there are no edges', () => {
		const text = formatCanvasStateText(snapshot());
		assert.ok(text.includes('连线: 无'));
	});
});
