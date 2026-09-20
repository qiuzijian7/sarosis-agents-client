/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 输入框自适应高度的不变量（2026-09-18）。
 *
 * ── 用户报告 ──────────────────────────────────────────────────────────
 * 「聊天框输入文本框中，输入文本时，不要自动调整高度变更成 1 行」✗
 *
 * ── 根因（代码级）──────────────────────────────────────────────────────
 * `_applyComposerHeight()` 的测量手法是「先把 inline 高度清成 `auto`，再读 `scrollHeight`」
 * （必要 ✓：元素若带固定高度，`scrollHeight` 会返回**那个固定高度**而不是内容高度 ✗）。
 * 但旧代码把写回包在「**只有值变了才写**」的守卫里 ✗✗：
 *
 *     t.style.height = 'auto';                                  // ← 已把高度清空 ✗
 *     const measured = t.scrollHeight;
 *     const target = this._computeComposerHeight(measured);
 *     if (target !== this._lastComposerHeight) {                // ← 值没变 ⇒ 跳过
 *         t.style.height = target + 'px';                       // ← 于是**永远不写回** ✗✗
 *     }
 *
 * ⇒ inline 高度**永久停在 `auto`** ⇒ 塌成内容高度 = **1 行** ✓（CSS 无 transition ⇒ 瞬间塌 ✓）。
 * 触发条件与现象完全吻合：用户拖高过输入框 / localStorage 恢复过高度 ⇒ `_userHasAdjustedHeight=true`
 * ⇒ `target = min(max(内容高, 拖动高), 320)` = **拖动高**；而"打字"通常不改变内容高度
 * ⇒ `target` 恒等于上次值 ⇒ **每次击键都跳过写回** ✗。
 *
 * ── 本文件锁住什么 ─────────────────────────────────────────────────────
 * 这是「删掉一行 / 加回一个守卫就复发」的那类 bug ✗ ⇒ 用**源码级断言**钉住顺序不变量
 * （与 `wsSwitchDiag.test.ts` / `guardrailWiring.test.ts` 同一手法 ✓）：
 *   ① 测量前的 `height = 'auto'` **必须保留**（否则量不到真实内容高 ⇒ 输入框永不长高 ✗）；
 *   ② 其后**必须无条件写回** `target`（本次修复的核心 ✓）；
 *   ③ **不得**再出现「值没变就跳过」的守卫 ✗✗（那正是本次 bug）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.composerHeight.test.ts
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** 被测源文件（相对仓库根）。 */
const COMPOSER_SRC = 'src/vs/sessions/browser/agentChat/agentChatPanel.composer.ts';

/** 读源文件（对 cwd 做兜底，兼容从子目录跑测试 ✓）。 */
function read(rel: string): string {
	const bases = [process.cwd(), path.join(process.cwd(), '..'), path.join(process.cwd(), '..', '..')];
	for (const base of bases) {
		const p = path.join(base, rel);
		if (fs.existsSync(p)) { return fs.readFileSync(p, 'utf8'); }
	}
	throw new Error(`找不到源文件：${rel}（cwd=${process.cwd()}）`);
}

/**
 * 截出 `_applyComposerHeight()` 的方法体（从签名到下一个同缩进的 `}`）。
 * 刻意不依赖精确行号：行号会随无关改动漂移 ⇒ 断言会假失败 ✗。
 */
function applyComposerHeightBody(src: string, rel: string): string {
	const sig = 'protected _applyComposerHeight(): void {';
	const start = src.indexOf(sig);
	assert.ok(start >= 0, `[${rel}] 找不到 ${sig} —— 方法被改名/删除了？本测试需要同步更新 ✓`);
	const rest = src.slice(start);
	const end = rest.indexOf('\n\t}');
	assert.ok(end > 0, `[${rel}] 找不到 ${sig} 的结束括号（缩进变了？）`);
	return rest.slice(0, end);
}

suite('输入框自适应高度 — 顺序不变量（2026-09-18）', () => {

	test('★★★ 测量前的 height=\'auto\' 必须保留（否则量不到真实内容高，输入框永不长高）', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		assert.ok(
			body.includes("t.style.height = 'auto'"),
			`[${COMPOSER_SRC}] _applyComposerHeight 必须先把 inline 高度清成 'auto' 再读 scrollHeight —— `
			+ `元素带固定高度时 scrollHeight 会返回那个固定高度（= 量不到内容高）✗`,
		);
		assert.ok(
			body.includes('t.scrollHeight'),
			`[${COMPOSER_SRC}] 必须真的去读 scrollHeight 作为内容高度 ✓`,
		);
	});

	test('★★★ 清成 auto 之后必须无条件写回 target（本次 bug：值没变 ⇒ 跳过 ⇒ 塌成 1 行 ✗✗）', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		assert.ok(
			body.includes('t.style.height = target + \'px\''),
			`[${COMPOSER_SRC}] _applyComposerHeight 必须把 target 写回 inline 高度 ✓`,
		);
		// 写回必须在 'auto' 之后（顺序错了就等于没写 ✓）
		const atAuto = body.indexOf("t.style.height = 'auto'");
		const atWrite = body.indexOf('t.style.height = target + \'px\'');
		assert.ok(atWrite > atAuto, `[${COMPOSER_SRC}] 写回必须出现在 'auto' 之后（顺序不变量 ✓）`);
	});

	test('★★★ 不得再出现「target !== _lastComposerHeight 才写回」的守卫 ✗✗（这正是本次 bug 的写法）', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		// 允许注释里提到（我们刻意留了「为什么不能这么写」的说明 ✓），但**不得是活代码** ✗
		const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
		assert.ok(
			!/if\s*\(\s*target\s*!==\s*this\._lastComposerHeight\s*\)/.test(code),
			`[${COMPOSER_SRC}] _applyComposerHeight 里出现了「值没变就跳过写回」的守卫 ✗✗ `
			+ `—— 上面刚把高度清成 'auto'，跳过写回会让输入框永久塌成内容高度（1 行）✓ `
			+ `（2026-09-18 用户报的那个 bug；如需"省一次样式写入"，请先改成不破坏 inline 高度的测量方式 ✓）`,
		);
	});

	test('★★★ 写回本身必须**无条件**（不得被 if 包住）✗ —— 2026-09-19 复核后仍然成立', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
		const writeLine = code.split('\n').find(l => l.includes("t.style.height = target + 'px'")) ?? '';
		assert.ok(writeLine.length > 0, `[${COMPOSER_SRC}] 找不到写回语句 ✗`);
		assert.ok(
			!/\bif\b/.test(writeLine),
			`[${COMPOSER_SRC}] 写回语句不能写在 if 里 ✗✗（这就是 2026-09-18 那个 bug 的形态：`
			+ `清成 'auto' 后条件跳过 ⇒ 永久塌成 1 行 ✓）。`
			+ '允许用 heightChanged 之类的**旁路判断**做别的事（例如是否恢复消息区 scrollTop ✓），'
			+ '但**写回高度自身必须无条件** ✓。',
		);
	});

	test('★★ _lastComposerHeight 仍应被更新（诊断/后续复用依赖它反映真实高度）', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		assert.ok(
			body.includes('this._lastComposerHeight = target'),
			`[${COMPOSER_SRC}] 写回后必须同步 _lastComposerHeight ✓`,
		);
	});
});

// ─── ★★★ CLI/TUI 面板滚动不变量（2026-09-20 用户报：内容显示不全 / 无法滚动 / 无滚动条）──

/**
 * 症状三连（用户截图 ✓）：内容被裁在底部 ✗、滚不动 ✗、看不到滚动条 ✗ —— **同源** ✓：
 *
 * `.cli-messages-scroll { flex: 1; overflow-y: auto }` **缺 `min-height: 0`** ✗ ——
 * 弹性列里的 flex 子项默认 `min-height: auto` ⇒ 会被内容**撑高而不收缩** ✗ ⇒
 * `overflow-y: auto` **永不触发** ✓；父级 `.cli-chat-panel` 的 `overflow: hidden`
 * 再把超出部分直接裁掉 ⇒ 三个症状同时出现 ✓✓。
 */
suite('CLI/TUI 面板滚动不变量（2026-09-20）', () => {

	const CSS_REL = 'src/vs/sessions/browser/agentChat/media/cli-chat.css';
	const readCss = (): string => fs.readFileSync(path.join(process.cwd(), CSS_REL), 'utf8');

	test('★★★ 消息滚动区必须能收缩（flex 列内 overflow:auto ⇒ 必须配 min-height:0 ✗）', () => {
		const css = readCss();
		const m = css.match(/\.cli-messages-scroll\s*\{([\s\S]*?)\}/);
		assert.ok(m, '找不到 .cli-messages-scroll 规则 ✗');
		const body = m![1];
		assert.ok(/overflow-y:\s*auto/.test(body), '滚动区必须 overflow-y: auto ✓');
		assert.ok(/min-height:\s*0/.test(body),
			'缺 min-height: 0 ⇒ flex 子项被内容撑高、overflow 永不触发 ⇒ 显示不全且滚不动 ✗✗');
	});

	test('★★ 滚动条必须可见（预留槽位 + VS Code 标准滑轨色 ✓）', () => {
		const css = readCss();
		assert.ok(/scrollbar-gutter:\s*stable/.test(css), '必须预留滚动条槽位（否则滚动条时有时无 ✗）');
		assert.ok(css.includes('--vscode-scrollbarSlider-background'),
			'滑轨必须用 VS Code 标准变量（此前 --cli-border 对比度偏低 ✗）');
	});
});
