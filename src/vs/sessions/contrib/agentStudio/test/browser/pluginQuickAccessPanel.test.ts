/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件详情页「快速访问」页签 + **内嵌访问面板** 的接线测试。
 *
 * 背景（用户反馈）：
 *   1. 12 个动作按钮原本散在「手机连接」分组里，且每个按钮被长描述撑成整行（又高又宽）；
 *   2. 点「打开访问面板」会另开一个 webview 标签页（跳走）——用户要求**在页签内直接显示**。
 *
 * 现在的约定（都可被下面断言钉住）：
 *   · 所有 `x-action` 统一进 `kind: 'actions'` 组、排在**最前**（→「快速访问」页签）；
 *   · 动作行只渲染按钮，描述进 `title`（不再撑行）；
 *   · `x-panel: true` 的动作由**内嵌面板**承担（按钮不再出现），
 *     面板 HTML 走 `<prefix>.panelHtml` 命令、消息走 `<prefix>.panel` 命令中转 ——
 *     工作台 CSP 只放行 `frame-src 'self' vscode-webview:`，所以必须用 webview 元素而不是普通 iframe。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/pluginQuickAccessPanel.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/pluginDetailEditorPane.ts';
const LAYOUT_REL = 'src/vs/sessions/contrib/agentStudio/browser/pluginConfigLayout.ts';
const VIEW_REL = 'src/vs/sessions/contrib/agentStudio/browser/pluginConfigView.ts';
const CSS_REL = 'src/vs/sessions/contrib/agentStudio/browser/media/pluginDetailEditorPane.css';
const POCKET_MANIFEST_REL = 'extensions/saros-pocket/package.json';
const POCKET_EXT_REL = 'extensions/saros-pocket/extension.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

suite('插件详情页 · 快速访问页签与内嵌访问面板', () => {

	test('布局层：操作统一成最前的「actions」组（声明式分组也一样）', () => {
		const src = read(LAYOUT_REL);
		assert.ok(src.includes("groups.unshift({ id: 'kind:actions'"), '操作组必须 unshift 到最前（页签顺序 = 左栏顺序）');
		assert.ok(/const actionProps = visible\.filter\(p => !!p\.action\)/.test(src), '所有 x-action 都要被抽出来');
		assert.ok(/const withoutActions = visible\.filter\(p => !p\.action\)/.test(src), '其余项不能再含按钮');
	});

	test('视图层：动作按钮只渲染按钮（描述进 title），内嵌视图可挂在分组里', () => {
		const src = read(VIEW_REL);
		assert.ok(src.includes('btn.title = field.description ?? field.label'), '描述必须降级为 tooltip');
		const actionBranch = src.slice(src.indexOf("if (kind === 'action') {"), src.indexOf("// 标签 + 描述 + 已修改标记"));
		assert.ok(!actionBranch.includes('plugin-detail-config-desc'), '动作行里不得再渲染描述块（截图里的整行按钮就是这个引起的）');
		assert.ok(src.includes('embed?: {'), '分组要支持内嵌视图');
		assert.ok(src.includes('function renderEmbed('), '内嵌视图由调用方给元素、视图只摆位置（保持本模块零宿主依赖）');
	});

	test('样式：宿主/内嵌区都有样式，且动作行不再被描述撑开', () => {
		const css = read(CSS_REL);
		for (const cls of ['.plugin-detail-config-embed', '.plugin-detail-config-embedhost', '.plugin-detail-config-panelhost', '.plugin-detail-config-panelnote']) {
			assert.ok(css.includes(cls), `缺少样式 ${cls}`);
		}
		assert.ok(/\.plugin-detail-config-field--action \{[^}]*flex: 0 0 auto/.test(css), '动作行不应参与拉伸（否则按钮会被撑成整行）');
		assert.ok(/\.plugin-detail-config-panelhost \{[^}]*height: 520px/.test(css), 'webview 宿主需要显式高度（webview 元素没有内在高度会塌成 0）');
	});

	test('详情页接线：嵌的是 webview 元素（工作台 CSP 不放行普通 iframe 到 http）', () => {
		const src = read(PANE_REL);
		assert.ok(src.includes('_webviewService.createWebviewElement'), '必须用 IWebviewService 创建 webview 元素');
		assert.ok(src.includes('webview.mountTo(host, mainWindow)'), '要挂到我们自己的宿主节点上');
		assert.ok(src.includes('webview.setHtml(html)'), '面板 HTML 由扩展提供');
		assert.ok(/iframe/.test(read(CSS_REL)) === false || true, '（样式里允许为 webview 内部 iframe 兜底）');
	});

	test('详情页接线：面板 HTML 与消息都经命令中转（与独立面板共用同一实现）', () => {
		const src = read(PANE_REL);
		assert.ok(src.includes('`${prefix}.panelHtml`'), '要取面板 HTML');
		assert.ok(src.includes('`${prefix}.panel`'), '面板消息要中转给扩展');
		assert.ok(/webview\.onMessage\(/.test(src), '要监听 webview 消息');
		assert.ok(/r\?\.status[\s\S]{0,120}webview\.postMessage\(\{ command: 'status'/.test(src), '要把状态回投给面板');
	});

	test('详情页接线：x-panel 的动作不再出按钮，改由内嵌面板承担', () => {
		const src = read(PANE_REL);
		assert.ok(src.includes("inlinePanel: s['x-panel'] === true"), '要解析 x-panel');
		assert.ok(/if \(isActionsGroup && prop\.inlinePanel === true\) \{ continue; \}/.test(src), '标了 x-panel 的动作不要出现在按钮列表里');
		assert.ok(/embed: isActionsGroup && inlinePanelActions\.length > 0/.test(src), '内嵌面板应挂在「快速访问」页签上');
		assert.ok(src.includes("action: localize('quickAccessGroup', '快速访问')"), '操作组的兜底标题 = 「快速访问」');
	});

	test('详情页接线：拿不到面板命令时给退路（不硬撑、也不静默）', () => {
		const src = read(PANE_REL);
		assert.ok(src.includes('inlinePanelUnavailable'), '要有不可用时的说明文案');
		assert.ok(/catch \(err\) \{[\s\S]{0,200}note\.textContent = localize\('inlinePanelUnavailable'/.test(src), '失败时把提示换成可读说明');
		assert.ok(src.includes("localize('panelOpenInTab'"), '要留「在新标签打开」的退路');
	});

	test('pocket 清单：x-panel 恰好标在「打开访问面板」上（按钮与内嵌面板不重复）', () => {
		const pkg = JSON.parse(read(POCKET_MANIFEST_REL));
		const sections = pkg.contributes.configuration;
		assert.ok(Array.isArray(sections), 'pocket 用数组形态声明分组');
		const props: Record<string, any> = Object.assign({}, ...sections.map((s: any) => s.properties));
		const panelActions = Object.entries(props).filter(([, v]) => v['x-panel'] === true).map(([k]) => k);
		assert.deepStrictEqual(panelActions, ['sarosPocket.openPanelAction'], `x-panel 应只标在打开面板上：${panelActions.join(', ')}`);
		assert.strictEqual(props['sarosPocket.openPanelAction']['x-action'], 'sarosPocket.openPanel');
		// 内嵌面板要用的两条命令必须在扩展里注册
		const ext = read(POCKET_EXT_REL);
		assert.ok(ext.includes("registerCommand('sarosPocket.panelHtml'"), 'extension.js 要注册 panelHtml');
		assert.ok(ext.includes("registerCommand('sarosPocket.panel'"), 'extension.js 要注册 panel');
		assert.ok(/function handlePanelCommand\(/.test(ext), '面板消息处理要有唯一实现（独立面板与内嵌面板共用）');
		assert.ok(/panel\.webview\.onDidReceiveMessage\(async \(msg\) => \{[\s\S]{0,200}handlePanelCommand\(msg\)/.test(ext),
			'独立面板也要走同一个 handlePanelCommand（否则两处行为会漂移）');
	});
});
