/*---------------------------------------------------------------------------------------------
 *  coalesceAdjacentTextParts.test.ts — 「一条消息被拆成 2 段」根治的**回归护栏**（2026-09-23）
 *
 *  真机证据（用户 DevTools dump ✓ 已取证 ✓）：
 *    `bubble.children` = `… text:…#t62 → tool:…(63) → text:…#t64(h19) → text:…#t65(h1611) → footer`
 *    ⇒ **相邻两个 text part** 各建一个 `.parts-text-segment` ⇒ 视觉上"两块" ✗。
 *
 *  ★ 三条红线（都写成断言 ✓）：
 *    ① 相邻 text **必须**合并（同一段正文 ✓ 不丢信息 ✓）；
 *    ② 中间隔着 tool/thinking 的 **不得**合并（那是真的两段 ✓）；
 *    ③ **必须在渲染之前**归一（⇒ keyedParts 与 _createPartElement 同源 ✓ 不会闪烁 ✗）；
 *       渲染层（agentChatPanel.markdown.ts）**不得**出现该合并 ✗✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/coalesceAdjacentTextParts.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { coalesceAdjacentTextParts, deriveUiMessageParts } from './agentChatTypes.js';
import type { IMessagePart } from './agentChatTypes.js';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
// ⚠ 必须显式标注 `IMessagePart`：否则对象字面量的 `kind` 会被推成 `string` ✗ ⇒ 与联合类型不兼容 ✗
//   （本轮类型检查真的抓到了 —— 记一笔：`compile-check-ts-native` **覆盖测试文件** ✓）
const T = (text: string): IMessagePart => ({ kind: 'text', text });
const THINK = (text: string): IMessagePart => ({ kind: 'thinking', text });
const TOOL = (id: string): IMessagePart => ({
	kind: 'tool',
	tool: { id, name: 'read', status: 'success', args: '' } as never,
});
const txt = (p: unknown): string => String((p as { text?: string }).text ?? '');
const kind = (p: unknown): string => String((p as { kind?: string }).kind);

suite('coalesceAdjacentTextParts（2026-09-23 ✓ 用户「拆成 2 段」根治 ✓）', () => {

	test('★★★ 相邻两个 text **必须**合并成一个（正是真机里的 t64 + t65 ✓）', () => {
		const out = coalesceAdjacentTextParts([T('完成。'), T('| 文件夹 | 覆盖范围 |\n…')]);
		assert.strictEqual(out.length, 1, `相邻 text 必须并成一块（实际 ${out.length} 块 ✗）`);
		assert.strictEqual(txt(out[0]), '完成。| 文件夹 | 覆盖范围 |\n…', '文本必须**按原顺序**完整拼接 ✓');
	});

	test('★★★ 中间隔着 tool / thinking 的**不得**合并（那是真·两段 ✓）', () => {
		const withTool = coalesceAdjacentTextParts([T('A'), TOOL('t1'), T('B')]);
		assert.strictEqual(withTool.length, 3, '隔 tool ⇒ 三段结构不变 ✓');
		assert.deepStrictEqual(withTool.map(kind), ['text', 'tool', 'text']);
		const withThink = coalesceAdjacentTextParts([T('A'), THINK('想一下'), T('B')]);
		assert.strictEqual(withThink.length, 3, '隔 thinking ⇒ 不变 ✓');
		assert.deepStrictEqual(withThink.map(kind), ['text', 'thinking', 'text']);
	});

	test('★★ 连续多个 text 一并合并（不是只并两个 ✓）', () => {
		const out = coalesceAdjacentTextParts([T('a'), T('b'), T('c'), TOOL('t1'), T('d'), T('e')]);
		assert.strictEqual(out.length, 3, `应为 [abc, tool, de]（实际 ${out.map(kind).join('>')} ✗）`);
		assert.strictEqual(txt(out[0]), 'abc');
		assert.strictEqual(txt(out[2]), 'de');
	});

	test('★★ 空 text 被**吸收**（渲染层对空 text 返回 null ⇒ 会留下"看不见的缝" ✗✓）', () => {
		const out = coalesceAdjacentTextParts([T('A'), T(''), T('B')]);
		assert.strictEqual(out.length, 1, '空段不得单独存活 ✗✓（否则两段之间夹一个 null ⇒ 视觉裂缝 ✓）');
		assert.strictEqual(txt(out[0]), 'AB');
	});

	test('★★★ 不得修改入参（实时路径的 parts 与 pane **共享引用** ✗✓）', () => {
		const input = [T('A'), T('B')];
		const snapshot = JSON.stringify(input);
		const out = coalesceAdjacentTextParts(input);
		assert.strictEqual(JSON.stringify(input), snapshot, '入参不得被就地改写 ✗✓（共享引用会被外人看到）');
		assert.notStrictEqual(out, input, '必须返回**新数组** ✓');
		assert.notStrictEqual(out[0], input[0], '合并后的元素必须是**新对象** ✓（否则改写的是 pane 的 part ✗）');
	});

	test('★ 边界：空数组 / 单元素 / 无相邻（原样返回副本 ✓）', () => {
		assert.deepStrictEqual(coalesceAdjacentTextParts([]), []);
		assert.strictEqual(coalesceAdjacentTextParts([T('solo')]).length, 1);
		const noAdj = [T('A'), TOOL('t'), T('B'), TOOL('t2')];
		assert.strictEqual(coalesceAdjacentTextParts(noAdj).length, 4, '无相邻 ⇒ 结构不变 ✓');
	});

	test('★★ 与 `deriveUiMessageParts` 组合：派生器本身**不应**产出相邻 text ✓（自证判据 ✓）', () => {
		// 两个工具都带 textPosition ⇒ 派生结果必然是 text/tool 交替 ✓
		const parts = deriveUiMessageParts('前段中段后段', [
			{ id: 't1', name: 'a', status: 'success', args: '', textPosition: 2 },
			{ id: 't2', name: 'b', status: 'success', args: '', textPosition: 4 },
		] as never);
		for (let i = 1; i < parts.length; i++) {
			assert.ok(!(kind(parts[i - 1]) === 'text' && kind(parts[i]) === 'text'),
				`派生器产出了相邻 text ✗（第 ${i - 1}/${i} 个）⇒ 说明"相邻 text 只能来自数据缝隙"的判据被推翻 ✓ 请复核 ✓`);
		}
		// 而"无 textPosition"的工具会被追加到末尾（另一现象，见 MEMORY 记录 ✓ 本次未改 ✗）
		const unpositioned = deriveUiMessageParts('正文', [{ id: 't9', name: 'z', status: 'success', args: '' }] as never);
		assert.deepStrictEqual(unpositioned.map(kind), ['text', 'tool'], '无位置工具仍在末尾（本任务范围外 ✓）');
	});

	test('★★★ 接线①：恢复路径（adaptPersistedChatMessage）必须在**返回前**归一 ✓', () => {
		const src = read('src/vs/sessions/browser/agentChat/agentChatTypes.ts');
		const at = src.indexOf('parts = coalesceAdjacentTextParts(parts)');
		assert.ok(at > 0, 'adaptPersistedChatMessage 内必须调用归一 ✗✓');
		const fnAt = src.indexOf('export function adaptPersistedChatMessage');
		assert.ok(fnAt > 0 && at > fnAt, '该调用必须在 adaptPersistedChatMessage **内部** ✓');
	});

	test('★★★ 接线②：实时路径必须在 `Object.assign(_messages[idx], updates)` 之后归一 ✓', () => {
		const src = read('src/vs/sessions/browser/agentChat/agentChatPanel.base.ts');
		const assignAt = src.indexOf('Object.assign(this._messages[idx], updates)');
		const mergeAt = src.indexOf('m.parts = coalesceAdjacentTextParts(m.parts)');
		assert.ok(assignAt > 0, '实时路径的 parts 落地行必须仍是 Object.assign ✓');
		assert.ok(mergeAt > assignAt,
			'归一必须紧跟 parts 落地（渲染之前 ✓）—— 放渲染层会计数漂移 ⇒ 闪烁 ✗✓');
	});

	test('★★★ 红线：渲染层（markdown.ts）**不得**做该合并 ✗✓', () => {
		const md = read('src/vs/sessions/browser/agentChat/agentChatPanel.markdown.ts');
		assert.strictEqual(md.includes('coalesceAdjacentTextParts'), false,
			'渲染层不得合并 part ✗✓（keyedParts 的 expected/actual 必须与 _createPartElement 严格一致 ✓）');
	});
});
