/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★ 2026-09-21：xterm CLI 面板「尾区增量重写」契约（修复"每 delta 全量重写整个终端 ⇒ 闪烁/截断" ✗✗✓）。
 *
 * 两层断言 ✓：
 *   ① **行为**（tailDiff 纯函数 ✓）：diff/行数换算错一行 ⇒ CPL 上移错位 ⇒ 终端内容错乱 ✗✓
 *      —— 源码断言测不出来 ⇒ 必须有真用例 ✓；
 *   ② **接线**（源码结构 ✓）：流式/状态/spinner 路径**不得再直连 `_rerender()`** ✗。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { computeTailPatch, countRenderedLines, encodeTailPatch } from './tailDiff.js';

const PANEL_REL = 'src/vs/sessions/browser/agentChat/xtermTui/xtermCliPanel.ts';

function readPanelSrc(): string {
	return fs.readFileSync(path.join(process.cwd(), PANEL_REL), 'utf8');
}

/** 提取方法体（用花括号配平 ✓ —— 与 cliChatEditorPanel.render.test.ts 同款 ✓）。 */
function methodBody(src: string, signature: string): string {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `找不到方法：${signature}`);
	let i = src.indexOf('{', start);
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === '{') { depth++; }
		if (src[j] === '}') { depth--; }
		if (depth === 0) { return src.slice(i, j + 1); }
	}
	throw new Error(`方法体未闭合：${signature}`);
}

suite('xtermCliPanel.render（尾区增量重写 —— 2026-09-21 修复"每 delta 全量重写" ✗✗✓）', () => {

	// ── ① 行为：diff 纯函数 ─────────────────────────────────────────────

	test('内容没变 ⇒ noop（一次终端写都不发生 ✓✓）', () => {
		const p = computeTailPatch('a\r\nb\r\n', 'a\r\nb\r\n', 80, 24);
		assert.strictEqual(p.kind, 'noop');
		assert.strictEqual(p.payload, '');
	});

	test('无基线（首写）⇒ up=0 且 payload=全文（只写不擦 ✓）', () => {
		const p = computeTailPatch(undefined, 'hello\r\n', 80, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 0);
		assert.strictEqual(p.payload, 'hello\r\n');
		assert.strictEqual(p.oldTotalLines, 0);
		assert.strictEqual(p.newTotalLines, countRenderedLines('hello\r\n', 80));
	});

	test('纯追加（流式增长的常态 ✓）⇒ up=0、只写新增行（历史不重写 ✓✓）', () => {
		const p = computeTailPatch('a\r\nb\r\n', 'a\r\nb\r\nc\r\n', 80, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 0, '光标已在末尾新行 ⇒ 无需上移 ✓');
		assert.strictEqual(p.payload, 'c\r\n');
		assert.strictEqual(p.newTotalLines, 4); // a,b,c + 末尾空行 ✓
		assert.strictEqual(p.oldTotalLines, 3);
	});

	test('最后一行文字变长 ⇒ 只上移 1 行重写该行 ✓', () => {
		const p = computeTailPatch('a\r\nhel\r\n', 'a\r\nhello\r\n', 80, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 1);
		assert.strictEqual(p.payload, 'hello\r\n');
		assert.strictEqual(p.newTotalLines, p.oldTotalLines, '行数不变 ⇒ _contentLines 不动 ✓');
	});

	test('消息收缩（工具 trail 收起 ✓）⇒ 上移并清尾、payload 为空 ✓', () => {
		const p = computeTailPatch('a\r\nb\r\nc\r\n', 'a\r\n', 80, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 2, '要从末尾新行上移到第 1 行（b 行）✓');
		assert.strictEqual(p.payload, '', '收缩 ⇒ 清完即止 ✓');
		assert.strictEqual(p.newTotalLines, 2);
	});

	test('折行变化参与换算（cols=3，末行 6→7 字符 ⇒ 2 行变 3 行 ✓）', () => {
		const p = computeTailPatch('a\r\nabcdef\r\n', 'a\r\nabcdefg\r\n', 3, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 2, '旧末行占 2 显示行 ⇒ 上移 2 ✓');
		assert.strictEqual(p.newTotalLines, 1 + 3 + 1, 'a=1 行 + abcdefg=3 行 + 末尾空行 ✓');
	});

	test('ANSI 转义序列不计入折行宽度 ✓（上色行仍按可见宽度算 ✓）', () => {
		const red = (s: string) => `[31m${s}[0m`;
		const p = computeTailPatch(`${red('ab')}\r\n`, `${red('abcdefgh')}\r\n`, 4, 24);
		assert.strictEqual(p.kind, 'patch');
		assert.strictEqual(p.up, 1, '旧内容可见宽度 2 ⇒ 1 显示行 ✓（不是按转义序列长度 ✗）');
		assert.strictEqual(p.newTotalLines, 2 + 1, '可见宽度 8 / cols 4 = 2 行 + 末尾空行 ✓');
	});

	test('后缀超过视口 ⇒ full（CPL 进不了 scrollback ✗✓ 必须回退全量 ✓）', () => {
		const prev = ['h1', 'h2', 'h3', 'h4', 'h5'].join('\r\n') + '\r\n';
		const next = ['h1', 'X2', 'h3', 'h4', 'h5'].join('\r\n') + '\r\n';
		const p = computeTailPatch(prev, next, 80, 3); // 视口 3 行，后缀 5 行 ⇒ 上不去 ✗
		assert.strictEqual(p.kind, 'full');
	});

	test('encodeTailPatch：up>0 时先 CPL 上移 + ED 清尾，再写后缀 ✓', () => {
		const enc = encodeTailPatch({ kind: 'patch', up: 2, payload: 'x\r\n', newTotalLines: 2, oldTotalLines: 3 });
		assert.ok(enc.startsWith('[2F[0J'), `须以 CPL+ED 开头（实际 ${JSON.stringify(enc.slice(0, 12))} ✗）`);
		assert.ok(enc.endsWith('x\r\n'));
		// up=0 ⇒ 不带任何控制序列 ✓
		const enc0 = encodeTailPatch({ kind: 'patch', up: 0, payload: 'y\r\n', newTotalLines: 2, oldTotalLines: 1 });
		assert.strictEqual(enc0, 'y\r\n');
	});

	// ── ② 接线：流式路径不得再直连全量重渲染 ────────────────────────────

	test('★★★ 流式/spinner 路径禁止直连 `_rerender()`（每事件全量重写 = 闪烁真凶 ✗✗✓）', () => {
		const src = readPanelSrc();
		for (const sig of [
			'updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {',
			'setStreamTextBuffer(buffer: string): void {',
			'setStreamThinkingBuffer(buffer: string): void {',
		]) {
			const body = methodBody(src, sig);
			assert.ok(/_scheduleTailSync\(\)/.test(body), `${sig} 必须走尾区节流 ✓`);
		}
		// updateMessage 的中间消息分支允许全量（罕见 ✓），但末位分支必须是增量 ✓
		const upd = methodBody(src, 'updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {');
		assert.ok(/idx === this\._messages\.length - 1 && msg\.role === 'assistant'/.test(upd),
			'末位 assistant 必须走增量 ✓');
		const spinner = methodBody(src, 'private _startSpinner(): void {');
		assert.ok(!/this\._rerender\(\)/.test(spinner), 'spinner tick 禁止全量重写 ✗✓（此前每 80ms 一次 ✗）');
		assert.ok(/_scheduleTailSync\(\)/.test(spinner), 'spinner tick 必须走尾区节流 ✓');
	});

	test('★★★ 基线账本必须随写入路径同步（否则 diff 基线过期 ⇒ 光标错位 ✗✓）', () => {
		const src = readPanelSrc();
		const rerender = methodBody(src, 'private _rerender(): void {');
		assert.ok(/_writtenAnsi\.clear\(\)/.test(rerender), '全量重写必须清空基线 ✓');
		assert.ok(/_writtenAnsi\.set\(msg\.id/.test(rerender), '全量重写必须重建基线 ✓');
		const add = methodBody(src, 'addMessage(message: IAgentChatMessage): void {');
		assert.ok(/_writtenAnsi\.set\(message\.id/.test(add), '增量 append 必须登记基线 ✓');
		const tail = methodBody(src, 'private _rewriteMessageTail(msg: IAgentChatMessage): void {');
		assert.ok(/computeTailPatch\(/.test(tail) && /encodeTailPatch\(/.test(tail),
			'尾区重写必须使用纯函数（diff 数学可单测 ✓✓）');
	});

	test('★★ dispose 必须清掉尾区节流定时器（否则释放后往已销毁终端写 ✗✓）', () => {
		const src = readPanelSrc();
		const body = methodBody(src, 'override dispose(): void {');
		assert.ok(/_tailSyncTimer/.test(body) && /clearTimeout/.test(body),
			'dispose 必须 clearTimeout(_tailSyncTimer) ✓');
	});

	test('★★ CJK 必须按显示宽度折行（日志实锤：82 条消息 bufferLen=3343 vs 估算 2747，差 596 行 ✗✗✓）', () => {
		// 汉字 = 2 列 ✓（length 口径算 1 ⇒ 中文会话行数被低估 ~一半 ✗ ⇒ 高度与尾区 CPL 全错 ✗✗）
		assert.strictEqual(countRenderedLines('你好', 4), 1, '4 列宽 ÷ 4 列 = 1 行 ✓');
		assert.strictEqual(countRenderedLines('你好', 3), 2, '4 列宽 ÷ 3 列 = 2 行 ✓（length 口径会算成 1 ✗）');
		assert.strictEqual(countRenderedLines('ab你好cd', 4), 2, '中英混合 8 列 ÷ 4 = 2 行 ✓');
		assert.strictEqual(countRenderedLines('[31m你好[0m', 4), 1, 'ANSI 剥离后再按显示宽度 ✓');
		// 增补平面（扩展 B 汉字 ✓ 代理对 ✓）
		assert.strictEqual(countRenderedLines('𠀀𠀀', 2), 2, '扩展 B 汉字 = 2 列 ✓（for..of 按码点 ✓）');
		// 全角符号
		assert.strictEqual(countRenderedLines('１２３', 3), 2, '全角数字 = 2 列 ✓');
	});

	test('★ 底部截断定位：四条关键路径必须有 [XtermLayout] 打点 + 账本自检 ✓', () => {
		const src = readPanelSrc();
		// 用户报"底部内容被截断"⇒ 要求先埋诊断再修 ✓ —— 本断言保证诊断不被后续改动弄丢 ✗
		const mustHaveDiag: Array<[string, string]> = [
			['private _rerender(): void {', 'rerender'],
			['private _rewriteMessageTail(msg: IAgentChatMessage): void {', 'tail'],
			['private _recomputeLayout(): void {', 'layout'],
			['private _refitTerminal(): void {', 'refit'],
		];
		for (const [sig, tag] of mustHaveDiag) {
			assert.ok(methodBody(src, sig).includes(`_diag('${tag}'`),
				`${sig} 必须有 _diag('${tag}', …) 打点 ✓`);
		}
		assert.ok(/_assertContentLinesConsistent\(/.test(src), '必须有账本自检 ✓');
		// ★ 口径（日志实锤 Δ=-81 = N-1 ✗✓）：每条存"内容行数" ⇒ 不变量 = Σ+1 ✓
		assert.ok(/Σ_written\+1/.test(src), '自检必须按 Σ+1 口径（末尾空行共享 ✗✓）');
		assert.ok(/_writtenLines\.set\(msg\.id, countRenderedLines\([\s\S]*?\) - 1\)/.test(src),
			'全量重建基线必须存"内容行数"（−1 ✓）');
		// ★ 高度必须按整数行取整（日志实锤 rem=3.8px ⇒ 末行被切 ✗✓）
		const layout = methodBody(src, 'private _recomputeLayout(): void {');
		assert.ok(/rowsFit = Math\.max\(1, Math\.floor\(\(avail - XtermCliPanel\.TERM_VPAD\) \/ cellHeight\)\)/.test(layout),
			'必须先算整数行数 ✓');
		assert.ok(/rowsFit \* cellHeight \+ XtermCliPanel\.TERM_VPAD/.test(layout),
			'高度 = 整数行 × cell + TERM_VPAD ✓（rem 结构性归零 ✓✓）');
		// ★ 垂直开销必须与 _refitTerminal 同源（同一个常量 ✗✓ —— 差 1px ⇒ rows 少一行 ✗）
		const refit = methodBody(src, 'private _refitTerminal(): void {');
		assert.ok(/rect\.height - XtermCliPanel\.TERM_VPAD/.test(refit),
			'refit 的 rows 必须用同一个 TERM_VPAD ✓');
	});

	test('★★★ 单元格尺寸必须读 xterm 实测值（2026-09-21 底部截断根因 ✗✗✓）', () => {
		// xterm 6 行高 = 字体自然度量（fontBoundingBoxAscent+Descent ≈1.25×fontSize ≈ 15px @12px ✓），
		// 不是 fontSize×lineHeight（12px ✗）—— 用 12 算 rows=103 ⇒ 实际渲染 ~1545px ⇒
		// 底部 ~20 行被容器 overflow:hidden 裁掉 ⇒ 滚动到底也看不见（「建议下一步」消失 ✗✗）。
		const src = readPanelSrc();
		assert.ok(/\?\.dimensions\?\.css\?\.cell/.test(src),
			'必须优先读 xterm 渲染服务的真实 css.cell ✓（与 fit addon 同源 ✓）');
		const refit = methodBody(src, 'private _refitTerminal(): void {');
		assert.ok(/_getCellSize\(\)/.test(refit), 'refit 必须走 _getCellSize ✓');
		const layout = methodBody(src, 'private _recomputeLayout(): void {');
		assert.ok(/_getCellSize\(\)/.test(layout), 'layout 必须走 _getCellSize ✓');
		// 兜底探针不得再硬编码 lineHeight=1.0（那正是测出 12px 假值的来源 ✗✗）
		const probe = methodBody(src, 'function measureCell(host: HTMLElement): { width: number; height: number } {');
		assert.ok(!/style\.lineHeight/.test(probe),
			'measureCell 禁止覆写 lineHeight（须走 normal = 字体自然度量，与 xterm 口径一致 ✓）');
	});

	test('★★ countRenderedLines 只有一份实现（tailDiff.ts ✓ —— 面板内不得有本地副本 ✗）', () => {
		const src = readPanelSrc();
		assert.ok(!/function countRenderedLines/.test(src),
			'面板内不得再定义本地 countRenderedLines（口径必须唯一 ✗✓）');
		assert.ok(/from '\.\/tailDiff\.js'/.test(src), '必须从 tailDiff.js 导入 ✓');
	});
});
