/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_WEB_SEARCH_CHAR_LIMIT,
	WEB_EXTRACT_CHAR_LIMIT,
	decodeDuckDuckGoUrl,
	decodeHtmlEntities,
	extractSnippet,
	formatHttpErrorDetail,
	formatWebExtractResult,
	isDuckDuckGoAdOrChrome,
	isPermanentHttpStatus,
	permanentHttpErrorMessage,
	parseDuckDuckGoHtmlResults,
	parseDuckDuckGoLiteResults,
	renderSearchResults,
	stripHtmlTags,
	webExtractTruncationWarning,
	webSearchTruncationWarning,
} from '../../browser/providers/tool/webSearchParse.js';

suite('webSearchParse — DDG HTML 解析', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── decodeHtmlEntities / stripHtmlTags ─────────────────────────────

	test('decodeHtmlEntities decodes named and numeric entities', () => {
		assert.strictEqual(decodeHtmlEntities('a &amp; b'), 'a & b');
		assert.strictEqual(decodeHtmlEntities('&lt;div&gt;'), '<div>');
		assert.strictEqual(decodeHtmlEntities('&quot;x&quot;'), '"x"');
		assert.strictEqual(decodeHtmlEntities('it&#x27;s'), "it's");
		assert.strictEqual(decodeHtmlEntities('it&#39;s'), "it's");
		assert.strictEqual(decodeHtmlEntities('&#65;&#66;'), 'AB');
		assert.strictEqual(decodeHtmlEntities('a&nbsp;b'), 'a b');
	});

	test('stripHtmlTags removes all tags', () => {
		assert.strictEqual(stripHtmlTags('<b>bold</b> plain <i>x</i>'), 'bold plain x');
		assert.strictEqual(stripHtmlTags('no tags'), 'no tags');
	});

	// ─── decodeDuckDuckGoUrl ────────────────────────────────────────────

	test('unwraps uddg redirect param', () => {
		const href = '//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/page?a=1&b=2') + '&rut=abc';
		assert.strictEqual(decodeDuckDuckGoUrl(href), 'https://example.com/page?a=1&b=2');
	});

	test('protocol-relative href gets https: prefix', () => {
		assert.strictEqual(decodeDuckDuckGoUrl('//example.com/x'), 'https://example.com/x');
	});

	test('plain absolute URL returned as-is', () => {
		assert.strictEqual(decodeDuckDuckGoUrl('https://example.com/x'), 'https://example.com/x');
	});

	test('invalid uddg encoding falls through gracefully', () => {
		const href = '//duckduckgo.com/l/?uddg=%E0%A4%A&rut=x';
		// decodeURIComponent throws on malformed sequences → 返回原 href（补 https:）
		assert.strictEqual(decodeDuckDuckGoUrl(href), 'https:' + href);
	});

	// ─── isDuckDuckGoAdOrChrome ─────────────────────────────────────────

	test('filters y.js ad redirect', () => {
		assert.strictEqual(isDuckDuckGoAdOrChrome('https://duckduckgo.com/y.js?ad_domain=udemy.com&ad_provider=bingv7aa'), true);
	});

	test('filters ad_* params on any host', () => {
		assert.strictEqual(isDuckDuckGoAdOrChrome('https://example.com/?ad_type=pla'), true);
	});

	test('filters ddg help pages', () => {
		assert.strictEqual(isDuckDuckGoAdOrChrome('https://duckduckgo.com/duckduckgo-help-pages/results/translation'), true);
	});

	test('keeps organic results', () => {
		assert.strictEqual(isDuckDuckGoAdOrChrome('https://github.com/foo/bar'), false);
		assert.strictEqual(isDuckDuckGoAdOrChrome('https://duckduckgo.com/?q=test'), false);
	});

	// ─── extractSnippet ─────────────────────────────────────────────────

	test('extracts snippet and strips inner <b> highlight without early cutoff', () => {
		// 反向引用 \1 闭合同名标签：内部 <b> 不得提前截断
		const block = '<a class="result__snippet" href="#">TypeScript <b>5.5</b> introduces <b>inferred</b> type predicates and more</a>';
		assert.strictEqual(
			extractSnippet(block, 'result__snippet'),
			'TypeScript 5.5 introduces inferred type predicates and more'
		);
	});

	test('returns empty when class not present', () => {
		assert.strictEqual(extractSnippet('<div class="other">x</div>', 'result__snippet'), '');
	});

	test('decodes entities and normalizes whitespace', () => {
		const block = '<td class="result-snippet">a   &amp;\n b</td>';
		assert.strictEqual(extractSnippet(block, 'result-snippet'), 'a & b');
	});

	// ─── parseDuckDuckGoHtmlResults（html 端点）─────────────────────────

	const HTML_PAGE = `
<div class="results">
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&rut=1">TypeScript <b>Docs</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&rut=1">
      The official <b>TypeScript</b> documentation with <b>handbook</b> and tutorials.
    </a>
  </div>
  <div class="result result--ad">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=udemy.com&ad_provider=bingv7aa">Sponsored: Learn TS</a>
    </h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=udemy.com">Buy the course now</a>
  </div>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmicrosoft%2FTypeScript&rut=2">microsoft/TypeScript · GitHub</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmicrosoft%2FTypeScript&rut=2">
      TypeScript is a superset of JavaScript that compiles to clean JavaScript output.
    </a>
  </div>
</div>`;

	test('parses organic results with title/url/snippet aligned per block', () => {
		const results = parseDuckDuckGoHtmlResults(HTML_PAGE);
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].title, 'TypeScript Docs');
		assert.strictEqual(results[0].url, 'https://www.typescriptlang.org/docs/');
		assert.strictEqual(results[0].snippet, 'The official TypeScript documentation with handbook and tutorials.');
		assert.strictEqual(results[1].title, 'microsoft/TypeScript · GitHub');
		assert.strictEqual(results[1].url, 'https://github.com/microsoft/TypeScript');
		assert.strictEqual(results[1].snippet, 'TypeScript is a superset of JavaScript that compiles to clean JavaScript output.');
	});

	test('ad blocks are excluded and do not shift snippet alignment', () => {
		// 广告块位于两个自然结果之间：若标题/摘要分别全局收集再按下标配对，
		// 会把 GitHub 结果的摘要配错（错位）。按块解析必须正确。
		const results = parseDuckDuckGoHtmlResults(HTML_PAGE);
		assert.ok(results.every(r => !r.url.includes('y.js')));
		assert.ok(!results.some(r => r.snippet.includes('Buy the course')));
	});

	test('empty page returns no results', () => {
		assert.deepStrictEqual(parseDuckDuckGoHtmlResults('<html><body></body></html>'), []);
	});

	// ─── parseDuckDuckGoLiteResults（lite 端点，href 在 class 前）───────

	const LITE_PAGE = `
<table>
  <tr><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1" class='result-link'>Example A</a>
  </td></tr>
  <tr><td class='result-snippet'>Snippet for <b>A</b> with detail.</td></tr>
  <tr><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=2" class='result-link'>Example B</a>
  </td></tr>
  <tr><td class='result-snippet'>Snippet for B.</td></tr>
</table>`;

	test('lite endpoint: href-before-class attribute order works', () => {
		const results = parseDuckDuckGoLiteResults(LITE_PAGE);
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].title, 'Example A');
		assert.strictEqual(results[0].url, 'https://example.com/a');
		assert.strictEqual(results[0].snippet, 'Snippet for A with detail.');
		assert.strictEqual(results[1].title, 'Example B');
		assert.strictEqual(results[1].snippet, 'Snippet for B.');
	});
});

suite('webSearchParse — renderSearchResults（Continue searchWebImpl 契约）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const make = (n: number, snippetLen = 10) => Array.from({ length: n }, (_, i) => ({
		title: `Title ${i + 1}`,
		url: `https://example.com/${i + 1}`,
		snippet: 'x'.repeat(snippetLen),
	}));

	test('renders each result as name/URL/content block', () => {
		const { blocks, truncated } = renderSearchResults(make(2), 5, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
		assert.strictEqual(truncated.length, 0);
		const text = blocks.join('\n');
		assert.ok(text.includes('1. **Title 1**'));
		assert.ok(text.includes('   URL: https://example.com/1'));
		assert.ok(text.includes('2. **Title 2**'));
	});

	test('respects maxResults', () => {
		const { blocks } = renderSearchResults(make(8), 3, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
		const text = blocks.join('\n');
		assert.ok(text.includes('3. **Title 3**'));
		assert.ok(!text.includes('4. **Title 4**'));
	});

	test('content over charLimit is truncated and recorded', () => {
		const results = [
			{ title: 'Long', url: 'https://example.com/long', snippet: 'y'.repeat(9000) },
			{ title: 'Short', url: 'https://example.com/short', snippet: 'ok' },
		];
		const { blocks, truncated } = renderSearchResults(results, 5, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
		assert.deepStrictEqual(truncated, ['Long']);
		const text = blocks.join('\n');
		assert.ok(!text.includes('y'.repeat(9001)));
		assert.ok(text.includes('y'.repeat(DEFAULT_WEB_SEARCH_CHAR_LIMIT)));
	});

	test('empty title falls back to Result #N in truncated list', () => {
		const results = [{ title: '', url: 'https://example.com/x', snippet: 'z'.repeat(9000) }];
		const { truncated } = renderSearchResults(results, 5, 100);
		assert.deepStrictEqual(truncated, ['Result #1']);
	});

	test('exactly at limit is NOT truncated', () => {
		const results = [{ title: 'T', url: 'https://e.com', snippet: 'q'.repeat(DEFAULT_WEB_SEARCH_CHAR_LIMIT) }];
		const { truncated } = renderSearchResults(results, 5, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
		assert.strictEqual(truncated.length, 0);
	});

	test('truncation warning text matches Continue wording', () => {
		const w = webSearchTruncationWarning(['A', 'B']);
		assert.ok(w.includes(`exceeded the ${DEFAULT_WEB_SEARCH_CHAR_LIMIT} character limit`));
		assert.ok(w.includes('A, B'));
		assert.ok(w.includes('web_extract'));
	});
});

suite('webSearchParse — formatWebExtractResult（Continue fetchUrlContentImpl 契约）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('includes title heading and URL line', () => {
		const out = formatWebExtractResult('https://example.com/p', 'My Page', 'body text');
		assert.ok(out.startsWith('# My Page'));
		assert.ok(out.includes('URL: https://example.com/p'));
		assert.ok(out.includes('body text'));
		assert.ok(!out.includes('Truncation warning'));
	});

	test('missing title falls back to URL as heading', () => {
		const out = formatWebExtractResult('https://example.com/p', undefined, 'text');
		assert.ok(out.startsWith('# https://example.com/p'));
	});

	test('content over 20000 chars is truncated with Continue-style warning', () => {
		const content = 'c'.repeat(WEB_EXTRACT_CHAR_LIMIT + 500);
		const out = formatWebExtractResult('https://example.com/big', 'Big', content);
		assert.ok(!out.includes('c'.repeat(WEB_EXTRACT_CHAR_LIMIT + 1)));
		assert.ok(out.includes('**Truncation warning**'));
		assert.ok(out.includes(`exceeded the ${WEB_EXTRACT_CHAR_LIMIT} character limit`));
		assert.ok(out.includes('https://example.com/big'));
		assert.ok(out.includes('consider fetching specific sections'));
	});

	test('exactly at limit is NOT truncated', () => {
		const out = formatWebExtractResult('https://e.com', 'T', 'd'.repeat(WEB_EXTRACT_CHAR_LIMIT));
		assert.ok(!out.includes('Truncation warning'));
	});

	test('webExtractTruncationWarning matches Continue wording', () => {
		const w = webExtractTruncationWarning('https://example.com');
		assert.ok(w.includes(`The content from https://example.com was truncated because it exceeded the ${WEB_EXTRACT_CHAR_LIMIT} character limit.`));
		assert.ok(w.includes('If you need more content, consider fetching specific sections or using a more targeted approach.'));
	});
});

suite('webSearchParse — HTTP 错误分类（重试策略）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── isPermanentHttpStatus ──────────────────────────────────────────

	test('4xx client errors are permanent (404/403/400/410)', () => {
		assert.strictEqual(isPermanentHttpStatus(404), true);
		assert.strictEqual(isPermanentHttpStatus(403), true);
		assert.strictEqual(isPermanentHttpStatus(400), true);
		assert.strictEqual(isPermanentHttpStatus(410), true);
	});

	test('408 and 429 are NOT permanent (timeout / rate limit recover)', () => {
		assert.strictEqual(isPermanentHttpStatus(408), false);
		assert.strictEqual(isPermanentHttpStatus(429), false);
	});

	test('5xx server errors are NOT permanent (transient)', () => {
		assert.strictEqual(isPermanentHttpStatus(500), false);
		assert.strictEqual(isPermanentHttpStatus(502), false);
		assert.strictEqual(isPermanentHttpStatus(503), false);
	});

	test('2xx/3xx and undefined are NOT permanent', () => {
		assert.strictEqual(isPermanentHttpStatus(200), false);
		assert.strictEqual(isPermanentHttpStatus(301), false);
		assert.strictEqual(isPermanentHttpStatus(undefined), false);
	});

	// ─── formatHttpErrorDetail ──────────────────────────────────────────

	test('appends status code when error text lacks it', () => {
		assert.strictEqual(formatHttpErrorDetail('Not Found', 404), 'Not Found (HTTP 404)');
	});

	test('does NOT duplicate status code already in error text', () => {
		// 上游 webPageLoader 的 error 常是 "HTTP error 404"，再追加 "(HTTP 404)" 会重复
		assert.strictEqual(formatHttpErrorDetail('HTTP error 404', 404), 'HTTP error 404');
	});

	test('no statusCode → error text unchanged', () => {
		assert.strictEqual(formatHttpErrorDetail('net::ERR_NAME_NOT_RESOLVED', undefined), 'net::ERR_NAME_NOT_RESOLVED');
	});

	// ─── permanentHttpErrorMessage（LLM 引导，日志 1785730551341）────────

	test('404 message guides model not to retry and to pick another result', () => {
		const m = permanentHttpErrorMessage('HTTP error 404', 404);
		assert.ok(m.startsWith('HTTP error 404'));
		assert.ok(!m.includes('(HTTP 404)'), 'no duplicated status suffix');
		assert.ok(m.includes('The page does not exist'));
		assert.ok(m.includes('Do NOT retry this URL'));
		assert.ok(m.includes('web_search'));
	});

	test('403 message explains automated-access block', () => {
		const m = permanentHttpErrorMessage('HTTP error 403', 403);
		assert.ok(m.includes('Access forbidden'));
		assert.ok(m.includes('Do NOT retry this URL'));
	});

	test('401 / 410 have specific reasons', () => {
		assert.ok(permanentHttpErrorMessage('x', 401).includes('Authentication required'));
		assert.ok(permanentHttpErrorMessage('x', 410).includes('permanently gone'));
	});

	test('other 4xx falls back to generic Client error + guidance', () => {
		const m = permanentHttpErrorMessage('x (HTTP 418)', 418);
		assert.ok(m.includes('Client error'));
		assert.ok(m.includes('Do NOT retry this URL'));
	});
});
