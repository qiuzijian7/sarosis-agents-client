/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.keyedParts.test.ts — Keyed Reconciliation 纯函数单元测试。
 *
 *  覆盖场景：
 *    1) 各 part 类型的 key 分配（thinking / text / tool / subagent）
 *    2) 空 text part 跳过
 *    3) update_plan 纳入渲染（卡片保留）
 *    4) 多 part 混合顺序保持
 *    5) tool / subagent 无 id 时 auto-${index} 兜底
 *    6) lastTextPartKey 计算
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.keyedParts.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { buildKeyedParts, lastTextPartKey, filterPartElements, PART_KEY_ATTR } from './agentChatPanel.keyedParts.js';
import type { IMessagePart } from './agentChatTypes.js';

function textPart(text: string): IMessagePart {
	return { kind: 'text', text } as any;
}
function thinkingPart(text: string): IMessagePart {
	return { kind: 'thinking', text } as any;
}
function toolPart(name: string, id?: string): IMessagePart {
	return { kind: 'tool', tool: { name, id } } as any;
}
function subagentPart(name: string, id?: string): IMessagePart {
	return { kind: 'subagent', subAgent: { name, id } } as any;
}

suite('keyedParts - buildKeyedParts', () => {

	test('thinking part 分配稳定 key', () => {
		const result = buildKeyedParts([thinkingPart('thinking...')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'thinking:msg1#tk0');
		assert.strictEqual(result[0].index, 0);
	});

	test('text part 分配稳定 key', () => {
		const result = buildKeyedParts([textPart('hello')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'text:msg1#t0');
		assert.strictEqual(result[0].index, 0);
	});

	test('tool part 用 toolCall.id 作 key', () => {
		const result = buildKeyedParts([toolPart('file_read', 'call_123')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:call_123');
	});

	test('★ subagent part 不分配 key（路径 B 已移除，2026-08-22 更正过时期望）', () => {
		// 原用例期望 `subagent:sa_456` —— 那是 keyedParts 文件头旧注释里的**未实现设计**，
		// 使本用例长期失败。真实契约见 agentChatTypes.ts：子代理独立 part 已废弃，
		// 只通过 tool.subAgents / msg.subAgents 承载。
		// ⚠ 这条断言是**防回归闸门**：`_createPartElement` 不为 subagent 创建元素，
		// 若把它纳入 buildKeyedParts，会使一致性校验变成 actual < expected →
		// 每次 finalize 全量重建整条消息 = UI 闪烁。
		const result = buildKeyedParts([subagentPart('explore', 'sa_456')], 'msg1');
		assert.strictEqual(result.length, 0, 'subagent part 必须被忽略');
	});

	test('空 text part 被跳过', () => {
		const parts = [textPart(''), textPart('hello'), textPart('   ')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'text:msg1#t1');
		assert.strictEqual(result[0].index, 1);
	});

	test('update_plan 保留为卡片（纳入 keyed parts）', () => {
		const parts = [
			toolPart('update_plan', 'plan_1'),
			textPart('middle'),
			toolPart('update_plan', 'plan_2'),
		];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0].key, 'tool:plan_1');
		assert.strictEqual(result[1].key, 'text:msg1#t1');
		assert.strictEqual(result[2].key, 'tool:plan_2');
		assert.deepStrictEqual(result.map(r => r.index), [0, 1, 2]);
	});

	test('单张 update_plan 也保留', () => {
		const parts = [toolPart('update_plan', 'plan_1')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:plan_1');
		assert.strictEqual(result[0].index, 0);
	});

	test('tool 无 id 时 auto-${index} 兜底', () => {
		const result = buildKeyedParts([toolPart('file_read')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:auto-0');
	});

	test('★ subagent 无 id 时同样不分配 key（不走 auto 兜底）', () => {
		const result = buildKeyedParts([subagentPart('explore')], 'msg1');
		assert.strictEqual(result.length, 0);
	});

	test('多 part 混合顺序保持（subagent 被跳过且不占位）', () => {
		const parts = [
			thinkingPart('think1'),
			textPart('text1'),
			toolPart('file_read', 'tc1'),
			thinkingPart('think2'),
			textPart('text2'),
			toolPart('terminal', 'tc2'),
			subagentPart('explore', 'sa1'),
		];
		const result = buildKeyedParts(parts, 'msg1');
		// 7 个 part 中 subagent 被忽略 → 6 个 keyed part
		assert.strictEqual(result.length, 6);
		assert.strictEqual(result[0].key, 'thinking:msg1#tk0');
		assert.strictEqual(result[1].key, 'text:msg1#t1');
		assert.strictEqual(result[2].key, 'tool:tc1');
		assert.strictEqual(result[3].key, 'thinking:msg1#tk3');
		assert.strictEqual(result[4].key, 'text:msg1#t4');
		assert.strictEqual(result[5].key, 'tool:tc2');
		// index 保持**原始** part 位置（用于 _createPartElement 的 partIndex）
		assert.deepStrictEqual(result.map(r => r.index), [0, 1, 2, 3, 4, 5]);
	});

	test('空 parts 数组返回空列表', () => {
		const result = buildKeyedParts([], 'msg1');
		assert.strictEqual(result.length, 0);
	});

	test('纯空 text parts 返回空列表', () => {
		const parts = [textPart(''), textPart('   ')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 0);
	});

	test('key 在同一 msgId 下稳定（两次调用结果一致）', () => {
		const parts = [thinkingPart('t'), textPart('x'), toolPart('file_read', 'tc1')];
		const r1 = buildKeyedParts(parts, 'msg1');
		const r2 = buildKeyedParts(parts, 'msg1');
		assert.deepStrictEqual(r1.map(r => r.key), r2.map(r => r.key));
	});

	test('不同 msgId 生成不同 key', () => {
		const parts = [textPart('hello')];
		const r1 = buildKeyedParts(parts, 'msg1');
		const r2 = buildKeyedParts(parts, 'msg2');
		assert.notStrictEqual(r1[0].key, r2[0].key);
	});
});

/**
 * filterPartElements —— DOM 枚举唯一真源的纯逻辑内核。
 *
 * 事故背景（2026-08-22，日志 1787373914386「聊天框 UI 闪烁」）：一致性校验用
 * `bubble.querySelectorAll('[data-part-key]')`（**后代**查询），而 webCard /
 * extractCard 曾在卡片**内部** header 上设了同名同值属性 → actual 恒 > expected
 * （实测 66/64、73/66、69/67）→ 每次 finalize 回退整条消息全量重建。
 *
 * 测试环境无 document，故直接测纯内核（真实遍历逻辑，非 mock）。
 */
suite('keyedParts - filterPartElements', () => {

	/** 轻量元素 stub：只需 getAttribute。`kids` 模拟 element.children。 */
	function el(key: string | null, tag = 'div') {
		return { tag, getAttribute: (n: string) => (n === PART_KEY_ATTR ? key : null) };
	}

	test('返回全部带 key 的直接子元素，顺序保持', () => {
		const kids = [el('text:m#t0'), el('tool:tc1'), el('thinking:m#tk2')];
		const out = filterPartElements(kids);
		assert.strictEqual(out.length, 3);
		assert.deepStrictEqual(out.map(e => e.getAttribute(PART_KEY_ATTR)), ['text:m#t0', 'tool:tc1', 'thinking:m#tk2']);
	});

	test('跳过无 key 的兄弟元素（如 .message-attachments）', () => {
		const kids = [el(null, 'div.message-attachments'), el('text:m#t0'), el(null)];
		assert.strictEqual(filterPartElements(kids).length, 1);
	});

	test('★★ 只看一层：嵌套元素不可能被计入（本次事故的直接根因）', () => {
		// 关键点：内部 header 的 key 与外层 wrapper **完全相同**，正是旧代码形态。
		// 由于只遍历传入的 children（一层），嵌套元素根本不在集合里。
		const innerHeader = el('tool:tc1', 'div.tool-header');
		const wrapper = { ...el('tool:tc1'), children: [innerHeader] };
		const kids = [wrapper, el('text:m#t1')];
		const out = filterPartElements(kids);
		assert.strictEqual(out.length, 2, '外层 2 个；内部 header 不参与');
		// 控制组：若误用「后代」语义（把嵌套也算上）会得到 3 —— 证明差异真实存在
		const descendantLike = [...kids, innerHeader];
		assert.strictEqual(filterPartElements(descendantLike).length, 3,
			'（控制组）把嵌套元素混进同一层时确实会多数出 1 个');
	});

	test('★ 与 buildKeyedParts 计数配对：一致性校验不再误判', () => {
		const parts = [textPart('hello'), toolPart('web_extract', 'tc1')];
		const expected = buildKeyedParts(parts, 'm').length;
		// DOM 直接子元素只有 2 个 part（内部 header 不算）
		const kids = [el('text:m#t0'), el('tool:tc1')];
		assert.strictEqual(filterPartElements(kids).length, expected, 'actual 必须等于 expected');
	});

	test('空集合返回空数组（不抛）', () => {
		assert.deepStrictEqual(filterPartElements([]), []);
	});

	test('稀疏/空洞元素不崩', () => {
		const kids = [el('text:m#t0'), undefined as any, el('tool:tc1')];
		assert.strictEqual(filterPartElements(kids).length, 2);
	});

	test('空字符串 key 仍算 part 元素（getAttribute 非 null）', () => {
		assert.strictEqual(filterPartElements([el('')]).length, 1);
	});

	test('PART_KEY_ATTR 常量值固定（渲染与校验共用同一属性名）', () => {
		assert.strictEqual(PART_KEY_ATTR, 'data-part-key');
	});
});

suite('keyedParts - lastTextPartKey', () => {

	test('单个 text part 返回其 key', () => {
		const result = lastTextPartKey([textPart('hello')], 'msg1');
		assert.strictEqual(result, 'text:msg1#t0');
	});

	test('多个 text part 返回最后一个非空的 key', () => {
		const parts = [textPart('first'), thinkingPart('t'), textPart('second')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t2');
	});

	test('空 text part 不参与计算', () => {
		const parts = [textPart('first'), textPart(''), textPart('   ')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t0');
	});

	test('无 text part 返回 null', () => {
		const parts = [thinkingPart('t'), toolPart('file_read', 'tc1')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, null);
	});

	test('空 parts 返回 null', () => {
		const result = lastTextPartKey([], 'msg1');
		assert.strictEqual(result, null);
	});

	test('text 在 tool 之后时正确返回', () => {
		const parts = [toolPart('file_read', 'tc1'), textPart('after tool')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t1');
	});
});
