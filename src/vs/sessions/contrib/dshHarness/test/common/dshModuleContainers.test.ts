/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	DSH_ALWAYS_REGISTERED_CONTAINERS, DSH_BUILTIN_MODULES, DSH_MODULE_CONTAINERS, DSH_MODULE_PAGES, DshModuleId, IPluginWithManifest,
	activeModulesFromPlugins, activeModulesOf, containersFromPlugins, defaultPageRoute, moduleContainerOf, moduleContextKey, moduleIdForPluginName, pageRouteForActiveModules, pagesFromPlugins, planModuleContainers, resolveContainerPageState, withWorkbenchClient,
} from '../../common/dshModuleContainers.js';

suite('dshModuleContainers（容器聚合与注册计划）', () => {

	test('模块表不变量：包名唯一、容器不重叠常驻集合、聚合容器依赖非空', () => {
		const names = DSH_BUILTIN_MODULES.map(m => m.pluginName);
		assert.strictEqual(new Set(names).size, names.length, '内置模块包名必须唯一');

		for (const c of DSH_MODULE_CONTAINERS) {
			assert.ok(c.modules.length > 0, `${c.containerId} 必须至少依赖一个模块`);
			assert.ok(!DSH_ALWAYS_REGISTERED_CONTAINERS.includes(c.containerId),
				`${c.containerId} 同时在常驻集合与模块容器表里：两套机制会争同一个容器`);
		}
		const ids = DSH_MODULE_CONTAINERS.map(c => c.containerId);
		assert.strictEqual(new Set(ids).size, ids.length, '容器 ID 必须唯一');

		// 决议① 剩下的共容器实例（integration = skills + mcp）必须是聚合语义
		const integration = DSH_MODULE_CONTAINERS.find(c => c.containerId === 'agentStudio.integration');
		assert.deepStrictEqual([...(integration?.modules ?? [])].sort(), ['mcp', 'skills']);
		// 2026-11-03：memory 改为内置插件（@vssaros/dsh-memory，会话页记忆 Tab）。
		// 内置模块表必须登记它（启动补登记 bundles），但活动栏容器与 /x/memory/ 整页不复活。
		const kb = DSH_MODULE_CONTAINERS.find(c => c.containerId === 'agentStudio.knowledgeBase');
		assert.deepStrictEqual([...(kb?.modules ?? [])], ['kb'], 'kb 容器现在只由 kb 决定可见性');
		assert.ok(DSH_BUILTIN_MODULES.some(m => m.module === 'memory' && m.pluginName === '@vssaros/dsh-memory'),
			'memory 必须登记为内置模块，否则启动时不会被补进 bundles');
		assert.ok(!DSH_MODULE_CONTAINERS.some(c => c.containerId === 'agentStudio.memory'), '旧记忆库独立容器不应复活');
		assert.ok(!DSH_MODULE_CONTAINERS.some(c => c.modules.includes('memory')), 'memory 不占活动栏容器');
		assert.ok(!DSH_MODULE_PAGES.some(p => p.module === 'memory'), 'memory 没有 /x/memory/ 整页');
	});

	test('容器反查与默认页面路由（决议③ / 13.3 约定）', () => {
		for (const c of DSH_MODULE_CONTAINERS) {
			assert.strictEqual(defaultPageRoute(c), `/x/${c.modules[0]}/`, `${c.containerId} 的默认路由`);
			assert.strictEqual(moduleContainerOf(c.containerId), c);
		}
		assert.strictEqual(defaultPageRoute(moduleContainerOf('agentStudio.integration')), '/x/skills/', '共容器取首个依赖模块');
		assert.throws(() => moduleContainerOf('agentStudio.nope'), /未知的模块容器/);
	});

	test('★★ 容器页路由按**已激活且有页面**的模块选（不是"声明的第一个"）', () => {
		const integration = moduleContainerOf('agentStudio.integration');
		const kb = moduleContainerOf('agentStudio.knowledgeBase');

		// 常规：首个模块激活 ⇒ 用它（与既有行为一致）
		assert.deepStrictEqual(pageRouteForActiveModules(integration, ['skills']), { module: 'skills', kind: 'page', route: '/x/skills/' });
		assert.deepStrictEqual(pageRouteForActiveModules(kb, ['kb']), { module: 'kb', kind: 'page', route: '/x/kb/' });

		// ★ 真问题（这一站修的就是它）：只装了同容器里的**另一个**模块
		//   旧行为 = `defaultPageRoute()` = `/x/skills/`，而 skills 没装 ⇒ 面板必然 404。
		//   mcp 现在自带一个**只读片段**（`@vssaros/dsh-mcp`：挂了什么 / 跳过什么 / 为什么），
		//   所以只有 mcp 时落在它自己的片段路由上——与 memory 同一条规则（片段也是可服务的 HTML，比空白强）。
		assert.deepStrictEqual(pageRouteForActiveModules(integration, ['mcp']), { module: 'mcp', kind: 'section', route: '/x/mcp/section' },
			'只有 mcp 时用它自己的片段路由');
		// 2026-11-03：memory 模块整套下线 ⇒ 不再是任何容器的候选，记忆库自己的容器也已移除。
		assert.strictEqual(pageRouteForActiveModules(kb, ['memory']), undefined, 'memory 已下线，对 kb 不再是候选');
		// 两个都在时：**page 优先**（skills 是整页，mcp 的片段内嵌在它里面）
		assert.deepStrictEqual(pageRouteForActiveModules(integration, ['skills', 'mcp']), { module: 'skills', kind: 'page', route: '/x/skills/' });

		// 都没激活 / 空容器输入 ⇒ 没有页面
		assert.strictEqual(pageRouteForActiveModules(integration, []), undefined);
		assert.strictEqual(pageRouteForActiveModules(kb, ['kanban', 'agents']), undefined, '别的容器的模块激活与本容器无关');

		// 状态口径（说明文案的数据源）：各模块的激活与路由一目了然
		// 2026-10-12（「资料库」拆分）：kb 容器现在只有一个模块 —— 传 ['memory'] 也不会命中它。
		const state = resolveContainerPageState(kb, ['kb', 'memory']);
		assert.strictEqual(state.page?.module, 'kb');
		assert.deepStrictEqual(state.modules, [
			{ module: 'kb', active: true, route: '/x/kb/' },
		]);
	});

	test('withWorkbenchClient：只给"已启用 + module 对得上 + workbenchClient"的模块页打标记', () => {
		const kb = DSH_MODULE_CONTAINERS.find(c => c.modules.includes('kb'))!;
		const state = resolveContainerPageState(kb, ['kb']);
		const manifest = { manifestVersion: 1 as const, module: 'kb', view: { kind: 'page' as const, route: '/x/kb/' } };
		assert.strictEqual(withWorkbenchClient(state, [{ name: '@vssaros/dsh-kb', manifest, workbenchClient: true }]).page?.workbenchClient, true);
		assert.strictEqual(withWorkbenchClient(state, [{ name: '@vssaros/dsh-kb', manifest }]).page?.workbenchClient, undefined);
		assert.strictEqual(withWorkbenchClient(state, [{ name: '@vssaros/dsh-kb', manifest, workbenchClient: true, enabled: false }]).page?.workbenchClient, undefined);
		assert.strictEqual(withWorkbenchClient(state, [{ name: '@vssaros/dsh-x', manifest: { ...manifest, module: 'memory' }, workbenchClient: true }]).page?.workbenchClient, undefined);
		assert.strictEqual(withWorkbenchClient(state, []), state, '没有可标记的 ⇒ 原样返回');
	});

	test('页面表的不变量：覆盖所有容器模块、page/section 有路由、native/none 没有路由', () => {
		const modules = new Set(DSH_MODULE_PAGES.map(p => p.module));
		const pageOf = (module: string) => DSH_MODULE_PAGES.find(p => p.module === module);
		for (const container of DSH_MODULE_CONTAINERS) {
			for (const module of container.modules) {
				assert.ok(modules.has(module), `${container.containerId} 的模块 ${module} 不在 DSH_MODULE_PAGES 里（页面解析会拿不到它）`);
			}
			// 每个容器至少要有**一个**能出内容的模块（有页面路由的 page/section，或 native 原生视图）：
			// 否则"图标可见但点开永远空"。⚠ 2026-10-30：native 模块也算（判据见下）；
			//   2026-11-03 起唯一的 native 模块（agents 侧栏 roster）已随 Bots 工作台下线。
			assert.ok(container.modules.some(m => {
				const p = pageOf(m);
				return !!p?.route || p?.kind === 'native';
			}), `${container.containerId} 的模块里没有任何一个提供页面/原生视图`);
		}
		for (const page of DSH_MODULE_PAGES) {
			if (page.kind === 'native') {
				// 原生视图由 VsSaros 自绘 ⇒ 没有页面路由；数据来源在清单 view.data.route。
				assert.strictEqual(page.route, undefined, `${page.module} 是 native 视图，不该记页面路由`);
				continue;
			}
			if (page.kind === 'none') {
				assert.strictEqual(page.route, undefined, `${page.module} 是无页面模块，不该有 route`);
				continue;
			}
			// ⚠ 2026-10-28：字符集要与**模块 id** 对齐 —— `xhs-note` 是合法模块 id，
		//   `defaultPageRoute()` 对它的推导就是 `/x/xhs-note/`；原先只认 `[a-z]+` 会把连字符判红
		//   （现有带连字符的 `web-content-import` 恰好 kind=none 没有路由，所以一直没暴露）。
		assert.match(String(page.route), /^\/x\/[a-z][a-z0-9-]*\//, `${page.module} 的 route 不合法：${String(page.route)}`);
			if (page.kind === 'section') {
				assert.ok(page.host, `section 模块 ${page.module} 必须记下宿主模块`);
				assert.notStrictEqual(page.host, page.module, `section 模块 ${page.module} 的宿主不能是自己`);
			}
		}
	});

	test('模块反查与激活集合', () => {
		assert.strictEqual(moduleIdForPluginName('@vssaros/dsh-kanban'), 'kanban');
		assert.strictEqual(moduleIdForPluginName(' @vssaros/dsh-kb '), 'kb');
		assert.strictEqual(moduleIdForPluginName('@acme/dsh-graph-viewer'), undefined);
		assert.strictEqual(moduleIdForPluginName('@vssaros/dsh-bridge'), undefined);
		assert.deepStrictEqual(activeModulesOf(['@vssaros/dsh-mcp', '@acme/x', '@vssaros/dsh-kanban']), ['mcp', 'kanban']);
		assert.strictEqual(moduleContextKey('kanban'), 'vssaros.dsh.plugin.kanban.active');
	});

	test('engine=legacy：空计划（静态注册是唯一写者）', () => {
		const plan = planModuleContainers({
			engine: 'legacy',
			installedPlugins: ['@vssaros/dsh-kanban'],
			registeredContainerIds: ['agentStudio.tasks'],
		});
		assert.deepStrictEqual(plan.registrations, []);
		assert.deepStrictEqual(plan.deregistrations, []);
		assert.deepStrictEqual(plan.contextKeys, {});
	});

	test('engine=dsh：已装插件 → 注册容器；未装 → 注销已注册容器', () => {
		const plan = planModuleContainers({
			engine: 'dsh',
			installedPlugins: ['@vssaros/dsh-kanban'],
			registeredContainerIds: ['agentStudio.workflow', 'agentStudio.tasks'],
		});
		// ★ 2026-11-03：agents 不再有模块容器（Bots 工作台下线）⇒ 计划里不会再出现 agentStudio.presetAgent
		assert.deepStrictEqual(plan.activeModules, ['kanban']);
		assert.deepStrictEqual(plan.registrations, []);
		assert.deepStrictEqual(plan.deregistrations, ['agentStudio.workflow']);
		assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.kanban.active'], true);
		assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.workflow.active'], false);
	});

	test('聚合容器：任一依赖激活即显示；最后一个停用即注销', () => {
		const onlyMcp = planModuleContainers({
			engine: 'dsh', installedPlugins: ['@vssaros/dsh-mcp'], registeredContainerIds: [],
		});
		assert.deepStrictEqual(onlyMcp.registrations.map(c => c.containerId), ['agentStudio.integration']);

		// 真实存在的那个依赖（@vssaros/dsh-skills 已落地）：单独装着它就该点亮共容器
		const onlySkills = planModuleContainers({
			engine: 'dsh', installedPlugins: ['@vssaros/dsh-skills'], registeredContainerIds: [],
		});
		assert.deepStrictEqual(onlySkills.registrations.map(c => c.containerId), ['agentStudio.integration']);
		assert.strictEqual(onlySkills.contextKeys['vssaros.dsh.plugin.skills.active'], true);
		assert.strictEqual(onlySkills.contextKeys['vssaros.dsh.plugin.mcp.active'], false);

		// 2026-11-03：memory 下线后，这段只保留「已注册且仍激活 → 不重复注册」的语义，
		// 用 kb 顶替原 memory 的 fixture 角色（原来那条「只装 memory 要注销 kb」已无意义）。
		const both = planModuleContainers({
			engine: 'dsh', installedPlugins: ['@vssaros/dsh-skills', '@vssaros/dsh-mcp', '@vssaros/dsh-kb'],
			registeredContainerIds: ['agentStudio.integration', 'agentStudio.knowledgeBase'],
		});
		assert.deepStrictEqual(both.registrations, [], '已注册且仍激活 → 不重复注册');
		assert.ok(!both.deregistrations.includes('agentStudio.knowledgeBase'), '仍激活的知识库容器不许被注销');

		const noneLeft = planModuleContainers({
			engine: 'dsh', installedPlugins: [], registeredContainerIds: ['agentStudio.integration', 'agentStudio.knowledgeBase'],
		});
		assert.deepStrictEqual(noneLeft.deregistrations, ['agentStudio.integration', 'agentStudio.knowledgeBase']);
	});

	test('停用（插件中心开关）：已装但停用 = 不激活 → 注销容器 + 上下文键 false', () => {
		const plan = planModuleContainers({
			engine: 'dsh',
			installedPlugins: ['@vssaros/dsh-kanban', '@vssaros/dsh-mcp'],
			disabledPlugins: ['@vssaros/dsh-kanban'],
			registeredContainerIds: ['agentStudio.tasks', 'agentStudio.integration'],
		});
		assert.deepStrictEqual(plan.activeModules, ['mcp']);
		assert.deepStrictEqual(plan.deregistrations, ['agentStudio.tasks'], '停用的模块容器要注销');
		assert.deepStrictEqual(plan.registrations, [], '聚合容器仍激活 → 不重复注册');
		assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.kanban.active'], false);
		assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.mcp.active'], true);

		// 停用全部依赖 → 共容器整体注销
		const off = planModuleContainers({
			engine: 'dsh', installedPlugins: ['@vssaros/dsh-skills', '@vssaros/dsh-mcp'],
			disabledPlugins: ['@vssaros/dsh-skills', '@vssaros/dsh-mcp'],
			registeredContainerIds: ['agentStudio.integration'],
		});
		assert.deepStrictEqual(off.deregistrations, ['agentStudio.integration']);
	});

	test('★ 代码库容器：只装 codebase 插件也会注册（2026-10-12 由 page-only 升为 existing）', () => {
		// 历史：客户端接线完成后它从 planned 升为 page-only（动态侧注册 page 宿主，legacy 侧没有对应视图
		// —— 那儿的 graphView 是 Git 历史图）。
		// 2026-10-12（「资料库」拆分第一刀）：它被提升为「代码库」工作台 ⇒ **两种引擎下都要有入口**，
		// 所以 status 变 `existing`，静态侧现在**必须**有 `CodebaseLibraryViewPane`（由
		// `dshActivityBarSource.test.ts` 的表驱动三分断言把住）。
		const plan = planModuleContainers({
			engine: 'dsh', installedPlugins: ['@vssaros/dsh-codebase'], registeredContainerIds: [],
		});
		assert.deepStrictEqual(plan.registrations.map(c => c.containerId), ['vssaros.dsh.codebase']);
		assert.deepStrictEqual(plan.pending, [], '有页面的容器不该进 pending');
		assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.codebase.active'], true);
		assert.strictEqual(moduleContainerOf('vssaros.dsh.codebase').status, 'existing', '代码库两种引擎下都有入口');
	});

	test('常驻项（workspace / search / plugins / scm / 会话历史）永不出现在计划里', () => {
		const plan = planModuleContainers({
			engine: 'dsh',
			installedPlugins: DSH_BUILTIN_MODULES.map(m => m.pluginName),
			registeredContainerIds: [...DSH_ALWAYS_REGISTERED_CONTAINERS],
		});
		for (const always of DSH_ALWAYS_REGISTERED_CONTAINERS) {
			assert.ok(!plan.registrations.some(c => c.containerId === always), `${always} 不应被模块计划注册`);
			assert.ok(!plan.deregistrations.includes(always), `${always} 不应被模块计划注销`);
		}
		// 全部模块都装了：所有容器都应注册（含 page-only 的代码图谱）；当前没有 planned 容器
		assert.deepStrictEqual(plan.registrations.map(c => c.containerId).sort(),
			// ★ 2026-11-03：`agentStudio.presetAgent`（Bots 工作台）已下线 ⇒ 从期望集合里删掉
			['agentStudio.dashboard', 'agentStudio.integration', 'agentStudio.knowledgeBase', 'agentStudio.media', 'agentStudio.tasks', 'agentStudio.workflow',
				// `vssaros.dsh.*` 自建容器：代码库 2026-10-12 起是 `existing`（两种引擎都有）；历史会话 dsh 页
				// 2026-10-12 新增，`page-only`（legacy 侧的历史会话是**另一个**常驻容器 `sessionHistory.view`，两者并存）。
				// （画布模块已于 2026-10-15 移除 —— `.canvas` 文件仍走 legacy **编辑器**，不受影响 ✓）
				// `vssaros.dsh.scheduler`：定时任务（重构 2.1，page-only —— legacy 调度器从不执行，无静态对应物）。
				// `vssaros.dsh.imagegen`：生图 / 画布工作台（2026-10-21，page-only —— legacy 侧没有画布引擎）。
				// `vssaros.dsh.marketplace`：自营商城工作台（2026-10-22，page-only —— 商城认证与安装链在 IDE/dsh 侧）。
				// `vssaros.dsh.studio`：萨罗斯管理平台（2026-10-23，page-only —— 站点 iframe 只在 dsh 侧）。
				// ★ 2026-10-30：`vssaros.dsh.relay`（萨罗斯中转站）已移除 ⇒ 从期望集合里删掉。
				// ★ 2026-10-31：`vssaros.dsh.parallel`（并行工作台）已移除 ⇒ 从期望集合里删掉。
				'vssaros.dsh.codebase', 'vssaros.dsh.imagegen', 'vssaros.dsh.marketplace', 'vssaros.dsh.scheduler', 'vssaros.dsh.sessions', 'vssaros.dsh.studio']);
		assert.deepStrictEqual(plan.pending, [], '没有 planned 容器了（语义保留给"规划了图标但还没有页面"的下一个模块）');
	});

	suite('清单驱动（重构 1.1：containersFromPlugins / pagesFromPlugins / 派生计划）', () => {

		/** 造一个带清单的插件夹具。 */
		function fixturePlugin(name: string, module: string, containerId: string, order: number, route: string): IPluginWithManifest {
			return {
				name,
				manifest: {
					manifestVersion: 1,
					module,
					activityBar: { containerId, title: { zh: module, en: module }, icon: 'codicon:symbol-misc', order },
					view: { kind: 'page', route },
				},
			};
		}

		/* ★ 2026-11-03：`fixtureNativePlugin` 已删 —— 它唯一的用途是给 agents 造
		   `kind: 'native'` 的夹具（Bots 侧栏 roster 树），而那套界面已整体下线；
		   目前没有任何模块是 native 形态（`DSH_MODULE_PAGES` 里也没有 native 项），
		   留着这个 helper 只会变成"声明了但没人用"的死代码（TS6133）。 */

		test('★ 从清单派生容器与页面：内置插件集合派生出的表与硬编码表逐项一致（双轨对账）', () => {
			// 这条是整个 1.1 的**对账锚点**：派生 ≠ 表 ⇒ 说明有人改了清单忘了同步（或反之）。
			// channels 是 planned 预留位（没有插件目录）⇒ 夹具里不带它。
			const plugins: IPluginWithManifest[] = [
				fixturePlugin('@vssaros/dsh-skills', 'skills', 'agentStudio.integration', 90, '/x/skills/'),
				{ name: '@vssaros/dsh-mcp', manifest: { manifestVersion: 1, module: 'mcp', view: { kind: 'section', host: 'skills', route: '/x/mcp/section' } } },
				fixturePlugin('@vssaros/dsh-kb', 'kb', 'agentStudio.knowledgeBase', 110, '/x/kb/'),
				fixturePlugin('@vssaros/dsh-media', 'media', 'agentStudio.media', 112, '/x/media/'),
				fixturePlugin('@vssaros/dsh-codebase', 'codebase', 'vssaros.dsh.codebase', 113, '/x/codebase/'),
				fixturePlugin('@vssaros/dsh-kanban', 'kanban', 'agentStudio.tasks', 70, '/x/kanban/'),
				fixturePlugin('@vssaros/dsh-workflow', 'workflow', 'agentStudio.workflow', 80, '/x/workflow/'),
				// ★ 2026-11-03：agents 的 Bots 工作台整体下线（含原生侧栏 roster 树）⇒ 夹具里不再有它；
				//   备份留档：它曾是 `fixtureNativePlugin('@vssaros/dsh-agents', 'agents', 'agentStudio.presetAgent', 60, '/x/agents/api/agents')`。
				fixturePlugin('@vssaros/dsh-dashboard', 'dashboard', 'agentStudio.dashboard', 5, '/x/dashboard/'),
				fixturePlugin('@vssaros/dsh-sessions', 'sessions', 'vssaros.dsh.sessions', 120, '/x/sessions/'),
				// 重构 2.1：定时任务（官方 dsh-schedule 的薄壳；page-only，legacy 侧无对应物）。
				fixturePlugin('@vssaros/dsh-scheduler', 'scheduler', 'vssaros.dsh.scheduler', 95, '/x/scheduler/'),
				// 2026-10-21：生图 / 画布工作台（page-only）。
				fixturePlugin('@vssaros/dsh-imagegen', 'imagegen', 'vssaros.dsh.imagegen', 85, '/x/imagegen/'),
				// 2026-10-22：自营商城工作台（page-only；与「工作台商城」market 模块并存 ✓）。
				fixturePlugin('@vssaros/dsh-marketplace', 'marketplace', 'vssaros.dsh.marketplace', 86, '/x/marketplace/'),
				// ★ 2026-10-31：并行工作台已移除 ⇒ 它的 fixture 也删掉（与容器表/页面表同步）。
				// 2026-10-23：萨罗斯管理平台（page-only；页面 iframe 承载站点前端）。
				fixturePlugin('@vssaros/dsh-studio', 'studio', 'vssaros.dsh.studio', 88, '/x/studio/'),
				// ★ 2026-10-30：萨罗斯中转站工作台已移除 ⇒ 它的 fixture 也删掉。
				// ★ 2026-10-30：小红书笔记工作台已移除 ⇒ 它的 fixture 也删掉。
			];
			const containers = containersFromPlugins(plugins);
			// 容器集合与硬编码表一致（containerId + 成员模块）
			assert.deepStrictEqual(
				containers.map(c => ({ id: c.containerId, modules: [...c.modules].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
				DSH_MODULE_CONTAINERS.map(c => ({ id: c.containerId, modules: [...c.modules].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
				'派生容器表与硬编码表不一致');
			// 页面表一致（kind + route；section 带 host）
			const pages = pagesFromPlugins(plugins);
			for (const expected of DSH_MODULE_PAGES.filter(p => p.kind !== 'none')) {
				const actual = pages.find(p => p.module === expected.module);
				assert.ok(actual, `派生页面表缺 ${expected.module}`);
				assert.strictEqual(actual!.kind, expected.kind);
				assert.strictEqual(actual!.route, expected.route);
			}
			// 共容器（skills+mcp）聚合语义保留：integration 的成员是两个模块
			// （mcp 是寄居模块：没自己的 activityBar，但 view.host=skills ⇒ 并入宿主容器）。
			const integration = containers.find(c => c.containerId === 'agentStudio.integration');
			assert.deepStrictEqual(integration?.modules, ['skills', 'mcp'], '寄居模块必须并入宿主容器（否则只装 mcp 时图标不显示）');
		});

		test('★★ 新模块零壳改动：一个从没见过的插件清单就能产出容器注册计划', () => {
			// 这是 1.1 的**验收**：加一个全新模块（`totally-new`），不改任何壳代码，计划里就出现它的容器。
			const plugins: IPluginWithManifest[] = [
				fixturePlugin('@acme/dsh-totally-new', 'totally-new', 'dsh-totally-new.main', 300, '/x/totally-new/'),
			];
			const containers = containersFromPlugins(plugins);
			const pluginModules = new Map(plugins.map(p => [p.name, p.manifest!.module!]));
			const plan = planModuleContainers({
				engine: 'dsh',
				installedPlugins: plugins.map(p => p.name),
				registeredContainerIds: [],
				containers,
				pluginModules,
			});
			assert.deepStrictEqual(plan.registrations.map(c => c.containerId), ['dsh-totally-new.main']);
			assert.strictEqual(plan.contextKeys['vssaros.dsh.plugin.totally-new.active'], true);
			// 页面也能解析（不落在硬编码页面表上）
			const pages = pagesFromPlugins(plugins);
			const state = resolveContainerPageState(containers[0], ['totally-new' as DshModuleId], pages);
			assert.strictEqual(state.page?.route, '/x/totally-new/');
		});

		test('清单缺失/无 module 的插件不参与派生（bridge 这类基础插件）', () => {
			const plugins: IPluginWithManifest[] = [
				{ name: '@vssaros/dsh-bridge' },
				{ name: '@acme/dsh-no-manifest', manifest: undefined },
			];
			assert.deepStrictEqual(containersFromPlugins(plugins), []);
			assert.deepStrictEqual(pagesFromPlugins(plugins), []);
			assert.deepStrictEqual(activeModulesFromPlugins(plugins), []);
		});

		test('停用的插件不激活模块（enabled=false 视同未装）', () => {
			const plugins: IPluginWithManifest[] = [
				{ ...fixturePlugin('@acme/dsh-totally-new', 'totally-new', 'dsh-totally-new.main', 300, '/x/totally-new/'), enabled: false },
			];
			assert.deepStrictEqual(activeModulesFromPlugins(plugins), []);
		});

		test('派生容器排序稳定：按 order，再按 containerId', () => {
			const plugins: IPluginWithManifest[] = [
				fixturePlugin('@acme/dsh-b', 'b', 'dsh-b.main', 300, '/x/b/'),
				fixturePlugin('@acme/dsh-a', 'a', 'dsh-a.main', 200, '/x/a/'),
				fixturePlugin('@acme/dsh-c', 'c', 'dsh-c.main', 200, '/x/c/'),
			];
			assert.deepStrictEqual(containersFromPlugins(plugins).map(c => c.containerId), ['dsh-a.main', 'dsh-c.main', 'dsh-b.main']);
		});
	});
});
