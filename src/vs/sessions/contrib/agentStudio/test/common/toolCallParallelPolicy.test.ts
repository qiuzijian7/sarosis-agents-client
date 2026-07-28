/*---------------------------------------------------------------------------------------------
 *  Tests for the main-loop tool parallel policy (产品决策 2026-07-22):
 *  除 subagent 派发外，主循环工具一律串行执行 —— shouldParallelizeToolBatch
 *  在 MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false 下对任何批次都返回 false。
 *  subagent 内部并行（delegate_task batch / plan_explore → unifiedSubAgentDispatch）
 *  不经过该判定，不受影响（由 unifiedSubAgentDispatch 测试覆盖）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MAIN_LOOP_PARALLEL_TOOLS_ENABLED, shouldParallelizeToolBatch, splitDelegateParallelBatch } from '../../browser/toolCallUtils.js';
import type { IToolCallInfo } from '../../common/providers.js';

function tc(name: string, args: Record<string, unknown> = {}): IToolCallInfo {
	return { id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) } as IToolCallInfo;
}

suite('toolCallParallelPolicy — 主循环除 subagent 外禁止并行', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('policy flag is locked OFF', () => {
		assert.strictEqual(MAIN_LOOP_PARALLEL_TOOLS_ENABLED, false,
			'主循环并行开关必须关闭（恢复并行需显式改回 true）');
	});

	test('read-only PARALLEL_SAFE batch (search_files + search_code + file_read) → serial', () => {
		const batch = [tc('search_files', { pattern: 'gc.*' }), tc('search_code', { query: 'GC::ProcessAsync' }), tc('file_read', { path: 'a.cpp' })];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false,
			'历史上可并行的只读批次，在新策略下必须串行');
	});

	test('knowledge-graph batch (search_graph + query_graph + get_code_snippet) → serial', () => {
		const batch = [tc('search_graph', { query: 'x' }), tc('query_graph', { cypher: 'MATCH…' }), tc('get_code_snippet', { id: '1' })];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false);
	});

	test('single call → serial (unchanged)', () => {
		assert.strictEqual(shouldParallelizeToolBatch([tc('file_read')]), false);
	});

	test('multiple delegate_task calls → parallel（2026-07-27 日志 1785120071762 修复）', () => {
		// 用户报告：3 个 delegate_task 只有最后一个在调用工具——串行时首个
		// subagent（最长 600s）阻塞期间其余排队。≥2 个 delegate_task 属于
		// 「subagent 通道并行」（与主开关"仅 subagent 通道可并行"决策一致），
		// 允许并行；每个 handler 的 inlineTraceSink 闭包独立，dispatch 并发上限兜底。
		const batch = [tc('delegate_task', { role: 'explore', task: 'a' }), tc('delegate_task', { role: 'explore', task: 'b' }), tc('delegate_task', { role: 'explore', task: 'c' })];
		assert.strictEqual(shouldParallelizeToolBatch(batch), true,
			'全 delegate_task 批次必须并行（否则首个长 subagent 阻塞其余排队）');
	});

	test('delegate_task 混合只读工具 → parallel（2026-07-27 日志 1785121881324：read_skill+3×delegate 串行 bug）', () => {
		// 真实场景：LLM 同一轮夹带只读工具（read_skill/search_*）+ 多个 delegate_task。
		// 此前要求整批纯 delegate_task 过严 → 混合批次串行 → 只有首个 delegate 执行。
		// read_skill 无状态写，与 delegate 并行无副作用。
		const batch = [
			tc('read_skill', { skill_id: 'x' }),
			tc('delegate_task', { role: 'explore', task: 'a' }),
			tc('delegate_task', { role: 'explore', task: 'b' }),
			tc('delegate_task', { role: 'explore', task: 'c' }),
		];
		assert.strictEqual(shouldParallelizeToolBatch(batch), true,
			'≥2 delegate_task + 其余只读安全工具 → 并行');
	});

	test('单个 delegate_task 不并行（只有 1 个 → 串行）', () => {
		const batch = [tc('read_skill', { skill_id: 'x' }), tc('delegate_task', { role: 'explore', task: 'a' })];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false,
			'仅 1 个 delegate_task 无并行收益，走主开关（串行）');
	});

	test('delegate_task 混入写工具 → 回退串行（保守）', () => {
		const batch = [
			tc('file_write', { path: 'a.ts', content: 'x' }),
			tc('delegate_task', { role: 'explore', task: 'a' }),
			tc('delegate_task', { role: 'explore', task: 'b' }),
		];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false,
			'混入非只读工具（file_write）→ 回退主开关串行');
	});

	test('mixed batch (delegate_task + search) → serial', () => {
		const batch = [tc('delegate_task', { role: 'general', task: 'a' }), tc('search_files', { pattern: '*.ts' })];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false);
	});

	test('empty batch → serial', () => {
		assert.strictEqual(shouldParallelizeToolBatch([]), false);
	});
});

suite('splitDelegateParallelBatch — delegate 分区拆分（log 1785237386145）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('≥2 delegate_task → 返回 { head, delegates }', () => {
		const batch = [tc('update_plan', { plan: 'x' }), tc('delegate_task', { task: 'a' }), tc('delegate_task', { task: 'b' }), tc('delegate_task', { task: 'c' })];
		const split = splitDelegateParallelBatch(batch);
		assert.ok(split, '≥2 delegate_task 应返回拆分');
		assert.strictEqual(split!.delegates.length, 3, 'delegates 子集含全部 3 个 delegate_task');
		assert.strictEqual(split!.head.length, 1, 'head 含 1 个非 delegate 工具');
		assert.strictEqual(split!.head[0].name, 'update_plan');
	});

	test('复现日志场景：update_plan + index_status + read_skill + 3×delegate → head=3 只读/状态工具，delegates=3', () => {
		// 日志 1785237386145：该批次 shouldParallelizeToolBatch=false（update_plan 非
		// 并行安全）→ 整批串行 → 首个 delegate 阻塞，其余 2 张卡片无内容。分区后
		// head 串行、delegates 并行，3 张卡片同时呈现子 agent。
		const batch = [
			tc('update_plan', { plan: 'x' }),
			tc('index_status'),
			tc('read_skill', { skill_id: 's' }),
			tc('delegate_task', { task: 'a' }),
			tc('delegate_task', { task: 'b' }),
			tc('delegate_task', { task: 'c' }),
		];
		assert.strictEqual(shouldParallelizeToolBatch(batch), false, 'update_plan 混入 → 整批不并行（前提）');
		const split = splitDelegateParallelBatch(batch);
		assert.ok(split, '仍应拆分出 delegate 子集');
		assert.deepStrictEqual(split!.head.map(c => c.name), ['update_plan', 'index_status', 'read_skill']);
		assert.strictEqual(split!.delegates.length, 3);
	});

	test('<2 delegate_task → null（不触发分区）', () => {
		assert.strictEqual(splitDelegateParallelBatch([tc('delegate_task', { task: 'a' }), tc('read_skill')]), null);
		assert.strictEqual(splitDelegateParallelBatch([tc('file_read'), tc('search_files')]), null);
		assert.strictEqual(splitDelegateParallelBatch([]), null);
	});
});
