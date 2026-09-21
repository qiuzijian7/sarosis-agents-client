/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件详情页 Configuration 区的**布局决策**测试（纯逻辑，无需 DOM）。
 *
 * 背景（2026-09-20）：pocket 的设置项从十来个长到 **40 个**（28 项设置 + 12 个 `x-action` 按钮），
 * 而详情页当时是「一节扁平列表、每项占一整行」—— 用户反馈「布局不合理」。
 * 优化后的布局决策（分组 / 紧凑化 / 过滤 / 改动检测）都在 `pluginConfigLayout.ts`，
 * 本测试用 **pocket 的真实 manifest** 钉住「不丢项、不重复、顺序可控」。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/pluginConfigLayout.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	IConfigPropertyLike,
	configFieldKind,
	configSearchText,
	groupConfigProperties,
	isCompactConfigField,
	isConfigValueModified,
	isHiddenConfigProperty,
	matchesConfigFilter,
	orderConfigFields,
	readConfigSections,
} from '../../browser/pluginConfigLayout.js';

const POCKET_MANIFEST_REL = 'extensions/saros-pocket/package.json';

/**
 * 把 pocket 的 manifest 读成属性列表。
 *
 * ★ `group` 只在 manifest 用**数组形态**（真正的多 section）时才有意义：
 *   单对象形态的 `title` 是「配置区显示名」（如 "Saros Pocket"），不是分组标题 ——
 *   若把它当成每个属性的分组，就会把所有项塞进一个组，分组等于失效。
 */
function readPocketManifest(): { props: IConfigPropertyLike[]; declaresSections: boolean } {
	const abs = path.join(process.cwd(), POCKET_MANIFEST_REL);
	assert.ok(fs.existsSync(abs), `找不到 pocket manifest（路径基准变了？）：${abs}`);
	const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
	const raw = pkg?.contributes?.configuration;
	const sections = readConfigSections(raw);
	assert.ok(sections.length > 0, 'pocket 必须声明 contributes.configuration');
	const declaresSections = Array.isArray(raw);
	const props: IConfigPropertyLike[] = [];
	for (const section of sections) {
		for (const [key, schema] of Object.entries(section.properties ?? {})) {
			const s = schema as Record<string, unknown>;
			props.push({
				key,
				type: String(s.type ?? 'string'),
				default: s.default,
				description: typeof s.description === 'string' ? s.description : undefined,
				markdownDescription: typeof s.markdownDescription === 'string' ? s.markdownDescription : undefined,
				action: typeof s['x-action'] === 'string' ? s['x-action'] as string : undefined,
				actionLabel: typeof s['x-actionLabel'] === 'string' ? s['x-actionLabel'] as string : undefined,
				readOnly: s['x-readonly'] === true,
				group: declaresSections ? section.title : undefined,
				groupDescription: typeof (section as { description?: unknown }).description === 'string'
					? String((section as { description?: unknown }).description) : undefined,
				groupIcon: typeof (section as { 'x-icon'?: unknown })['x-icon'] === 'string'
					? String((section as { 'x-icon'?: unknown })['x-icon']) : undefined,
				advanced: s['x-advanced'] === true,
			});
		}
	}
	return { props, declaresSections };
}

const pocket = readPocketManifest();
/** 去掉 section 标题：用于验证**兜底分组**（不依赖扩展是否声明 section）。 */
const pocketNoGroups = pocket.props.map(p => ({ ...p, group: undefined }));

suite('pluginConfigLayout · contributes.configuration 归一化', () => {

	test('对象形态与数组形态都收敛为 section 列表（数组保留声明顺序）', () => {
		const one = readConfigSections({ title: 'A', properties: { a: { type: 'boolean' } } });
		assert.strictEqual(one.length, 1);
		assert.strictEqual(one[0].title, 'A');

		const many = readConfigSections([
			{ title: '连接', properties: {} },
			{ title: '开关', properties: {} },
		]);
		assert.deepStrictEqual(many.map(s => s.title), ['连接', '开关'], '数组形态的顺序必须保留 —— 那是作者可控的分组顺序');
	});

	test('脏数据不炸：null / 字符串 / 数组里混入 null', () => {
		assert.deepStrictEqual(readConfigSections(null), []);
		assert.deepStrictEqual(readConfigSections('nope'), []);
		assert.deepStrictEqual(readConfigSections([null as never, { properties: {} }]).length, 1);
	});
});

suite('pluginConfigLayout · 分组（pocket 真实 manifest）', () => {

	test('不丢项、不重复：每个可见属性恰好落在一个分组里', () => {
		const groups = groupConfigProperties(pocket.props);
		const visible = pocket.props.filter(p => !isHiddenConfigProperty(p));
		const grouped = groups.flatMap(g => g.props);

		assert.strictEqual(grouped.length, visible.length, `分组后项数必须一致（${grouped.length} vs ${visible.length}）`);
		assert.strictEqual(new Set(grouped.map(p => p.key)).size, visible.length, '不得有属性出现在两个分组里');
		for (const p of visible) {
			assert.ok(grouped.includes(p), `${p.key} 丢了`);
		}
	});

	test('兜底分组：12 个 x-action 按钮独立成组，不再与输入项混排', () => {
		const groups = groupConfigProperties(pocketNoGroups);
		const actions = groups.find(g => g.kind === 'actions');
		assert.ok(actions, '应存在「操作」分组');
		assert.strictEqual(actions.props.length, 12, 'pocket 当前有 12 个按钮');
		assert.ok(actions.props.every(p => !!p.action), '按钮组里只能有 x-action 项');
		// 反向：其余分组不得混入按钮
		for (const g of groups.filter(g => g.kind !== 'actions')) {
			assert.ok(g.props.every(p => !p.action), `${g.id} 混进了按钮`);
		}
	});

	test('兜底分组：布尔开关进入紧凑分组（一行两个，省掉近 8 行高度）', () => {
		const groups = groupConfigProperties(pocketNoGroups);
		const switches = groups.find(g => g.kind === 'switches');
		assert.ok(switches, '应存在「开关」分组');
		assert.ok(switches.props.length >= 7, `pocket 的开关应聚在一起（实际 ${switches.props.length}）`);
		assert.ok(switches.props.every(p => isCompactConfigField(p)), '紧凑组里必须都是可紧凑的字段');
		assert.ok(switches.props.every(p => p.advanced !== true), '高级开关不该混进常规开关组（它们进「高级」）');
	});

	test('pocket 已用数组形态声明分组（作者可控的标题与顺序，详情页与原生设置页都会用）', () => {
		assert.strictEqual(pocket.declaresSections, true, 'pocket 的 configuration 应为数组形态的多个 section');
		const groups = groupConfigProperties(pocket.props);
		const declared = groups.filter(g => g.kind === 'declared');
		assert.ok(declared.length >= 4, `声明式分组太少（实际 ${declared.length} 组）`);
		assert.ok(groups.every(g => g.kind === 'declared' || g.kind === 'advanced' || g.kind === 'actions'),
			'只应有「声明式分组 + 操作组 + 高级聚合组」，不该再走兜底分桶');
		const titles = declared.map(g => g.title);
		assert.strictEqual(new Set(titles).size, titles.length, `标题不得重复：${titles.join(' / ')}`);
		for (const group of declared) {
			assert.ok(typeof group.description === 'string' && group.description.length > 0, `分组「${group.title}」缺副标题（右侧内容区第一行）`);
		}
	});

	test('动作按钮统一进「快速访问」组并排在**最前**（声明式分组也一样）', () => {
		const groups = groupConfigProperties(pocket.props);
		assert.strictEqual(groups[0].kind, 'actions', '第一个分组必须是操作组 —— 详情页据此把它作为「快速访问」页签');
		assert.strictEqual(groups[0].id, 'kind:actions');
		assert.strictEqual(groups[0].props.length, 12, 'pocket 的 12 个按钮都该在这里');
		assert.ok(groups[0].props.every(p => !!p.action));
		for (const group of groups.filter(g => g.kind !== 'actions')) {
			assert.ok(group.props.every(p => !p.action), `分组「${group.title ?? group.id}」里还留着按钮（应统一到快速访问）`);
		}
	});

	test('x-advanced 低频项聚成一个「高级」组，且排在最后、不混进常规分组', () => {
		const groups = groupConfigProperties(pocket.props);
		const advancedGroups = groups.filter(g => g.kind === 'advanced');
		assert.strictEqual(advancedGroups.length, 1, '应恰好有一个高级组');
		assert.strictEqual(groups[groups.length - 1].kind, 'advanced', '高级组必须排在最后（左栏底部入口）');
		const advancedProps = advancedGroups[0].props;
		assert.strictEqual(advancedProps.length, 8, `pocket 的高级项应为 8（实际 ${advancedProps.length}）`);
		assert.ok(advancedProps.every(p => p.advanced === true));
		for (const group of groups.filter(g => g.kind !== 'advanced')) {
			assert.ok(group.props.every(p => p.advanced !== true), `常规分组「${group.title}」混进了高级项`);
		}
		const advancedKeys = advancedProps.map(p => p.key).sort();
		assert.deepStrictEqual(advancedKeys, [
			'sarosPocket.connectionToken', 'sarosPocket.desktopMonitor', 'sarosPocket.desktopProcessName',
			'sarosPocket.launchPublicOnStart', 'sarosPocket.maxFileBytes', 'sarosPocket.proxyPort',
			'sarosPocket.upstreamPort', 'sarosPocket.userDataDir',
		], '高级项清单变了 —— 记得同步效果图与文档');
	});

	test('组内顺序：开关 → 值 → 只读 → 按钮（稳定，不改同类相对顺序）', () => {
		const props: IConfigPropertyLike[] = [
			{ key: 'p.action1', type: 'boolean', action: 'cmd' },
			{ key: 'p.value1', type: 'string' },
			{ key: 'p.switch1', type: 'boolean' },
			{ key: 'p.ro1', type: 'string', readOnly: true },
			{ key: 'p.value2', type: 'number' },
			{ key: 'p.switch2', type: 'boolean' },
		];
		assert.deepStrictEqual(orderConfigFields(props).map(p => p.key),
			['p.switch1', 'p.switch2', 'p.value1', 'p.value2', 'p.ro1', 'p.action1']);
		assert.deepStrictEqual(props.map(p => p.key), ['p.action1', 'p.value1', 'p.switch1', 'p.ro1', 'p.value2', 'p.switch2'], '不得原地改写入参');
	});

	test('字段种类判定：按钮 / 只读 / 开关 / 其他', () => {
		assert.strictEqual(configFieldKind({ key: 'a', type: 'boolean', action: 'cmd' }), 'action');
		assert.strictEqual(configFieldKind({ key: 'a', type: 'string', readOnly: true }), 'readonly');
		assert.strictEqual(configFieldKind({ key: 'a', type: 'boolean' }), 'switch');
		assert.strictEqual(configFieldKind({ key: 'a', type: 'number' }), 'value');
		assert.strictEqual(configFieldKind({ key: 'a', type: 'array' }), 'value');
	});

	test('只读派生值不与可编辑项混淆（x-readonly 单独归入展示组）', () => {
		const props: IConfigPropertyLike[] = [
			{ key: 'p.a', type: 'string' },
			{ key: 'p.loginStatus', type: 'string', readOnly: true },
			{ key: 'p.flag', type: 'boolean' },
		];
		const groups = groupConfigProperties(props);
		const flat = groups.flatMap(g => g.props);
		assert.deepStrictEqual(flat.map(p => p.key), ['p.flag', 'p.a', 'p.loginStatus'], '开关 → 可编辑 → 只读 的呈现顺序');
		assert.strictEqual(flat.find(p => p.key === 'p.loginStatus')!.readOnly, true);
	});

	test('只剩一个分组时不产生多余的分组标题（title 为 null）', () => {
		const groups = groupConfigProperties([{ key: 'a.x', type: 'string' }, { key: 'a.y', type: 'number' }]);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].title, null, '单组再套一层标题只是噪音');
	});

	test('扩展声明了 section 标题时以声明为准（含「无标题项」兜底到其他设置）', () => {
		const props: IConfigPropertyLike[] = [
			{ key: 'p.b', type: 'string', group: '第二组' },
			{ key: 'p.a', type: 'boolean', group: '第一组' },
			{ key: 'p.c', type: 'string', group: '第二组' },
			{ key: 'p.d', type: 'string' },
		];
		const groups = groupConfigProperties(props);
		assert.deepStrictEqual(groups.map(g => g.title), ['第二组', '第一组', null]);
		assert.deepStrictEqual(groups.map(g => g.kind), ['declared', 'declared', 'values']);
		assert.deepStrictEqual(groups[0].props.map(p => p.key), ['p.b', 'p.c'], '组内保持声明顺序');
		assert.deepStrictEqual(groups[2].props.map(p => p.key), ['p.d'], '没声明标题的排最后');
	});

	test('隐藏项（*.agentId / knot.models）不参与分组与计数', () => {
		const props: IConfigPropertyLike[] = [
			{ key: 'p.visible', type: 'string' },
			{ key: 'p.agentId', type: 'string' },
			{ key: 'knot.models', type: 'array' },
		];
		const groups = groupConfigProperties(props);
		assert.deepStrictEqual(groups.flatMap(g => g.props).map(p => p.key), ['p.visible']);
	});
});

suite('pluginConfigLayout · 改动检测 / 过滤', () => {

	test('未声明默认值一律视为未修改（不误报「已修改」）', () => {
		assert.strictEqual(isConfigValueModified('x', undefined), false);
		assert.strictEqual(isConfigValueModified(undefined, undefined), false);
	});

	test('标量按严格比较，数组按内容比较', () => {
		assert.strictEqual(isConfigValueModified(8000, 8000), false);
		assert.strictEqual(isConfigValueModified(8001, 8000), true);
		assert.strictEqual(isConfigValueModified(false, false), false);
		assert.strictEqual(isConfigValueModified('', ''), false);
		assert.deepStrictEqual(isConfigValueModified(['a', 'b'], ['a', 'b']), false);
		assert.strictEqual(isConfigValueModified(['a'], ['a', 'b']), true);
		// 顺序不同即视为不同（用户改过就提示，避免「看起来没变」的误判）
		assert.strictEqual(isConfigValueModified(['b', 'a'], ['a', 'b']), true);
	});

	test('过滤：键名、显示名、描述都可命中，多词是 AND', () => {
		const prop: IConfigPropertyLike = { key: 'sarosPocket.lanAuthEnabled', type: 'boolean', description: '局域网访问密码开关' };
		assert.strictEqual(matchesConfigFilter(prop, 'Lan Auth Enabled', ''), true, '空查询一律命中');
		assert.strictEqual(matchesConfigFilter(prop, 'Lan Auth Enabled', 'lan'), true, '按键名');
		assert.strictEqual(matchesConfigFilter(prop, 'Lan Auth Enabled', '局域网'), true, '按中文描述');
		assert.strictEqual(matchesConfigFilter(prop, 'Lan Auth Enabled', 'lan 密码'), true, '多词 AND');
		assert.strictEqual(matchesConfigFilter(prop, 'Lan Auth Enabled', 'lan tunnel'), false, '无关词不得命中');
		assert.ok(configSearchText(prop, 'Lan Auth Enabled').includes('sarosPocket.lanauthEnabled'.toLowerCase()));
	});
});
