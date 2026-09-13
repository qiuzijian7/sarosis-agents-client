/*---------------------------------------------------------------------------------------------
 *  Unit tests for workflowError（P0-1 跨范式统一错误分类）+ meta 写侧类型化（P0-2）。
 *
 *  这两组 API 都是"约定收敛"型改造，测试锁定其行为契约，防后续回退：
 *   - toWorkflowError 的推断规则（cancel/timeout 关键词）与幂等性；
 *   - isRetryableError 的可重试集合（取消/入参非法/无画布**不可**重试）；
 *   - sheetDimsMeta 的「有限值一律写入（含 0）」语义 —— 曾因省略 0 破坏
 *     nodeCard 的 `meta.rows !== undefined` 上游图集语义判定；
 *   - metaValue/buildMeta 丢弃 undefined/null（防写入 'undefined' 脏值）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { WorkflowError, toWorkflowError, isRetryableError } from '../../common/workflowError.js';
import { metaValue, buildMeta, sheetDimsMeta, sheetDimsOf } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

suite('workflowError (P0-1)', () => {

	test('WorkflowError 携带 code/cause 且 instanceof Error', () => {
		const cause = new Error('root');
		const e = new WorkflowError('BackendError', 'comfy 500', cause);
		assert.ok(e instanceof Error);
		assert.strictEqual(e.code, 'BackendError');
		assert.strictEqual(e.message, 'comfy 500');
		assert.strictEqual(e.cause, cause);
		assert.strictEqual(e.name, 'WorkflowError');
	});

	test('toWorkflowError 幂等：已分类错误原样返回（不重复包装丢失 code）', () => {
		const e = new WorkflowError('Timeout', 'slow');
		assert.strictEqual(toWorkflowError(e), e);
	});

	test('toWorkflowError 按消息推断 Cancelled', () => {
		assert.strictEqual(toWorkflowError(new Error('run was cancelled')).code, 'Cancelled');
	});

	test('toWorkflowError 按消息推断 Timeout（中英文均覆盖）', () => {
		assert.strictEqual(toWorkflowError(new Error('timed out after 90s')).code, 'Timeout');
		assert.strictEqual(toWorkflowError(new Error('stage 执行超时（90s）')).code, 'Timeout');
	});

	test('toWorkflowError 未命中关键词时用 fallback', () => {
		assert.strictEqual(toWorkflowError(new Error('weird'), 'BackendError').code, 'BackendError');
		assert.strictEqual(toWorkflowError(new Error('weird')).code, 'Unknown');
	});

	test('toWorkflowError 接受非 Error 抛值（字符串/对象）', () => {
		assert.strictEqual(toWorkflowError('plain string').message, 'plain string');
		assert.strictEqual(toWorkflowError({ a: 1 }).code, 'Unknown');
	});

	test('isRetryableError：超时/后端/上游可重试', () => {
		assert.strictEqual(isRetryableError('Timeout'), true);
		assert.strictEqual(isRetryableError('BackendError'), true);
		assert.strictEqual(isRetryableError('UpstreamFailed'), true);
	});

	test('★ isRetryableError：取消/入参非法/无画布**不可**重试（重试只会重复失败）', () => {
		assert.strictEqual(isRetryableError('Cancelled'), false);
		assert.strictEqual(isRetryableError('InvalidInput'), false);
		assert.strictEqual(isRetryableError('NoCanvas'), false);
		assert.strictEqual(isRetryableError('Unknown'), false);
	});
});

suite('meta 写侧类型化 (P0-2)', () => {

	suite('metaValue', () => {

		test('数字/布尔序列化为字符串（存储层 meta 全字符串）', () => {
			assert.strictEqual(metaValue(3), '3');
			assert.strictEqual(metaValue(0), '0');
			assert.strictEqual(metaValue(true), 'true');
		});

		test('字符串原样', () => {
			assert.strictEqual(metaValue('1'), '1');
		});

		test('★ undefined/null → undefined（丢弃字段，防写入 "undefined" 脏值）', () => {
			assert.strictEqual(metaValue(undefined), undefined);
			assert.strictEqual(metaValue(null), undefined);
		});
	});

	suite('buildMeta', () => {

		test('批量序列化并丢弃空值', () => {
			const m = buildMeta({ rows: 3, cols: 3, removeBg: true, skip: undefined, none: null });
			assert.deepStrictEqual(m, { rows: '3', cols: '3', removeBg: 'true' });
		});

		test('空 patch → 空对象（可安全展开）', () => {
			assert.deepStrictEqual(buildMeta({}), {});
		});
	});

	suite('sheetDimsMeta ⇄ sheetDimsOf 往返', () => {

		test('正常维度往返一致', () => {
			const m = sheetDimsMeta(3, 4);
			assert.deepStrictEqual(m, { rows: '3', cols: '4' });
			assert.deepStrictEqual(sheetDimsOf(m as Record<string, unknown>), { rows: 3, cols: 4 });
		});

		test('★ 0 也写入（nodeCard 用 meta.rows !== undefined 判定上游图集语义，省略会破坏判定）', () => {
			const m = sheetDimsMeta(0, 0);
			assert.strictEqual(m.rows, '0');
			assert.strictEqual(m.cols, '0');
			// 读侧数值等价：Number('0')||0 === 0
			assert.deepStrictEqual(sheetDimsOf(m as Record<string, unknown>), { rows: 0, cols: 0 });
		});

		test('非有限值（NaN/Infinity）不写入', () => {
			assert.deepStrictEqual(sheetDimsMeta(NaN, Infinity), {});
		});

		test('sheetDimsOf 容忍缺失 meta 与脏值', () => {
			assert.deepStrictEqual(sheetDimsOf(undefined), { rows: 0, cols: 0 });
			assert.deepStrictEqual(sheetDimsOf({ rows: 'abc' }), { rows: 0, cols: 0 });
		});
	});
});
