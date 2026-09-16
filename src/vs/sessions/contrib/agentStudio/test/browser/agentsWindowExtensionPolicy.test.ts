/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * agents 窗口「原生扩展（VS Code 插件）」策略 —— 纯函数单测 + **源码级接线**断言。
 *
 * 为什么要两部分：
 *   · 纯函数部分保证**判据**正确（模式矩阵 / 通配 / 黑名单与必需名单优先级 / 宽容解析）；
 *   · 源码级部分保证**接线**没被绕过（判据再对，没人调用也等于没有）——
 *     这正是 `guardrailWiring.test.ts` 里那条元教训的做法。
 *
 * 背景与设计：`doc/native-extensions-in-agents-window-plan.md`（L0 = 本策略 + 设置，L1 = 「插件」视图的扩展 tab）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/agentsWindowExtensionPolicy.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	AGENT_PROVIDING_CONTRIBUTION_POINTS,
	AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING,
	AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING,
	AGENTS_WINDOW_EXTENSION_BLOCKLIST,
	AGENTS_WINDOW_EXTENSION_MODE_SETTING,
	AGENTS_WINDOW_EXTENSION_REQUIRED,
	AgentsWindowExtensionMode,
	DEFAULT_AGENTS_WINDOW_EXTENSION_POLICY,
	isAgentContributingContributionSet,
	isAgentsWindowExtensionMode,
	isAllowedToRunInAgentsWindow,
	matchesAnyExtensionPattern,
	matchesExtensionPattern,
	resolveAgentsWindowExtensionPolicy,
} from '../../../../../platform/extensionManagement/common/agentsWindowExtensionPolicy.js';
// ── 公网 gallery 配置的回归测试：直接拿 product.json 喂给真实服务实现 ──────────────
import { ExtensionGalleryManifestService } from '../../../../../platform/extensionManagement/common/extensionGalleryManifestService.js';
import { ExtensionGalleryManifestStatus, ExtensionGalleryResourceType, getExtensionGalleryManifestResourceUri } from '../../../../../platform/extensionManagement/common/extensionGalleryManifest.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';

const POLICY_MODULE_REL = 'src/vs/platform/extensionManagement/common/agentsWindowExtensionPolicy.ts';
const ENABLEMENT_SERVICE_REL = 'src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts';
const CONTRIBUTION_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
const PLUGINS_VIEW_REL = 'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts';
const MANIFEST_PROPS_REL = 'src/vs/workbench/services/extensions/common/extensionManifestPropertiesService.ts';
const PLATFORM_EXTENSIONS_REL = 'src/vs/platform/extensions/common/extensions.ts';
const AGENT_PLUGIN_DISCOVERY_REL = 'src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts';
const VIEWS_EXTENSION_POINT_REL = 'src/vs/workbench/api/browser/viewsExtensionPoint.ts';
const VIEW_DESCRIPTOR_SERVICE_REL = 'src/vs/workbench/services/views/browser/viewDescriptorService.ts';

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 只剥整行 `//` 注释（与 `guardrailWiring.test.ts` 的共用实现同口径，避免被自己的注释骗）。 */
function stripComments(src: string): string {
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 更严：先剥块注释再剥行注释 —— **仅**用于负向断言（「不得出现 X」）。 */
function stripAllComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

suite('agentsWindowExtensionPolicy — 纯函数', () => {

	test('宽容解析：默认 / 非法值一律回落到 declarative（绝不抛异常）', () => {
		for (const raw of [undefined, null, {}, { mode: 'nope' }, { mode: 42 }, { mode: null }]) {
			const policy = resolveAgentsWindowExtensionPolicy(raw as { mode?: unknown });
			assert.strictEqual(policy.mode, AgentsWindowExtensionMode.Declarative);
			assert.deepStrictEqual(policy.allowlist, []);
		}
		assert.deepStrictEqual(DEFAULT_AGENTS_WINDOW_EXTENSION_POLICY, {
			mode: AgentsWindowExtensionMode.Declarative,
			allowlist: [],
			allowAgentContributions: true,
		});
	});

	test('宽容解析：合法 mode 与 allowlist 过滤（非字符串 / 空白项被丢弃）', () => {
		assert.strictEqual(resolveAgentsWindowExtensionPolicy({ mode: 'allowlist' }).mode, AgentsWindowExtensionMode.Allowlist);
		assert.strictEqual(resolveAgentsWindowExtensionPolicy({ mode: 'all' }).mode, AgentsWindowExtensionMode.All);
		assert.deepStrictEqual(
			resolveAgentsWindowExtensionPolicy({ mode: 'allowlist', allowlist: ['a.b', 42, '', '   ', null, 'c.d'] }).allowlist,
			['a.b', 'c.d'],
		);
		assert.deepStrictEqual(resolveAgentsWindowExtensionPolicy({ allowlist: 'not-an-array' }).allowlist, []);
		assert.ok(isAgentsWindowExtensionMode('declarative') && isAgentsWindowExtensionMode('allowlist') && isAgentsWindowExtensionMode('all'));
		assert.ok(!isAgentsWindowExtensionMode('ALL') && !isAgentsWindowExtensionMode(undefined));
	});

	test('模式匹配：精确 / publisher.* / * / 大小写不敏感 / 空值', () => {
		assert.ok(matchesExtensionPattern('ms-python.python', 'ms-python.python'));
		assert.ok(matchesExtensionPattern('MS-Python.Python', 'ms-python.python'));
		assert.ok(matchesExtensionPattern('  ms-python.python  ', 'ms-python.python'));
		assert.ok(!matchesExtensionPattern('ms-python.black', 'ms-python.python'));
		assert.ok(matchesExtensionPattern('ms-python.*', 'ms-python.python'));
		assert.ok(!matchesExtensionPattern('ms-python.*', 'ms-vscode.cpptools'));
		assert.ok(matchesExtensionPattern('*', 'anything.at-all'));
		assert.ok(!matchesExtensionPattern('', 'a.b'));
		assert.ok(!matchesExtensionPattern('a.b', ''));
		assert.ok(matchesAnyExtensionPattern(['x.y', 'a.*'], 'a.b'));
		assert.ok(!matchesAnyExtensionPattern([], 'a.b'));
	});

	test('mode=declarative（默认）：只放行声明式 → **与上游行为逐字节一致**', () => {
		const policy = resolveAgentsWindowExtensionPolicy({ mode: 'declarative' });
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'ms-python.python', true), true);
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'ms-python.python', false), false);
		// 白名单在 declarative 模式下**不生效**（否则"默认=上游行为"就不成立了）
		assert.strictEqual(isAllowedToRunInAgentsWindow({ mode: AgentsWindowExtensionMode.Declarative, allowlist: ['ms-python.*'] }, 'ms-python.python', false), false);
	});

	test('mode=allowlist：白名单放行带代码扩展，未命中回落声明式判据', () => {
		const policy = resolveAgentsWindowExtensionPolicy({ mode: 'allowlist', allowlist: ['saros.tool-example', 'internal.*'] });
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'saros.tool-example', false), true, '精确白名单');
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'internal.secret-plugin', false), true, 'publisher.* 白名单');
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'other.extension', true), true, '未命中但属声明式');
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'other.extension', false), false, '未命中且带代码');
	});

	test('mode=all：除黑名单外全放行', () => {
		const policy = resolveAgentsWindowExtensionPolicy({ mode: 'all' });
		assert.strictEqual(isAllowedToRunInAgentsWindow(policy, 'any.extension', false), true);
		for (const blocked of AGENTS_WINDOW_EXTENSION_BLOCKLIST) {
			assert.strictEqual(isAllowedToRunInAgentsWindow(policy, blocked, false), false, `黑名单 ${blocked} 在任何模式下都不得放行`);
			assert.strictEqual(isAllowedToRunInAgentsWindow(policy, blocked.toUpperCase(), false), false, '黑名单匹配大小写不敏感');
		}
	});

	test('产品级必需名单：任何模式（含 declarative）都必须放行', () => {
		for (const mode of ['declarative', 'allowlist', 'all']) {
			for (const required of AGENTS_WINDOW_EXTENSION_REQUIRED) {
				assert.strictEqual(
					isAllowedToRunInAgentsWindow({ mode: mode as AgentsWindowExtensionMode, allowlist: [] }, required, false),
					true,
					`${required} 在 ${mode} 下必须放行（否则 TOF 认证 provider 不会注册）`,
				);
			}
		}
	});

	test('Agent 贡献型判定：至少一个 agent 贡献点，且其余全在（声明式 ∪ agent 贡献点）内', () => {
		const DECLARATIVE = new Set(['themes', 'grammars', 'languages', 'keybindings']);
		assert.deepStrictEqual([...AGENT_PROVIDING_CONTRIBUTION_POINTS].sort(), ['agentCapabilities', 'chatPlugins']);

		assert.strictEqual(isAgentContributingContributionSet(['agentCapabilities'], DECLARATIVE), true, '单 agent 点');
		assert.strictEqual(isAgentContributingContributionSet(['chatPlugins', 'themes'], DECLARATIVE), true, 'agent 点 + 声明式点');
		assert.strictEqual(isAgentContributingContributionSet(['agentCapabilities', 'chatPlugins'], DECLARATIVE), true, '两个 agent 点');

		assert.strictEqual(isAgentContributingContributionSet(['themes', 'grammars'], DECLARATIVE), false, '纯声明式 ≠ agent 贡献型');
		assert.strictEqual(isAgentContributingContributionSet([], DECLARATIVE), false, '无贡献点');
		assert.strictEqual(isAgentContributingContributionSet(['agentCapabilities', 'commands'], DECLARATIVE), false, '夹带非声明式贡献点 ⇒ 不享受本通道');
	});

	test('Agent 贡献型扩展：默认放行（两条桥才会触发），可显式关闭', () => {
		const on = resolveAgentsWindowExtensionPolicy({}); // 默认 allowAgentContributions = true
		assert.strictEqual(on.allowAgentContributions, true);

		assert.strictEqual(isAllowedToRunInAgentsWindow(on, 'acme.agent-provider', false, true), true, 'declarative 模式下默认放行');
		assert.strictEqual(isAllowedToRunInAgentsWindow({ ...on, mode: AgentsWindowExtensionMode.Allowlist }, 'acme.agent-provider', false, true), true, 'allowlist 模式同样放行');
		assert.strictEqual(isAllowedToRunInAgentsWindow(on, 'acme.ordinary-extension', false, false), false, '普通带代码扩展仍禁用');
		// 3 参调用（旧口径）必须保持原语义 —— 未显式声明为 agent 贡献型就不享受该通道
		assert.strictEqual(isAllowedToRunInAgentsWindow(on, 'acme.agent-provider', false), false);

		const off = resolveAgentsWindowExtensionPolicy({ allowAgentContributions: false });
		assert.strictEqual(off.allowAgentContributions, false);
		assert.strictEqual(isAllowedToRunInAgentsWindow(off, 'acme.agent-provider', false, true), false, '关闭后严格维持上游行为');
		// 关闭开关不影响黑名单/必需名单优先级
		assert.strictEqual(isAllowedToRunInAgentsWindow(off, 'saros.tof-authentication', false, false), true);
		assert.strictEqual(isAllowedToRunInAgentsWindow(off, 'GitHub.copilot', true, true), false);

		// 宽容解析：非布尔 → 按放行（默认值）
		assert.strictEqual(resolveAgentsWindowExtensionPolicy({ allowAgentContributions: 'nope' }).allowAgentContributions, true);
		assert.strictEqual(resolveAgentsWindowExtensionPolicy({ allowAgentContributions: 0 }).allowAgentContributions, true);

		// 手写字面量缺该字段 ⇒ 同样默认放行（不是 undefined / 不是 false）
		assert.strictEqual(
			isAllowedToRunInAgentsWindow({ mode: AgentsWindowExtensionMode.Declarative, allowlist: [] }, 'acme.agent-provider', false, true),
			true,
		);
	});
});

suite('agentsWindowExtensionPolicy — 接线（源码级不变量）', () => {

	test('设置键与名单是稳定契约（改键 = 破坏用户设置）', () => {
		const src = readSource(POLICY_MODULE_REL);
		assert.ok(src.includes(`'${AGENTS_WINDOW_EXTENSION_MODE_SETTING}'`), '设置键字面量必须是 saros.extensions.agentsWindow.mode');
		assert.ok(src.includes(`'${AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING}'`), '设置键字面量必须是 saros.extensions.agentsWindow.allowlist');
		assert.strictEqual(AGENTS_WINDOW_EXTENSION_MODE_SETTING, 'saros.extensions.agentsWindow.mode');
		assert.strictEqual(AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING, 'saros.extensions.agentsWindow.allowlist');
	});

	test('extensionEnablementService：sessions 窗口判定必须走策略（不得退回硬编码）', () => {
		const src = readSource(ENABLEMENT_SERVICE_REL);
		assert.ok(src.includes('resolveAgentsWindowExtensionPolicy('), '必须解析策略');
		assert.ok(src.includes('isAllowedToRunInAgentsWindow('), '必须调用纯函数判据');
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_MODE_SETTING'), '必须读模式设置');
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING'), '必须读白名单设置');
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_BLOCKLIST'), 'copilot 黑名单必须集中到策略模块（单一真源）');
		assert.ok(src.includes('onDidChangeConfiguration'), '策略变化必须触发 enablement 重算');

		// 负向：旧的硬编码数组名不得复活（否则名单会重新出现两份、漂移）
		const bare = stripAllComments(src);
		assert.ok(!bare.includes('VSSAROS_SESSIONS_WINDOW_REQUIRED_EXTENSIONS'), '已迁移到策略模块的 REQUIRED 名单不得再在服务里硬编码');
		assert.ok(!bare.includes('VSSAROS_DISABLED_EXTENSIONS'), '已迁移到策略模块的 BLOCKLIST 不得再在服务里硬编码');
	});

	test('设置已注册（否则设置 UI 看不到、无补全）', () => {
		const src = readSource(CONTRIBUTION_REL);
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_MODE_SETTING'), 'mode 设置必须注册');
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING'), 'allowlist 设置必须注册');
		assert.ok(src.includes(`'declarative'`) && src.includes(`'allowlist'`) && src.includes(`'all'`), 'enum 三档必须齐全');
	});

	test('pluginsView：「扩展」tab 用服务层数据，且**没有**引入上游扩展视图容器（L1 路线不变量）', () => {
		const src = readSource(PLUGINS_VIEW_REL);
		assert.ok(src.includes('IExtensionsWorkbenchService'), '扩展 tab 必须用服务层数据源');
		assert.ok(src.includes('this.extensionsWorkbenchService.local'), '必须读 .local 列表');
		assert.ok(src.includes('_renderExtensions('), '必须有扩展 tab 渲染');
		assert.ok(src.includes('_installVsixFromUri('), '必须有 VSIX 安装出口（gallery 未配置时的唯一安装路径）');
		assert.ok(src.includes('_pickVsixAndInstall('), '必须有本地 VSIX 入口');
		assert.ok(src.includes('_installVsixFromUrl('), '必须有从 URL 安装 VSIX 的入口（内网分发，L4）');
		assert.ok(src.includes('plugins-extensions-container'), '必须有独立的扩展 tab 容器');

		const bare = stripAllComments(src);
		assert.ok(!bare.includes('extensions/browser/extensionsViewlet'), 'L1 不引入上游扩展视图容器（引了就会连带 25 个原生视图）');
	});

	test('「Agent 贡献型扩展」开关已注册', () => {
		const src = readSource(CONTRIBUTION_REL);
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING'), 'allowAgentContributions 设置必须注册');
		assert.strictEqual(AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING, 'saros.extensions.agentsWindow.allowAgentContributions');
	});

	test('声明式允许集：必须导出且含两个 Agent 桥贡献点（否则 L2 白名单不完整）', () => {
		const src = readSource(MANIFEST_PROPS_REL);
		assert.ok(src.includes('export const SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS'), '允许集必须导出（供服务/策略复用）');
		assert.ok(src.includes(`'agentCapabilities'`), 'agentCapabilities 必须在允许集内');
		assert.ok(src.includes(`'chatPlugins'`), 'chatPlugins 必须在允许集内');
	});

	test('类型契约：IExtensionContributions 必须声明 agentCapabilities（否则允许集里写它会编译失败）', () => {
		const src = readSource(PLATFORM_EXTENSIONS_REL);
		assert.ok(src.includes('agentCapabilities?:'), 'IExtensionContributions 必须声明 agentCapabilities');
		assert.ok(src.includes('IAgentCapabilityContribution'), '必须定义该贡献点的结构类型');
	});

	test('enablement：判定必须把「Agent 贡献型」算进来（否则桥永远不触发）', () => {
		const src = readSource(ENABLEMENT_SERVICE_REL);
		assert.ok(src.includes('isAgentContributingContributionSet('), '必须计算 agent 贡献型');
		assert.ok(src.includes('SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS'), '必须用导出的声明式允许集');
		assert.ok(src.includes('AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING'), '必须读新设置');
		assert.ok(src.includes('isAllowedToRunInAgentsWindow(policy, extension.identifier.id, isDeclarativeAllowed, isAgentContributing)'), '必须把 agent 贡献型传给判据');
	});

	test('卸载扩展型插件不得依赖 agents 窗口里不存在的命令（否则"删除"静默失败）', () => {
		const src = readSource(AGENT_PLUGIN_DISCOVERY_REL);
		assert.ok(src.includes('_extensionsWorkbenchService'), '必须走 IExtensionsWorkbenchService（两个窗口都已注册）');
		assert.ok(src.includes('this._extensionsWorkbenchService.uninstall('), '必须调用 uninstall');

		const bare = stripAllComments(src);
		assert.ok(
			!bare.includes(`'workbench.extensions.uninstallExtension'`),
			'不得再用 workbench.extensions.uninstallExtension 命令：它在 agents 窗口未注册（extensions.contribution 未加载）',
		);
	});

	test('L4：从 URL 安装 VSIX 走流式下载通道 + 地址校验（不经 IPC 搬二进制）', () => {
		const src = readSource(PLUGINS_VIEW_REL);
		assert.ok(src.includes(`'marketplace.downloadToFile'`), '必须复用商城的流式下载通道（扩展宿主 Node 直接落盘）');
		assert.ok(src.includes('/^https?:\\/\\/\\S+\\.vsix$/i'), '必须先校验 http(s)://…vsix 地址');
		assert.ok(src.includes('statusCode >= 400'), '下载失败必须中止，不得继续安装');
		assert.ok(src.includes('userDataRootFromRoamingHome('), '临时文件落在 Saros 数据目录（与商城同一约定）');
		assert.ok(src.includes('extensionsWorkbenchService.install('), '最终必须走 IExtensionsWorkbenchService.install');

		// 负向：不得为此自建 HTTP 通道（商城刻意用扩展宿主流式落盘，避免二进制过 IPC）
		const bare = stripAllComments(src);
		assert.ok(!bare.includes('IRequestService'), '不应自建 HTTP 通道');
	});

	test('搜索框必须支持市场搜索（gallery 未配置时不发请求 + 自建商城兜底 + 明确提示）', () => {
		const src = readSource(PLUGINS_VIEW_REL);
		assert.ok(src.includes('queryGallery('), '必须调用 IExtensionsWorkbenchService.queryGallery');
		assert.ok(src.includes('extensionGalleryManifestStatus'), '必须先查 gallery 状态');
		assert.ok(src.includes('ExtensionGalleryManifestStatus.Available'), '必须用 Available 判定');
		assert.ok(src.includes('_scheduleMarketSearch('), '必须有防抖调度（逐字请求会浪费且乱序）');
		assert.ok(src.includes('listPackages({ q: query'), 'Saros 商城要同一次搜索里也查（双来源）');
		assert.ok(src.includes('_createMarketInstallCard(') && src.includes('_installFromGallery('), '市场结果必须可一键安装');
		assert.ok(src.includes('CancellationTokenSource'), '必须可取消（防旧结果覆盖新结果）');
		assert.ok(src.includes('marketNotConfigured'), '未配置 gallery 必须给可执行提示');

		// 负向：gallery 请求必须在"可用性"分支内（无 gallery 时不发请求）
		const bare = stripAllComments(src);
		assert.ok(/if \(this\._isGalleryAvailable\(\)\) \{/.test(bare), 'queryGallery 必须在 _isGalleryAvailable() 分支内');
	});

	test('L3：扩展贡献的容器/视图按**同一策略**写 windowEnablement（不改全局语义）', () => {
		const src = readSource(VIEWS_EXTENSION_POINT_REL);
		assert.ok(src.includes('resolveExtensionWindowEnablement('), '必须按策略计算');
		assert.ok(
			/if \(!this\.environmentService\.isSessionsWindow\) \{\s*return undefined;/.test(src),
			'非 agents 窗口必须早退且返回 undefined（上游行为不变，绝不能返回 Editor）',
		);
		assert.ok(src.includes('windowEnablement,'), '容器描述符必须写入该字段');
		assert.ok(src.includes('windowEnablement: this.resolveExtensionWindowEnablement(extension.description)'), '视图描述符必须写入该字段');
		assert.ok(src.includes('WindowEnablement.Both') && src.includes('WindowEnablement.Editor'), '放行 = Both / 否则 = Editor');
		// 判据必须与 enablement 服务**同源**（同一策略 + 同一上游声明式允许集），否则会出现
		// 「扩展被禁用但视图仍占着 activitybar」的自相矛盾状态
		assert.ok(src.includes('isAgentContributingContributionSet('), '必须复用 agent 贡献型判定');
		assert.ok(src.includes('SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS'), '必须复用导出的声明式允许集');
		assert.ok(src.includes('canExecuteOnSessionsWindow('), '必须复用上游"声明式"判定');

		// 负向：不得为图省事把 viewDescriptorService 的会话窗口语义改成"undefined 也算可见" ——
		// 那会一次性放开**所有**未标注 windowEnablement 的容器（含大量内置容器），无法按扩展粒度控制。
		const vds = readSource(VIEW_DESCRIPTOR_SERVICE_REL);
		assert.ok(
			vds.includes('return enablement === WindowEnablement.Sessions || enablement === WindowEnablement.Both;'),
			'会话窗口的可见性判定必须仍是「只认 Sessions | Both」',
		);
	});
});

suite('extensionsGallery — 公网扩展市场配置（product.json）', () => {

	const PRODUCT_JSON_REL = 'product.json';

	function readProduct(): { extensionsGallery?: Record<string, string> } & Record<string, unknown> {
		return JSON.parse(fs.readFileSync(path.join(process.cwd(), PRODUCT_JSON_REL), 'utf8'));
	}

	test('product.json 必须配置 extensionsGallery（否则 agents 窗口搜不了市场）', () => {
		const gallery = readProduct().extensionsGallery;
		assert.ok(
			gallery,
			'必须配置 extensionsGallery：`ExtensionGalleryManifestService.extensionGalleryManifestStatus` 只看 `extensionsGallery.serviceUrl`',
		);
		assert.ok(gallery.serviceUrl?.startsWith('https://'), `serviceUrl 必须是 https（当前：${gallery.serviceUrl}）`);
		assert.ok(gallery.itemUrl && gallery.publisherUrl, 'itemUrl / publisherUrl 缺失会导致「详情 / 发布者」链接失效');
		assert.ok(gallery.resourceUrlTemplate, 'resourceUrlTemplate 缺失时扩展资源（读我文件、图标等）无法按 gallery 资源加载');
		// 占位符契约：必须与 extensionResourceLoader.getExtensionGalleryResourceURL() 的 format2 入参一一对应
		for (const placeholder of ['{publisher}', '{name}', '{version}', '{path}']) {
			assert.ok(gallery.resourceUrlTemplate.includes(placeholder), `resourceUrlTemplate 必须含 ${placeholder}`);
		}
	});

	test('服务层能从该配置推出 Available 状态与 query 端点（判据与实现同源）', async () => {
		const product = readProduct();
		const service = new ExtensionGalleryManifestService(product as unknown as IProductService);

		assert.strictEqual(service.extensionGalleryManifestStatus, ExtensionGalleryManifestStatus.Available, '状态必须是 Available');

		const manifest = await service.getExtensionGalleryManifest();
		assert.ok(manifest, 'gallery manifest 不应为 null');
		assert.strictEqual(
			getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionQueryService),
			`${product.extensionsGallery!.serviceUrl}/extensionquery`,
			'query 端点必须由 serviceUrl 推出（`queryGallery` 打的就是它）',
		);
		assert.strictEqual(
			getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionResourceUri),
			product.extensionsGallery!.resourceUrlTemplate,
			'扩展资源端点必须等于 resourceUrlTemplate',
		);
	});
});
