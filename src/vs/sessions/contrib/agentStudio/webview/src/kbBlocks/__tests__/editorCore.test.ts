/*---------------------------------------------------------------------------------------------
 *  Unit tests for the framework-free KB editor core helpers.
 *
 *  These helpers (extractOutline / countWords / countChars / estimateReadingMinutes)
 *  intentionally have NO dependency on `@blocksuite/*` or the DOM so they can be
 *  unit-tested under plain Node. They are also explicitly designed to mirror the
 *  *observable behaviour* of AFFiNE / BlockSuite's renderer:
 *
 *    - extractOutline  -> AFFiNE's outline viewer: a flat list of headings, each
 *                         carrying { level (1-6), text, 0-based line }.
 *    - countWords      -> AFFiNE's "字数": every CJK ideograph/kana counts as 1 unit,
 *                         every whitespace/punctuation-separated Latin word counts as 1.
 *    - countChars      -> secondary "字符数" stat: all whitespace excluded.
 *    - estimateReadingMinutes -> reading-time estimate: ceil(words / 200), min 1 min.
 *
 *  NOTE: AFFiNE stores docs as a *block model* and derives these numbers from the
 *  block tree, whereas this project stores KB notes as *Markdown source* and derives
 *  them from the raw text. The two are therefore behaviour-level mirrors, not a
 *  byte-for-byte port. (AFFiNE's only literal `countWords` in-tree is the naive
 *  `content.split(/\s+/).length` used by the copilot `doc_compose` tool, which is
 *  NOT CJK-aware — so the CJK-aware heuristic here is the intended CN "字数" semantics.)
 *
 *  Run with:  node src/vs/sessions/contrib/agentStudio/webview/src/kbBlocks/__tests__/run-editorcore-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractOutline, countWords, countChars, estimateReadingMinutes, type IOutlineItem } from '../editorCore.js';

/* ===========================================================================================
 * extractOutline — mirrors AFFiNE's outline viewer (ATX headings only)
 * ===========================================================================================*/

test('extractOutline: captures heading level, text and line', () => {
	const md = '# Title\n\nsome text\n## Section A\n### Sub\n';
	const out = extractOutline(md);
	assert.deepEqual(out, [
		{ level: 1, text: 'Title', line: 0 },
		{ level: 2, text: 'Section A', line: 3 },
		{ level: 3, text: 'Sub', line: 4 },
	] satisfies IOutlineItem[]);
});

test('extractOutline: ignores headings inside fenced code blocks', () => {
	const md = '```\n# not a heading\n```\n# real heading\n';
	const out = extractOutline(md);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].text, 'real heading');
	assert.strictEqual(out[0].line, 3);
});

test('extractOutline: tolerates trailing # characters (ATX closing)', () => {
	const md = '## Heading ##\n';
	const out = extractOutline(md);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].level, 2);
	assert.strictEqual(out[0].text, 'Heading');
});

test('extractOutline: empty document yields no items', () => {
	assert.deepEqual(extractOutline(''), []);
	assert.deepEqual(extractOutline('just a paragraph\nno heading here'), []);
});

test('extractOutline: supports all six ATX levels (1-6)', () => {
	const md = ['# h1', '## h2', '### h3', '#### h4', '##### h5', '###### h6'].join('\n');
	const out = extractOutline(md);
	assert.deepEqual(out.map(o => o.level), [1, 2, 3, 4, 5, 6]);
	assert.deepEqual(out.map(o => o.text), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
});

test('extractOutline: requires a space after the # run (CommonMark)', () => {
	// A '#' immediately followed by text (no separating space) is NOT an ATX heading.
	const out = extractOutline('#NoSpace\n# WithSpace\n');
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].text, 'WithSpace');
});

test('extractOutline: handles CRLF line endings', () => {
	const md = '# Title\r\n\r\n## Section\r\n';
	const out = extractOutline(md);
	assert.deepEqual(out, [
		{ level: 1, text: 'Title', line: 0 },
		{ level: 2, text: 'Section', line: 2 },
	] satisfies IOutlineItem[]);
});

test('extractOutline: a heading at the very end with no trailing newline', () => {
	const md = 'prose\n# Last';
	const out = extractOutline(md);
	assert.deepEqual(out, [{ level: 1, text: 'Last', line: 1 }] satisfies IOutlineItem[]);
});

test('extractOutline: fenced code block with an info string is still skipped', () => {
	const md = '```ts\n# not a heading\n```\n# real\n';
	const out = extractOutline(md);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].text, 'real');
	assert.strictEqual(out[0].line, 3);
});

test('extractOutline: preserves inline markdown in the captured text', () => {
	// The outline text is the raw heading line (minus # markers), not a rendered string.
	const out = extractOutline('# Hello *world* and `code`\n');
	assert.strictEqual(out[0].text, 'Hello *world* and `code`');
});

test('extractOutline: line index is correct when a code fence precedes the heading', () => {
	const md = ['```', 'ignored', '```', '', '# Real', ''].join('\n');
	const out = extractOutline(md);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].line, 4);
});

test('extractOutline: nested fenced blocks (```js / ```) toggle correctly', () => {
	const md = ['```js', 'const a = 1;', '```', '', '# After', ''].join('\n');
	const out = extractOutline(md);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].text, 'After');
});

test('extractOutline: indented ATX headings (<= 3 spaces) are NOT detected (design choice)', () => {
	// editorCore only recognises headings anchored at column 0; this diverges from
	// CommonMark (which allows up to 3 spaces of indent) and from AFFiNE's block model.
	// The test locks in the *current* behaviour so any future change is caught.
	const out = extractOutline('   ## Indented\n# Top\n');
	assert.deepEqual(out, [{ level: 1, text: 'Top', line: 1 }] satisfies IOutlineItem[]);
});

test('extractOutline: setext headings (underline style) are NOT detected (design choice)', () => {
	// AFFiNE has no concept of setext; editorCore only parses ATX. Lock in behaviour.
	const out = extractOutline('Title\n=====\n\n# Real\n');
	assert.deepEqual(out, [{ level: 1, text: 'Real', line: 3 }] satisfies IOutlineItem[]);
});

test('extractOutline: matches the AFFiNE outline-item contract (level 1-6, non-empty text, 0-based line)', () => {
	const md = '# A\n\n## B\n\n#### D\n';
	for (const item of extractOutline(md)) {
		assert.ok(item.level >= 1 && item.level <= 6, `level in range: ${item.level}`);
		assert.ok(typeof item.text === 'string' && item.text.length > 0, 'text non-empty');
		assert.ok(Number.isInteger(item.line) && item.line >= 0, 'line 0-based int');
	}
});

/* ===========================================================================================
 * countWords — AFFiNE's "字数": each CJK ideograph/kana = 1, each Latin word = 1
 * ===========================================================================================*/

test('countWords: counts each CJK ideograph as one unit', () => {
	assert.strictEqual(countWords('中文测试'), 4);
	assert.strictEqual(countWords('你好world'), 3); // 2 CJK + 1 latin word
});

test('countWords: counts latin words separated by punctuation', () => {
	assert.strictEqual(countWords('foo bar baz'), 3);
	assert.strictEqual(countWords("don't foo-bar"), 2); // apostrophe + hyphen stay within a word
	assert.strictEqual(countWords('hello, world!'), 2);
});

test('countWords: empty input is 0', () => {
	assert.strictEqual(countWords(''), 0);
	assert.strictEqual(countWords('   \n  '), 0);
});

test('countWords: pure CJK counts every ideograph (whitespace ignored)', () => {
	assert.strictEqual(countWords('中 文'), 2);
	assert.strictEqual(countWords('中\n文\n字'), 3);
});

test('countWords: Hiragana and Katakana are counted as CJK units', () => {
	// The CJK regex range includes ぀-ヿ (Hiragana + Katakana, U+3040-U+30FF).
	assert.strictEqual(countWords('こんにちは'), 5);
	assert.strictEqual(countWords('カタカナ'), 4);
	assert.strictEqual(countWords('ひらがなカタカナ'), 8); // ひらがな(4) + カタカナ(4)
});

test('countWords: digits are counted as Latin "words"', () => {
	assert.strictEqual(countWords('123 456'), 2);
	assert.strictEqual(countWords('abc123'), 1);
	assert.strictEqual(countWords('版本2 和3'), 5); // 版本和(3 CJK) + '2' + '3'
});

test('countWords: punctuation-only strings count as 0', () => {
	assert.strictEqual(countWords('，。！？'), 0);
	assert.strictEqual(countWords('...'), 0);
	assert.strictEqual(countWords('！@#$%'), 0);
});

test('countWords: mixed CJK + Latin + digits in one sentence', () => {
	// "在2024年 we shipped 3 features" -> 在(1) 年(1) we(1) shipped(1) features(1) = 5
	// (2024 and 3 are glued to CJK/other so they are not separate Latin words here:
	//  "2024" is inside the Latin token "we", no — see decomposition below)
	// Decomposition: 在, 年 are CJK (2). "we" (1), "shipped" (1), "3" (1), "features" (1)
	// "2024" sits between CJK "在" and "年" so it becomes part of `withoutCjk` run:
	//   text -> " 2024 " around CJK -> latin match "2024" = 1
	// Total = 2 (CJK) + 1(2024) + 1(we) + 1(shipped) + 1(3) + 1(features) = 7
	assert.strictEqual(countWords('在2024年 we shipped 3 features'), 7);
});

test('countWords: trailing/leading whitespace and newlines do not create phantom words', () => {
	assert.strictEqual(countWords('  hello world  '), 2);
	assert.strictEqual(countWords('\n\nfoo\n\n'), 1);
});

test('countWords: Hangul is NOT counted as a word unit (known limitation)', () => {
	// Hangul syllables (U+AC00-U+D7A3) are outside the CJK range, and the Latin regex
	// only matches ASCII alphanumerics, so Korean text currently scores 0.
	// This is a documented divergence from a fully-CJK-aware counter; the test pins the
	// current behaviour so it is a conscious decision if/when we extend the range.
	assert.strictEqual(countWords('안녕하세요'), 0);
});

test('countWords: fullwidth Latin letters are NOT counted (known limitation)', () => {
	// ＡＢＣ (U+FF21-U+FF3A) are outside both the CJK range and the ASCII Latin regex.
	assert.strictEqual(countWords('ＡＢＣ'), 0);
});

test('countWords: emoji and symbols contribute 0', () => {
	assert.strictEqual(countWords('😀🚀'), 0);
	assert.strictEqual(countWords('中文😀混合'), 4); // 4 CJK, emoji ignored
});

test('countWords: matches the AFFiNE "字数" contract (non-negative integer)', () => {
	for (const s of ['', 'hello', '中文', 'mixed 中 en 文 123', '!!!']) {
		const n = countWords(s);
		assert.ok(Number.isInteger(n) && n >= 0, `countWords("${s}") = ${n}`);
	}
});

/* ===========================================================================================
 * countChars — secondary "字符数" stat: all whitespace excluded
 * ===========================================================================================*/

test('countChars: excludes all whitespace', () => {
	assert.strictEqual(countChars('a b\tc\nd'), 4);
	assert.strictEqual(countChars('中文 测试'), 4);
	assert.strictEqual(countChars(''), 0);
});

test('countChars: excludes the ideographic space (U+3000)', () => {
	assert.strictEqual(countChars('a　b'), 2); // fullwidth space is \s in JS
});

test('countChars: counts CJK, Latin and punctuation alike (only whitespace removed)', () => {
	assert.strictEqual(countChars('中a1!'), 4);
	assert.strictEqual(countChars('  \t\n\r  '), 0);
});

/* ===========================================================================================
 * estimateReadingMinutes — ceil(words / 200), always >= 1
 * ===========================================================================================*/

test('estimateReadingMinutes: at least 1, rounded up', () => {
	assert.strictEqual(estimateReadingMinutes(0), 1);
	assert.strictEqual(estimateReadingMinutes(199), 1);
	assert.strictEqual(estimateReadingMinutes(200), 1);
	assert.strictEqual(estimateReadingMinutes(201), 2);
	assert.strictEqual(estimateReadingMinutes(400), 2);
	assert.strictEqual(estimateReadingMinutes(401), 3);
});

test('estimateReadingMinutes: negative / falsy words still floors at 1', () => {
	assert.strictEqual(estimateReadingMinutes(-5), 1);
	assert.strictEqual(estimateReadingMinutes(Number.NaN), 1);
});

test('estimateReadingMinutes: exact multiples of 200', () => {
	assert.strictEqual(estimateReadingMinutes(200), 1);
	assert.strictEqual(estimateReadingMinutes(600), 3);
	assert.strictEqual(estimateReadingMinutes(2000), 10);
});

/* ===========================================================================================
 * Integration: a realistic KB note produces a coherent outline + stats
 * ===========================================================================================*/

test('integration: a mixed KB note yields a coherent outline and stats', () => {
	const md = [
		'# 项目计划',
		'',
		'这是一段中文说明 with some English words.',
		'',
		'```',
		'# this is code, not a heading',
		'```',
		'',
		'## 背景',
		'背景内容 123。',
		'',
		'### 子目标',
		'子目标描述。',
	].join('\n');

	const outline = extractOutline(md);
	assert.deepEqual(
		outline.map(o => ({ level: o.level, text: o.text })),
		[
			{ level: 1, text: '项目计划' },
			{ level: 2, text: '背景' },
			{ level: 3, text: '子目标' },
		]
	);

	const words = countWords(md);
	// NOTE: countWords does NOT skip fenced code (only extractOutline does), so the
	// "# this is code, not a heading" line inside the fence still contributes words.
	// CJK: 项目计划(4) 这是一段中文说明(8) 背景(2) 背景内容(4) 子目标(3) 子目标描述(5) = 26
	// Latin/digit runs: "with"(1) "some"(1) "English"(1) "words"(1)
	//                   "this"(1) "is"(1) "code"(1) "not"(1) "a"(1) "heading"(1)
	//                   "123"(1) = 11
	// total = 37
	assert.strictEqual(words, 37);
	assert.strictEqual(estimateReadingMinutes(words), 1);
	assert.ok(countChars(md) > words, 'char count (no whitespace) should exceed word count');
});
