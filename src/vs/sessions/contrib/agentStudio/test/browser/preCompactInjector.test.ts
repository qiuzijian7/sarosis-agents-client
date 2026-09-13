/*---------------------------------------------------------------------------------------------
 *  preCompactInjector.test.ts — 压缩前记忆注入回归测试（P2 补测，2026-09-09）
 *
 *  覆盖：4-Tier 分类与预算比例、预算上限（min(tokenBudget, 2000)）、固定槽位优先、
 *        supersededBy 过滤、注入去重（P5）、滑动窗口填充、关键词加权排序。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PreCompactInjector, type InjectEntry } from '../../common/preCompactInjector.js';

function entry(id: string, type: string, content: string, score = 1): InjectEntry {
	return { id, type, content, score, timestamp: Date.now() };
}

const CTX = (budget = 2000) => ({
	sessionId: 's1', agentId: 'a1',
	currentMessages: [{ role: 'user', content: 'hello world question', timestamp: Date.now() }],
	tokenBudget: budget,
});

suite('preCompactInjector — 4-Tier 注入', () => {
	let injector: PreCompactInjector;
	setup(() => { injector = new PreCompactInjector(); });

	test('Tier 分类：procedural/semantic/working 直判，其余归 episodic', () => {
		const r = injector.prepare(CTX(), [
			entry('e1', 'procedural', 'proc content'),
			entry('e2', 'semantic', 'sem content'),
			entry('e3', 'working', 'work content'),
			entry('e4', 'fact', 'epi content'),
			entry('e5', 'pattern', 'epi content 2'),
		]);
		const sources = r.sources.map(s => s.source);
		assert.ok(sources.includes('memory:procedural:e1'));
		assert.ok(sources.includes('memory:semantic:e2'));
		assert.ok(sources.includes('memory:working:e3'));
		assert.ok(sources.includes('memory:episodic:e4'));
		assert.ok(sources.includes('memory:episodic:e5'));
	});

	test('预算上限 2000：超大 tokenBudget 不超过 2000', () => {
		const r = injector.prepare(CTX(100000), [entry('e1', 'fact', 'x'.repeat(100))]);
		assert.ok(r.totalTokens <= 2000, `totalTokens=${r.totalTokens}`);
	});

	test('固定槽位优先注入且不受 tier 预算限制', () => {
		const r = injector.prepare(
			CTX(),
			[entry('e1', 'fact', 'entry content')],
			[{ name: 'persona', content: 'USER PREFERS dark theme' }],
		);
		assert.strictEqual(r.sources[0].source, 'slot:persona');
	});

	test('空内容槽位被跳过', () => {
		const r = injector.prepare(CTX(), [], [{ name: 'persona', content: '   ' }]);
		assert.strictEqual(r.sources.length, 0);
	});

	test('supersededBy 条目被过滤', () => {
		const superseded = { ...entry('e1', 'fact', 'old'), metadata: { supersededBy: 'e2' } };
		const r = injector.prepare(CTX(), [superseded, entry('e2', 'fact', 'new')]);
		const ids = r.sources.map(s => s.source);
		assert.ok(!ids.some(i => i.includes(':e1')), '被取代条目不应注入');
		assert.ok(ids.some(i => i.includes(':e2')));
	});

	test('预算耗尽时不超发（totalTokens ≤ budget）', () => {
		const entries: InjectEntry[] = [];
		for (let i = 0; i < 50; i++) {
			entries.push(entry(`e${i}`, 'fact', 'x'.repeat(2000))); // 每条 ~500 tokens
		}
		const r = injector.prepare(CTX(600), entries);
		assert.ok(r.totalTokens <= 600, `totalTokens=${r.totalTokens}`);
	});

	test('注入去重：同 id 条目只注入一次（entry + windowEntries 重叠）', () => {
		const e = entry('dup-1', 'fact', 'shared content between entry and window');
		const r = injector.prepare(CTX(), [e], undefined, [{ id: 'dup-1', content: 'shared content between entry and window' }]);
		const dupSources = r.sources.filter(s => s.source.includes('dup-1'));
		assert.strictEqual(dupSources.length, 1, '同 id 应只出现一个 source');
	});

	test('滑动窗口填充：window 条目带 window: 前缀', () => {
		const r = injector.prepare(CTX(), [], undefined, [{ id: 'w1', content: 'window filler' }]);
		assert.ok(r.sources.some(s => s.source === 'window:w1'));
	});

	test('关键词加权：与用户消息相关的条目在同 tier 内排前', () => {
		// 同 base score 下，userMsg 关键词加权（0.15/词，上限 3）决定排序
		const relevant = entry('rel', 'fact', 'the websocket reconnect strategy detailed here', 1);
		const irrelevant = entry('irr', 'fact', 'totally different cooking recipe list here', 1);
		const r = injector.prepare(
			{ sessionId: 's', agentId: 'a', tokenBudget: 2000, currentMessages: [
				{ role: 'user', content: 'explain the websocket reconnect strategy', timestamp: Date.now() },
			] },
			[irrelevant, relevant],
		);
		const order = r.sources.map(s => s.source);
		const relIdx = order.findIndex(i => i.includes(':rel'));
		const irrIdx = order.findIndex(i => i.includes(':irr'));
		assert.ok(relIdx >= 0 && irrIdx >= 0);
		assert.ok(relIdx < irrIdx, `相关条目应排前（rel=${relIdx}, irr=${irrIdx}）`);
	});

	test('注入文本包含标题头与各 source 分节', () => {
		const r = injector.prepare(CTX(), [entry('e1', 'fact', 'some fact')], [{ name: 'persona', content: 'p' }]);
		assert.ok(r.injectedContext.startsWith('## Preserved Context (from memory)'));
		assert.ok(r.injectedContext.includes('### slot:persona'));
		assert.ok(r.injectedContext.includes('### memory:episodic:e1'));
	});
});
