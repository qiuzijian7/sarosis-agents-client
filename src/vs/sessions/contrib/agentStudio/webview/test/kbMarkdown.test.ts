/* Unit tests for the KB markdown pure logic (no DOM / no React).
 * Run with: node test/run.mjs  (esbuild-bundles this file then executes it). */

import { slugify } from '../src/kbMarkdown/rehypeSlug';
import { extractHeadingSection } from '../src/kbMarkdown/headingSection';
import { extractOutline, findHeadingId } from '../src/kbMarkdown/outline';
import { resolveWikilink } from '../src/kbMarkdown/wikilinkResolver';
import { GEMOJI } from '../src/kbMarkdown/gemojiData';
import { sanitizeChildren } from '../src/kbMarkdown/rehypeRawSafe';
import type { WorkspaceFile } from '../src/kbMarkdown/types';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
	} else {
		failed++;
		console.error(`✗ ${label}\n   expected: ${e}\n   actual:   ${a}`);
	}
}

function ok(cond: boolean, label: string): void {
	if (cond) passed++;
	else {
		failed++;
		console.error(`✗ ${label}`);
	}
}

// ── slugify ────────────────────────────────────────────────────────────────
eq(slugify('My Heading'), 'my-heading', 'slugify basic');
eq(slugify('  Trim Me  '), 'trim-me', 'slugify trims');
eq(slugify('Hello, World!'), 'hello-world', 'slugify strips punctuation');
eq(slugify('中文标题'), '中文标题', 'slugify keeps CJK');
eq(slugify('a--b   c'), 'a-b-c', 'slugify collapses spaces/dashes');

// ── extractHeadingSection ──────────────────────────────────────────────────
const DOC = [
	'# A',
	'intro text',
	'## B',
	'b content',
	'## C',
	'c content',
	'# D',
	'd content',
].join('\n');

eq(
	extractHeadingSection(DOC, 'B'),
	'## B\nb content',
	'headingSection slices a level-2 section',
);
eq(
	extractHeadingSection(DOC, 'A'),
	'# A\nintro text\n## B\nb content\n## C\nc content',
	'headingSection stops at next same-or-higher heading',
);
eq(
	extractHeadingSection(DOC, 'Missing'),
	'',
	'headingSection returns empty when not found',
);
eq(
	extractHeadingSection(DOC, 'b'),
	'## B\nb content',
	'headingSection matches case-insensitively',
);

// Headings inside fenced code must be ignored.
const FENCED = ['# Real', '```', '# Fake Heading', '```', '## Real2', 'body'].join('\n');
eq(
	extractHeadingSection(FENCED, 'Real'),
	'# Real\n```\n# Fake Heading\n```\n## Real2\nbody',
	'headingSection ignores fenced headings',
);

// ── extractOutline ─────────────────────────────────────────────────────────
const FM_DOC = [
	'---',
	'title: Test',
	'---',
	'# First',
	'text',
	'## Second',
	'## Second',
	'# Third',
].join('\n');
const outline = extractOutline(FM_DOC);
eq(
	outline.map((o) => o.level),
	[1, 2, 2, 1],
	'outline levels (frontmatter skipped)',
);
eq(
	outline.map((o) => o.text),
	['First', 'Second', 'Second', 'Third'],
	'outline texts',
);
eq(
	outline.map((o) => o.id),
	['first', 'second', 'second-1', 'third'],
	'outline ids with dedup suffix match rehypeSlug',
);

// ── findHeadingId ──────────────────────────────────────────────────────────
eq(findHeadingId(outline, 'Second'), 'second', 'findHeadingId first occurrence');
eq(findHeadingId(outline, 'second'), 'second', 'findHeadingId case-insensitive');
eq(findHeadingId(outline, 'Third'), 'third', 'findHeadingId exact');
ok(findHeadingId(outline, 'Nope') === undefined, 'findHeadingId missing → undefined');

// ── resolveWikilink ───────────────────────────────────────────────────────
const FILES: WorkspaceFile[] = [
	{ uri: 'file:///vault/Note.md', name: 'Note.md' },
	{ uri: 'file:///vault/Sub/Note.md', name: 'Note.md' },
	{ uri: 'file:///vault/Sub/Other.md', name: 'Other.md' },
];
eq(
	resolveWikilink('Note', FILES).uri,
	'file:///vault/Note.md',
	'resolveWikilink picks shortest path on tie',
);
eq(
	resolveWikilink('Note', FILES, 'file:///vault/Sub/Other.md').uri,
	'file:///vault/Sub/Note.md',
	'resolveWikilink prefers same directory',
);
eq(
	resolveWikilink('Sub/Note', FILES).uri,
	'file:///vault/Sub/Note.md',
	'resolveWikilink path-suffix match',
);
eq(
	resolveWikilink('Missing', FILES).uri,
	null,
	'resolveWikilink broken link',
);
eq(
	resolveWikilink('Note#Section', FILES).heading,
	'Section',
	'resolveWikilink passes heading through',
);
eq(
	resolveWikilink('Note.md', FILES).uri,
	'file:///vault/Note.md',
	'resolveWikilink strips .md extension',
);

// ── prismLanguages (PrismLight whitelist) ──────────────────────────────────
import { PrismLight as _Prism, oneDark as _OneDark } from '../src/kbMarkdown/components/prismLanguages';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

ok(typeof _Prism === 'function', 'prismLanguages exports PrismLight component');
ok(!!_OneDark && typeof _OneDark === 'object', 'prismLanguages exports oneDark style object');

const tsHtml = renderToStaticMarkup(
	createElement(_Prism, { language: 'typescript', style: _OneDark }, 'const x: number = 1;'),
);
ok(/class="token/.test(tsHtml), 'whitelisted typescript grammar tokenizes code');

const aliasHtml = renderToStaticMarkup(
	createElement(_Prism, { language: 'ts', style: _OneDark }, 'const x = 1;'),
);
ok(/class="token/.test(aliasHtml), 'ts alias resolves to typescript grammar');

const unknownHtml = renderToStaticMarkup(
	createElement(_Prism, { language: 'definitely-not-a-real-lang', style: _OneDark }, 'plain text'),
);
ok(!/class="token/.test(unknownHtml), 'unknown language degrades to plain text without throwing');

// ── collectDomOutline (rendered-DOM TOC) ──────────────────────────────────
import { collectDomOutline } from '../src/kbMarkdown/domOutline';

// Minimal DOM mock: only `id` / `tagName` / `textContent` matter to the collector.
const fakeContainer = {
	querySelectorAll: () => ([
		{ tagName: 'H1', id: 'hello', textContent: 'Hello' },
		{ tagName: 'H2', id: 'wave-hello', textContent: '👋 Hello' },
		{ tagName: 'H3', id: '', textContent: 'no-id' }, // skipped: no id
		{ tagName: 'H4', id: 'sub', textContent: 'Sub `code`' },
	] as unknown as Element[]),
} as unknown as ParentNode;

const dom = collectDomOutline(fakeContainer);
eq(dom.length, 3, 'collectDomOutline skips headings without id');
eq(dom[0].level, 1, 'collectDomOutline reads h1 level');
eq(dom[0].text, 'Hello', 'collectDomOutline reads rendered text');
eq(dom[0].id, 'hello', 'collectDomOutline reads rendered id');
eq(dom[1].id, 'wave-hello', 'collectDomOutline keeps emoji-expanded slug id (matches rehypeSlug)');
eq(dom[2].text, 'Sub `code`', 'collectDomOutline reads inline-code text verbatim (matches rehypeSlug)');
ok(collectDomOutline(null).length === 0, 'collectDomOutline(null) returns empty');

// ── parseFrontmatter (enhanced YAML subset) ──────────────────────────────
import { parseFrontmatter } from '../src/kbMarkdown/frontmatter';

const fm1 = parseFrontmatter('---\ntags: [a, b, c]\n---\n\n# Body');
ok(Array.isArray(fm1?.data.tags), 'flow array parses to array');
eq((fm1?.data.tags as string[]).join(','), 'a,b,c', 'flow array elements kept');
eq(fm1?.body.trim(), '# Body', 'frontmatter fence stripped from body');

const fm2 = parseFrontmatter('---\ntags:\n  - a\n  - b\n---\n');
eq((fm2?.data.tags as string[]).join(','), 'a,b', 'block list still supported');

const fm3 = parseFrontmatter('---\nmeta:\n  a: 1\n  b: two\n---\n');
ok(typeof fm3?.data.meta === 'object' && !Array.isArray(fm3?.data.meta), 'nested block map -> object');
eq((fm3?.data.meta as Record<string, unknown>).a, 1, 'nested number preserved');
eq((fm3?.data.meta as Record<string, unknown>).b, 'two', 'nested string preserved');

const fm4 = parseFrontmatter('---\nmeta: {a: 1, b: true}\n---\n');
eq((fm4?.data.meta as Record<string, unknown>).a, 1, 'inline flow map number');
eq((fm4?.data.meta as Record<string, unknown>).b, true, 'inline flow map boolean');

const fm5 = parseFrontmatter('---\ndone: true\ncount: 42\npi: 3.14\nempty: null\ntitle: "Hello, world"\n---\n');
eq(fm5?.data.done, true, 'boolean true preserved');
eq(fm5?.data.count, 42, 'integer preserved');
eq(fm5?.data.pi, 3.14, 'float preserved');
eq(fm5?.data.empty, null, 'null preserved');
eq(fm5?.data.title, 'Hello, world', 'quoted string with comma not split');

const fm6 = parseFrontmatter('---\nmeta:\n  - x\n  - y\n---\n');
eq((fm6?.data.meta as string[]).join(','), 'x,y', 'nested block list under mapping');

ok(parseFrontmatter('no frontmatter here') === null, 'missing fence returns null');

// ── toggleTaskCheckbox (task list round-trip) ────────────────────────────
import { toggleTaskCheckbox } from '../src/kbMarkdown/taskToggle';

const tt1 = toggleTaskCheckbox('- [ ] todo\n- [x] done', 1);
eq(tt1, '- [x] todo\n- [x] done', 'toggleTaskCheckbox flips [ ] -> [x] on line 1');
const tt2 = toggleTaskCheckbox('- [ ] todo\n- [x] done', 2);
eq(tt2, '- [ ] todo\n- [ ] done', 'toggleTaskCheckbox flips [x] -> [ ] on line 2');
const tt3 = toggleTaskCheckbox('- [X] up', 1);
eq(tt3, '- [ ] up', 'toggleTaskCheckbox tolerates uppercase [X]');
const tt4 = toggleTaskCheckbox('not a task', 1);
eq(tt4, null, 'toggleTaskCheckbox returns null on non-task line');
const tt5 = toggleTaskCheckbox('- [ ] a', 9);
eq(tt5, null, 'toggleTaskCheckbox returns null on out-of-range line');
const tt6 = toggleTaskCheckbox('  * [ ] nested', 1);
eq(tt6, '  * [x] nested', 'toggleTaskCheckbox handles nested/asterisk markers');

// ── GEMOJI full dataset (缺口 5: 380 精选 → 1848 全量) ──────────────────────
const gk1 = Object.keys(GEMOJI).length;
ok(gk1 >= 1800, `GEMOJI has full coverage (${gk1} shortcodes, expected >= 1800)`);
eq(GEMOJI['rocket'], '🚀', 'GEMOJI rocket → 🚀');
eq(GEMOJI['thumbsup'], '👍', 'GEMOJI thumbsup → 👍');
eq(GEMOJI['wave'], '👋', 'GEMOJI wave → 👋');
eq(GEMOJI['+1'], '👍', 'GEMOJI +1 → 👍 (leading + shortcode)');
eq(GEMOJI['100'], '💯', 'GEMOJI 100 → 💯 (numeric shortcode)');
// All shortcodes must match the replacement regex `/:([a-z0-9_+-]+):/`.
const bad = Object.keys(GEMOJI).filter((k) => !/^[a-z0-9_+-]+$/.test(k));
eq(bad, [], 'GEMOJI every shortcode matches the :name: regex');

// ── rehypeRawSafe allowlist sanitise (零依赖 rehype-raw + rehype-sanitize 替代) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkEl = (tag: string, props: Record<string, unknown> = {}, kids: any[] = []): any =>
	({ type: 'element', tagName: tag, properties: props, children: kids });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkTxt = (v: string): any => ({ type: 'text', value: v });

// 1) disallowed wrapper (<script>) dropped entirely
eq(sanitizeChildren([mkEl('script', {}, [mkTxt('alert(1)')])]), [], 'sanitize drops <script>');
// 2) allowed <div> keeps class mapped to className
const s2 = sanitizeChildren([mkEl('div', { class: 'x' }, [mkTxt('hi')])]);
eq(s2.length, 1, 'sanitize keeps <div>');
eq(s2[0].properties.className, 'x', 'sanitize maps class → className');
// 3) javascript: URL in <a href> is stripped
const s3 = sanitizeChildren([mkEl('a', { href: 'javascript:alert(1)' }, [mkTxt('x')])]);
eq(s3[0].properties.href, undefined, 'sanitize strips javascript: href');
// 4) safe https link + target=_blank gets rel hardened
const s4 = sanitizeChildren([mkEl('a', { href: 'https://e.com', target: '_blank' }, [mkTxt('x')])]);
eq(s4[0].properties.href, 'https://e.com', 'sanitize keeps safe https href');
eq(s4[0].properties.rel, 'noopener noreferrer', 'sanitize hardens target=_blank');
// 5) data: URL in <img src> is stripped
const s5 = sanitizeChildren([mkEl('img', { src: 'data:image/png;base64,AAAA' })]);
eq(s5[0].properties.src, undefined, 'sanitize strips data: img src');
// 6) inline style and on* handlers are dropped
const s6 = sanitizeChildren([mkEl('div', { style: 'x', onclick: 'evil()' }, [mkTxt('y')])]);
eq(s6[0].properties.style, undefined, 'sanitize drops inline style');
eq(s6[0].properties.onclick, undefined, 'sanitize drops on* handler');
// 7) <style> dropped entirely
eq(sanitizeChildren([mkEl('style', {}, [mkTxt('.x{}')])]), [], 'sanitize drops <style>');

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
