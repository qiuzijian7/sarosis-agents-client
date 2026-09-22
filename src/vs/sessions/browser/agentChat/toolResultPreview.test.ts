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

	test('★★★ 内容字段优先：unreal_exec 的 `{ok,repr,output}` ⇒ 摘要取 **output** ✓✓（真机取证 ✓）', () => {
		// 真机日志原文（vscode-app-1790084962792.log 的 6274-6277 行 ✓）
		const real = '{\n  "ok": true,\n  "repr": null,\n  "output": "UE version: 5.8.1-0+UE5\\nproject dir: /Game/Demo"\n}';
		const s = summarizeToolResult(real);
		assert.ok(s.startsWith('UE version: 5.8.1'),
			`必须取 output 的**内容**（实际「${s}」✗✓ —— 上一版会把 output 挤成 JSON 噪音 ✗）`);
		assert.strictEqual(s.includes('"ok"'), false, '不得把 JSON 键名挤进摘要 ✗✓');
		assert.strictEqual(s.includes('\\n'), false, '换行必须折叠成一行 ✓');
	});

	test('★★★ 用户线索「有的工具会返回结果字段」⇒ `result` / `message` 同样必须被识别 ✓', () => {
		assert.strictEqual(summarizeToolResult('{\n  "result": "找到了 3 个资产"\n}'), '找到了 3 个资产');
		assert.strictEqual(summarizeToolResult('{ "message": "bridge unreachable" }'), 'bridge unreachable');
	});

	test('★★ 无内容字段（unreal_health ✓）⇒ 退化为**紧凑单行 JSON**（保留字段名 ✓）', () => {
		// 真机日志原文（:6227-6232 ✓）
		const health = '{\n  "status": "ok",\n  "project": "unknown",\n  "pid": 82016,\n  "uptime_seconds": 17\n}';
		const s = summarizeToolResult(health);
		assert.ok(s.includes('"status"') && s.includes('"pid"'), `必须保留字段名（实际「${s}」✗）`);
		assert.strictEqual(s.includes('\n'), false);
	});

	test('★ 内容字段为空串 / null ⇒ **不得**当成命中（继续走紧凑 JSON ✓）', () => {
		const s = summarizeToolResult('{\n  "ok": true,\n  "output": "",\n  "repr": null\n}');
		assert.ok(s.includes('"ok"'), `空内容字段必须被跳过（实际「${s}」✗✓）`);
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

suite('unreal 终端卡 —— 接线与样式断言（★ 实现搬到终端模块后同步 ✓）', () => {

	const TERM_REL = 'src/vs/sessions/browser/agentChat/unrealTerminalView.ts';

	test('★★★ 终端正文必须用纯函数产出摘要/规模（不得自己取首行 ✗✓）', () => {
		const term = read(TERM_REL);
		assert.ok(/import\s*\{[^}]*summarizeToolResult/.test(term), '必须 import summarizeToolResult ✓');
		assert.ok(term.includes('summarizeToolResult('), '摘要必须由纯函数产出 ✓');
		assert.ok(term.includes('resultStats('), '规模必须由纯函数产出 ✓');
		const card = read(CARD_REL);
		assert.strictEqual(/_summarize\(/.test(card), false,
			'卡片不得再自己取首行 ✗✓（它正是只剩 `{` 的根因 ✓ 现已搬到终端模块 ✓）');
	});

	test('★★★ 规模与截断必须真的接到 UI（否则用户把「只有这么点」当成工具坏了 ✗✓）', () => {
		const term = read(TERM_REL);
		assert.ok(/stats\.lines/.test(term) && /stats\.chars/.test(term), '必须显示 N 行 · M 字符 ✓');
		assert.ok(/stats\.truncated/.test(term), '必须显示「已截断」✓');
		assert.ok(term.includes('unreal-term-warn'), '截断必须有状态类 ✓');
		assert.ok(term.includes('unreal-term-failed'),
			'失败态必须有状态类 ✓（`ok:false` / bridge 不可达 都要显式标出 ✗✓）');
	});

	test('★★★ 结果面板必须防**裁切**与**不换行** + 滚动权归**本体**（2026-09-22 用户两条反馈 ✓）', () => {
		const css = read(CSS_REL);
		// ⚠ 锚定「规则行首 + 父类前缀」✗✓ —— 否则会先命中复合/裸类名规则 ✗（本轮已踩两次 ✓）
		let at = css.indexOf('\n.unreal-term .unreal-term-out {');
		if (at < 0) { at = css.indexOf('.unreal-term-out {'); }
		assert.ok(at > 0, '.unreal-term-out 必须有样式 ✗✓');
		const block = css.slice(at, css.indexOf('}', at));
		assert.ok(block.includes('white-space: pre-wrap'), '长行必须换行 ✓（终端里最丑的横向跑飞 ✗）');
		assert.ok(block.includes('word-break: break-word'), '长 token 必须能断行 ✓');
		// ★ 用户反馈②：分区**不得**自带滚动 ⇒ 屏幕上只允许一根滚动条 ✓✓
		assert.ok(block.includes('max-height: none'), '分区不得自带限高 ✗✓（旧版 ⇒ 出现 2~3 根滚动条 ✗）');
		assert.ok(block.includes('overflow: visible'), '分区不得自带滚动 ✗✓（滚动权归 .unreal-term-tl ✓）');
		// 限高与滚动必须真的落在**本体**上 ✓
		const tlAt = css.indexOf('.unreal-term .unreal-term-tl {');
		assert.ok(tlAt > 0, '本体必须有限高规则 ✓（且必须是带前缀的高优先级选择器 ✓）');
		const tlBlock = css.slice(tlAt, css.indexOf('}', tlAt));
		assert.ok(/max-height:\s*\d+px/.test(tlBlock) && tlBlock.includes('overflow: auto'),
			'本体必须 max-height + overflow: auto ⇒ **唯一**滚动条 ✓✓');
	});

	test('★ 终端各态样式必须齐备（bar / cmd / code / kv / foot / exit ✓）', () => {
		const css = read(CSS_REL);
		// ★ 2026-09-22 方案 E（时间线）落地后同步 ✓：bar/foot 已并入"时间线节点" ✓
		for (const sel of ['.unreal-term-tl', '.unreal-term-node', '.unreal-term-cmd', '.unreal-term-code', '.unreal-term-kv', '.unreal-term-meta', '.unreal-term-exit']) {
			assert.ok(css.includes(sel), `必须存在 ${sel} 样式 ✓`);
		}
		assert.ok(css.includes('.tool-header-children-expanded'), '通用展开态规则必须仍在 ✓');
	});
});
