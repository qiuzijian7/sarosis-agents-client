/*---------------------------------------------------------------------------------------------
 *  StreamAccumulator 专属行为基线（2026-09-22 阶段④-g P1 ✓）
 *
 *  为什么需要它 ✗✓：`StreamAccumulator`（413 行 ✓）是从 `agentChatService.sendMessage` 里搬出来的
 *  **最热路径**（每次流式都跑 ✓），9 个 handler 原本只经「服务级端到端基线」间接覆盖 ✗
 *  ⇒ 改动某个 handler 的边界条件可能**静默不红** ✗✓。本文件把它当**纯对象**直接驱动 ✓：
 *  零 DOM、零 IO、零 driver ⇒ 断言点 = 契约点 ✓（不依赖服务编排 ✓）。
 *
 *  ⚠⚠ 首跑暴露了一条**容易猜错**的真契约（本文件因此有价值 ✓✓）：
 *    **累加器只维护「分片」**（`_fullContentChunks` / `_fullThinkingChunks` / `_toolArgChunks` ✓），
 *    `fullContent` / `fullThinking` / `toolCalls[].arguments` 的**拼接与派生都在宿主** ✓✗
 *    （落盘时宿主 `_fullContentChunks.join('')` ✓、参数由宿主把 `_toolArgChunks` join 进 `arguments` ✓）。
 *    ⇒ 本文件**刻意钉住"这里不拼接"** ✗✓：谁"顺手"在累加器里改成 `+=`，就会与宿主的 join
 *    形成**两份真相源**（ConsString rope 事故的形态 ✗）⇒ 必须当场变红 ✓。
 *
 *  ⚠ 另一条实测契约 ✓：`discardPriorText` 只丢**末尾连续的 text 段** ✓，**工具段与其之前的文本不动** ✓
 *    （更早 iteration 的文本已由工具确认 ⇒ 误删会造成信息丢失 ✗✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { StreamAccumulator } from '../../browser/streamAccumulator.js';

const text = (content: string) => ({ type: 'text', content } as any);
const thinking = (content: string) => ({ type: 'thinking', content } as any);
const replace = (content: string) => ({ type: 'content_replace', content } as any);
const toolStart = (id: string, name: string, extra: any = {}) =>
	({ type: 'tool_start', toolCallId: id, toolName: name, ...extra } as any);
const toolArgs = (id: string, content: string) => ({ type: 'tool_args', toolCallId: id, content } as any);
const toolResult = (id: string, content: string) => ({ type: 'tool_result', toolCallId: id, content } as any);
const usage = (u: any) => ({ type: 'usage', usage: u } as any);
const turn = (content: string, toolCallIds: string[] = []) =>
	({ type: 'assistant_turn', content, metadata: { toolCallIds } } as any);

const contentOf = (acc: StreamAccumulator) => acc._fullContentChunks.join('');
const thinkingOf = (acc: StreamAccumulator) => acc._fullThinkingChunks.join('');

suite('StreamAccumulator — 流式累加契约（不依赖服务 ✓）', () => {

	test('★ 文本只进「分片」✓：顺序正确、连续文本合并为**一个** text part、累加器**不**自拼全文 ✗✓', () => {
		const acc = new StreamAccumulator();
		for (const s of ['你', '好', '，世界']) { acc.applyTextDelta(text(s)); }
		assert.strictEqual(contentOf(acc), '你好，世界', '分片必须按序入列 ✓');
		assert.strictEqual(acc.fullContent, '',
			'★ 累加器**不得**自拼 `fullContent` ✗✓（拼接归宿主 ✓ —— 两份真相源会漂移 ✗）');
		const parts = acc._streamingParts;
		assert.strictEqual(parts.length, 1, `连续文本必须合并为 1 个 text part（实际 ${parts.length} ✗）`);
		assert.strictEqual(parts[0].kind, 'text');
		assert.strictEqual(parts[0].text, '你好，世界', 'part 文本必须随之累加（渲染真相源 ✓）');
	});

	test('★ thinking 独立入列 ✓、**不污染**正文 ✓（累加器同样不自拼 fullThinking ✗✓）', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(thinking('先想一下'));
		acc.applyTextDelta(text('答案'));
		assert.strictEqual(thinkingOf(acc), '先想一下', '思考必须独立累加 ✓');
		assert.strictEqual(contentOf(acc), '答案', '正文**不得**混入思考（混了 ⇒ 用户看到"自言自语" ✗✓）');
		assert.strictEqual(acc.fullThinking, '', '拼接归宿主 ✓（同 `fullContent` 口径 ✓）');
		assert.strictEqual(acc._streamingParts.length, 1, 'thinking **不得**产生 text part ✗✓（否则渲染出思考段 ✓）');
	});

	test('★★ `content_replace` ⇒ 重置分片、**改写**末尾 text part（不是新建 ✗）、并对齐 currentTurnTextLen ✓', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(text('我这就去删除文件'));           // 幻觉
		acc.applyTextDelta(replace('（改用工具）'));              // 上游清洗后的权威文本
		assert.strictEqual(contentOf(acc), '（改用工具）', 'content_replace 必须**丢弃**旧文本 ✓');
		assert.strictEqual(acc.currentTurnTextLen, '（改用工具）'.length,
			'必须对齐到新文本长度（它决定 tool_start 的 textPosition ✗✓）');
		const parts = acc._streamingParts;
		assert.strictEqual(parts.length, 1, `必须**改写**末尾 text part 而不是新建（实际 ${parts.length} 个 ✗）`);
		assert.strictEqual(parts[0].text, '（改用工具）', 'part 必须一并改写（否则幻觉文本仍会被渲染并落盘 ✗✓）');
	});

	test('★★ 工具生命周期：`arguments` **留空**（分片归 `_toolArgChunks` ✓）、结果回填 + status=done ✓', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(text('先看代码'));
		acc.applyToolDelta(toolStart('t1', 'file_read'));
		acc.applyToolDelta(toolArgs('t1', '{"p"'));
		acc.applyToolDelta(toolArgs('t1', ':"a.ts"}'));
		acc.applyToolDelta(toolResult('t1', '文件内容'));

		const tcs = (acc.toolCalls ?? []) as any[];
		assert.strictEqual(tcs.length, 1, `应恰好 1 个工具调用（实际 ${tcs.length} ✗）`);
		assert.strictEqual(tcs[0].id, 't1');
		assert.strictEqual(tcs[0].name, 'file_read');
		assert.deepStrictEqual(acc._toolArgChunks.get('t1'), ['{"p"', ':"a.ts"}'],
			'★ 参数必须**分片留存**（真机参数是流式分片到达的 ✗✓ —— join 归宿主 ✓，此处不得覆盖 ✗）');
		assert.strictEqual(tcs[0].arguments, '',
			'累加器不拼 `arguments` ✗✓（由宿主 join 后写入 ⇒ 只有一处真相源 ✓）');
		// ⚠ 实测契约（首跑抓错 ✓）：`currentTurnTextLen` **只被 `content_replace` 推进** ✗✓
		//   （`text` delta **不**推进它 ✓ —— 累加器不维护派生量 ✓，与"只维护分片"同一条原则 ✓）
		//   ⇒ 裸 `tool_start` 时它仍为 0 ✓；要按顺序交织，靠的是上游下发的 `textPosition` ✓
		//   或**每回合结束时**的 `content_replace` 对齐 ✓（见本文件 assistant_turn 用例 ✓）。
		assert.strictEqual(tcs[0].textPosition, 0,
			'无 content_replace 时 textPosition 取 0（tool_start 的兜底即"本轮已对齐的文本长度" ✓）');
		// 对齐过的场景 ⇒ tool_start 必须取到该长度 ✓（这才是"文本/工具交织"的真实保证 ✓）
		const acc2 = new StreamAccumulator();
		acc2.applyTextDelta(text('abcde'));
		acc2.applyTextDelta(replace('abcde'));   // 上游对齐 ⇒ currentTurnTextLen = 5 ✓
		acc2.applyToolDelta(toolStart('t2', 'grep'));
		assert.strictEqual((acc2.toolCalls ?? [])[0].textPosition, 5,
			'★ 已对齐后建卡必须取 `currentTurnTextLen` ⇒ 重载后文本/工具仍按原顺序交织 ✓');
		assert.strictEqual(String(tcs[0].result), '文件内容', '结果必须回填到同一 id ✓');
		assert.strictEqual(tcs[0].status, 'done', '必须打 status=done（否则刷新后卡片停在 loading ✗✓）');
		assert.deepStrictEqual(acc._streamingParts.map(p => p.kind), ['text', 'tool'],
			'parts 必须保留「文本→工具」的时序（渲染真相源 ✓）');
	});

	test('★ `tool_args` / `tool_result` 在**没有**对应 tool_start 时必须安全忽略 ✓（不得抛 ✓）', () => {
		const acc = new StreamAccumulator();
		assert.doesNotThrow(() => {
			acc.applyToolDelta(toolArgs('ghost', '{"x":1}'));
			acc.applyToolDelta(toolResult('ghost', '结果'));
		}, '孤儿工具 delta 必须被忽略（抛错会中断整条流 ✗✓）');
		assert.strictEqual(acc.toolCalls, undefined, '不得凭空想建出工具卡片 ✗✓');
	});

	test('usage **跨 delta 累加** ✓（求和，不是覆盖 ✓）', () => {
		const acc = new StreamAccumulator();
		acc.applyUsage(usage({ inputTokens: 10, outputTokens: 1, cachedTokens: 3 }));
		acc.applyUsage(usage({ inputTokens: 20, outputTokens: 2, cachedTokens: 4 }));
		assert.strictEqual(acc.usageInput, 30, 'input 必须累加 ✓');
		assert.strictEqual(acc.usageOutput, 3, 'output 必须累加 ✓');
		assert.strictEqual(acc.usageCached, 7, 'cached 必须累加 ✓');
		assert.strictEqual(acc.usageSeen, true, '出现过用量 ⇒ usageSeen=true（"零值也写"的前提 ✓）');
	});

	test('★★ `assistant_turn` ⇒ 回合快照 + **把 webview 文本缓冲对齐**到本轮权威文本 ✓（不对齐会 CONTENT MISMATCH ⇒ 卡死 ✗✓）', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(text('A'));
		const pushed: any[] = [];
		acc.applyAssistantTurn(turn('A', ['t1']), d => pushed.push(d));
		acc.applyTextDelta(text('B'));
		acc.applyAssistantTurn(turn('B', []), d => pushed.push(d));

		assert.strictEqual(acc.turns.length, 2, `两个 iteration 必须留 2 个回合快照（实际 ${acc.turns.length} ✗）`);
		assert.strictEqual(acc.turns[0].content, 'A');
		assert.deepStrictEqual(acc.turns[0].toolCallIds, ['t1'],
			'回合必须记住**本轮**发起的工具 id（跨轮归属判据 ✗✓）');
		assert.deepStrictEqual(acc.turns[1].toolCallIds, [], '下一回合不得继承上一轮的工具 ✗✓');
		assert.strictEqual(acc.currentTurnTextLen, 0, '回合结算后 textPosition 必须从 0 重记 ✓');
		assert.deepStrictEqual(pushed.map(d => d.type), ['content_replace', 'content_replace'],
			'★ 每个非空回合都必须下发 content_replace（对齐 webview textBuffer ✗✓）；空回合不得下发 ✗✓');
		assert.strictEqual(pushed[0].content, 'A', '对齐内容必须是本轮的**权威文本** ✓');
	});

	test('★★★ `discardPriorText` ⇒ **只丢末尾连续 text 段** ✓（工具段及其之前的文本**不动** ✓，分片与 parts 口径一致 ✓）', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(text('我这就去删除文件'));   // 这一段属于**更早** iteration（后面有工具 ⇒ 不该丢）
		acc.applyToolDelta(toolStart('t1', 'grep'));
		acc.applyToolDelta(toolResult('t1', '命中'));
		acc.applyTextDelta(text('假装完成'));            // 末尾幻觉文本 ⇒ 应丢
		acc.applyTextDelta(thinking('再编一点'));        // 思考也算丢弃量 ✓

		const dropped = acc.discardPriorText();
		// ★ 2026-09-22 修复 ✓（原为"实测发现"：pop 尾部 text part 却**整体清空**分片 ✗ ⇒ 口径不一致 ✓）：
		//   现在分片侧**也只从尾部移除同样多的字符** ✓ ⇒ 与 `parts` 同步 ✓，与 docblock 一致 ✓。
		assert.strictEqual(dropped, '假装完成'.length + '再编一点'.length,
			'报告量 = **真正丢弃**的字符数（末尾 text 段 + 全部 thinking ✓；工具之前那段**不计入** ✓）');
		assert.strictEqual(contentOf(acc), '我这就去删除文件',
			'★ 工具段**之前**的文本必须留在分片里 ✓✓（与 parts 口径一致 ⇒ 不再"两份真相源打架" ✓）');
		assert.strictEqual(thinkingOf(acc), '', '思考分片一并清空 ✓');
		assert.strictEqual(acc.currentTurnTextLen, 0, '本轮文本长度必须归零 ✓');
		const kinds = acc._streamingParts.map(p => p.kind);
		assert.deepStrictEqual(kinds, ['text', 'tool'],
			`★ parts 只 pop **末尾连续** text 段 ⇒ 工具段及其之前的文本段都保留（实际 ${JSON.stringify(kinds)} ✗✓）`);

		// 丢弃之后必须还能继续累加 ✓（discard 不是"废掉累加器" ✗），且**保留的前文仍在** ✓✓
		acc.applyTextDelta(text('（改用工具）'));
		assert.strictEqual(contentOf(acc), '我这就去删除文件（改用工具）',
			'丢弃后必须还能继续累加 ✓，且工具之前那段必须**保持在前** ✓✓（这正是修复的核心语义 ✓）');
	});

	test('`context_compacted` ⇒ 捕获边界（turnCount = **事件发生时的回合数** ✓）；**无摘要不捕获** ✗✓', () => {
		const acc = new StreamAccumulator();
		acc.applyTextDelta(text('A'));
		acc.applyAssistantTurn(turn('A'), () => { });
		const captured = acc.applyContextCompacted({
			type: 'context_compacted', compressionSummary: '摘要', compressionOriginalCount: 9,
			compressionCompressedCount: 1, compressionTokensSaved: 100, compressionSummaryChars: 2,
		} as any);
		assert.ok(captured, '有摘要必须捕获 ✓');
		assert.strictEqual(acc.pendingCompaction?.summary, '摘要', '摘要原文必须留存（原文兜底段用它 ✓）');
		assert.strictEqual(acc.pendingCompaction?.turnCount, 1,
			'★ 必须记住事件发生时的回合数（决定边界插在哪 ✓ —— 错了会让压缩点回放错位 ✗✓）');
		assert.strictEqual(acc.pendingCompaction?.summaryChars, 2, '核心摘要字符数必须透传（摘要饥饿判据只认它 ✓）');

		const acc2 = new StreamAccumulator();
		const none = acc2.applyContextCompacted({ type: 'context_compacted' } as any);
		assert.strictEqual(none, undefined, '无摘要时必须返回 undefined ✓');
		assert.strictEqual(acc2.pendingCompaction, undefined, '无摘要时**不得**留下边界状态 ✗✓');
	});

	test('未知 / 别名 delta **不得抛** ✓（流循环对每条 delta 都会调进来 ✓）', () => {
		const acc = new StreamAccumulator();
		assert.doesNotThrow(() => {
			for (const d of [{ type: 'totally_unknown' }, { type: 'work_mode_changed' }, { type: 'card_data' }]) {
				acc.applyTextDelta(d as any);
				acc.applyToolDelta(d as any);
				acc.applyUsage(d as any);
				acc.applyWorkModeDelta(d as any);
				acc.applyCardData(d as any);
			}
		}, '未知/别名 delta 必须被安全忽略（抛错会中断整条流 ✗✓）');
	});
});
