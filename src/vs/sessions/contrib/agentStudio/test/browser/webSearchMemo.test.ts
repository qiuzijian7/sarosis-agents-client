/*---------------------------------------------------------------------------------------------
 *  web_search 结果备忘的单测（对齐 Hermes-Agent 的 search memo，2026-09-24）。
 *
 *  盯四件事：**键的构成**（含 provider、limit 分桶）、**TTL**（过期即失效且顺手清垃圾）、
 *  **单飞**（同 key 并发只打一次网）、**失败不入库**（否则一次偶发故障被固化 20 分钟）。
 *  时钟可注入 ⇒ 全部确定性验证，不靠 sleep。
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	SEARCH_MEMO_TTL_MS,
	WebSearchMemo,
	bucketLimit,
	normalizeQuery,
	searchMemoKey,
} from '../../browser/providers/tool/webSearchMemo.js';
import type { IWebSearchProviderOutput } from '../../browser/providers/tool/webSearchProviders.js';

function fakeOutput(title: string): IWebSearchProviderOutput {
	return { results: [{ title, url: `https://example.com/${title}`, snippet: 's' }] };
}

/** 默认 TTL 是个具体值（20 分钟）—— 改它等于改产品语义，所以钉住。 */
suite('webSearchMemo — 检索结果备忘', () => {

	test('TTL 默认 20 分钟', () => {
		assert.strictEqual(SEARCH_MEMO_TTL_MS, 20 * 60 * 1000);
	});

	// ─── 键的构成 ────────────────────────────────────────────────────────

	test('limit 向上取桶：1–5 → 5，6–10 → 10，超出最大桶用请求值', () => {
		assert.strictEqual(bucketLimit(1), 5);
		assert.strictEqual(bucketLimit(3), 5);
		assert.strictEqual(bucketLimit(5), 5);
		assert.strictEqual(bucketLimit(6), 10);
		assert.strictEqual(bucketLimit(10), 10);
		assert.strictEqual(bucketLimit(20), 20, '超出最大桶时不得取少于请求的条数');
	});

	test('查询归一化只做"折空白 + 小写"（激进归一化会让语义不同的查询串味）', () => {
		assert.strictEqual(normalizeQuery('  Hello   WORLD  '), 'hello world');
		assert.strictEqual(normalizeQuery('C++\n教程'), 'c++ 教程');
		// 刻意保留标点：C++ 与 C、node.js 与 nodejs 必须仍是不同的键。
		assert.notStrictEqual(searchMemoKey('ddg', 'C++', 5), searchMemoKey('ddg', 'C', 5));
		assert.notStrictEqual(searchMemoKey('ddg', 'node.js', 5), searchMemoKey('ddg', 'nodejs', 5));
	});

	test('★ 键含 provider：同一查询不同后端不共用条目', () => {
		assert.notStrictEqual(searchMemoKey('ddg', 'x', 5), searchMemoKey('tavily', 'x', 5));
	});

	test('★ 键按桶合并：3 与 5 同键，6 与 10 同键，5 与 6 不同键', () => {
		assert.strictEqual(searchMemoKey('ddg', 'x', 3), searchMemoKey('ddg', 'x', 5));
		assert.strictEqual(searchMemoKey('ddg', 'x', 6), searchMemoKey('ddg', 'x', 10));
		assert.notStrictEqual(searchMemoKey('ddg', 'x', 5), searchMemoKey('ddg', 'x', 6));
	});

	// ─── TTL ────────────────────────────────────────────────────────────

	test('★ 未过期命中；到 TTL 即失效，且顺手清掉条目', async () => {
		let now = 1000;
		const memo = new WebSearchMemo(500, () => now);
		await memo.getOrLoad('k', async () => fakeOutput('a'));

		assert.strictEqual(memo.get('k')?.results[0]?.title, 'a');
		now = 1499;
		assert.ok(memo.get('k'), 'TTL 内必须命中');
		now = 1500;
		assert.strictEqual(memo.get('k'), undefined, '到达 TTL 即失效（>= 判定）');
		assert.strictEqual(memo.size, 0, '过期条目要被清掉，否则 Map 无界增长');
	});

	test('过期后重新加载会拿到新值（不是旧条目）', async () => {
		let now = 0;
		let n = 0;
		const memo = new WebSearchMemo(100, () => now);
		await memo.getOrLoad('k', async () => fakeOutput(`v${++n}`));
		now = 101;
		const fresh = await memo.getOrLoad('k', async () => fakeOutput(`v${++n}`));
		assert.strictEqual(fresh.results[0]?.title, 'v2');
		assert.strictEqual(n, 2);
	});

	// ─── 单飞 ───────────────────────────────────────────────────────────

	test('★★ 同 key 并发只调用一次 factory（模型一轮里重复发同一查询是常见行为）', async () => {
		const memo = new WebSearchMemo();
		let calls = 0;
		let settle: (v: IWebSearchProviderOutput) => void = () => { };
		const factory = () => {
			calls++;
			return new Promise<IWebSearchProviderOutput>(resolve => { settle = resolve; });
		};

		const p1 = memo.getOrLoad('k', factory);
		const p2 = memo.getOrLoad('k', factory);
		assert.strictEqual(calls, 1, '第二个并发调用必须复用同一个在飞请求');

		settle(fakeOutput('a'));
		const [r1, r2] = await Promise.all([p1, p2]);
		assert.strictEqual(r1, r2, '两个调用应拿到同一份结果');
		assert.strictEqual(calls, 1);

		await memo.getOrLoad('k', factory);
		assert.strictEqual(calls, 1, '落库之后的调用直接命中，不再打网');
	});

	// ─── 失败语义 ───────────────────────────────────────────────────────

	test('★ factory 抛错 → 不入库、错误原样抛出、在飞状态被清掉', async () => {
		const memo = new WebSearchMemo();
		await assert.rejects(memo.getOrLoad('k', async () => { throw new Error('boom'); }), /boom/);
		assert.strictEqual(memo.get('k'), undefined, '失败绝不写缓存（否则一次偶发故障被固化整个 TTL）');

		// 在飞状态必须已清理：否则后续调用会永远复用那个失败的 promise。
		let calls = 0;
		const out = await memo.getOrLoad('k', async () => { calls++; return fakeOutput('ok'); });
		assert.strictEqual(calls, 1);
		assert.strictEqual(out.results[0]?.title, 'ok');
	});

	test('"成功但 0 结果"照常入库（它是合法结果，缓存它同样省掉一次打网）', async () => {
		const memo = new WebSearchMemo();
		let calls = 0;
		const empty: IWebSearchProviderOutput = { results: [] };
		await memo.getOrLoad('k', async () => { calls++; return empty; });
		const again = await memo.getOrLoad('k', async () => { calls++; return empty; });
		assert.strictEqual(again, empty);
		assert.strictEqual(calls, 1);
	});

});
