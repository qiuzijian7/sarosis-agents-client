/*---------------------------------------------------------------------------------------------
 *  workflowSandbox — 「最小真实测试环境」的 Node 侧回归。
 *
 *  与浏览器 visual harness 共用 `webview/visual/runtime.ts`（同一份注册 / 同一份执行
 *  链路），差异只在宿主：本文件无 DOM，只验证**执行**；浏览器侧再叠加**渲染**断言。
 *
 *  ★ import 路径必须字面量（esbuild 静态解析）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { createSandbox, type Sandbox } from '../../webview/visual/runtime.js';

suite('workflow sandbox (node host)', () => {

	test('createSandbox: mock + registry + memory store 就位', async () => {
		const sb = await createSandbox({ mode: 'node' });
		assert.ok(sb.specs.length > 100, `specs=${sb.specs.length}`);
		assert.ok(sb.store, 'snapshot store');
		assert.ok(sb.cardState, 'card state store');
		assert.strictEqual(typeof sb.runner.invoke, 'function', 'fake runner');
		// bridge 必须已装（否则 nodeCard/workflowRun 模块求值即抛）
		assert.ok((globalThis as unknown as Record<string, unknown>).__vssarosBridge, 'bridge mock installed');
	});

	test('run(): 本地节点缺输入 → 正确的中文业务错误（非崩溃）', async () => {
		const sb = await createSandbox({ mode: 'node' });
		const r = await sb.run('ComfyTV.RelightStage', {});
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /请先在节点弹窗中摆灯/);
	});

	test('run(): 纯文本节点无后端即可 success', async () => {
		const sb = await createSandbox({ mode: 'node' });
		// ★ Prompt 节点读的是 `prompt` 字段（不是 text）
		const r = await sb.run('Saros.Prompt', { prompt: 'hello' });
		assert.strictEqual(r.status, 'success', `error=${r.error ?? '(none)'}`);
	});

	test('run(): 结果状态写回 cardState（浏览器侧据此重渲染）', async () => {
		const sb = await createSandbox({ mode: 'node' });
		await sb.run('ComfyTV.RelightStage', {}, 'node-1');
		const st = (sb.cardState.get as (id: string) => { runState?: string; errorMsg?: string })('node-1');
		assert.strictEqual(st.runState, 'error', `runState=${st.runState}`);
		assert.ok(st.errorMsg, 'errorMsg should be set');

		await sb.run('Saros.Prompt', { prompt: 'x' }, 'node-2');
		const st2 = (sb.cardState.get as (id: string) => { runState?: string })('node-2');
		assert.strictEqual(st2.runState, 'success');
	});

	test('run(): runner 异常默认收敛为 error，strictThrow 才原样抛出', async () => {
		// ★ 223 个节点里 ComfyTV.MultiPanelStoryboardStage 是唯一让 runner 异常冒泡的
		//   （其余都自行 catch 成 error）。用它可以稳定复现两种行为。
		const sb = await createSandbox({ mode: 'node' });
		const r = await sb.run('ComfyTV.MultiPanelStoryboardStage', { prompt: 'a cat' });
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /no backend/i);

		const strict = await createSandbox({ mode: 'node', strictThrow: true });
		await assert.rejects(
			() => strict.run('ComfyTV.MultiPanelStoryboardStage', { prompt: 'a cat' }),
			/no backend/i,
		);
	});

	test('全量扫描：所有 spec 都可执行且不挂起', async () => {
		const sb = await createSandbox({ mode: 'node' });
		let success = 0;
		let error = 0;
		for (const s of sb.specs) {
			const type = (s as { type: string }).type;
			const r = await sb.run(type, { text: 'hello', prompt: 'hello' }, 'scan-' + type);
			if (r.status === 'success') { success++; } else { error++; }
		}
		// 与 2026-09-04 探针一致的基线：3 success / 220 非 success，总 223
		assert.strictEqual(sb.specs.length, 223, `specs=${sb.specs.length}`);
		assert.ok(success >= 3, `success=${success}`);
		assert.strictEqual(success + error, 223, 'every node must return a status');
	});

	// ── runGraph：多节点 + 上下游联动 ───────────────────────────────────────

	test('runGraph(): 按拓扑序执行，upstreams 正确传递', async () => {
		const sb = await createSandbox({ mode: 'node' });
		const r = await sb.runGraph({
			// ★ 故意乱序声明：c, a, b —— 拓扑序应纠正为 a → b → c
			nodes: [
				{ id: 'c', type: 'Saros.Prompt', values: { prompt: 'c' } },
				{ id: 'a', type: 'Saros.Prompt', values: { prompt: 'a' } },
				{ id: 'b', type: 'Saros.Prompt', values: { prompt: 'b' } },
			],
			edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
		});
		assert.deepStrictEqual(r.order, ['a', 'b', 'c'], `order=${r.order}`);
		assert.deepStrictEqual(r.nodes[0].upstreams, [], 'a 无上游');
		assert.deepStrictEqual(r.nodes[1].upstreams, ['a'], 'b 的上游是 a');
		assert.deepStrictEqual(r.nodes[2].upstreams, ['b'], 'c 的上游是 b');
		assert.strictEqual(r.ok, true, `status=${r.nodes.map(n => n.status).join(',')}`);
	});

	test('runGraph(): 上游失败 → 下游 skipped（不刷无意义报错）', async () => {
		const sb = await createSandbox({ mode: 'node' });
		const r = await sb.runGraph({
			nodes: [
				{ id: 'a', type: 'ComfyTV.RelightStage' },                  // 缺输入 → error
				{ id: 'b', type: 'Saros.Prompt', values: { prompt: 'x' } },
			],
			edges: [{ from: 'a', to: 'b' }],
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.nodes[0].status, 'error');
		assert.strictEqual(r.nodes[1].status, 'skipped');
		assert.match(r.nodes[1].error ?? '', /上游/);
	});

	test('runGraph(): 画布导出的 fixture 可在 Node 侧回放（录制→回归闭环）', async () => {
		// ★ 这是「手拖一次 → 导出 → 秒级回归」的 Node 侧那一半。
		//   fixture 用画布导出格式（`values` / `from` / `to` / `fromPort`），
		//   与 `visual/canvas/canvasHost.tsx` 的 exportFixture 一致。
		const sb = await createSandbox({ mode: 'node' });
		const fixture = {
			nodes: [
				{ id: 'n1', type: 'Saros.Prompt', values: { prompt: 'a cinematic portrait of a cat, 85mm' } },
				{ id: 'n2', type: 'Saros.Prompt', values: { prompt: 'hello' } },
			],
			edges: [{ from: 'n1', to: 'n2', fromPort: 'output', toPort: 'input' }],
		};
		const r = await sb.runGraph({
			nodes: fixture.nodes.map(n => ({ id: n.id, type: n.type, values: n.values })),
			edges: fixture.edges.map(e => ({ from: e.from, to: e.to, fromPort: e.fromPort })),
		});
		assert.strictEqual(r.ok, true, r.nodes.map(n => n.status + ':' + (n.error ?? '')).join(' | '));
		assert.deepStrictEqual(r.order, ['n1', 'n2']);
		assert.deepStrictEqual(r.nodes[1].upstreams, ['n1'], '下游拿到上游');
	});

	test('runGraph(): 环 / 悬空连线 / 重复 id 均为图级错误', async () => {
		const sb = await createSandbox({ mode: 'node' });

		const cyc = await sb.runGraph({
			nodes: [{ id: 'a', type: 'Saros.Prompt' }, { id: 'b', type: 'Saros.Prompt' }],
			edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
		});
		assert.match(cyc.error ?? '', /环/);

		const dangling = await sb.runGraph({
			nodes: [{ id: 'a', type: 'Saros.Prompt' }],
			edges: [{ from: 'a', to: 'ghost' }],
		});
		assert.match(dangling.error ?? '', /不存在的节点/);

		const dup = await sb.runGraph({
			nodes: [{ id: 'a', type: 'Saros.Prompt' }, { id: 'a', type: 'Saros.Prompt' }],
		});
		assert.match(dup.error ?? '', /重复/);
	});
});
