/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_WEB_SEARCH_CHAR_LIMIT,
	MIN_USEFUL_CONTENT_LENGTH,
	WEB_EXTRACT_CHAR_LIMIT,
	classifyExtractQuality,
	decodeDuckDuckGoUrl,
	decodeHtmlEntities,
	extractHtmlTitleAndDescription,
	extractSnippet,
	formatHttpErrorDetail,
	formatWebExtractResult,
	htmlToPlainText,
	isDuckDuckGoAdOrChrome,
	isPermanentHttpStatus,
	permanentHttpErrorMessage,
	parseDuckDuckGoHtmlResults,
	parseDuckDuckGoLiteResults,
	renderSearchResults,
	selectBetterExtract,
	stripHtmlTags,
	webExtractBlockedMessage,
	webExtractIncompleteWarning,
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

suite('webSearchParse — web_extract 提取质量分类（P1-1 信号驱动升级）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ⚠ 填充词**不能以空格结尾**：classifyExtractQuality 按 `trim()` 后长度计量，结尾空格
	// 会让期望值差 1（写成 'lorem ipsum ' 时 n=300 实测 299，坑过一次）。
	const long = (n: number) => 'loremipsum'.repeat(Math.ceil(n / 10)).slice(0, n);

	// ─── ok / thin 边界 ─────────────────────────────────────────────────

	test('long content without signals → ok', () => {
		const q = classifyExtractQuality(long(500));
		assert.strictEqual(q.verdict, 'ok');
		assert.strictEqual(q.length, 500);
		assert.deepStrictEqual(q.signals, []);
	});

	test('content shorter than the threshold → thin (NOT a hard failure)', () => {
		const q = classifyExtractQuality(long(MIN_USEFUL_CONTENT_LENGTH - 1));
		assert.strictEqual(q.verdict, 'thin');
		assert.strictEqual(q.signals.length, 0);
	});

	test('threshold is inclusive on the ok side', () => {
		assert.strictEqual(classifyExtractQuality(long(MIN_USEFUL_CONTENT_LENGTH)).verdict, 'ok');
	});

	test('empty content → thin (长度 0 不该被判 blocked)', () => {
		assert.strictEqual(classifyExtractQuality('').verdict, 'thin');
		assert.strictEqual(classifyExtractQuality('   \n\t ').verdict, 'thin');
	});

	test('length is measured on the trimmed text', () => {
		assert.strictEqual(classifyExtractQuality(`   ${long(300)}   `).length, 300);
	});

	// ─── blocked：强特征（与页面长度无关）────────────────────────────────

	test('strong interstitial phrases → blocked regardless of length', () => {
		const samples: Array<[string, string]> = [
			['Checking your browser before accessing example.com', 'cloudflare-browser-check'],
			['Enable JavaScript and cookies to continue', 'js-cookies-required'],
			['Attention Required! | Cloudflare', 'cloudflare-block-page'],
			['DDoS protection by Cloudflare', 'ddos-guard'],
			['Verifying you are human. This may take a few seconds.', 'human-verification'],
			['网站正在安全验证，请稍候', 'zh-verification'],
			['请开启 JavaScript 后继续访问', 'zh-js-required'],
		];
		for (const [text, label] of samples) {
			const q = classifyExtractQuality(text);
			assert.strictEqual(q.verdict, 'blocked', `expected blocked for: ${text}`);
			assert.ok(q.signals.includes(label), `expected signal ${label}, got ${q.signals.join(',')}`);
		}
	});

	test('title is scanned too — a challenge TITLE blocks even when the body is long', () => {
		const q = classifyExtractQuality(long(5000), 'Checking your browser before accessing');
		assert.strictEqual(q.verdict, 'blocked');
	});

	test('blocked wins over thin (a短 challenge page is not merely "thin")', () => {
		const q = classifyExtractQuality('Just a moment...');
		assert.strictEqual(q.verdict, 'blocked');
		assert.ok(q.length < MIN_USEFUL_CONTENT_LENGTH);
	});

	// ─── blocked：弱特征只在短页生效（误判护栏）──────────────────────────

	test('weak signals block SHORT pages (cloudflare interstitial / captcha / rate limit)', () => {
		for (const text of ['Just a moment...', 'Please complete the reCAPTCHA', 'Access denied', 'Too many requests']) {
			assert.strictEqual(classifyExtractQuality(text).verdict, 'blocked', `expected blocked for: ${text}`);
		}
	});

	test('weak signals are IGNORED on long pages (避免正常长文被误杀)', () => {
		// 这三种短语出现在正常长文里非常常见 —— 必须不判 blocked。
		const q1 = classifyExtractQuality(`Just a moment. ${long(4000)}`);
		assert.strictEqual(q1.verdict, 'ok', `got ${q1.verdict} / ${q1.signals.join(',')}`);

		const q2 = classifyExtractQuality(`How to integrate reCAPTCHA into your form. ${long(4000)}`);
		assert.strictEqual(q2.verdict, 'ok', `got ${q2.verdict} / ${q2.signals.join(',')}`);

		const q3 = classifyExtractQuality(`We hit a rate limit in production. ${long(4000)}`);
		assert.strictEqual(q3.verdict, 'ok', `got ${q3.verdict} / ${q3.signals.join(',')}`);
	});

	test('strong patterns are phrase-level — near misses must NOT block', () => {
		// "DDoS protection"（无 "by"）、"attention required"（无 Cloudflare 后缀）都不该命中。
		assert.strictEqual(classifyExtractQuality(`Our DDoS protection is enabled. ${long(4000)}`).verdict, 'ok');
		assert.strictEqual(classifyExtractQuality(`Attention required for this experiment. ${long(4000)}`).verdict, 'ok');
	});

	test('only the head window is scanned (长文深处的短语不触发)', () => {
		const q = classifyExtractQuality(`${long(4000)} ... Checking your browser before accessing`);
		assert.strictEqual(q.verdict, 'ok', `got ${q.verdict} / ${q.signals.join(',')}`);
	});

	// ─── htmlToPlainText ────────────────────────────────────────────────

	test('htmlToPlainText drops script/style/head and decodes entities', () => {
		const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
			<body><script>var secret = 1;</script><p>Hello &amp; welcome</p><div>  spaced   out </div></body></html>`;
		const text = htmlToPlainText(html);
		assert.ok(text.includes('Hello & welcome'));
		assert.ok(!text.includes('secret'), 'inline script text must not leak into content');
		assert.ok(!text.includes('color:red'), 'style text must not leak');
		assert.ok(!text.includes('<'), 'no tags should remain');
		assert.ok(!/\s{2,}/.test(text), 'whitespace should be collapsed');
	});

	// ─── extractHtmlTitleAndDescription ─────────────────────────────────

	test('extractHtmlTitleAndDescription reads title + meta description (both attribute orders)', () => {
		const a = extractHtmlTitleAndDescription('<html><head><title>A &amp; B</title><meta name="description" content="Desc here"></head></html>');
		assert.strictEqual(a.title, 'A & B');
		assert.strictEqual(a.description, 'Desc here');

		const b = extractHtmlTitleAndDescription('<html><head><meta content="Reversed" name="description"><title>Only</title></head></html>');
		assert.strictEqual(b.title, 'Only');
		assert.strictEqual(b.description, 'Reversed');
	});

	test('extractHtmlTitleAndDescription returns empties when absent', () => {
		assert.deepStrictEqual(extractHtmlTitleAndDescription('<html><body>no head</body></html>'), { title: '', description: '' });
	});

	// ─── selectBetterExtract（升级裁决）──────────────────────────────────

	test('a non-blocked candidate beats a blocked one even when much shorter', () => {
		const sel = selectBetterExtract(
			{ text: 'Checking your browser before accessing', source: 'reader-mode' },
			{ text: 'Real but short content.', source: 'raw-html' },
		);
		assert.strictEqual(sel.chosen.source, 'raw-html');
		assert.strictEqual(sel.rejectedQuality.verdict, 'blocked');
	});

	test('when neither is blocked, the longer text wins', () => {
		const sel = selectBetterExtract(
			{ text: long(300), source: 'reader-mode' },
			{ text: long(900), source: 'raw-html' },
		);
		assert.strictEqual(sel.chosen.source, 'raw-html');
		assert.strictEqual(sel.chosenQuality.length, 900);
	});

	test('a raw-HTML rescue out of a reader-mode interstitial is picked', () => {
		// 场景：可访问性树只拿到拦截页，而原始 HTML 里有 noscript 正文。
		const sel = selectBetterExtract(
			{ text: 'Just a moment...', source: 'reader-mode' },
			{ text: long(2000), source: 'raw-html' },
		);
		assert.strictEqual(sel.chosen.source, 'raw-html');
		assert.strictEqual(sel.chosenQuality.verdict, 'ok');
	});

	test('both blocked → still returns a blocked verdict (调用方据此出标签化失败)', () => {
		const sel = selectBetterExtract(
			{ text: 'Just a moment...', source: 'reader-mode' },
			{ text: 'Access denied', source: 'raw-html' },
		);
		assert.strictEqual(sel.chosenQuality.verdict, 'blocked');
	});

	test('exact tie picks the first candidate (determinism)', () => {
		const sel = selectBetterExtract(
			{ text: long(400), source: 'reader-mode' },
			{ text: long(400), source: 'raw-html' },
		);
		assert.strictEqual(sel.chosen.source, 'reader-mode');
	});

	// ─── 输出文案 ───────────────────────────────────────────────────────

	test('webExtractIncompleteWarning names the url, the length and forbids presenting it as complete', () => {
		const q = classifyExtractQuality('short');
		const w = webExtractIncompleteWarning('https://example.com/p', q);
		assert.ok(w.includes('https://example.com/p'));
		assert.ok(w.includes(String(q.length)));
		assert.ok(w.includes('Do NOT present it as the complete content'));
	});

	test('webExtractBlockedMessage labels the failure, lists signals, and forbids retry', () => {
		const q = classifyExtractQuality('Just a moment...');
		const m = webExtractBlockedMessage('https://example.com/p', q);
		assert.ok(m.startsWith('## Web Extract Blocked'));
		assert.ok(m.includes('https://example.com/p'));
		assert.ok(m.includes('cloudflare-interstitial'));
		assert.ok(m.includes('intentionally NOT returned'));
		assert.ok(m.includes('Do NOT retry this URL'));
	});

	// ─── blocked：页面级「内容不可用 / 登录墙」（2026-09-24 由生产日志驱动）──────
	//
	// 这组用例来自一次真实的"抓取不到内容"：小红书未登录时抓到的其实是站点占位页，
	// 旧实现判 `verdict=ok` 把它**当成功**返回给模型（`web_extract OK → # 小红书 - 你访问的页面不见了`）。
	// 模型据此作答就是编造 —— 这比"抓取失败"更糟，因为它看不出来。

	test('★★ 小红书未登录的真实形状 → blocked + kind=unavailable（旧实现判 ok）', () => {
		// 生产日志里的真实样本：标题是站点通知、正文 1152 字符（导航 + 这句通知）。
		// 关键正是"它很长" —— 弱特征的 600 字符阈值挡不住它，必须靠特征表。
		const q = classifyExtractQuality(long(1152), '小红书 - 你访问的页面不见了');
		assert.strictEqual(q.verdict, 'blocked', `got ${q.verdict} / ${q.signals.join(',')}`);
		assert.strictEqual(q.kind, 'unavailable');
		assert.ok(q.signals.includes('zh-page-gone'));
		assert.ok(q.length >= 600, '样本长度本身必须超过弱特征阈值，否则这条用例证明不了什么');
	});

	test('★ 正文里的"页面不可用"整句同样拦（不只在标题里）', () => {
		const samples: Array<[string, string]> = [
			[`你要查看的页面不存在 ${long(3000)}`, 'zh-page-removed'],
			[`当前笔记暂时无法浏览 ${long(3000)}`, 'zh-note-unavailable'],
		];
		for (const [text, label] of samples) {
			const q = classifyExtractQuality(text);
			assert.strictEqual(q.verdict, 'blocked', `expected blocked for: ${text.slice(0, 16)}`);
			assert.ok(q.signals.includes(label), `expected ${label}, got ${q.signals.join(',')}`);
		}
	});

	test('★ 登录句式只在**短页**生效（长文里引用一句不该被拒 —— 误判护栏）', () => {
		// 这类通用句式若收成强特征，任何引用它的教程都会被拒 —— 按收录纪律只能进弱组。
		const short = classifyExtractQuality('请先登录后查看');
		assert.strictEqual(short.verdict, 'blocked');
		assert.strictEqual(short.kind, 'unavailable');

		const longPage = classifyExtractQuality(`教程：遇到"请先登录后查看"时该怎么做。${long(4000)}`);
		assert.strictEqual(longPage.verdict, 'ok', `got ${longPage.verdict} / ${longPage.signals.join(',')}`);
	});

	test('kind 只在 blocked 时出现（ok / thin 不设 —— 它表达的是"成因"，不是"内容好坏"）', () => {
		assert.strictEqual(classifyExtractQuality(long(500)).kind, undefined);
		assert.strictEqual(classifyExtractQuality('short').kind, undefined);
	});

	test('interstitial 仍为 kind=interstitial，文案不变（回归）', () => {
		const q = classifyExtractQuality('Just a moment...');
		assert.strictEqual(q.kind, 'interstitial');
		assert.ok(webExtractBlockedMessage('https://example.com/p', q).startsWith('## Web Extract Blocked'));
	});

	test('★★ 不可用页的文案：禁止原样重试、给出真浏览器通道、不泄漏占位页文本', () => {
		const marker = `你访问的页面不见了 ${long(900)}`;
		const q = classifyExtractQuality(marker);
		const m = webExtractBlockedMessage('https://www.xiaohongshu.com/discovery/item/abc', q);

		assert.ok(m.startsWith('## Web Extract — content unavailable'), m.slice(0, 60));
		assert.ok(m.includes('https://www.xiaohongshu.com/discovery/item/abc'));
		assert.ok(m.includes('zh-page-gone'), '要列出命中的信号，便于归因');
		assert.ok(m.includes('Do NOT retry this URL with web_extract'), '必须显式禁止这条无解的路');
		assert.ok(m.includes('browser_navigate'), '要给"真浏览器"这条真出路');
		assert.ok(m.includes('sign in **once**'), '登录动作落给用户；模型不得自己去搞凭据');
		assert.ok(!m.includes(marker), '占位页自身的文本一律不外传（否则模型会基于它作答）');
	});

	test('truncation warning hinges on strict `> LIMIT`（缓存留 +1 字符的依据）', () => {
		// webTools 的 CACHE_TEXT_CAP = WEB_EXTRACT_CHAR_LIMIT + 1 就靠这条严格大于：
		// 若把入库文本正好截到 LIMIT，命中缓存时告警会消失 ⇒ 模型误以为拿到完整页面。
		// 这条断言把这个隐式耦合钉住（改任一侧都会在这里红）。
		const atLimit = formatWebExtractResult('https://e.example', 'T', 'x'.repeat(WEB_EXTRACT_CHAR_LIMIT));
		assert.ok(!atLimit.includes('Truncation warning'), '正好到上限 → 不告警');

		const overLimit = formatWebExtractResult('https://e.example', 'T', 'x'.repeat(WEB_EXTRACT_CHAR_LIMIT + 1));
		assert.ok(overLimit.includes('Truncation warning'), '超出上限 → 告警（缓存存到 LIMIT+1 即为此）');
	});
});
