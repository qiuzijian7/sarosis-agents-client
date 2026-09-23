/*---------------------------------------------------------------------------------------------
 *  partsSegmentSpacing.test.ts — 「一条消息像被拆成 2 段」修复的**回归护栏**（2026-09-23）
 *
 *  背景（用户反馈 ✓ 已定性为"非 bug、是 parts 结构" ✓）：
 *    · 渲染层**每个 text part 各建一个块** ⇒ `.message-content.parts-text-segment`
 *      （`agentChatPanel.markdown.ts:750-755` / `:808-815` ✓）；
 *    · 恢复层在消息无 parts 时按 **`textPosition`** 切开正文（`agentChatTypes.ts:386-408` ✓）。
 *    ⇒ 段边界处"双份外边距 + 中间那张折叠工具卡"让一条消息**看起来**是两块 ✗。
 *
 *  ★ 本修复的**红线**（已写成断言 ✓）：**只动 CSS，绝不动结构** ✗✓
 *    —— 合并 part 会违反 `keyedParts.ts` 的一致性硬约束 ⇒ finalize 全量重建 ⇒ **闪烁** ✗✓
 *    （该文件与 `_createPartElement` 的收录范围必须**严格一致** ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/partsSegmentSpacing.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';
const MD_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.markdown.ts';
const KEYED_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.keyedParts.ts';
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

suite('parts 分段视觉归一（2026-09-23 ✓ 只动 CSS ✓ 结构零改动 ✓）', () => {

	test('★★★ 段边界必须消掉双份空隙（段自身 margin:0 + 段内首末元素归零 ✓）', () => {
		const css = read(CSS_REL);
		assert.ok(css.includes('.parts-text-segment { margin: 0; }'),
			'段自身不得留额外外边距 ✗✓（它与段内 `<p>` 的外距叠加 ⇒ 段边界处空隙加倍 ✗）');
		assert.ok(css.includes('.parts-text-segment > :first-child { margin-top: 0; }'),
			'段内首元素上距必须归零 ✓');
		assert.ok(css.includes('.parts-text-segment > :last-child { margin-bottom: 0; }'),
			'段内末元素下距必须归零 ✓');
		assert.ok(css.includes('.parts-text-segment + .parts-text-segment { margin-top: 0; }'),
			'连续两段必须紧贴 ✓（恢复后常见：切点处没有卡的情况 ✓）');
	});

	test('★★★ 夹心结构（文字段 → 卡 → 文字段）才收紧，且用 `:has()` 限定范围 ✓', () => {
		const css = read(CSS_REL);
		assert.ok(css.includes('.parts-text-segment:has(+ .tool-header-wrapper + .parts-text-segment)'),
			'必须用 `:has()` **限定**"夹心结构" ✗✓ —— 否则会改掉所有工具卡的通用间距 ✗（影响面外溢 ✓）');
		assert.ok(css.includes('.parts-text-segment + .tool-header-wrapper:has(+ .parts-text-segment)'),
			'夹心那**张卡自己**的外距也要收紧 ✓（否则仍隔着 4px+4px ✗）');
		// 卡与段之间留 2px 而**不是 0** ✓ —— 完全贴合会让卡"粘"在文字上，反而更难读 ✓
		const at = css.indexOf('.parts-text-segment + .tool-header-wrapper:has(+ .parts-text-segment)');
		const block = css.slice(at, css.indexOf('}', at));
		assert.ok(block.includes('margin-top: 2px'), '卡与段之间必须留 2px（不是 0 ✓）');
		assert.ok(block.includes('margin-bottom: 0'), '卡的下距必须归零 ✓');
	});

	test('★★★ 红线：**绝不动结构** —— 每个 text part 仍各自成块 ✗✓', () => {
		const md = read(MD_REL);
		// 渲染层仍按 part 建元素（没有"合并相邻 text part"这种逻辑 ✗）
		assert.ok(md.includes("$(\".message-content.parts-text-segment\")"),
			'每个 text part 仍必须各自成块 ✓（合并会破坏 keyed 一致性校验 ⇒ 闪烁 ✗✓）');
		assert.ok(/segEl\.className = 'message-content parts-text-segment'/.test(md),
			'_createPartElement 仍须一段一块 ✓');
		// keyed 一致性硬约束的注释必须在（提醒后来者别合并 ✗✓）
		const keyed = read(KEYED_REL);
		assert.ok(keyed.includes('严格一致'),
			'`keyedParts.ts` 的"收录范围必须与 _createPartElement 严格一致"约束不得被删 ✗✓');
	});

	test('★ 修复可降级：`:has()` 不被支持时自动失效 ⇒ 回落当前观感（无副作用 ✓）', () => {
		const css = read(CSS_REL);
		const n = (css.match(/:has\(/g) || []).length;
		assert.ok(n >= 3, `:has() 规则必须在 ✓（实际 ${n} 条）`);
		// 断言：收紧规则**全部**带 `:has()`（无 `:has()` 的通用间距规则一条都没有 ✓）
		const generic = css.match(/^\.tool-header-wrapper \{[^}]*margin-top:\s*2px/m);
		assert.strictEqual(generic, null,
			'不得出现"裸的 .tool-header-wrapper 间距覆盖" ✗✓（那会改掉所有卡片的通用间距 ✓ 影响面外溢 ✗）');
	});
});
