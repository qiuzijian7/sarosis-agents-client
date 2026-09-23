/*---------------------------------------------------------------------------------------------
 *  mergeTurnMessageParts.test.ts — 「同一 turn 的相邻文本段**必须合并成一个 part**」（2026-09-23）
 *
 *  背景（用户实测 ✓ 截图 + DOM dump ✓）：
 *    恢复后消息 bubble 的 children 出现 `… text#t64(h19) → text#t65(h1611) → footer` ——
 *    两个**相邻** text part 各建一个 `.parts-text-segment` ⇒ 视觉上"一条消息被拆成 2 段" ✗。
 *  真源 = `agentChatPanel.header.ts` 的 turn 聚合器：旧实现"给上一个 text part 追加 `\n\n`
 *    + 再 push 另一个 text part" ⇒ parts 数组里产生相邻 text ✗ ⇒ 两块 ✓。
 *
 *  ★ 修复红线：合并必须保留 `\n\n` **视觉间距** ✓ 但只产出**一个** part ⇒ **一块** ✓✓；
 *    且**不得**合并隔了 tool 的文本（那是真·两段 ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/mergeTurnMessageParts.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { mergeTurnMessageParts } from './agentChatTypes.js';
import type { IAgentChatMessage, IMessagePart } from './agentChatTypes.js';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

let _id = 0;
const T = (text: string): IMessagePart => ({ kind: 'text', text });
const TOOL = (name: string): IMessagePart => ({
	kind: 'tool',
	tool: { id: `tc-${++_id}`, name, status: 'success', args: '' } as never,
});
const msg = (parts: IMessagePart[]): IAgentChatMessage => ({
	id: `m-${++_id}`, role: 'assistant', content: '', parts, timestamp: 0, agentId: 'a',
} as never);
const kinds = (parts: readonly IMessagePart[]) => parts.map(p => p.kind);
const textOf = (p: IMessagePart) => (p as { text?: string }).text ?? '';

suite('mergeTurnMessageParts —— turn 聚合合并相邻文本（2026-09-23 ✓ 用户「2 段」根治 ✓）', () => {

	test('★★★ 真源形态：同 turn 的两条"纯文本"消息 ⇒ **一个** text part（用户实测的 t64+t65 ✓）', () => {
		const out = mergeTurnMessageParts([msg([T('完成。')]), msg([T('| 文件夹 | 覆盖范围 |')])]);
		assert.strictEqual(out.length, 1, `相邻文本必须并成**一个** part（实际 ${out.length} ✗ ⇒ 仍会是两块 ✗）`);
		assert.strictEqual(textOf(out[0]), '完成。\n\n| 文件夹 | 覆盖范围 |',
			'合并必须保留 **\\n\\n** 视觉间距 ✓（旧实现就是这个分隔 ✓ —— 但旧实现产出**两个** part ✗）');
	});

	test('★★★ 中间隔着 tool 的文本**不得**合并（那是真·两段 ✓）', () => {
		const out = mergeTurnMessageParts([msg([T('A')]), msg([TOOL('read'), T('B')])]);
		assert.deepStrictEqual(kinds(out), ['text', 'tool', 'text'], 'text→tool→text 结构必须保留 ✓');
	});

	test('★★ 连续三条消息各带文本 ⇒ 仍只一个 text part（\n\n 依次串联 ✓）', () => {
		const out = mergeTurnMessageParts([msg([T('a')]), msg([T('b')]), msg([T('c')])]);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(textOf(out[0]), 'a\n\nb\n\nc');
	});

	test('★★ 工具与文本交错 ⇒ 结构与顺序不变 ✓（含多工具 ✓）', () => {
		const out = mergeTurnMessageParts([
			msg([T('前言'), TOOL('r1')]),
			msg([TOOL('r2'), T('后文')]),
		]);
		assert.deepStrictEqual(kinds(out), ['text', 'tool', 'tool', 'text']);
		assert.strictEqual(textOf(out[0]), '前言');
		assert.strictEqual(textOf(out[3]), '后文');
	});

	test('★★ 空段吸收：一条消息只有空文本 ⇒ 不得造出多余段 ✗✓', () => {
		const out = mergeTurnMessageParts([msg([T('A')]), msg([T('')]), msg([T('B')])]);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(textOf(out[0]), 'A\n\n\n\nB', '空段也以分隔符串联 ✓（与旧 `\n\n` 行为一致 ✓）');
	});

	test('★ 边界：单条消息 / 空数组 ⇒ 原样返回（不新建多余块 ✓）', () => {
		const one = mergeTurnMessageParts([msg([T('solo'), TOOL('x')])]);
		assert.deepStrictEqual(kinds(one), ['text', 'tool']);
		assert.deepStrictEqual(mergeTurnMessageParts([]), []);
	});

	test('★★★ 接线：聚合器必须用本函数，且**不再就地** `lastPart.text += ` ✓', () => {
		const src = read('src/vs/sessions/browser/agentChat/agentChatPanel.header.ts');
		assert.ok(src.includes('mergeTurnMessageParts(turnMessages)'),
			'_aggregateTurns 必须调用纯函数 ✗✓（否则本次修复没接上 ✗）');
		assert.strictEqual(src.includes('lastPart.text = `${lastPart.text}\\n\\n`;'), false,
			'旧的"改一个 part + 再 push 另一个"写法必须删掉 ✗✓（它正是相邻 text part 的诞生地 ✓）');
	});

	test('★★★ 红线：setMessages 必须先聚合再渲染（保证归一产物进入渲染 ✓）', () => {
		const src = read('src/vs/sessions/browser/agentChat/agentChatPanel.base.ts');
		const agg = src.indexOf('this._messages = this._aggregateTurns(messages)');
		const render = src.indexOf('this._renderMessages();', agg);
		assert.ok(agg > 0 && render > agg,
			'setMessages 内必须先 _aggregateTurns 后 _renderMessages ✓（顺序不能颠倒 ✗）');
	});
});
