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

	test('★★★ 布局被扰动后贴底用户必须**重新钉底**（打字导致聊天区滚动 ✗✓ 2026-09-21 / 09-22）', () => {
		const body = applyComposerHeightBody(read(COMPOSER_SRC), COMPOSER_SRC);
		// 机制（两个方向都会被扰动 ✓）：
		//  · 输入框**变高** ⇒ flex 挤压 ⇒ 消息区 clientHeight 变小 ⇒ maxScroll 变大 ⇒ scrollTop 不变
		//    ⇒ 视窗相对内容下滑 ⇒ "打字引发滚动" ✗✓；
		//  · 输入框**被测量压扁**（`:2081` 的 `height='auto'` ✓）⇒ 消息区变大 ⇒ maxScroll 变小 ⇒
		//    浏览器把 scrollTop **钳制下调** ⇒ 向上跳一下 ✗✓（2026-09-22 用户报的就是这一支 ✓）。
		// 只恢复 savedScrollTop（旧 maxScroll）⇒ 贴底用户永久偏离底部 Δh ✗✓。
		// ★ 2026-09-22：门控必须是「**布局被扰动过**」（`autoDisturbed` = `auto` 是否真改变了高度 ✓），
		//   而**不是**「最终目标高度是否变化」（`heightChanged` ✗✓：拖高过输入框时它恒为 false ⇒
		//   钳制上跳**永不恢复** ✗✗ —— 这就是用户报的那个 bug ✓）。
		assert.ok(
			/if \(autoDisturbed && this\._messagesContainer\)/.test(body),
			`[${COMPOSER_SRC}] 恢复必须由 autoDisturbed 门控 ✓；用 heightChanged 门控会让「拖高过输入框」的用户\n`
			+ '每次击键都被钳制上跳且永不恢复 ✗✗（2026-09-22 用户报的 bug ✓）',
		);
		assert.ok(
			!/if \(heightChanged && this\._messagesContainer\)/.test(body),
			`[${COMPOSER_SRC}] 不得回退成 heightChanged 门控 ✗（该门控漏掉"测量压扁"这一支 ✓）`,
		);
		// 正向不变量（原断言，逐字保留 ✓）
		assert.ok(
			/this\._isAtBottom\)[\s\S]{0,200}?scrollTop = this\._messagesContainer\.scrollHeight/.test(body),
			`[${COMPOSER_SRC}] 高度变化后：_isAtBottom ⇒ 必须 scrollTop = scrollHeight（重新钉底 ✓）；`
			+ '否则贴底用户每敲一行就偏离底部一截 ✗✓',
		);
		// 非贴底（上滚阅读）⇒ 必须仍走 savedScrollTop 恢复（保住阅读锚点 ✓）
		assert.ok(
			/else if \(this\._messagesContainer\.scrollTop !== savedScrollTop\)/.test(body),
			`[${COMPOSER_SRC}] 非贴底路径必须保留 savedScrollTop 恢复 ✓`,
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

	test('★★★ 块间距必须走单一令牌且达「空行级」（2026-09-21 对齐 pi TUI ✓）', () => {
		// pi 的 markdown 渲染器每个块后追加一个空行（≈19px ✓）；我们此前只有 2px ✗ ⇒ 观感"挤" ✓
		const css = readCss();
		assert.ok(/--cli-md-gap:\s*\d+px/.test(css), '必须有 --cli-md-gap 单一令牌（便于一处调松紧 ✓）');
		const gapUses = css.split('var(--cli-md-gap)').length - 1;
		assert.ok(gapUses >= 6,
			`块规则（p/pre/ul/h/blockquote/table/hr）都要走该令牌，实际只有 ${gapUses} 处 ✗`);
		const m = css.match(/--cli-md-gap:\s*(\d+)px/);
		assert.ok(m && Number(m[1]) >= 12,
			`块间距必须达"空行级"（≥12px ✓，pi ≈19px ✓），实际 ${m?.[1] ?? '?'}px ✗`);
	});

	test('★★★ accent 必须**保持蓝色**（用户 2026-09-21 决策 ✓，勿在"对齐 pi"时顺手改成青绿 ✗）', () => {
		// pi 的 accent 是青绿 `#8abeb7`（dark.json ✓）；用户明确**保留当前蓝色** ✓
		// ⇒ 这里钉住：`--cli-agent-color` 必须取自 `--vscode-textLink-foreground` ✓，
		//   且**不得**出现 pi 的青绿字面量 ✗（否则是无声的观感变更 ✓）。
		const css = readCss();
		const m = css.match(/--cli-agent-color:\s*([^;]+);/);
		assert.ok(m, '找不到 --cli-agent-color ✗');
		assert.ok(m![1].includes('textLink-foreground'),
			`accent 必须仍取 VS Code 链接色（蓝 ✓），实际：${m![1]} ✗`);
		// ⚠ 必须**先去掉注释**再查字面量 ✓ —— 注释里**刻意**写着「pi 的青绿 #8abeb7」作为决策依据 ✓，
		//   连注释一起查必然红 ✗（与「黑白灰」那次同一个坑 ✓：注释可以解释、活代码不行 ✓）。
		const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
		assert.ok(!code.toLowerCase().includes('#8abeb7'),
			'活代码里不得引入 pi 的青绿 #8abeb7（用户已裁定保留蓝色 ✗）');
	});

	test('★★★ 代码块必须走「带语法高亮」渲染器（对齐 pi 的 syntax* ✓，且要有回退 ✗）', () => {
		// 此前 CLI 面板用**朴素 `<pre>`**（纯文本 ✗）⇒ 无着色 ✓；现改走工作台暴露的
		// `EditorMarkdownCodeBlockRenderer`（内含 tokenizeToString + Trusted Types policy ✓）。
		const panel = fs.readFileSync(path.join(process.cwd(),
			'src/vs/sessions/browser/agentChat/cliChatEditorPanel.ts'), 'utf8');
		assert.ok(panel.includes('__SAROSIS_MD_CODE_BLOCK_RENDERER__'),
			'CLI 面板必须读取高亮钩子 ✗（否则代码块仍是纯文本 ✓）');
		assert.ok(panel.includes('cli-code-block'),
			'必须保留朴素 `<pre>` 回退（拿不到钩子时行为不变 ✓）');
		const wb = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/browser/workbench.ts'), 'utf8');
		assert.ok(wb.includes('EditorMarkdownCodeBlockRenderer') && wb.includes('__SAROSIS_MD_CODE_BLOCK_RENDERER__'),
			'workbench 必须把带高亮的代码块渲染器暴露到 globalThis ✓');
		const css = readCss();
		assert.ok(css.includes('.monaco-tokenized-source'),
			'CSS 必须样式化高亮产物 `.monaco-tokenized-source` ✓');
	});

	test('★★★ 主聊天代码块也必须高亮（同步钩子 ✓ + 大块跳过 ✓ + 安全注入 ✓）', () => {
		// 主聊天走 `codeBlockRendererSync`（同步 ✗）⇒ 必须用**同步**钩子 ✓；
		// 换异步渲染器会回退掉 2026-09-05 的流式竞态修复 ✗（见该处注释 ✓）。
		const md = fs.readFileSync(path.join(process.cwd(),
			'src/vs/sessions/browser/agentChat/agentChatPanel.markdown.ts'), 'utf8');
		assert.ok(md.includes('__SAROSIS_MD_HIGHLIGHT_SYNC__'), '主聊天必须读同步高亮钩子 ✗');
		assert.ok(md.includes('(!isLarge && hlSync)'), '大代码块必须跳过高亮（性能 ✓）');
		assert.ok(md.includes('safeSetInnerHtml(codeEl, tokenized)'),
			'HTML 注入必须走 safeSetInnerHtml（Trusted Types ✓）');
		const wb = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/browser/workbench.ts'), 'utf8');
		assert.ok(wb.includes('__SAROSIS_MD_HIGHLIGHT_SYNC__') && wb.includes('tokenizeToStringSync'),
			'workbench 必须提供**同步**分词钩子（tokenizeToStringSync ✓）');
	});

	test('★★★ TUI 面板必须 rAF 合并重建（2026-09-21 用户报「闪烁严重」✗）', () => {
		// 根因：`_updateMessageElement` 走 `clearNode(el)` 整条重建 ✗，却被**每个流式 delta** 调用 ⇒
		// 每秒几十次「清空+重建」⇒ 严重闪烁 ✓✓。修法：合并到**一帧一次** ✓（同主聊天做法 ✓）。
		const cli = fs.readFileSync(path.join(process.cwd(),
			'src/vs/sessions/browser/agentChat/cliChatEditorPanel.ts'), 'utf8');
		assert.ok(cli.includes('_scheduleUpdateMessageElement('), '必须有 rAF 合并入口 ✗');
		assert.ok(cli.includes('window.requestAnimationFrame('), '必须真正走 rAF（否则仍是每 delta 一渲染 ✗）');
		assert.ok(cli.includes('this._pendingRenderIds.add('), '必须按消息 id 去重（一帧内多次更新只重建一次 ✓）');
		// 流式路径不得再直接调 `_updateMessageElement`（否则合并被绕过 ✗）
		const direct = (cli.split('this._updateMessageElement(').length - 1);
		assert.ok(direct <= 1,
			`流式路径必须走合并入口（直接调用应只剩合并器内部那 1 处；实际 ${direct} ✗）`);
	});

	test('★★ 同步高亮钩子必须有分词缓存（流式每帧重建 ⇒ 每帧重新分词太贵 ✗）', () => {
		for (const rel of ['src/vs/workbench/browser/workbench.ts', 'src/vs/sessions/browser/workbench.ts']) {
			const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
			assert.ok(/const cache = new Map<string, string>\(\)/.test(src),
				`${rel} 的同步钩子必须有分词缓存 ✗（否则流式期间每帧重新分词 ✓）`);
		}
	});

	test('★★★ 钩子必须装在**两个** Workbench 上（本仓有两个入口 ✗，只改一个＝没生效 ✓）', () => {
		// 2026-09-21 用户实测「未生效」✗：本仓有 `sessions/browser/workbench.ts` 与
		// `workbench/browser/workbench.ts` **两个** `Workbench` 类 ✗ —— 只装一个，
		// 若启动走的是另一个 ⇒ 钩子不存在 ⇒ 静默回退纯文本 ✓✓（无任何报错 ✗）。
		const a = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/browser/workbench.ts'), 'utf8');
		const b = fs.readFileSync(path.join(process.cwd(), 'src/vs/workbench/browser/workbench.ts'), 'utf8');
		for (const [name, src] of [['sessions/browser', a], ['workbench/browser', b]] as const) {
			assert.ok(src.includes('__SAROSIS_MD_CODE_BLOCK_RENDERER__'), `${name} 必须装**异步**钩子 ✗`);
			assert.ok(src.includes('__SAROSIS_MD_HIGHLIGHT_SYNC__'), `${name} 必须装**同步**钩子 ✗`);
			assert.ok(src.includes('TokenizationRegistry.getOrCreate'),
				`${name} 的同步钩子必须**预热**语言分词器（懒加载 ⇒ 首次渲染拿不到令牌 ✗）`);
			assert.ok(src.includes('[MdHighlight] hooks installed'),
				`${name} 必须打安装日志（否则"没生效"时无法判断装没装上 ✗）`);
		}
	});

	test('★★ md 语义令牌必须齐（对齐 pi 的 mdHeading/mdLink/mdCode/mdQuote/mdHr/mdListBullet ✓）', () => {
		const css = readCss();
		for (const t of ['--cli-md-heading', '--cli-md-link', '--cli-md-code', '--cli-md-code-block',
			'--cli-md-quote', '--cli-md-hr', '--cli-md-bullet']) {
			assert.ok(css.includes(t + ':'), `缺少语义令牌 ${t} ✗（pi 有同名令牌 ✓）`);
		}
	});
});
