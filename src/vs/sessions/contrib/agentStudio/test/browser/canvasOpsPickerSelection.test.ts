/*---------------------------------------------------------------------------------------------
 *  Unit test: 聊天卡 picker 选择 → 画布节点选中态同步（2026-09-11 用户需求）。
 *
 *  由来：聊天卡勾选 ImagePicker 候选后**只** resume 执行侧，画布节点仍是旧高亮 ✗。
 *  同步必须把「refs」解析成「池内序号」（`selected_index`，1-based）+ `directRef`
 *  （'all' 池视图按 ref 匹配，无需序号）—— 解析只有 webview 侧能做（池 = 快照库 + 上游连线）。
 *
 *  ★ 多选（2026-09-12 用户需求「多选图片时 UI 要有多选状态」）：勾选 N 张必须整批
 *  高亮 —— 除单值主选外，还写 `selected_indices`（0-based 序号 JSON 数组）与
 *  `directRefs`（ref JSON 数组）。单值字段保留（旧调用方 / 执行器兜底）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildPickerSelectionPatch } from '../../webview/src/features/workflowEditor/comfyHost/canvasOps.js';

test('★ picker 选择 → 画布补丁：单值（selected_index/directRef）+ 多选数组同时写', () => {
	const pool = ['r0', 'r1', 'r2'];
	// 池内第 2 张（0-based 1）→ selected_index 必须是 2（1-based），否则高亮错格 ✗
	assert.deepStrictEqual(
		buildPickerSelectionPatch(['r1'], pool),
		{ directRef: 'r1', directRefs: '["r1"]', selected_index: 2, selected_indices: '[1]' },
	);
	// 多选：主选 = 第一张（r2 → 序号 3），数组 = 全部选中（升序 [0,2]）→ 整批高亮 ✓
	assert.deepStrictEqual(
		buildPickerSelectionPatch(['r2', 'r0'], pool),
		{ directRef: 'r2', directRefs: '["r2","r0"]', selected_index: 3, selected_indices: '[0,2]' },
	);
	// 首张 → 1
	assert.strictEqual(buildPickerSelectionPatch(['r0'], pool)['selected_index'], 1);
});

test('★★ ref 不在池内 → 绝不猜序号（只写 ref 字段）', () => {
	// 猜序号会高亮到**错误的格子**，比不同步更糟 ✗ —— 所以宁可只写 ref。
	const p = buildPickerSelectionPatch(['not-in-pool'], ['r0', 'r1']);
	assert.deepStrictEqual(p, { directRef: 'not-in-pool', directRefs: '["not-in-pool"]' });
	assert.ok(!('selected_index' in p), '不得写入猜出来的 selected_index');
	assert.ok(!('selected_indices' in p), '不得写入猜出来的 selected_indices');
	// 池为空（上游未产出）时同理
	assert.deepStrictEqual(buildPickerSelectionPatch(['x'], []), { directRef: 'x', directRefs: '["x"]' });
});

test('★ 混合（池内 + 池外）→ 序号数组只含池内项，ref 数组全含', () => {
	const p = buildPickerSelectionPatch(['r1', 'zzz'], ['r0', 'r1']);
	assert.strictEqual(p['selected_index'], 2);
	assert.strictEqual(p['selected_indices'], '[1]');
	assert.strictEqual(p['directRefs'], '["r1","zzz"]');
});

test('★ 空/非法输入 → 空补丁（不写任何字段，避免把画布选中态清掉）', () => {
	assert.deepStrictEqual(buildPickerSelectionPatch([], ['r0']), {});
	assert.deepStrictEqual(buildPickerSelectionPatch([''], ['r0']), {});
	// 空字符串应被跳过，取下一个有效 ref
	assert.strictEqual(buildPickerSelectionPatch(['', 'r1'], ['r0', 'r1'])['directRef'], 'r1');
});
