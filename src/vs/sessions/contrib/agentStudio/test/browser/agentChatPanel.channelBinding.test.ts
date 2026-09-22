/*---------------------------------------------------------------------------------------------
 *  Channel 绑定 tab 的回归护栏（2026-09-22 用户报障 ✓）
 *
 *  报障两条 ✓（用户截图）：
 *   ① **输入框被挤成一个小方块、按钮撑满整行** ✗ —— 根因不在"没写样式" ✓，而在**样式权重**：
 *      按钮带 `monaco-button monaco-text-button`（工作台**全局**样式 ✓），全局表里 `.monaco-button`
 *      与本 tab 的 `.chat-settings-add-btn` **同权重但在表顺序上更靠后** ⇒ 它的尺寸/宽度会赢 ✗✓
 *      ⇒ 按钮独占整行，`.chat-binding-input{flex:1}` 被压到 `min-width:0` 而塌成方块 ✓。
 *   ② **取 chat_id 的提示不对** ✗ —— 真实路径是「**客户端飞书 → 群设置 → 底部「会话 ID」字段**」✓，
 *      而不是"在飞书群里发 `/bind list`" ✗。
 *
 *  本文件把两条都钉住 ✓（源码/CSS 断言 —— 与本仓既有的 `assertWired` 风格一致 ✓）：
 *   · 两条规则必须**限定在行内**（`.chat-binding-add-row .xxx` ⇒ 权重 0,2,0 > 0,1,0 ✓）✗✓；
 *   · 输入框 `flex: 1 1 auto` + 兜底 `min-width` ✓；按钮 `flex: 0 0 auto` + `width: auto` ✓（不许再撑 ✓）；
 *   · 提示文案必须出现「会话 ID」✓、**不得**再出现 `/bind list` ✗✓；两处实现（chat panel / 旧设置面板）口径一致 ✓。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';
const PANEL_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.dropdowns.ts';
const LEGACY_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts';
const HEADER_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.header.ts';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** 取某选择器的规则体（从 `{` 到配对的 `}` ✓）—— 用真实 CSS 文本，不做正则近似 ✓。 */
function ruleBody(css: string, selector: string): string | undefined {
	const at = css.indexOf(selector);
	if (at < 0) { return undefined; }
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	return open < 0 || close < 0 ? undefined : css.slice(open + 1, close);
}

suite('Channel 绑定 tab — 输入框/按钮布局与取号文案护栏 ✓', () => {

	test('★★★ 布局规则必须**限定在行内** ✓✓（否则全局 `.monaco-button` 会把按钮撑满、输入框塌成方块 ✗✓）', () => {
		const css = read(CSS_REL);
		const inputRule = ruleBody(css, '.chat-binding-add-row .chat-binding-input {');
		assert.ok(inputRule, '★ 必须有行内限定的输入框规则（裸 `.chat-binding-input` 权重不够 ⇒ 会被压 ✓✗）');

		const btnRule = ruleBody(css, '.chat-binding-add-row .chat-settings-add-btn {');
		assert.ok(btnRule, '★ 必须有行内限定的按钮规则（裸 `.chat-settings-add-btn` 权重与 `.monaco-button` 相同 ⇒ 可能被表顺序反超 ✓✗）');
	});

	test('★★★ 输入框可输入 ✓：`flex: 1 1 auto` + 兜底 `min-width`（病理挤压下仍能用 ✓）', () => {
		const rule = ruleBody(read(CSS_REL), '.chat-binding-add-row .chat-binding-input {')!;
		assert.ok(/flex:\s*1\s+1\s+auto/.test(rule), `输入框必须 flex: 1 1 auto（实际规则：${rule.trim().slice(0, 90)} ✗）`);
		assert.ok(/width:\s*auto/.test(rule), '必须显式 width: auto（否则继承来的固定宽度会压死 ✓）');
		assert.ok(/min-width:\s*\d+px/.test(rule), '必须兜一个 min-width（被挤到 min-width:0 就是用户看到的那个方块 ✗✓）');
	});

	test('★★★ 按钮**不得**再撑满整行 ✓✓（`flex: 0 0 auto` + `width: auto`）', () => {
		const rule = ruleBody(read(CSS_REL), '.chat-binding-add-row .chat-settings-add-btn {')!;
		assert.ok(/flex:\s*0\s+0\s+auto/.test(rule), `按钮必须 flex: 0 0 auto（实际：${rule.trim().slice(0, 90)} ✗）`);
		assert.ok(/width:\s*auto/.test(rule), '★ 必须显式 width: auto 反制全局 `.monaco-button` 的宽度 ✗✓');
		assert.ok(/white-space:\s*nowrap/.test(rule), '按钮文字不得换行（换行会让它变高变丑 ✓）');
	});

	test('★★ 行容器：flex + 居中 + 间距 ✓（高度不对齐会让输入框与按钮错位 ✓）', () => {
		const rule = ruleBody(read(CSS_REL), '.chat-binding-add-row {')!;
		assert.ok(/display:\s*flex/.test(rule), '必须是 flex 行 ✓');
		assert.ok(/align-items:\s*center/.test(rule), '必须垂直居中（否则输入框/按钮高低不齐 ✓）');
		assert.ok(/gap:\s*\d+px/.test(rule), '必须有间距 ✓');
	});

	test('★★★ 取号提示必须是「客户端飞书 → 群设置 → 会话 ID」✓✓，且**hint 文案本身**不得再出现 `/bind list` ✗✓', () => {
		// ⚠ 只检查**真正的 hint 赋值行** ✗✓ —— 全文扫描会把"记录历史说法的注释"也算进去 ✓
		//   （我第一版就是这么假红的 ✓：命中了我自己写的注释 ✓）。
		const hintTextOf = (src: string): string =>
			src.split('\n').filter(l => l.includes('hint.textContent')).join('\n');

		const panelHint = hintTextOf(read(PANEL_REL));
		assert.ok(panelHint.length > 0, '前置：必须能定位到 hint.textContent 赋值 ✓');
		assert.ok(panelHint.includes('客户端飞书'), '★ 提示必须点明是**客户端飞书**里取号 ✓');
		assert.ok(panelHint.includes('会话 ID'), '★ 必须给出真实字段名「会话 ID」（用户口述的权威路径 ✓✗）');
		assert.ok(panelHint.includes('群设置'), '★ 必须给出入口路径（群设置 ✓），否则用户仍找不到 ✓');
		assert.ok(!panelHint.includes('/bind list'),
			'★ hint 文案本身不得再提 `/bind list` ✗✓（用户明确纠错：命令不是取号路径 ✓）');

		const legacyHint = hintTextOf(read(LEGACY_REL));
		assert.ok(legacyHint.includes('客户端飞书') && legacyHint.includes('会话 ID'),
			'旧设置面板（agentSettingsEditorPane）必须与 chat panel 口径一致 ✓（同一件事 ⇒ 不能一新一旧 ✗✓）');
		assert.ok(!legacyHint.includes('/bind list'), '旧设置面板的 hint 同样不得再提 `/bind list` ✗✓');
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 聊天框 header · 渠道绑定标签（2026-09-22 用户报障：绑定了飞书的 session 看不到关联标签）
// ══════════════════════════════════════════════════════════════════════════
//
// 根因：徽章元素在 `agentChatPanel.header.ts` 里确实创建了 ✓，但 `.chat-header-feishu-badge`
//   的样式**只在旧 webview**（`webview/src/styles/globals.css`），native 的 `media/agentChat.css`
//   里一条都没有 ⇒ 裸 `<span>` 在 `.chat-header-left`（display:flex + min-width:0）里按 flex
//   规则被压成 0 宽 ⇒ **DOM 里有、肉眼看不见**（同一份标签在会话列表里是好的 ⇒ 用户能看到对比 ✓）。
//
// 本 suite 把三条不变量钉住：① native CSS 必须有规则且 `flex: 0 0 auto`（不许被挤没 ✓）；
//   ② 默认会话态与 logo 有独立样式 ✓；③ 渲染由**字段**驱动（header 每次全量重绘，只挂 DOM 会被刷掉 ✓）。

suite('聊天框 header · 渠道绑定标签护栏 ✓', () => {

	test('★★★ native 样式表必须有徽章规则，且声明 flex: 0 0 auto + white-space: nowrap ✓', () => {
		const rule = ruleBody(read(CSS_REL), '.chat-header-feishu-badge {');
		assert.ok(rule, '★ media/agentChat.css 必须有 .chat-header-feishu-badge 规则（否则 DOM 在、肉眼不可见 ✗✓）');
		assert.ok(/display:\s*inline-flex/.test(rule!), '徽章必须 inline-flex（品牌 logo 与文案同行居中 ✓）');
		assert.ok(/flex:\s*0\s+0\s+auto/.test(rule!), '★ 必须 flex: 0 0 auto —— 这是「不被挤成 0 宽」的关键 ✗✓');
		assert.ok(/white-space:\s*nowrap/.test(rule!), '文案不得换行（换行会把 header 撑高 ✓）');
	});

	test('★★ 默认会话态与徽章内品牌 logo 各有独立样式 ✓', () => {
		const css = read(CSS_REL);
		assert.ok(ruleBody(css, '.chat-header-feishu-badge.is-default {'),
			'必须能区分「渠道默认会话」态（实底）——否则与精确绑定混淆 ✓');
		assert.ok(ruleBody(css, '.chat-header-feishu-badge .channel-logo {'),
			'徽章内品牌 logo 必须有规则（svg 不被 flex 拉伸 ✓）');
	});

	test('★★ header 渲染由**字段**驱动：状态与 logo 都来自 state（重绘后仍在 ✓）', () => {
		const header = read(HEADER_REL);
		assert.ok(header.includes('span.chat-header-feishu-badge'), 'header 必须创建徽章元素 ✓');
		assert.ok(header.includes('this._feishuBoundChatId'),
			'★ 必须由字段驱动（header 每次全量重绘 ⇒ 只挂在 DOM 上的元素会被刷掉 ✗✓）');
		assert.ok(header.includes('this._feishuBindingIcon'),
			'★ 品牌 logo 必须来自 host 注入的字段（面板层不得反向依赖 contrib 的 channelIcons ✓）');
		assert.ok(header.includes('is-default'), '默认会话必须加 is-default 类 ✓');
	});
});
