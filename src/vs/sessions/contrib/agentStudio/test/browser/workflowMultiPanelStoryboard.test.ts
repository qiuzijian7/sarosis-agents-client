/*---------------------------------------------------------------------------------------------
 *  Unit tests for multiPanelStoryboard — 多宫格故事板数据契约纯函数。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	parsePanelsState,
	panelsStateToJson,
	createDefaultPanelsState,
	buildMultiPanelPrompt,
	gridLayoutForCount,
	isPanelsEmpty,
	splitStoryToPanels,
	isMultiPanelStoryboardNode,
} from '../../webview/src/features/workflowEditor/comfyHost/multiPanelStoryboard.js';

suite('multiPanelStoryboard 多宫格故事板数据契约', () => {

	suite('gridLayoutForCount — 宫格数 → 行列', () => {
		test('2/4/6/9 → 对应布局', () => {
			assert.deepStrictEqual(gridLayoutForCount(2), { cols: 2, rows: 1 });
			assert.deepStrictEqual(gridLayoutForCount(4), { cols: 2, rows: 2 });
			assert.deepStrictEqual(gridLayoutForCount(6), { cols: 3, rows: 2 });
			assert.deepStrictEqual(gridLayoutForCount(9), { cols: 3, rows: 3 });
		});
		test('非法宫格数 → 默认 2×2', () => {
			assert.deepStrictEqual(gridLayoutForCount(5), { cols: 2, rows: 2 });
			assert.deepStrictEqual(gridLayoutForCount(0), { cols: 2, rows: 2 });
		});
	});

	suite('createDefaultPanelsState — 空白状态', () => {
		test('宫格数正确 + panels 数量对齐 + index 递增', () => {
			const s = createDefaultPanelsState(6);
			assert.strictEqual(s.gridCount, 6);
			assert.strictEqual(s.panels.length, 6);
			assert.deepStrictEqual(s.panels.map(p => p.index), [0, 1, 2, 3, 4, 5]);
			assert.strictEqual(s.panels[0].character, '');
		});
		test('非法宫格数 → 归一化为 4', () => {
			assert.strictEqual(createDefaultPanelsState(7).gridCount, 4);
			assert.strictEqual(createDefaultPanelsState(7).panels.length, 4);
		});
	});

	suite('parsePanelsState — 解析防御', () => {
		test('正常 JSON 往返', () => {
			const s = createDefaultPanelsState(4);
			s.panels[0].character = '小明';
			const parsed = parsePanelsState(panelsStateToJson(s));
			assert.strictEqual(parsed.gridCount, 4);
			assert.strictEqual(parsed.panels[0].character, '小明');
		});
		test('空串 / 非法 JSON → 默认 4 宫格空白', () => {
			assert.strictEqual(parsePanelsState('').gridCount, 4);
			assert.strictEqual(parsePanelsState('not-json{{').gridCount, 4);
			assert.strictEqual(parsePanelsState('{"gridCount":99}').gridCount, 4);
		});
		test('gridCount 合法但 panels 缺失 → 补齐空白格', () => {
			const parsed = parsePanelsState('{"gridCount":6}');
			assert.strictEqual(parsed.gridCount, 6);
			assert.strictEqual(parsed.panels.length, 6);
			assert.strictEqual(parsed.panels[5].action, '');
		});
	});

	suite('buildMultiPanelPrompt — 拼 qwen 多宫格 prompt', () => {
		test('角色去重集中 + 每格拼接', () => {
			const s = createDefaultPanelsState(4);
			s.panels[0].character = '小明';
			s.panels[1].character = '小明';
			s.panels[0].action = '正面站立';
			s.panels[1].action = '侧面转头';
			const p = buildMultiPanelPrompt(s);
			assert.ok(p.includes('角色：小明。'));
			assert.ok(p.includes('第1格：正面站立'));
			assert.ok(p.includes('第2格：侧面转头'));
			// 角色只出现一次（去重）
			assert.strictEqual(p.split('小明').length - 1, 1);
		});
		test('imagePrompt 优先于 action，对白加引号', () => {
			const s = createDefaultPanelsState(2);
			s.panels[0].action = '跑步';
			s.panels[0].dialogue = '等等我';
			const p = buildMultiPanelPrompt(s);
			assert.ok(p.includes('对白「等等我」'));
			assert.ok(p.includes('第1格：跑步，对白「等等我」'));
		});
		test('空内容 → 待补充占位', () => {
			const s = createDefaultPanelsState(2);
			const p = buildMultiPanelPrompt(s);
			assert.ok(p.includes('第1格：（待补充画面）'));
		});
	});

	suite('isMultiPanelStoryboardNode — 节点类型识别', () => {
		test('精确匹配', () => {
			assert.strictEqual(isMultiPanelStoryboardNode('ComfyTV.MultiPanelStoryboardStage'), true);
			assert.strictEqual(isMultiPanelStoryboardNode('ComfyTV.StoryboardEditorStage'), false);
			assert.strictEqual(isMultiPanelStoryboardNode('ComfyTV.ImageStage'), false);
		});
	});

	suite('isPanelsEmpty — 宫格判空', () => {
		test('全空 → true', () => {
			assert.strictEqual(isPanelsEmpty(createDefaultPanelsState(4)), true);
		});
		test('任一字段非空 → false', () => {
			const s = createDefaultPanelsState(4);
			s.panels[1].action = '跑步';
			assert.strictEqual(isPanelsEmpty(s), false);
		});
	});

	suite('splitStoryToPanels — 故事文本启发式拆宫格', () => {
		test('句子 ≥ 宫格数 → 均匀取样覆盖全文', () => {
			const text = '小明起床。小明吃饭。小明上学。小明回家。小明睡觉。小明做梦。';
			const s = splitStoryToPanels(text, 4);
			assert.strictEqual(s.gridCount, 4);
			assert.strictEqual(s.panels.length, 4);
			assert.ok(s.panels.every(p => p.imagePrompt.length > 0));
		});
		test('句子 < 宫格数 → 前几格有内容，后面空', () => {
			const s = splitStoryToPanels('第一句。第二句。', 4);
			assert.strictEqual(s.panels.length, 4);
			assert.ok(s.panels[0].imagePrompt.length > 0);
			assert.ok(s.panels[1].imagePrompt.length > 0);
			assert.strictEqual(s.panels[2].imagePrompt, '');
			assert.strictEqual(s.panels[3].imagePrompt, '');
		});
		test('空文本 → 全空格', () => {
			const s = splitStoryToPanels('', 4);
			assert.ok(s.panels.every(p => p.imagePrompt === ''));
		});
		test('按换行切句', () => {
			const s = splitStoryToPanels('第一行\n第二行\n第三行\n第四行', 4);
			assert.strictEqual(s.panels[0].imagePrompt, '第一行');
			assert.strictEqual(s.panels[3].imagePrompt, '第四行');
		});
	});
});
