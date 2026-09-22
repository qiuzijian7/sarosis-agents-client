/*---------------------------------------------------------------------------------------------
 *  toolResultPreview.test.ts — 工具结果摘要判据单测（+ 接线/样式断言）
 *
 *  钉住的回归（2026-09-22 用户报「unreal_help 显示不全」✗✓）：
 *   · 旧摘要取结果**首行** ✗ ⇒ 美化 JSON 的首行恒为 `{` ⇒ 卡片正文只剩一个 `{` ✗✗；
 *   · 修复后：结构化结果给**单行紧凑预览** ✓、纯文本给首个**有意义**的行 ✓、
 *     全无信息时也**绝不返回空** ✓（返回空会让卡片看起来"坏了" ✗）；
 *   · 并且必须**如实标注**规模与截断 ✓（否则用户把「结果只有这么点」当成工具坏了 ✗✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/toolResultPreview.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	TOOL_RESULT_SUMMARY_LIMIT,
	countResultLines,
	isTruncatedResult,
	resultStats,
	summarizeToolResult,
} from './toolResultPreview.js';

const CARD_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.unrealCard.ts';
const CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

suite('工具结果摘要（unreal_help 「显示不全」回归）', () => {

	test('★★★ 美化 JSON ⇒ 必须是**紧凑单行预览**（旧实现只剩 `{` ✗✗）', () => {
		const pretty = '{\n  "symbol": "unreal",\n  "members": [\n    "Actor",\n    "Blueprint"\n  ]\n}';
		const s = summarizeToolResult(pretty);
		assert.strictEqual(s.startsWith('{'), true);
		assert.notStrictEqual(s, '{', '**绝不能**只给一个 `{` ✗✓（这正是用户截图里的现象 ✓）');
		assert.ok(s.includes('"symbol"') && s.includes('"members"'),
			`摘要必须包含关键字段名（实际「${s}」✗）`);
		assert.strictEqual(s.includes('\n'), false, '摘要必须是**一行** ✓（换行会把卡片撑开 ✗）');
	});

	test('★★★ 纯 `{` / `[` 行必须被跳过 ⇒ 取后面的有信息行 ✓', () => {
		assert.strictEqual(summarizeToolResult('{\n  Actor\n  Blueprint\n}'), 'Actor',
			'跳过一个孤零零的 `{`，取下一行 ✓');
		assert.strictEqual(summarizeToolResult('[\n  one\n  two\n]'), 'one');
	});

	test('★★ 纯文本：取首个非空行（exec/build 的多行报告常态 ✓）', () => {
		assert.strictEqual(summarizeToolResult('Hello world\nsecond line'), 'Hello world');
		assert.strictEqual(summarizeToolResult('\n\n  第一行  \n第二行'), '第一行', '前导空行必须跳过 ✓');
	});

	test('★★ 超长 ⇒ 截断 + 省略号 ✓（且长度受 limit 控制 ✓）', () => {
		const long = 'x'.repeat(500);
		const s = summarizeToolResult(long, 40);
		assert.strictEqual(s.length, 41, '40 + 一个省略号 ✓');
		assert.ok(s.endsWith('…'));
		assert.strictEqual(summarizeToolResult('short'), 'short', '未超长**不得**加省略号 ✗');
	});

	test('★ 脏输入安全：空 / 全空白 / 全是标点 ⇒ 不抛错且**绝不返回空** ✗✓', () => {
		assert.strictEqual(summarizeToolResult(''), '');
		assert.strictEqual(summarizeToolResult('   \n  '), '');
		assert.strictEqual(summarizeToolResult(undefined as unknown as string), '', 'undefined ⇒ 空串（不抛 ✓）');
		const punct = summarizeToolResult('{ [ ] } , : ;'.repeat(3));
		assert.notStrictEqual(punct, '', '全是标点也必须给出**非空**回退 ✗✓（否则卡片像坏了 ✓）');
	});

	test('★ `countResultLines`：行数用于「完整结果（N 行）」提示 ✓', () => {
		assert.strictEqual(countResultLines('a\nb\nc'), 3);
		assert.strictEqual(countResultLines('  '), 0);
		assert.strictEqual(countResultLines(''), 0);
	});

	test('★★★ 截断必须**可识别** ✓（服务侧发模型时会加 `...[truncated for IPC]` ✓ 见 historyCompaction）', () => {
		assert.strictEqual(isTruncatedResult('abc\n...[truncated for IPC]'), true);
		assert.strictEqual(isTruncatedResult('code\n… (已截断)'), true);
		assert.strictEqual(isTruncatedResult('正常结果\n第二行'), false, '不得误报 ✓（否则等于狼来了 ✗）');
		assert.strictEqual(isTruncatedResult(''), false);
	});

	test('★★ `resultStats`：行数 / 字符数 / 截断（供「完整结果（N 行 · M 字符）」✓）', () => {
		const sample = '{\n  "a": 1,\n  "b": 2\n}';
		const s = resultStats(sample);
		assert.strictEqual(s.lines, 4);
		// ⚠ 用**派生值**断言，不硬编码数字 ✗✓（本轮首跑就是硬编码 20 vs 实际 22 ⇒ 假红 ✓）
		assert.strictEqual(s.chars, sample.length, '字符数 = trim 后长度 ✓');
		assert.strictEqual(s.truncated, false);
		assert.deepStrictEqual(resultStats('   '), { lines: 0, chars: 0, truncated: false }, '全空白 ⇒ 全 0 ✓');
	});

	test('★ 默认上限常量 = 160（与卡片旧值一致 ✓ 便于对照）', () => {
		assert.strictEqual(TOOL_RESULT_SUMMARY_LIMIT, 160);
	});
});

suite('unreal 卡片「显示不全」—— 接线与样式断言', () => {

	test('★★★ 卡片必须用纯函数产出摘要/规模（不得再自己取首行 ✗✓）', () => {
		const card = read(CARD_REL);
		assert.ok(/import\s*\{[^}]*summarizeToolResult/.test(card), '必须 import summarizeToolResult ✓');
		assert.ok(card.includes('summarizeToolResult(resultText)'), '摘要必须由纯函数产出 ✓');
		assert.ok(card.includes('resultStats(resultText)'), '规模必须由纯函数产出 ✓');
		assert.strictEqual(/_summarize\(/.test(card), false,
			'不得再保留"取首行"的私有实现 ✗✓（它正是只剩 `{` 的根因 ✓）');
	});

	test('★★★ 规模与截断必须真的接到 UI（否则用户把"只有这么点"当成工具坏了 ✗✓）', () => {
		const card = read(CARD_REL);
		assert.ok(/stats\.lines/.test(card) && /stats\.chars/.test(card), '必须显示 N 行 · M 字符 ✓');
		assert.ok(/stats\.truncated/.test(card), '必须显示「已截断」✓');
		assert.ok(card.includes('unreal-result-truncated'), '截断必须有状态类（CSS 有 ⚠ 标注 ✓）');
		assert.ok(card.includes('unreal-result-error'),
			'错误态必须有状态类 ✓（bridge 不可达/HTTP 错误在本族里都只是普通文本结果 ✓）');
	});

	test('★★★ 样式必须防**裁切**与**不换行**（旧状态：该卡一条 CSS 都没有 ✗✗）', () => {
		const css = read(CSS_REL);
		const at = css.indexOf('.unreal-result-block');
		assert.ok(at > 0, '.unreal-result-block 必须有样式 ✗✓（此前整族 unreal-* 规则都不存在 ✓）');
		const block = css.slice(at, css.indexOf('}', at));
		assert.ok(block.includes('white-space: pre-wrap'),
			'必须 pre-wrap ✗✓（默认 pre 会让长 JSON 行横向溢出 ⇒ 看起来"显示不全" ✓）');
		assert.ok(block.includes('word-break: break-word'), '长 token 必须能断行 ✓');
		assert.ok(block.includes('overflow: auto'),
			'必须**自己滚动** ✗✓：祖先 `.tool-header-children-expanded` 有 max-height 上限（1200px ✓）'
			+ '，不自己滚动就会在超长结果上被裁掉 ✓');
		assert.ok(block.includes('max-height'), '必须自带 max-height ⇒ 内容尺度可控 ✓');
	});

	test('★ 样式必须覆盖新增的截断/错误态（否则加了类也白加 ✗）', () => {
		const css = read(CSS_REL);
		assert.ok(css.includes('.unreal-result-truncated'), '截断态样式必须存在 ✓');
		assert.ok(css.includes('.unreal-result-error'), '错误态样式必须存在 ✓');
		assert.ok(css.includes('.unreal-summary'), '摘要行样式必须存在 ✓（它是用户第一眼看到的东西 ✓）');
	});

	test('★ 卡片容器必须允许展开态可见（回归护栏 ✓）', () => {
		const css = read(CSS_REL);
		assert.ok(css.includes('.tool-header-children-expanded'), '通用展开态规则必须仍在 ✓');
	});
});
