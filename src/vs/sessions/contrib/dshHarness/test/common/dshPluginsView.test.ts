/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「插件」视图（`agentStudio.plugins`）的**源码契约守卫**：类名有样式 / 页签集合 / 占位符文案。
 *
 * 为什么需要（2026-10-11，方案 B 第 1–4 步的护栏）：这个视图的四个页签此前各自长了一套 item 样式——
 * `installed` 用 WorkbenchList 渲染器、`extensions` 与 `marketplace` 是两套手写卡片、而 `dsh` 页签的
 * **18 个类名一条 CSS 规则都没有**（整套样式写在内联 `style.cssText` 里）⇒ "每个页签 item 都不一样"。
 * 这类缺陷编译期看不出来、运行也不报错，只能靠扫描源码发现（同 `dshActivityBarSource.test.ts` 的口径）。
 *
 * 口径：类名只查**自己定义**的（框架/主题提供的走白名单）；页签与文案按**源码形态**断言，
 * 避免"4 个页签 → 3 个"这类结构性决定被后来的改动悄悄推翻（`workbench-e2e` 按页签文案点击，
 * 改名会假红——见那里的注释）。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const REL_VIEW = 'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts';
const REL_CSS = 'src/vs/sessions/contrib/agentStudio/browser/views/media/pluginsView.css';

/** 不在本文件里定义的类名（框架 / 主题 / 其它视图贡献的样式表负责）。 */
const NOT_OURS = new Set([
	// Workbench 的布局与空态标记（由 workbench 的 CSS 负责；本文件只做针对性修复）
	'empty', 'welcome', 'welcome-view', 'pane', 'pane-body', 'pane-composite-part', 'composite', 'viewlet',
	'monaco-list', 'monaco-list-row', 'monaco-scrollable-element', 'quick-input-widget', 'monaco-list-row-focused',
]);

function readFromRepoRoot(rel: string): string | undefined {
	// runner 约定从仓库根执行（`node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs`）。
	const abs = path.join(process.cwd(), rel);
	return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

/**
 * 从视图源码里收集"会被挂到元素上的类名" → 首次出现的行号（报错时给定位）。
 *
 * 认这三种写法（本视图里就这么挂类名）：
 *   - `$('div.a.b')` / `$('button.a.active')`：选择器串里的点号类名；
 *   - `classList.add('x' | 'x y')` / `classList.toggle('x', …)`；
 *   - `className = 'x y'`。
 */
function classesUsedInView(source: string): Map<string, number> {
	const found = new Map<string, number>();
	const add = (name: string, line: number) => {
		if (name && !found.has(name)) {
			found.set(name, line);
		}
	};
	source.split(/\r?\n/).forEach((line, index) => {
		const lineNo = index + 1;
		for (const m of line.matchAll(/\$\((['"])([^'"]+)\1\)/g)) {
			for (const c of m[2].matchAll(/\.([A-Za-z][\w-]*)/g)) {
				add(c[1], lineNo);
			}
		}
		for (const m of line.matchAll(/classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
			for (const c of m[1].matchAll(/'([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*)'/g)) {
				for (const single of c[1].split(/\s+/)) {
					add(single, lineNo);
				}
			}
		}
		for (const m of line.matchAll(/className\s*=\s*'([^']+)'/g)) {
			for (const single of m[1].split(/\s+/)) {
				add(single, lineNo);
			}
		}
	});
	return found;
}

/** 从 CSS 里收集所有被定义过的类名（宽松匹配：多出来的名字只会让检查更松，不会漏报）。 */
function classesInCss(source: string): Set<string> {
	const out = new Set<string>();
	for (const m of source.matchAll(/\.([A-Za-z][\w-]*)/g)) {
		out.add(m[1]);
	}
	return out;
}

suite('插件视图契约守卫（类名有样式 / 基础件 / 页签集合 / 占位符文案）', () => {
	const view = readFromRepoRoot(REL_VIEW);
	const css = readFromRepoRoot(REL_CSS);

	/**
	 * **去掉注释行**后的源码。
	 *
	 * ⚠ "不该再出现某名字"这类断言只能用这个：注释里**会也应该**引用旧名字——比如解释"为什么删掉
	 * marketplace 页签"时引用 `"Marketplace"`、解释"本视图不再有 `style.cssText`"时引用它本身。
	 * 用全文匹配会把这种解释性注释判成红（本轮两次假红都是这么来的）。
	 */
	const codeOnly = (view ?? '')
		.split(/\r?\n/)
		.filter(line => !/^\s*(\*|\/\/)/.test(line))
		.join('\n');

	test('两个文件都读得到（守卫自身的前置）', () => {
		assert.ok(view, `读不到 ${REL_VIEW}`);
		assert.ok(css, `读不到 ${REL_CSS}`);
	});

	test('每个用到的类名都有 CSS 规则（"某个页签整页没样式"这种缺陷不许再发生）', () => {
		const used = classesUsedInView(view!);
		const defined = classesInCss(css!);
		const missing = [...used.entries()]
			.filter(([name]) => !defined.has(name) && !NOT_OURS.has(name))
			.map(([name, line]) => `${name}(:${line})`)
			.sort();
		assert.deepStrictEqual(missing, [], `这些类名在 pluginsView.ts 里用了，但 ${REL_CSS} 里没有规则：${missing.join('、')}`);
	});

	test('基础件在位（token + 共用件：token 层是收敛"四套样式"的唯一真源）', () => {
		const required = [
			'--plugins-radius-lg', '--plugins-font-md', '--plugins-muted',
			'plugins-card', 'plugins-badge', 'plugins-btn', 'plugins-section', 'plugins-empty', 'plugins-notice',
		];
		const missing = required.filter(name => !css!.includes(name));
		assert.deepStrictEqual(missing, [], `基础件/token 缺失：${missing.join('、')}`);
	});

	test('页签恰好三个：已装插件 / VS Code 扩展 / dsh 组合包（Marketplace 已并入扩展；T1 改名 2026-10-14）', () => {
		assert.match(view!, /type PluginsTab = 'installed' \| 'extensions' \| 'dsh';/,
			'`PluginsTab` 必须恰好是 installed / extensions / dsh 三个——独立 marketplace 页签已并入「扩展」（方案 B）');
		// ⚠ 别在这里全文扫 `'marketplace'`（2026-10-13 实际踩到，守卫自己假红）：这个字符串现在**合法地**
		//   出现在安装通道的比较里（`dshInstallTransport(...) === 'marketplace'`，见
		//   `agentStudio/common/dshPluginTransport.ts`）⇒ 全文扫会把"通道比较"判成"又长出一个页签" ✗。
		//   页签**取值**由 `PluginsTab` 类型 + `_switchTab(tab: PluginsTab)` 在编译期锁死（上面第一条），
		//   所以这里只钉"没有 marketplace 页签的**接线**"：赋值 / 切换 / 按它分支渲染三处 ✓。
		assert.ok(!/this\._activeTab\.set\('marketplace'/.test(view!), '不该能把 activeTab 设成 marketplace ✗');
		assert.ok(!/_switchTab\('marketplace'\)/.test(view!), '不该有切到 marketplace 页签的入口 ✗');
		assert.ok(!/_activeTab\.get\(\) === 'marketplace'/.test(view!), '不该按 marketplace 页签分支渲染 ✗');
		// T1 改名（2026-10-14；IA 诊断见 `doc/dsh-plugin-center-ia-tabs-mockup.html`）：三个标签原本**不在同一维度**
		// ——「插件 / 扩展」是**东西的种类**、「运行时」是**进程状态**；而且「插件」与「运行时」各列了一份插件清单，
		// 用户分不清"我装的"在哪个页签。现在直呼其物（并区分"已装 / 可获取"），Host 状态改由页签上的**状态点**表达。
		assert.ok(view!.includes("localize('pluginsTabInstalled', \"已装插件\")"), '页签文案「已装插件」缺失');
		assert.ok(view!.includes("localize('pluginsTabExtensions', \"VS Code 扩展\")"), '页签文案「VS Code 扩展」缺失');
		assert.ok(view!.includes("localize('pluginsTabRuntime', \"dsh 组合包\")"), '页签文案「dsh 组合包」缺失');
		// 标签与搜索占位符必须**同口径**（旧实现标签是「插件」、占位符却写"搜索**已安装**插件" ⇒ 自相矛盾）
		assert.ok(view!.includes("localize('searchInstalledPlugins', \"搜索已装插件（名称 / 描述）…\")"),
			'「已装插件」页签的占位符要与标签同口径（都叫"已装插件"）');
		// ⚠ 只看**代码行**：注释里会（也应该）出现旧名字——比如 `PluginsTab` 定义上方解释
		// "为什么删掉 marketplace 页签"时就要引用 `"Marketplace"`。守卫抓注释会变成假红。
		assert.ok(!codeOnly.includes('"Installed"') && !codeOnly.includes('"Marketplace"'),
			'页签名不应再出现英文默认值（本视图其它文案全是中文）');
	});

	test('S1 页签：分段控件契约（ARIA + roving tabindex + 方向键 + 计数 + 状态点）', () => {
		// 为什么钉这些：S1 的可访问性全靠这几行——容器 tablist、按钮 tab、选中态写进 aria-selected、
		// 只有选中的那个进 Tab 顺序（roving tabindex），方向键/Home/End 直接切页。
		assert.ok(view!.includes("tabs.setAttribute('role', 'tablist')"), '页签容器要有 role=tablist');
		assert.ok(view!.includes("btn.setAttribute('role', 'tab')"), '每个页签要有 role=tab');
		assert.ok(view!.includes("btn.setAttribute('aria-selected', on ? 'true' : 'false')"),
			'选中状态必须写进 aria-selected（不能只靠 .active 类）');
		assert.ok(view!.includes('btn.tabIndex = on ? 0 : -1'), 'roving tabindex：只有选中的页签进 Tab 键顺序');
		assert.ok(/\[\s*'ArrowLeft',\s*'ArrowRight',\s*'Home',\s*'End'\s*\]/.test(view!),
			'方向键 / Home / End 要能切页签（键盘用户必须能换页）');
		assert.ok(view!.includes("btn.setAttribute('aria-controls'") || view!.includes("?.setAttribute('aria-controls'"),
			'页签要 aria-controls 指到对应面板');
		assert.ok(view!.includes("setAttribute('role', 'tabpanel')"), '面板要有 role=tabpanel');
		// 计数与状态点：元素要建、要有 CSS、零计数与"Host 可达"要能区分
		assert.ok(view!.includes("$('span.plugins-tab-count')") && view!.includes("$('span.plugins-tab-dot')"),
			'计数与状态点元素缺失');
		assert.ok(view!.includes("classList.toggle('is-zero'"), '零计数要弱化显示（否则 0 和"没读到"分不清）');
		assert.ok(view!.includes("classList.toggle('on', !!bundles)"),
			'Host 状态点应由"能读到组合包清单"驱动（不额外探活）');
		assert.ok(css!.includes('.plugins-tab-count') && css!.includes('.plugins-tab-dot.on'),
			'计数 / 状态点缺 CSS');
		assert.ok(css!.includes('.plugins-tab:focus-visible'), '页签要有可见焦点环（键盘可达）');
	});

	test('默认隐藏 + 显式激活：不许再出现 style.cssText，且显隐约定成对', () => {
		// ① 静态样式一律进 CSS（2026-10-11 收敛：本视图原有 4 处 `style.cssText`，全在容器/小标题上）
		assert.ok(!/style\.cssText/.test(codeOnly),
			'本视图不该再用 `style.cssText`（静态样式进 pluginsView.css；显隐/高度写成具体的 `.style.x = 值`）');
		// ② 初始隐藏的唯一来源是 CSS 的 `display:none`（`_switchTab` 只在点击时调用、构造时不调）
		for (const cls of ['plugins-extensions-container', 'plugins-dsh-container']) {
			assert.ok(new RegExp(`\\.${cls}\\s*\\{[^}]*display:\\s*none`, 's').test(css!),
				`.${cls} 的 CSS 必须以 display:none 作默认——它是初始隐藏的唯一来源`);
		}
		// ③ 激活时**必须给显式值**：`''` 会清掉内联后回落到 CSS 的 `none` ⇒ 页签永远显示不出来
		//    （本轮改这条时正是这个坑，所以用断言钉住，而不是靠注释）。
		assert.match(view!, /_extensionsContainer\.style\.display = tab === 'extensions' \? 'flex' : 'none';/,
			'扩展容器激活时必须显式 `flex`（不能是空串）');
		assert.match(view!, /_dshContainer\.style\.display = tab === 'dsh' \? 'block' : 'none';/,
			'运行时容器激活时必须显式 `block`（不能是空串）');
	});

	test('4b：插件页签是 DOM 分组列表（不再是 WorkbenchList），分组只用 fromMarketplace', () => {
		// 这一换法（方案 B 第 4 步）很容易被"顺手改回列表"推翻，所以钉住：
		assert.ok(!/WorkbenchList/.test(codeOnly), '插件页签不该再用 WorkbenchList（4b 已换成 DOM 分组列表）');
		assert.ok(!/IListVirtualDelegate/.test(codeOnly), '列表委托已删（行高改由 CSS `.plugins-installed-row` 给）');
		assert.match(codeOnly, /_renderInstalledTab\(/, '要有 `_renderInstalledTab`（分组渲染主体）');
		assert.match(codeOnly, /_renderPluginRow\(/, '要有 `_renderPluginRow`（行渲染，走 `PluginListRenderer`）');
		// 分组判据：插件接口里唯一可靠的"来源"是 `fromMarketplace`（`uri` 前缀随安装位置变，不能当来源）
		assert.match(codeOnly, /plugin\.fromMarketplace/, '分组判据应是 `plugin.fromMarketplace`');
		// 「全搬」（2026-10-12）：四个段都搬走后不该再出现段切换条/段状态；组合包两段改由插件页签渲染
		assert.ok(!/_renderDshSegments|_dshSegment\b/.test(codeOnly),
			'段切换条已取消（随包模块/官方/已安装 三段都搬进插件页签，运行时只剩运行态现场 + 添加插件入口）');
		assert.match(codeOnly, /_renderDshBundleCard\(target: HTMLElement/,
			'组合包卡片应可指定渲染目标（否则没法落到插件页签）');
		assert.ok(codeOnly.includes('pluginsSectionInstalledBundles') && codeOnly.includes('pluginsSectionOfficialBundles'),
			'插件页签应渲染「已安装组合包」「官方随附」两段');
		assert.ok(css!.includes('.plugins-installed-list') && css!.includes('.plugins-installed-row'),
			'新容器 / 行要有 CSS（`.plugins-installed-list` / `.plugins-installed-row`）');
	});

	test('方案A：策展清单是数据驱动的（官方包跟 dsh 版本 / 第三方包必须钉版本），且视图渲染它', () => {
		const mod = readFromRepoRoot('src/vs/sessions/contrib/agentStudio/common/dshPluginRecommendations.ts');
		assert.ok(mod, '读不到策展清单模块');
		// 契约：接受可选的 dsh 版本（拿得到就钉版本，避免被 dsh 的 peer 预检拦下）
		assert.match(mod!, /export function dshPluginRecommendations\(dshVersion\?: string\)/,
			'`dshPluginRecommendations(dshVersion?)` 的签名是"可钉版本"的契约');
		/**
		 * **第三方包 allowlist**（`@deepseek-ai/` 之外的条目）—— **当前刻意为空** ✓（2026-10-14）。
		 *
		 * 为什么要有这份 allowlist（2026-10-13）：清单从"只有官方包"扩成两类，原来那条"每个 `pkg:` 都必须
		 * `@deepseek-ai/` 前缀"的断言已经**表达不了新口径** ⇒ 换成"官方包 或 在 allowlist 里登记的第三方包"。
		 * 加第三方包必须**显式改这里**（有意为之的摩擦 ✓）—— 它意味着"我们要为别人的包背书"，
		 * 不该顺手溜进来 ✗。
		 *
		 * 为什么现在空：唯一那条 `@tt-a1i/archify-dsh@1.0.0` 已按用户要求改成**默认随包**
		 * （vendored 进 `dsh-plugins/vssaros-archify/`）⇒ 它不该再出现在"可选安装"的策展清单里
		 *（两条安装路径并存 = 其中一条还要用户点、还要联网 ✗）。allowlist 机制保留给下一个第三方包 ✓。
		 */
		const THIRD_PARTY_ALLOW: readonly (readonly [pkg: string, version: string])[] = [];
		assert.deepStrictEqual([...THIRD_PARTY_ALLOW], [],
			'第三方 allowlist 当前应为空（archify 已改随包 vendored，见 `dsh-plugins/vssaros-archify/VENDOR.md`）；'
			+ '要加新的第三方包，改这里 + 确认它**不该**随包 ✓');
		const pkgs = [...mod!.matchAll(/pkg:\s*'([^']+)'/g)].map(m => m[1]);
		assert.ok(pkgs.length >= 1, '策展清单至少要有一条');
		for (const p of pkgs) {
			const allowed = THIRD_PARTY_ALLOW.some(([name]) => name === p);
			assert.ok(p.startsWith('@deepseek-ai/') || allowed,
				`策展条目必须是官方包、或在 allowlist 里登记的第三方包（否则就是臆造包名）：${p}`);
		}
		// 每个第三方包**必须**自带 `pinVersion`（第三方版本与 dsh 版本无关；套 dsh 版本会拼出不存在的版本号 ✗）
		for (const [name, version] of THIRD_PARTY_ALLOW) {
			assert.ok(pkgs.includes(name), `allowlist 里的 ${name} 在清单里找不到（allowlist 过期了 ⇒ 同步删/改）`);
			assert.match(mod!, new RegExp(`pkg:\\s*'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]{0,120}?pinVersion:\\s*'${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
				`第三方包 ${name} 必须显式钉 pinVersion: '${version}'（不随 dsh 版本走，见模块头 ★ 两类条目）`);
		}
		// 官方包**不许**被钉版本（钉了就会脱离 profile 的 dsh 版本 ⇒ 升级 dsh 后被 peer 预检拦下）
		assert.ok(!/pkg:\s*'@deepseek-ai\/[^']+'[\s\S]{0,120}?pinVersion/.test(mod!),
			'官方包必须跟 dsh 版本走，不能钉 pinVersion ✗');
		// 视图侧：用了它、渲染了推荐块、并给了 CSS（类名守卫也覆盖，这里再显式盯一眼意图）
		assert.match(codeOnly, /dshPluginRecommendations\(/, '视图应使用策展清单');
		assert.ok(codeOnly.includes('plugins-dsh-reco'), '视图应渲染推荐块');
		assert.ok(css!.includes('.plugins-dsh-reco'), '推荐块要有 CSS');
	});

	test('社区目录（dsh-market 的内容）在插件商城里渲染，且安装源优先级与市场一致', () => {
		const mod = readFromRepoRoot('src/vs/sessions/contrib/agentStudio/browser/dshMarketCatalog.ts');
		assert.ok(mod, '读不到社区目录模块');
		// ① 目录地址 = dsh-market 自己用的那份策展注册表（同一份内容）
		assert.ok(mod!.includes('awesome-dsh-plugin.com/plugins.json'),
			'目录地址应是 dsh-market 用的策展注册表（否则两边内容会不一致）');
		// ② 安装源优先级：npm 优先、否则回落仓库地址（与市场自己的策略一致）
		assert.match(mod!, /entry\.npm \? entry\.npm : entry\.url/, '安装 spec 应 npm 优先、否则 git');
		// ③ 视图侧：渲染它、并且安装走**既有**的 installBundle 链路（不新开安装通道）
		assert.match(codeOnly, /_renderDshMarketSection\(\)/, '视图应渲染社区目录段');
		assert.match(codeOnly, /fetchDshMarketCatalog\(/, '视图应抓这份目录');
		assert.match(codeOnly, /installBundle\(spec,/, '安装要走既有 installBundle 通道');
	});

	test('★ 安装通道判据只有一处实现：真安装与「取消」按钮都用 dshInstallTransport（不许各写一遍）', () => {
		const view = readFromRepoRoot(REL_VIEW)!;
		// ① 视图必须**用**共享判据（纯函数在 `agentStudio/common/dshPluginTransport.ts`，真值表由
		//    `agentStudio/test/common/dshPluginTransport.test.ts` 钉住 ✓）
		assert.match(view, /import \{[^}]*dshInstallTransport[^}]*\} from '\.\.\/\.\.\/common\/dshPluginTransport\.js'/,
			'视图应从共享模块导入 dshInstallTransport（自己写判据 = 两处会漂 ✗）');
		assert.match(view, /dshInstallTransport\(inspected, false\) === 'marketplace'/,
			'「取消」按钮必须用共享判据判"是不是商城那条"（只有它有取消能力 —— 自己写判据就会白长一个按钮 ✗）');
		assert.match(view, /dshInstallTransport\(inspect,\s*!!approvedBuilds\)/,
			'真安装处必须按共享判据选路（带上 approvedBuilds）');
		// ② 真安装那条必须按它分流（`spec` 那条存在、且回落逻辑也认它）
		assert.match(view, /dshInstallTransport\(inspect,\s*!!approvedBuilds\)/,
			'真安装处必须按共享判据选路（并带上 approvedBuilds：批准构建脚本只能走商城那条 ✗）');
		assert.match(view, /transport === 'spec'/, '视图应有 spec（主进程按 spec 安装）那条分支');
		assert.match(view, /installPluginSpec\(spec,\s*name\)/,
			'spec 分支必须调 installPluginSpec（并把预检给的包名传进去 —— 装完按它核对版本 ✓）');
		assert.match(view, /host\.installBundle\(spec, requestId, approvedBuilds\)/,
			'回落/商城那条必须保留（构建脚本批准与 git/tarball 只有它能做 ✗）');
		// ③ 旧写法必须收口：手写 `kind !== 'path'` 会漏掉"注册表规格也走主进程"这件事 ⇒ 取消按钮白长一个
		assert.ok(!/inspected\?\.kind !== 'path'/.test(view),
			'取消按钮的判据必须换成 dshInstallTransport(...) === \'marketplace\'：手写 `kind !== \'path\'` 会让 spec 那条也长出取消按钮（点了没反应 ✗）');
	});

	test('搜索占位符里不许再有 emoji 转义（统一中文文案）', () => {
		const bad = view!
			.split(/\r?\n/)
			.map((line, index) => ({ line, no: index + 1 }))
			.filter(({ line }) => /placeholder\s*=/.test(line) && /\\u\{?[0-9A-Fa-f]{4}/.test(line))
			.map(({ no }) => `:${no}`);
		assert.deepStrictEqual(bad, [], `这些占位符还在用 emoji 转义（原「🔍 搜索商城资源…」那种）：${bad.join('、')}`);
	});

	test('★ 启停话术：`via` 如实透传 + 错误码与诊断都要露出来（4.51 病根：界面只剩"操作失败"）', () => {
		// 组合包与行级两条路共用同一个话术入口。各自写一遍必漏字段——行级那处就写死过 `via: 'host'`，
		// 于是"Host 失败 ⇒ 文件级兜底"（4.53 起会真的走到）被说成"已应用（Host 热重载完成）"。
		assert.ok(codeOnly.includes('_toggleResultText('), '启停话术应当集中在 `_toggleResultText` 一个入口（否则"漏字段"会反复发生）');
		assert.ok(codeOnly.includes('_toggleResultText(this._dshHmr, res)'),
			'行级启停没把**结果整个**交给话术入口 ⇒ `via` / `errorCode` / `diagnostic` 又会被丢掉');
		// 诊断是 `operation-error` 这类非预期异常的**唯一**线索（预期拒绝才有枚举码）：不显示就等于没查过
		assert.ok(codeOnly.includes('result.diagnostic'), '诊断没显示 ⇒ 界面只剩"操作失败"（README 4.51 的病根）');
		assert.ok(/result\.errorCode \? ` \[\$\{result\.errorCode\}\]`/.test(codeOnly), '错误码没显示');
		// `via: 'file'` 从 4.52/4.53 起不再只等于"Host 未运行"（还包含"Host 跑了但没能应用 ⇒ 退回写文件"）
		assert.ok(!codeOnly.includes('Host 未运行，直接改了 profile'),
			'file 通路的说明不许再写"Host 未运行"：兜底那一次 Host 是跑着的，这话会把排查方向带偏');
	});
});
