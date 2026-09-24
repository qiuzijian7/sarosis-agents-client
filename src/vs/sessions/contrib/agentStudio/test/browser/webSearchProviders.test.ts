/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * web_search 多后端 provider 的纯逻辑单测（P0-2，2026-09-24）。
 *
 * 覆盖三层：
 *  ① 各托管后端**响应解析**（字段映射 / 缺字段兜底 / 脏 JSON / HTML 高亮去标签）；
 *  ② 各 provider 的**请求形状**（URL、method、header、body 参数名 —— 这些是外部契约，
 *     拼错了只有真机联调才能发现，必须钉住）；
 *  ③ **链路解析**与 DuckDuckGo 的降级/上报语义（auto 成链、显式不换家、全失败 vs 无结果）。
 *
 * 全部走注入的假 fetch（`IWebFetchLike`），不发真实网络请求。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_WEB_SEARCH_CONFIG,
	WEB_SEARCH_AUTO,
	braveProvider,
	describeProviderSetupHint,
	duckDuckGoProvider,
	exaProvider,
	parseBraveResponse,
	parseExaResponse,
	parseSearxngResponse,
	parseTavilyResponse,
	resolveWebSearchChain,
	searxngProvider,
	tavilyProvider,
} from '../../browser/providers/tool/webSearchProviders.js';
import type { IWebFetchLike, IWebSearchProviderConfig } from '../../browser/providers/tool/webSearchProviders.js';

// ─── 假 fetch ───────────────────────────────────────────────────────────────

interface IRoute { status?: number; body?: string; throwMessage?: string; }

/**
 * 按 URL 子串路由的假 fetch。命中的第一条胜出（Object.entries 保序），因此**具体域名
 * 必须排在宽泛模式之前**。
 */
function fakeFetch(routes: Record<string, IRoute>): { calls: Array<{ url: string; init?: Parameters<IWebFetchLike>[1] }>; fetchFn: IWebFetchLike } {
	const calls: Array<{ url: string; init?: Parameters<IWebFetchLike>[1] }> = [];
	const fetchFn: IWebFetchLike = async (url, init) => {
		calls.push({ url, init });
		for (const [pattern, route] of Object.entries(routes)) {
			if (!url.includes(pattern)) { continue; }
			if (route.throwMessage) { throw new Error(route.throwMessage); }
			if (route.status !== undefined && route.status >= 400) { throw new Error(`HTTP ${route.status}`); }
			return { status: route.status ?? 200, statusText: '', body: route.body ?? '' };
		}
		throw new Error(`fakeFetch: no route for ${url}`);
	};
	return { calls, fetchFn };
}

function cfg(patch: Partial<IWebSearchProviderConfig>): IWebSearchProviderConfig {
	return { ...DEFAULT_WEB_SEARCH_CONFIG, ...patch };
}

/** 最小可用的 DDG html 结果页：一个自然结果（标题 + 跳转包装 URL + 摘要）。 */
const DDG_HTML_BODY = `<html><body>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example A</a>
<a class="result__snippet">Snippet A</a>
</body></html>`;

/** 最小可用的 DDG lite 结果页（类名与 html 端点不同）。 */
const DDG_LITE_BODY = `<html><body>
<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flite">Example Lite</a>
<td class="result-snippet">Snippet Lite</td>
</body></html>`;

suite('webSearchProviders — 响应解析', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseSearxngResponse maps title/url/content and skips entries without url', () => {
		const body = JSON.stringify({
			results: [
				{ title: 'A', url: 'https://a.example', content: 'CA' },
				{ title: 'B', url: '', content: 'CB' },
				{ title: '', url: 'https://c.example', snippet: 'SC' },
			],
		});
		const out = parseSearxngResponse(body);
		assert.deepStrictEqual(out.map(r => r.url), ['https://a.example', 'https://c.example']);
		assert.strictEqual(out[0].snippet, 'CA');
		// 无 title → 用 URL 兜底（保持列表可读）
		assert.strictEqual(out[1].title, 'https://c.example');
		assert.strictEqual(out[1].snippet, 'SC');
	});

	test('parseSearxngResponse returns [] for non-JSON (SearXNG 未开 json 格式 → HTML)', () => {
		assert.deepStrictEqual(parseSearxngResponse('<!DOCTYPE html><html>…</html>'), []);
	});

	test('parseTavilyResponse maps content, falls back to raw_content/snippet', () => {
		const body = JSON.stringify({
			results: [
				{ title: 'T1', url: 'https://t1', content: 'C1' },
				{ title: 'T2', url: 'https://t2', raw_content: 'RC2' },
				{ title: 'T3', url: 'https://t3' },
			],
		});
		const out = parseTavilyResponse(body);
		assert.deepStrictEqual(out.map(r => r.snippet), ['C1', 'RC2', '']);
	});

	test('parseBraveResponse reads web.results and strips <strong> highlight tags', () => {
		const body = JSON.stringify({
			web: {
				results: [
					{ title: 'Brave <strong>hit</strong>', url: 'https://b1', description: 'desc <strong>with</strong> tags' },
				],
			},
		});
		const out = parseBraveResponse(body);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].snippet, 'desc with tags');
		// 标题不做去标签（与 DDG 路径的 title 处理口径一致：只 trim）
		assert.strictEqual(out[0].title, 'Brave <strong>hit</strong>');
	});

	test('parseBraveResponse returns [] when only top-level results exist (层级写错的回归保护)', () => {
		assert.deepStrictEqual(parseBraveResponse(JSON.stringify({ results: [{ title: 'x', url: 'https://x' }] })), []);
	});

	test('parseExaResponse maps text/summary and falls back to author for title', () => {
		const body = JSON.stringify({
			results: [
				{ title: 'E1', url: 'https://e1', text: 'TEXT1' },
				{ author: 'Auth', url: 'https://e2', summary: 'SUM2' },
			],
		});
		const out = parseExaResponse(body);
		assert.strictEqual(out[0].snippet, 'TEXT1');
		assert.strictEqual(out[1].title, 'Auth');
		assert.strictEqual(out[1].snippet, 'SUM2');
	});

	test('all parsers are defensive against null / wrong-shaped payloads', () => {
		for (const parse of [parseSearxngResponse, parseTavilyResponse, parseBraveResponse, parseExaResponse]) {
			assert.deepStrictEqual(parse(''), []);
			assert.deepStrictEqual(parse('null'), []);
			assert.deepStrictEqual(parse('[]'), []);
			assert.deepStrictEqual(parse(JSON.stringify({ results: 'not-an-array' })), []);
			assert.deepStrictEqual(parse(JSON.stringify({ results: [null, 42, 'x'] })), []);
		}
	});

});

suite('webSearchProviders — 请求形状（外部契约，拼错只有联调才发现）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('tavilyProvider POSTs api_key/query/max_results to api.tavily.com/search', async () => {
		const { calls, fetchFn } = fakeFetch({
			'api.tavily.com': { body: JSON.stringify({ results: [{ title: 'T', url: 'https://t', content: 'C' }] }) },
		});
		const out = await tavilyProvider.search('hello world', 7, cfg({ tavilyApiKey: 'k-1' }), fetchFn);

		assert.strictEqual(out.results[0].snippet, 'C');
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://api.tavily.com/search');
		assert.strictEqual(calls[0].init?.method, 'POST');
		const body = JSON.parse(calls[0].init?.body ?? '{}');
		assert.strictEqual(body.api_key, 'k-1');
		assert.strictEqual(body.query, 'hello world');
		assert.strictEqual(body.max_results, 7);
		// basic 深度：不需要 Tavily 再代抓全文（省额度 + 省延迟）
		assert.strictEqual(body.search_depth, 'basic');
	});

	test('braveProvider sends X-Subscription-Token and encodes query/count', async () => {
		const { calls, fetchFn } = fakeFetch({ 'api.search.brave.com': { body: JSON.stringify({ web: { results: [] } }) } });
		await braveProvider.search('a&b c', 3, cfg({ braveApiKey: 'bk' }), fetchFn);

		assert.ok(calls[0].url.startsWith('https://api.search.brave.com/res/v1/web/search?q=a%26b%20c&count=3'), calls[0].url);
		assert.strictEqual(calls[0].init?.headers?.['X-Subscription-Token'], 'bk');
		// GET（不传 method）
		assert.strictEqual(calls[0].init?.method, undefined);
	});

	test('exaProvider POSTs x-api-key and explicitly requests contents.text', async () => {
		const { calls, fetchFn } = fakeFetch({ 'api.exa.ai': { body: JSON.stringify({ results: [] }) } });
		await exaProvider.search('q', 4, cfg({ exaApiKey: 'ek' }), fetchFn);

		assert.strictEqual(calls[0].url, 'https://api.exa.ai/search');
		assert.strictEqual(calls[0].init?.headers?.['x-api-key'], 'ek');
		const body = JSON.parse(calls[0].init?.body ?? '{}');
		assert.strictEqual(body.numResults, 4);
		// 不显式要 text 的话 Exa 只回 title/url → snippet 全空（实测踩过的坑）
		assert.ok(body.contents?.text, 'contents.text must be requested');
	});

	test('searxngProvider trims trailing slashes and asks for format=json', async () => {
		const { calls, fetchFn } = fakeFetch({ 'searx.example': { body: JSON.stringify({ results: [] }) } });
		await searxngProvider.search('q', 5, cfg({ searxngUrl: 'http://searx.example//' }), fetchFn);

		assert.ok(calls[0].url.startsWith('http://searx.example/search?q=q&format=json'), calls[0].url);
		assert.ok(!calls[0].url.includes('//search'), calls[0].url);
	});

});

suite('webSearchProviders — 链路解析（auto 成链 / 显式不换家）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('auto with no keys → DuckDuckGo only (与加抽象前行为一致)', () => {
		assert.deepStrictEqual(resolveWebSearchChain(DEFAULT_WEB_SEARCH_CONFIG), ['duckduckgo']);
	});

	test('auto keeps configured hosted providers in tavily→exa→brave→searxng order, DDG last', () => {
		assert.deepStrictEqual(
			resolveWebSearchChain(cfg({ tavilyApiKey: 'k', braveApiKey: 'k', searxngUrl: 'http://s' })),
			['tavily', 'brave', 'searxng', 'duckduckgo'],
		);
		assert.deepStrictEqual(
			resolveWebSearchChain(cfg({ exaApiKey: 'k' })),
			['exa', 'duckduckgo'],
		);
	});

	test('blank / whitespace-only config values do not count as configured', () => {
		assert.deepStrictEqual(
			resolveWebSearchChain(cfg({ tavilyApiKey: '   ', searxngUrl: '  ' })),
			['duckduckgo'],
		);
	});

	test('explicit provider → exactly that one, no silent fallback', () => {
		// 注意：即使填了 tavily key，显式选 brave 也**不**降级到 tavily ——
		// 否则用户会以为在用自己选的 API、且可能产生意料外的计费。
		assert.deepStrictEqual(resolveWebSearchChain(cfg({ provider: 'brave', tavilyApiKey: 'k' })), ['brave']);
		assert.deepStrictEqual(resolveWebSearchChain(cfg({ provider: 'searxng' })), ['searxng']);
	});

	test('explicit provider is not dropped even when unconfigured (报错信息交给调用方)', () => {
		assert.deepStrictEqual(resolveWebSearchChain(cfg({ provider: 'tavily' })), ['tavily']);
	});

	test('isAvailable reflects only its own config slot', () => {
		assert.strictEqual(tavilyProvider.isAvailable(cfg({ tavilyApiKey: 'k' })), true);
		assert.strictEqual(tavilyProvider.isAvailable(cfg({ braveApiKey: 'k' })), false);
		assert.strictEqual(searxngProvider.isAvailable(cfg({ searxngUrl: ' ' })), false);
		assert.strictEqual(exaProvider.isAvailable(cfg({})), false);
		// DDG 永远可用（keyless 兜底）
		assert.strictEqual(duckDuckGoProvider.isAvailable(cfg({})), true);
	});

	test('describeProviderSetupHint names the exact setting for each provider', () => {
		assert.ok(describeProviderSetupHint('tavily').includes('webSearch.tavilyApiKey'));
		assert.ok(describeProviderSetupHint('brave').includes('webSearch.braveApiKey'));
		assert.ok(describeProviderSetupHint('exa').includes('webSearch.exaApiKey'));
		assert.ok(describeProviderSetupHint('searxng').includes('webSearch.searxngUrl'));
		assert.strictEqual(describeProviderSetupHint('duckduckgo'), 'no configuration required');
		const unknown = describeProviderSetupHint('nope');
		// 未知 id 必须把合法值列出来（否则用户没法自查拼写）
		for (const id of [WEB_SEARCH_AUTO, 'duckduckgo', 'searxng', 'tavily', 'brave', 'exa']) {
			assert.ok(unknown.includes(id), `${unknown} should list ${id}`);
		}
	});

});

suite('webSearchProviders — DuckDuckGo 降级与失败上报', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses html results when available (instant answer fetched in parallel)', async () => {
		const { calls, fetchFn } = fakeFetch({
			'html.duckduckgo.com': { body: DDG_HTML_BODY },
			'api.duckduckgo.com': { body: '{}' },
		});
		const out = await duckDuckGoProvider.search('q', 5, DEFAULT_WEB_SEARCH_CONFIG, fetchFn);

		assert.strictEqual(out.results.length, 1);
		assert.strictEqual(out.results[0].url, 'https://example.com/a');
		assert.strictEqual(out.results[0].snippet, 'Snippet A');
		assert.strictEqual(out.answer, undefined);
		// instant answer 也是并行发起的（不等 html 完成）
		assert.ok(calls.some(c => c.url.includes('api.duckduckgo.com')));
	});

	test('falls back to lite when html yields no results', async () => {
		const { calls, fetchFn } = fakeFetch({
			'html.duckduckgo.com': { body: '<html><body>no results markup</body></html>' },
			'lite.duckduckgo.com': { body: DDG_LITE_BODY },
			'api.duckduckgo.com': { body: '{}' },
		});
		const out = await duckDuckGoProvider.search('q', 5, DEFAULT_WEB_SEARCH_CONFIG, fetchFn);

		assert.strictEqual(out.results.length, 1);
		assert.strictEqual(out.results[0].url, 'https://example.com/lite');
		assert.ok(calls.some(c => c.url.includes('lite.duckduckgo.com')));
	});

	test('surfaces an instant answer even when organic results are empty', async () => {
		const { fetchFn } = fakeFetch({
			'html.duckduckgo.com': { body: '<html></html>' },
			'lite.duckduckgo.com': { body: '<html></html>' },
			'api.duckduckgo.com': {
				body: JSON.stringify({ AbstractText: 'The answer', AbstractSource: 'Wikipedia', AbstractURL: 'https://en.wikipedia.org/x' }),
			},
		});
		const out = await duckDuckGoProvider.search('q', 5, DEFAULT_WEB_SEARCH_CONFIG, fetchFn);

		assert.deepStrictEqual(out.results, []);
		assert.strictEqual(out.answer?.text, 'The answer');
		assert.strictEqual(out.answer?.source, 'Wikipedia');
		assert.strictEqual(out.answer?.url, 'https://en.wikipedia.org/x');
	});

	test('does NOT throw: reports all three failing branches via errors (熔断判定归链路所有者)', async () => {
		const { fetchFn } = fakeFetch({
			'html.duckduckgo.com': { throwMessage: 'boom-html' },
			'lite.duckduckgo.com': { throwMessage: 'boom-lite' },
			'api.duckduckgo.com': { throwMessage: 'boom-instant' },
		});
		const out = await duckDuckGoProvider.search('q', 5, DEFAULT_WEB_SEARCH_CONFIG, fetchFn);

		assert.deepStrictEqual(out.results, []);
		assert.strictEqual(out.answer, undefined);
		assert.strictEqual(out.errors?.length, 3);
		assert.ok(out.errors?.some(e => e.startsWith('ddg-html:')));
		assert.ok(out.errors?.some(e => e.startsWith('ddg-lite:')));
		assert.ok(out.errors?.some(e => e.startsWith('instant-answer:')));
	});

	test('partial failure is visible in errors but does not fail the call', async () => {
		const { fetchFn } = fakeFetch({
			'html.duckduckgo.com': { body: DDG_HTML_BODY },
			'api.duckduckgo.com': { throwMessage: 'boom-instant' },
		});
		const out = await duckDuckGoProvider.search('q', 5, DEFAULT_WEB_SEARCH_CONFIG, fetchFn);

		assert.strictEqual(out.results.length, 1);
		// 部分降级：有结果 ⇒ errors 仅作留痕，调用方照常成功返回
		assert.strictEqual(out.errors?.length, 1);
	});

});
