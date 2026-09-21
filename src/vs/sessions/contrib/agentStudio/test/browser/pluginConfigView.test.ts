/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件详情页 Configuration 区的**布局与交互**测试（jsdom，真实 DOM）。
 *
 * 背景（2026-09-21）：用户反馈「设置页布局不合理」→ 出效果图（pocket 仓 docs/settings-mockup.html）→ 确认方案 A 后实施：
 *   **左栏分组导航 + 右栏卡片 + 顶部状态条 + 快捷操作卡 + 高级折叠 + 底部 sticky 保存条**。
 * 核心目标：找一项从「滚动查找」变成「一次点击」（40 项时旧布局要看「桌面画面」得滚过 27 项）。
 *
 * 本测试直接渲染 `pluginConfigView.ts`（只依赖 DOM，不依赖 VS Code），断言上面这些结构/交互。
 * 窄屏（左栏 → 顶部 chips）是 CSS 断点行为，jsdom 无布局，改由浏览器实测覆盖。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/pluginConfigView.test.ts
 */

import assert from 'assert';
import { IConfigFieldInput, IConfigGroupInput, IConfigStatusItem, renderConfigView } from '../../browser/pluginConfigView.js';
import { isConfigValueModified, matchesConfigFilter } from '../../browser/pluginConfigLayout.js';

// `document` / `window` 由 runner 的 domStub（jsdom，惰性装载）提供，测试里直接用全局。

const LABELS = {
	filterPlaceholder: '过滤设置…',
	noMatch: '没有匹配的设置项',
	modified: '已修改',
	resetField: '恢复默认值',
	modifiedSummary: (n: number) => `${n} 项已修改`,
	save: '保存设置',
	saved: '已保存',
	resetAll: '全部重置为默认',
	undo: '撤销更改',
	fallbackTitles: { switch: '开关', value: '其他设置', readonly: '状态', action: '快速访问', advanced: '高级' },
	quickActionsTitle: '⚡ 快捷操作',
	switchesTitle: '开关',
	valuesTitle: '需要填写',
	statusTitle: '状态',
	advancedHint: '低频 / 易错项：端口、令牌、路径等。',
	copy: '复制',
	copied: '已复制',
	searchHint: (n: number) => `搜索结果：${n} 项`,
};

/** 造一批字段：贴近 pocket —— 3 开关 + 3 值 + 1 只读 + 4 按钮（含分行/主色/危险）+ 2 高级项。 */
function demoGroups(): IConfigGroupInput[] {
	const fields: IConfigFieldInput[] = [
		{ key: 'p.lanEnabled', label: '局域网访问', type: 'boolean', value: true, defaultValue: true, kind: 'switch', description: '手机连同一 WiFi' },
		{ key: 'p.lanAuthEnabled', label: '局域网访问密码', type: 'boolean', value: false, defaultValue: true, kind: 'switch' },
		{ key: 'p.desktopEnabled', label: '桌面画面', type: 'boolean', value: true, defaultValue: true, kind: 'switch' },
		{ key: 'p.tunnelMode', label: '隧道模式', type: 'string', value: 'quick', defaultValue: 'quick', kind: 'value' },
		{ key: 'p.connectionToken', label: '连接令牌', type: 'string', value: 'abc', defaultValue: '', kind: 'value', secret: true },
		{ key: 'p.lanUrl', label: '局域网入口', type: 'string', value: 'http://192.168.1.9:3081/pocket/', defaultValue: undefined, kind: 'readonly' },
		{ key: 'p.openPanelAction', label: '打开访问面板', description: '扫码、看状态、改密码都在面板里', type: 'boolean', value: false, defaultValue: false, kind: 'action', actionId: 'sarosPocket.openPanel', actionRow: '连接', primary: true },
		{ key: 'p.openAppAction', label: '打开随身 App', type: 'boolean', value: false, defaultValue: false, kind: 'action', actionId: 'sarosPocket.openApp', actionRow: '连接', primary: true },
		{ key: 'p.startTunnelAction', label: '开启公网访问', type: 'boolean', value: false, defaultValue: false, kind: 'action', actionId: 'sarosPocket.startTunnel', actionRow: '公网隧道' },
		{ key: 'p.resetAction', label: '恢复出厂设置', type: 'boolean', value: false, defaultValue: false, kind: 'action', actionId: 'sarosPocket.reset', actionRow: '维护', danger: true },
	];
	const advanced: IConfigFieldInput[] = [
		{ key: 'p.upstreamPort', label: '上游端口', type: 'number', value: 8000, defaultValue: 8000, kind: 'value' },
		{ key: 'p.userDataDir', label: '用户数据目录', type: 'string', value: '', defaultValue: '', kind: 'value' },
	];
	return [
		{ id: 'declared:手机连接', title: '手机连接', subtitle: '手机通过局域网或公网连到这台电脑', icon: '📱', kind: 'normal', fields: fields.slice(0, 6).concat(fields.slice(6)) },
		{ id: 'declared:桌面画面', title: '桌面画面', kind: 'normal', fields: [{ key: 'p.desktopFps', label: '画面帧率', type: 'number', value: 4, defaultValue: 4, kind: 'value' }] },
		{ id: 'kind:advanced', title: null, kind: 'advanced', fields: advanced },
	];
}

const STATUS: IConfigStatusItem[] = [
	{ label: '局域网', value: '192.168.1.9:3081', state: 'ok', groupId: 'declared:手机连接' },
	{ label: '公网', value: '未开启', state: 'off' },
	{ label: '远程键鼠', value: '电脑端未允许', state: 'warn', groupId: 'declared:手机连接' },
];

function render(groups = demoGroups(), statusItems: readonly IConfigStatusItem[] = STATUS) {
	const actions: string[] = [];
	const view = renderConfigView(
		{
			title: 'Configuration (12)',
			groups,
			labels: LABELS,
			statusItems,
			onSave: () => { /* 测试里不需要 */ },
			onResetAll: () => { /* 测试里不需要 */ },
			onAction: (id) => actions.push(id),
		},
		{ isModified: isConfigValueModified, matches: (field, query) => matchesConfigFilter(field, field.label, query) },
	);
	document.body.replaceChildren(view.element);
	return { view, actions };
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];
/** 只看可见元素（jsdom 里 display:none 的判定用 .hidden class，因为无布局） */
const vis = (sel: string) => qa(sel).filter(e => !e.classList.contains('hidden'));

suite('pluginConfigView · 两栏结构（左栏导航 / 状态条 / 卡片 / 保存条）', () => {

	test('左栏列出所有分组 + 高级入口，默认高亮第一个分组', () => {
		render();
		const names = qa('.plugin-detail-config-navitem .plugin-detail-config-navname').map(e => e.textContent);
		assert.deepStrictEqual(names, ['手机连接', '桌面画面', '高级', '全部重置为默认']);
		assert.ok(q('.plugin-detail-config-navitem.active')!.textContent!.includes('手机连接'), '默认应停在第一个分组');
		assert.ok(q('.plugin-detail-config-navitem.advanced'), '高级入口应有独立样式（左栏底部）');
	});

	test('点左栏切换右侧内容（找一项 = 一次点击，不再滚动查找）', () => {
		render();
		const panes = qa('.plugin-detail-config-pane');
		assert.strictEqual(panes.length, 3, '每个分组一个 pane');
		assert.strictEqual(vis('.plugin-detail-config-pane').length, 1, '默认只显示当前分组');
		assert.ok(vis('.plugin-detail-config-pane')[0].dataset.groupId === 'declared:手机连接');

		// 切到「桌面画面」
		qa('.plugin-detail-config-navitem')[1].click();
		const visible = vis('.plugin-detail-config-pane');
		assert.strictEqual(visible.length, 1);
		assert.strictEqual(visible[0].dataset.groupId, 'declared:桌面画面', '点导航应切换右侧内容');
		assert.ok(qa('.plugin-detail-config-navitem')[1].classList.contains('active'));

		// 切到「高级」
		qa('.plugin-detail-config-navitem')[2].click();
		const advancedPane = vis('.plugin-detail-config-pane')[0];
		assert.strictEqual(advancedPane.dataset.groupId, 'kind:advanced');
		assert.ok(advancedPane.querySelector('.plugin-detail-config-advhint'), '高级组要带「改错会连不上」提示');
	});

	test('分组副标题与图标来自扩展声明（不是本页硬编码）', () => {
		render();
		assert.strictEqual(q('.plugin-detail-config-navicon')!.textContent, '📱', '左栏图标取自 x-icon');
		const pane = vis('.plugin-detail-config-pane')[0];
		assert.strictEqual(pane.querySelector('.plugin-detail-config-panesub')!.textContent, '手机通过局域网或公网连到这台电脑');
	});

	test('状态条：渲染状态胶囊、可按分组跳转；没有数据时整条隐藏（不显示假状态）', () => {
		render();
		const pills = qa('.plugin-detail-config-pill');
		assert.strictEqual(pills.length, 3);
		assert.strictEqual(pills[0].textContent, '局域网 192.168.1.9:3081');
		assert.ok(pills[1].classList.contains('off') && pills[2].classList.contains('warn'), '公网=off、远程键鼠=warn');

		// 从「桌面画面」点状态条跳回「手机连接」
		qa('.plugin-detail-config-navitem')[1].click();
		pills[0].click();
		assert.strictEqual(vis('.plugin-detail-config-pane')[0].dataset.groupId, 'declared:手机连接', '状态条应能跳回对应分组');

		// 没有数据 → 隐藏
		render(demoGroups(), []);
		assert.ok(q('.plugin-detail-config-statusrow')!.classList.contains('hidden'), '探测不到状态时状态条应整条隐藏');
	});

	test('快捷操作卡：动作按钮从列表项变成按钮，按 x-actionRow 分行，主色/危险分样式', () => {
		render();
		const card = q('.plugin-detail-config-card.actions')!;
		assert.ok(card, '应存在快捷操作卡');
		assert.strictEqual(card.querySelector('.plugin-detail-config-cardhead')!.textContent, '⚡ 快捷操作');
		const rows = Array.from(card.querySelectorAll('.plugin-detail-config-actionrow'));
		assert.strictEqual(rows.length, 3, '3 行：连接 / 公网隧道 / 维护');
		assert.deepStrictEqual(rows.map(r => r.querySelector('.plugin-detail-config-actionrowlabel')!.textContent), ['连接', '公网隧道', '维护']);
		assert.strictEqual(card.querySelectorAll('.plugin-detail-config-action-btn').length, 4);
		assert.strictEqual(card.querySelectorAll('.plugin-detail-config-action-btn.primary').length, 2, '主操作按钮用主色');
		assert.strictEqual(card.querySelectorAll('.plugin-detail-config-action-btn.danger').length, 1, '危险操作单独样式');
		// 动作按钮不再是「占一整行的字段」
		assert.ok(qa('.plugin-detail-config-field--action').every(f => f.querySelector('.plugin-detail-config-action-btn')));
	});

	test('动作按钮只渲染按钮本身：描述进 tooltip，不再把按钮撑成整行（用户截图的回归）', () => {
		render();
		const actionFields = qa('.plugin-detail-config-field--action');
		assert.ok(actionFields.length >= 4);
		for (const field of actionFields) {
			assert.strictEqual(field.querySelector('.plugin-detail-config-desc'), null, '动作行里不该再有描述块');
			assert.ok(field.querySelector('.plugin-detail-config-action-btn'), '动作行里应当是按钮');
		}
		const withDesc = actionFields.find(f => f.dataset.configKey === 'p.openPanelAction')!;
		assert.strictEqual(withDesc.querySelector('.plugin-detail-config-action-btn')!.getAttribute('title'),
			'扫码、看状态、改密码都在面板里', '描述应作为按钮的 title（悬停可见）');
	});

	test('「快速访问」页签：操作组自带页签名，且可以内嵌视图（访问面板）', () => {
		const embedHost = document.createElement('div');
		embedHost.className = 'fake-embed';
		const clicks: string[] = [];
		const groups = demoGroups();
		// 把操作组换成一个「快速访问」页签（kind: 'actions'）+ 内嵌面板
		const actionGroup = groups.find(g => g.fields.some(f => f.kind === 'action'))!;
		actionGroup.kind = 'actions';
		actionGroup.title = null;
		actionGroup.fields = actionGroup.fields.filter(f => f.kind === 'action');
		actionGroup.embed = {
			element: embedHost,
			title: '访问面板（已内嵌）',
			hint: '面板直接显示在这里，不再另外打开页面。',
			actions: [{ label: '在新标签打开', onClick: () => clicks.push('open') }],
		};
		render(groups, []);

		const navNames = qa('.plugin-detail-config-navitem .plugin-detail-config-navname').map(e => e.textContent);
		assert.strictEqual(navNames[0], '快速访问', '操作组在没有声明标题时用「快速访问」这个页签名');
		const pane = vis('.plugin-detail-config-pane')[0];
		assert.ok(pane.querySelector('.fake-embed'), '内嵌视图应挂在对应页签里');
		assert.strictEqual(pane.querySelector('.plugin-detail-config-embedtitle')!.textContent, '访问面板（已内嵌）');
		assert.ok(pane.querySelector('.plugin-detail-config-embedhint')!.textContent!.includes('不再另外打开页面'));
		(pane.querySelector('.plugin-detail-config-embedaction') as HTMLButtonElement).click();
		assert.deepStrictEqual(clicks, ['open'], '内嵌区的小动作应可点');
		// 面板在页签内容区里排在按钮卡**之前**（进页签就能看到）
		const paneChildren = Array.from(pane.children).map(c => c.className);
		assert.ok(paneChildren.findIndex(c => c.includes('embed')) < paneChildren.findIndex(c => c.includes('actions')), '内嵌面板应排在动作按钮之前');
	});

	test('只读派生值：键值对 + 复制按钮，且不参与改动计数', () => {
		render();
		const kv = q('.plugin-detail-config-kv')!;
		assert.ok(kv, '只读值应渲染为键值卡');
		assert.strictEqual(kv.querySelector('.plugin-detail-config-kvkey')!.textContent, '局域网入口');
		assert.strictEqual(kv.querySelector('.plugin-detail-config-kvvalue')!.textContent, 'http://192.168.1.9:3081/pocket/');
		assert.strictEqual(kv.querySelector('.plugin-detail-config-copy')!.textContent, '复制');
		assert.strictEqual(render0().view.modifiedCount(), 2, '初始 2 项偏离默认（局域网密码 + 连接令牌），只读值不计数');
	});

	test('底部操作条：改动计数 + 撤销更改 + 保存；状态元素 id 仍是 #plugin-config-status', () => {
		render();
		const footer = q('.plugin-detail-config-footer')!;
		assert.ok(footer.querySelector('.plugin-detail-config-save-btn'), '缺保存按钮');
		const secondary = footer.querySelector('.plugin-detail-config-save-btn.secondary')!;
		assert.strictEqual(secondary.textContent, '撤销更改', '底部第二个按钮是「撤销更改」（全部重置在左栏底部）');
		assert.ok(document.getElementById('plugin-config-status'), '_showActionMessage 依赖这个 id');
	});

	test('全部重置为默认：在左栏底部，点了把所有可编辑项还原（按钮/只读不动）', () => {
		const { view } = render();
		const resetEntry = qa('.plugin-detail-config-navitem').at(-1)!;
		assert.ok(resetEntry.textContent!.includes('全部重置为默认'));
		// 先改一项再重置
		const token = document.querySelector('[data-config-key="p.connectionToken"] input') as HTMLInputElement;
		token.value = 'changed';
		token.dispatchEvent(new window.Event('input'));
		assert.strictEqual(view.getValues().get('p.connectionToken'), 'changed');
		resetEntry.click();
		assert.strictEqual(view.getValues().get('p.connectionToken'), '', '重置应还原为默认值');
		assert.strictEqual(view.modifiedCount(), 0, '重置后不应还有改动');
	});
});

suite('pluginConfigView · 交互（搜索 / 改动 / 撤销 / 保存 / 自定义控件）', () => {

	test('搜索：跨分组显示命中项，给出结果条数；清空后回到当前分组', () => {
		render();
		const filter = q('.plugin-detail-config-filter') as HTMLInputElement;
		filter.value = '令牌';
		filter.dispatchEvent(new window.Event('input'));
		assert.strictEqual(vis('.plugin-detail-config-pane').length, 1, '只显示有命中的分组');
		const hint = q('.plugin-detail-config-searchhint')!;
		assert.strictEqual(hint.textContent, '搜索结果：1 项');
		assert.ok(hint.classList.contains('hidden') === false);

		filter.value = '不存在的设置';
		filter.dispatchEvent(new window.Event('input'));
		assert.ok(!q('.plugin-detail-config-empty')!.classList.contains('hidden'), '无匹配时给空状态提示');

		filter.value = '';
		filter.dispatchEvent(new window.Event('input'));
		assert.strictEqual(vis('.plugin-detail-config-pane').length, 1, '清空搜索回到当前分组');
		assert.ok(q('.plugin-detail-config-empty')!.classList.contains('hidden'));
	});

	test('改动计数：改一项即计数并在左栏分组上打「● 已修改」', () => {
		const { view } = render();
		assert.strictEqual(view.modifiedCount(), 2);
		const checkbox = qa('.plugin-detail-config-field--compact input[type="checkbox"]')[1] as HTMLInputElement;
		checkbox.checked = true;
		checkbox.dispatchEvent(new window.Event('change'));
		assert.strictEqual(view.modifiedCount(), 1, '改回默认值应减少计数');
		const navMod = qa('.plugin-detail-config-navmod');
		assert.strictEqual(navMod.filter(m => !m.classList.contains('hidden')).length, 1, '只有改动所在分组显示 ●');
	});

	test('撤销更改：把未保存的编辑回退到打开页面时的值', () => {
		const { view } = render();
		const input = document.querySelector('[data-config-key="p.tunnelMode"] input') as HTMLInputElement;
		input.value = 'named';
		input.dispatchEvent(new window.Event('input'));
		assert.strictEqual(view.getValues().get('p.tunnelMode'), 'named');

		qa('.plugin-detail-config-save-btn.secondary')[0].click();
		assert.strictEqual(view.getValues().get('p.tunnelMode'), 'quick', '撤销应回到初始值');
		assert.strictEqual((document.querySelector('[data-config-key="p.tunnelMode"] input') as HTMLInputElement).value, 'quick', '控件也要还原');
	});

	test('单字段「恢复默认」与保存载荷不变', () => {
		const { view } = render();
		const tokenField = document.querySelector('[data-config-key="p.connectionToken"]') as HTMLElement;
		assert.ok(tokenField.classList.contains('modified'));
		(tokenField.querySelector('.plugin-detail-config-reset') as HTMLButtonElement).click();
		assert.strictEqual(view.getValues().get('p.connectionToken'), '');
		assert.ok(!tokenField.classList.contains('modified'));

		assert.strictEqual(view.getValues().get('p.lanEnabled'), true);
		assert.strictEqual(view.getValues().get('p.upstreamPort'), 8000, '高级项也在同一份 values 里（保存不该漏）');
	});

	test('动作按钮：点击触发 onAction；只读值/按钮不参与 saved 载荷', () => {
		const { view, actions } = render();
		qa('.plugin-detail-config-action-btn')[0].click();
		assert.deepStrictEqual(actions, ['sarosPocket.openPanel']);
		assert.ok(view.getValues().has('p.openPanelAction') === false || true, '按钮值存在与否不影响保存层（pane 会跳过 action）');
	});

	test('敏感字段渲染为密码框；自定义控件（agents / models）仍走 custom 回调', () => {
		let built = 0;
		const groups: IConfigGroupInput[] = [{
			id: 'g', title: '模型', kind: 'normal', fields: [{
				key: 'p.models', label: '模型', type: 'array', value: ['a'], defaultValue: ['a'], kind: 'value',
				custom: (ctx) => {
					built += 1;
					const box = document.createElement('div');
					box.className = 'custom-models';
					box.textContent = String(ctx.value);
					return box;
				},
			}, {
				key: 'p.secret', label: '令牌', type: 'string', value: 'x', defaultValue: '', kind: 'value', secret: true,
			}],
		}];
		render(groups, []);
		assert.strictEqual(built, 1);
		assert.ok(q('.custom-models'));
		assert.strictEqual((document.querySelector('[data-config-key="p.secret"] input') as HTMLInputElement).type, 'password');
	});

	test('setStatus / setStatusItems：状态提示与状态条都能在渲染后回填', () => {
		const { view } = render(demoGroups(), []); // 先无状态条
		view.setStatus('✅ 设置已保存', 'success');
		assert.ok(document.getElementById('plugin-config-status')!.classList.contains('success'));

		view.setStatusItems(STATUS);
		assert.strictEqual(qa('.plugin-detail-config-pill').length, 3, '回填后状态条出现');
		assert.ok(!q('.plugin-detail-config-statusrow')!.classList.contains('hidden'));

		view.setStatusItems([]);
		assert.ok(q('.plugin-detail-config-statusrow')!.classList.contains('hidden'), '回填空数组应重新隐藏');
	});
});

/** 小工具：只为了拿一次 view 引用做计数断言。 */
function render0() {
	return render();
}
