#!/usr/bin/env node
// check-workbench-catalog.mjs ★ 工作台**清单一致性**守卫（防"新增模块忘了登记"）
//
// 为什么必须有（2026-10-22 实锤的 bug）：
//   新增了商城工作台（`@vssaros/dsh-marketplace`，页面 `/x/marketplace/`）⇒ 主页里**没有**「商城」卡片。
//   根因：工作台入口散落在**两份硬编码清单**里，两份都没登记 ⇒ 卡片不显示；
//   而且**只补一份还不够** —— 另一份同时是 **route 白名单**
//   （`client.workbenchNav.js` 的 `itemByRoute()` 只认 `DEFAULT_ITEMS` 里的 route）
//   ⇒ 卡片就算出现，点「打开」也会被静默拒掉（"点了没反应"）✗。
//   ⇒ 这道守卫要求：**凡是宿主模块页表里 kind='page' 的模块，两处都必须登记** ✓。
//
// 三份清单（任一漏登记 ⇒ 变红）：
//   ① 宿主模块页表：`src/vs/sessions/contrib/dshHarness/common/dshModuleContainers.ts` 的 DSH_MODULE_PAGES
//   ② dsh 主页卡片：`dsh-plugins/vssaros-dashboard/lib/catalog.js` 的 WORKBENCH_MODULES
//   ③ dsh 侧栏启动器 / route 白名单：`dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js` 的 DEFAULT_ITEMS
//
// 豁免：显式登记在 HOST_EXEMPT 里的模块（**必须写明原因**）——
//   例：scheduler（定时任务）**故意不进主页卡片**（它是"自动化任务"，不是工作台），
//   但**必须在 DEFAULT_ITEMS 里**（侧栏有它）⇒ 豁免只对"主页卡片"这一处生效 ✓。
//
// 跑法：node dsh-plugins/check-workbench-catalog.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

// ── ① 宿主模块页表（kind='page' 的模块 → route）────────────────────
const pagesSrc = read(path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshModuleContainers.ts'));
const pageModules = [];
for (const m of pagesSrc.matchAll(/\{\s*module:\s*'([^']+)',\s*kind:\s*'page',\s*route:\s*'([^']+)'\s*\}/g)) {
	pageModules.push({ module: m[1], route: m[2] });
}
if (pageModules.length === 0) {
	fail('没从 dshModuleContainers.ts 抓到任何 kind=page 的模块（解析口径坏了 ⇒ 守卫会空跑）');
} else {
	ok(`宿主模块页表：${pageModules.length} 个整页模块（${pageModules.map(p => p.module).join('、')}）`);
}

// ── ② 主页卡片清单 ────────────────────────────────────────────────
const catalogSrc = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'catalog.js'));
const homeCards = new Set([...catalogSrc.matchAll(/route:\s*'([^']+)'/g)].map(m => m[1]));

// ── ③ 侧栏启动器 / route 白名单 ───────────────────────────────────
const navSrc = read(path.join(HERE, 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'));
const navItems = new Set([...navSrc.matchAll(/route:\s*"([^"]+)"/g)].map(m => m[1]));

// 主页**故意**不收的模块（写明原因；只对"主页卡片"这一处生效）
// ⚠ 2026-10-28：`scheduler` 的豁免**已删** —— 用户要求「dsh 侧增加定时任务工作台，复用原生的定时任务 UI」，
//   scheduler 0.3.0 起是正经工作台（官方 TaskManagerPage 满页渲染）⇒ 老理由
//   「自动化任务是"自动化任务"不是工作台」不再成立，主页必须给入口。
//   教训：豁免理由一旦过期就会变成"这个工作台永远没人找得到"，删豁免比留着更安全。
const HOST_EXEMPT = {};

/* ⚠ 2026-10-23：宿主页表里既登记"模块主页"（`/x/kb/`），也可能登记**子路由**
   （`/x/kb/sideview`）。两份清单一向只登记**模块主页**（那是用户点的入口）
   ⇒ 精确匹配会把子路由误报成"漏登记"（实测报了 kb(/x/kb/sideview)）。
   判据改成**前缀归属**：清单里有 `/x/kb/` 就算 `/x/kb/xxx` 已登记
   （与 `openModulePage` 的白名单口径一致：精确 → 前缀归属）。 */
const covers = (set, route) => {
	if (set.has(route)) { return true; }
	for (const r of set) {
		if (!r || r === '/') { continue; }
		const prefix = r.endsWith('/') ? r : r + '/';
		if (route.startsWith(prefix)) { return true; }
	}
	return false;
};

const missingNav = [];
const missingHome = [];
for (const { module, route } of pageModules) {
	if (!covers(navItems, route)) { missingNav.push(`${module}(${route})`); }
	if (!covers(homeCards, route) && !HOST_EXEMPT[module]) { missingHome.push(`${module}(${route})`); }
}
if (missingNav.length === 0) {
	ok(`侧栏启动器 / route 白名单：${pageModules.length} 个整页模块都已登记 ✓`);
} else {
	fail(`侧栏启动器 / route 白名单漏登记（⇒ 从主页或侧栏点「打开」会被静默拒掉）：${missingNav.join('、')}`);
}
if (missingHome.length === 0) {
	ok(`主页卡片清单：${pageModules.length} 个整页模块都已登记（豁免 ${Object.keys(HOST_EXEMPT).length} 个）✓`);
} else {
	fail(`主页卡片清单漏登记（⇒ 主页上看不到这个工作台）：${missingHome.join('、')}`);
}

// 豁免项本身要真的被豁免掉（登记了却还在清单里 ⇒ 说明豁免过期了，会掩盖真问题）
for (const [module, why] of Object.entries(HOST_EXEMPT)) {
	const route = pageModules.find(p => p.module === module)?.route;
	if (!route) { continue; }
	if (homeCards.has(route)) {
		fail(`豁免项「${module}」已经在主页卡片清单里了 ⇒ 它的豁免理由（${why}）已过期，请删掉豁免`);
	}
}

// ── ④ 图标可渲染：`codicon:*` → emoji 映射表覆盖所有已注册工作台（2026-10-22）──────
// 为什么必须守：注册表 `icon` 是**标识符**（`codicon:home`），而 dsh 前端**没有 codicon 字体/CSS**
//   ⇒ 不映射就只能显示兜底 🧩（以前那行是 `icon.length <= 4 ? icon : "🧩"`）。加了映射表之后，
//   新增工作台若用了没登记的 codicon，就会**悄悄**退回 🧩 ⇒ 必须让它在这里变红 ✓。
const NAV_FILE = path.join(ROOT, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js');
const MARKET_FILE = path.join(ROOT, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.market.js');
const mapBlockOf = (text) => {
	const m = /const WB_ICON_EMOJI\s*=\s*\{([\s\S]*?)\};/.exec(text);
	return m ? m[1].replace(/\s+/g, ' ').trim() : '';
};
const navIconSrc = read(NAV_FILE);
const marketIconSrc = read(MARKET_FILE);
const navIconMap = mapBlockOf(navIconSrc);
const marketIconMap = mapBlockOf(marketIconSrc);
if (!navIconMap) {
	fail('client.workbenchNav.js 里找不到 WB_ICON_EMOJI 映射表（图标会全部退回 🧩）');
} else if (!marketIconMap) {
	fail('client.market.js 里找不到 WB_ICON_EMOJI 映射表（商城列表会显示 codicon:xxx 原文）');
} else if (navIconMap !== marketIconMap) {
	fail('两处 WB_ICON_EMOJI **不一致**（两个 chunk 各存一份 ⇒ 必须逐字相同，否则启动器与商城显示不同图标）');
} else {
	ok(`codicon→emoji 映射表两处逐字一致（${(navIconMap.match(/"codicon:/g) ?? []).length} 项）✓`);
}

// 每个**已注册**工作台（有 desktopWorkbenches.register 的包）的图标，都必须能映射到非 🧩 的 emoji
const pluginsRoot = path.join(ROOT, 'dsh-plugins');
/** 键 → emoji（从 workbenchNav 那份表解析；两张表已校验逐字一致 ⇒ 用哪份都一样）。 */
const iconPairs = new Map([...navIconMap.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
const unmapped = [];
for (const dirName of fs.readdirSync(pluginsRoot)) {
	const pkgPath = path.join(pluginsRoot, dirName, 'package.json');
	if (!fs.existsSync(pkgPath)) { continue; }
	const pkg = JSON.parse(read(pkgPath));
	const wb = pkg.vssaros && pkg.vssaros.workbench;
	if (!wb) { continue; }
	const libDir = path.join(pluginsRoot, dirName, 'lib');
	if (!fs.existsSync(libDir)) { continue; }
	const registered = fs.readdirSync(libDir).filter(f => f.endsWith('.js'))
		.some(f => /desktopWorkbenches\.register\(/.test(read(path.join(libDir, f))));
	if (!registered) { continue; }
	const icon = wb.icon ?? (pkg.vssaros.activityBar && pkg.vssaros.activityBar.icon) ?? '';
	if (!icon) { unmapped.push(`${dirName}（没写 icon）`); continue; }
	const emoji = iconPairs.get(icon);
	if (!emoji) { unmapped.push(`${dirName}（${icon} 不在映射表里）`); }
	else if (emoji === '🧩') { unmapped.push(`${dirName}（${icon} 映射到占位符 🧩）`); }
}
if (unmapped.length) {
	fail(`已注册工作台的图标映射不到 emoji（会显示 🧩）：${unmapped.join('、')}`);
} else {
	ok('已注册工作台的图标都能映射到 emoji ✓');
}

// ── ⑤ 以**包清单**为真源反推（2026-11-02）──────────────────────────────────────
// 为什么还要这一段：上面 ①–③ 的真源是宿主 TS 里的 `kind:'page'` 表 ⇒ 只管**整页**模块。
//   **注册式**工作台（`view.kind=none` / `native`，界面由 `desktopWorkbenches.register()` 渲染）
//   不在那张表里 ⇒ 漏登记**一律抓不到**。实测：`vssaros-loop` 做完后在界面上没有任何入口
//   （不在 DEFAULT_ITEMS、启动器又把 `vssaros/*` 整体排除、主页没卡片），而本守卫一直是绿的。
//   ⇒ 真源换成各包 `package.json` 的 `vssaros.workbench`：声明了工作台，就必须**可达**。
//
// 三个方向：
//   A. 整页工作台（view.kind=page）：清单的 route ⇒ 必须在 DEFAULT_ITEMS（route 白名单）与主页卡片里；
//   B. 注册式工作台（none/native）：没有 route，靠启动器的「已注册但无固定入口」兜底 ⇒
//      ① 客户端真的调用了 `desktopWorkbenches.register(`，且描述符 repository 与清单一致（不然快照里没有它）；
//      ② 启动器的过滤判据必须是 `coveredByFixedEntry`（不能退回「`vssaros/` 一律排除」）；
//   C. 反向（幽灵入口）：DEFAULT_ITEMS 里每个 `/x/<m>/` 都必须有对应的包 ⇒ 否则「卡片在、点不开」。
const readJson = (p) => JSON.parse(read(p));
const wbPackages = [];
for (const dirName of fs.readdirSync(pluginsRoot)) {
	const pkgPath = path.join(pluginsRoot, dirName, 'package.json');
	if (!fs.existsSync(pkgPath)) { continue; }
	let pkg;
	try { pkg = readJson(pkgPath); } catch { continue; }
	const v = pkg.vssaros;
	if (!v || !v.workbench) { continue; }
	wbPackages.push({
		dirName,
		module: v.module || '',
		viewKind: (v.view && v.view.kind) || (v.module ? 'page' : 'none'),
		route: v.view && v.view.route ? v.view.route : (v.module ? `/x/${v.module}/` : ''),
		repository: v.workbench.repository || '',
	});
}
if (wbPackages.length === 0) {
	fail('没从任何包清单里读到 vssaros.workbench（解析口径坏了 ⇒ ⑤ 会空跑）');
} else {
	ok(`包清单声明的工作台：${wbPackages.length} 个（${wbPackages.map(p => p.module || p.dirName).join('、')}）`);
}

// DEFAULT_ITEMS 块（只取这一块，别把文件里别处的 route 字面量混进来）
const defaultItemsBlock = (() => {
	const a = navSrc.indexOf('const DEFAULT_ITEMS = [');
	if (a < 0) { return ''; }
	const b = navSrc.indexOf('\n\t\t];', a);
	return navSrc.slice(a, b < 0 ? undefined : b);
})();
const defaultRoutes = [...defaultItemsBlock.matchAll(/route:\s*"([^"]+)"/g)].map(m => m[1]);
if (defaultRoutes.length === 0) {
	fail('读不到 client.workbenchNav.js 的 DEFAULT_ITEMS 块（⑤-A/C 会空跑）');
}

// A. 整页工作台 ⇒ route 白名单 + 主页卡片
const pageWb = wbPackages.filter(p => p.viewKind === 'page');
const aNav = [];
const aHome = [];
for (const p of pageWb) {
	if (!p.route) { continue; }
	if (!covers(new Set(defaultRoutes), p.route)) { aNav.push(`${p.dirName}(${p.route})`); }
	if (!covers(homeCards, p.route) && !HOST_EXEMPT[p.module]) { aHome.push(`${p.dirName}(${p.route})`); }
}
if (aNav.length === 0 && aHome.length === 0) {
	ok(`⑤-A 整页工作台（${pageWb.length} 个）：清单 route 都在侧栏白名单与主页卡片里 ✓`);
} else {
	if (aNav.length) { fail(`⑤-A 清单声明了工作台，但侧栏 route 白名单没有（⇒ 点「打开」被静默拒掉）：${aNav.join('、')}`); }
	if (aHome.length) { fail(`⑤-A 清单声明了工作台，但主页没有卡片（⇒ 主页看不到它）：${aHome.join('、')}`); }
}

// B. 注册式工作台 ⇒ 靠启动器兜底，前提是它真的会出现在宿主快照里
const regWb = wbPackages.filter(p => p.viewKind !== 'page');
const bProblems = [];
for (const p of regWb) {
	const libDir = path.join(pluginsRoot, p.dirName, 'lib');
	let hit = null;
	try {
		for (const f of fs.readdirSync(libDir).filter(n => n.endsWith('.js'))) {
			const text = read(path.join(libDir, f));
			if (/desktopWorkbenches\.register\(/.test(text)) { hit = { f, text }; break; }
		}
	} catch { /* 没有 lib 目录 ⇒ 下面会报 */ }
	if (!hit) {
		bProblems.push(`${p.dirName}：清单声明了工作台，但 lib/ 里没有 desktopWorkbenches.register(（⇒ 宿主快照里没有它 ⇒ 没有入口）`);
		continue;
	}
	const wantRepo = p.repository;
	if (wantRepo && !hit.text.includes(`'${wantRepo}'`) && !hit.text.includes(`"${wantRepo}"`)) {
		bProblems.push(`${p.dirName}：客户端描述符里找不到清单的 repository「${wantRepo}」（${hit.f}）`);
	}
}
const launcherUsesCoverage = /function coveredByFixedEntry\(/.test(navSrc)
	&& /filter\(w => w && w\.id && !coveredByFixedEntry\(w\.id\)(?: && !policyHiddenIds\(\)\.has\(w\.id\))?\)/.test(navSrc);
const launcherOldBlanket = /registeredExtras[\s\S]{0,400}!String\(w\.id\)\.startsWith\("vssaros\/"\)/.test(navSrc);
if (regWb.length > 0 && (!launcherUsesCoverage || launcherOldBlanket)) {
	bProblems.push('client.workbenchNav.js 的 registeredExtras 必须按 coveredByFixedEntry 过滤；'
		+ '退回「vssaros/ 开头一律排除」会让所有注册式内置工作台（如 superagent）没有任何入口');
}
if (bProblems.length === 0) {
	ok(`⑤-B 注册式工作台（${regWb.length} 个：${regWb.map(p => p.module || p.dirName).join('、')}）：客户端都真的注册了工作台，启动器按「无固定入口」兜底 ✓（列表显隐由 ⑧ 的下线名单决定）`);
} else {
	for (const m of bProblems) { fail(`⑤-B ${m}`); }
}

// C. 幽灵入口：DEFAULT_ITEMS 里的 /x/<m>/ 必须有对应的包（任何包，不限于声明了 workbench 的）
const allModules = new Set();
for (const dirName of fs.readdirSync(pluginsRoot)) {
	const pkgPath = path.join(pluginsRoot, dirName, 'package.json');
	if (!fs.existsSync(pkgPath)) { continue; }
	try { const m = readJson(pkgPath).vssaros?.module; if (m) { allModules.add(m); } } catch { /* ignore */ }
}
const ghosts = [];
for (const r of defaultRoutes) {
	const m = /^\/x\/([a-z][a-z0-9-]*)\//.exec(r);
	if (m && !allModules.has(m[1])) { ghosts.push(r); }
}
if (ghosts.length === 0) {
	ok('⑤-C 侧栏白名单里没有幽灵入口（每个 /x/<m>/ 都有对应的包）✓');
} else {
	fail(`⑤-C 侧栏白名单里有入口但没有对应的包（⇒ 「入口在、点不开」；删了模块忘了删这里）：${ghosts.join('、')}`);
}

// ── ⑤-D 「记忆」工作台卡片必须是**可用**入口（2026-11-11 用户报「工作台中缺少 记忆 item」）──
// ⚠ 11-03 起记忆**没有独立整页**（vssaros.view.kind='none'，管理 UI 在会话页「记忆」Tab）
//   ⇒ 只在 catalog.js 加一张卡片 = 得到一个点了 404 的假入口 ✗。
//   真入口是三件套：主页卡片 + DEFAULT_ITEMS 带 comp 的条目 + vssaros-memory 登记的组件页签。
//   缺任何一件都是历史反复踩的「卡片在、点不开」，且不会有任何报错 ⇒ 必须钉死。
{
	const memoryCard = /route:\s*'\/x\/memory\/',\s*name:\s*'记忆'/.test(catalogSrc);
	const memoryNav = /route:\s*"\/x\/memory\/",\s*comp:\s*"memory"/.test(navSrc);
	let memoryComp = '';
	try { memoryComp = read(path.join(HERE, 'vssaros-memory', 'lib', 'client.js')); } catch { /* 下面会报 */ }
	const memoryRegistered = /__vssarosPageComponents\.memory\s*=/.test(memoryComp)
		&& /MemoryTabView\(\{ \.\.\.props, sessionId: sid, t: t2 \}\)/.test(memoryComp);
	if (!memoryCard) { fail('⑤-D 主页工作台清单缺「记忆」卡片（/x/memory/）⇒ 用户看不到这个工作台'); }
	if (!memoryNav) { fail('⑤-D DEFAULT_ITEMS 缺 /x/memory/ 的 comp:"memory" 条目 ⇒ 卡片会去开不存在的整页（404）'); }
	if (!memoryRegistered) { fail('⑤-D vssaros-memory/lib/client.js 没登记 __vssarosPageComponents.memory ⇒ 组件页签回落成 404 iframe'); }
	// 旧 id `vssaros-wb-memory` 仍在 retired 集合里（负责清 11-03 下线的旧存档）⇒ 复用它的
	// 新条目会在每次 loadTabs() 时被清掉，表现为「记忆页签开一下就没了」✗。
	if (/id:\s*"vssaros-wb-memory",[^\n]*route:\s*"\/x\/memory\/"/.test(navSrc)) {
		fail('⑤-D 记忆条目复用了 retired 里的旧 id vssaros-wb-memory ⇒ 页签每次加载都会被清掉');
	}
	if (memoryCard && memoryNav && memoryRegistered) {
		ok('⑤-D 「记忆」工作台：主页卡片 + 组件页签条目 + MemoryTabView 登记三件齐全 ✓');
	}
}

// ── ⑥ 临时下线清单一致性（2026-11-04：看板 / 流程 / 生图暂时下线）──────────────────
// 为什么必须有：下线 = 「一份真源 + 三份清单各打标 + 五个消费点各过滤一次」；漏一处就是
//   "标了却还从某个入口冒出来"，而 ①–⑤ 只查「有没有登记」，查不到「该不该隐藏」。
//   真源 = catalog.js::OFFLINE_WORKBENCH_ROUTES；恢复上线 = 清空它 + 摘掉各处标记 ⇒ ⑥ 逐项放行/拦截。
{
	const before = problems;
	const offlineDecl = /export const OFFLINE_WORKBENCH_ROUTES = \[([^\]]*)\];/.exec(catalogSrc);
	if (!offlineDecl) {
		fail('⑥ 读不到 catalog.js::OFFLINE_WORKBENCH_ROUTES（下线真源缺失 ⇒ 本段会空跑）');
	} else {
		const offline = [...offlineDecl[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
		ok(`⑥ 临时下线清单：${offline.length} 个（${offline.join('、') || '空 = 全部上线'}）`);
		// ★ 2026-11-10（用户要求）：主页「工具」入口下线，防止有人误把它恢复成卡片
		if (offline.includes('/x/skills/')) {
			ok('⑥ 主页「工具」入口已下线（页面本体 / 直接 URL 仍保留）');
		} else {
			fail('⑥ 用户要求移除主页「工具」入口：/x/skills/ 必须在下线真源里');
		}

		// ① 运行时：主页卡片的可见清单真的过滤了（import 真模块，不比注释/字符串）
		try {
			const mod = await import(pathToFileURL(path.join(HERE, 'vssaros-dashboard', 'lib', 'catalog.js')).href);
			const visible = new Set((mod.VISIBLE_WORKBENCH_MODULES || []).map(m => m.route));
			const leaked = offline.filter(r => visible.has(r));
			const unmarked = offline.filter(r => !(mod.WORKBENCH_MODULES || []).some(m => m.route === r && m.offline === true));
			const stray = (mod.WORKBENCH_MODULES || []).filter(m => m.offline && !offline.includes(m.route)).map(m => m.route);
			if (leaked.length) { fail(`⑥ 主页卡片仍会渲染下线工作台：${leaked.join('、')}`); }
			if (unmarked.length) { fail(`⑥ catalog.js 里这些 route 没打 offline: true：${unmarked.join('、')}`); }
			if (stray.length) { fail(`⑥ 有 offline 标记但不在下线真源里（恢复时漏摘）：${stray.join('、')}`); }
			if (!leaked.length && !unmarked.length && !stray.length) { ok('⑥ 主页卡片：下线项已移出可见清单，标记与真源一致 ✓'); }
		} catch (e) {
			fail(`⑥ import catalog.js 失败（运行时判据无法执行）：${e && e.message}`);
		}
		if (!/workbench: VISIBLE_WORKBENCH_MODULES/.test(read(path.join(HERE, 'vssaros-dashboard', 'lib', 'index.js')))) {
			fail('⑥ buildDashboardPayload 没用 VISIBLE_WORKBENCH_MODULES（数据岛仍会带上下线卡片）');
		}

		// ② 侧栏条目表：offline 集合必须恰好等于真源，且每条同时 hidden（否则仍进启动器/排序）
		const navOffline = [...defaultItemsBlock.matchAll(/route: "([^"]+)"[^\n]*offline: true/g)].map(m => m[1]);
		const navBoth = [...defaultItemsBlock.matchAll(/route: "([^"]+)", hidden: true, offline: true/g)].map(m => m[1]);
		const sameSet = (a, b) => a.length === b.length && a.every(r => b.includes(r));
		if (!sameSet(navOffline, offline)) {
			fail(`⑥ DEFAULT_ITEMS 的 offline 标记与真源不一致（实际 ${navOffline.join('、') || '无'}）`);
		}
		if (!sameSet(navBoth, offline)) {
			fail('⑥ 下线条目必须同时 hidden: true, offline: true（否则仍出现在启动器/可排序列）');
		}
		if (!/if \(it\.offline\) \{ return; \}/.test(navSrc)) {
			fail('⑥ syncPinnedRows 未过滤 offline ⇒ 以前固定过的下线工作台仍会长侧栏行');
		}
		if (!/DEFAULT_ITEMS\.filter\(i => i && i\.offline\)/.test(navSrc)) {
			fail('⑥ retired 未从 offline 派生 ⇒ localStorage 里残留的下线页签会被恢复');
		}
		if (!/readLocalItems[\s\S]{0,500}!it\.offline/.test(marketIconSrc)) {
			fail('⑥ 商城「已装」格未过滤 offline ⇒ 下线工作台仍可从商城点开');
		}

		// ③ 工具页只读镜像：列出的下线条目必须打标，计数/列表只许用可见清单
		const skillsSrc = read(path.join(HERE, 'vssaros-skills', 'lib', 'index.js'));
		const mirror = /const TOOLS_WORKBENCHES = \[([\s\S]*?)\n\];/.exec(skillsSrc);
		if (!mirror) {
			fail('⑥ 读不到 TOOLS_WORKBENCHES 镜像（解析口径坏了）');
		} else {
			for (const line of mirror[1].split('\n')) {
				const r = /route: '([^']+)'/.exec(line);
				if (r && offline.includes(r[1]) && !/offline: true/.test(line)) {
					fail(`⑥ 工具页镜像里的 ${r[1]} 没打 offline: true`);
				}
			}
		}
		if (!/const VISIBLE_TOOLS_WORKBENCHES = TOOLS_WORKBENCHES\.filter\(w => !w\.offline\)/.test(skillsSrc)) {
			fail('⑥ 工具页缺 VISIBLE_TOOLS_WORKBENCHES 过滤清单');
		}
		const rawUses = (skillsSrc.match(/(?<!VISIBLE_)TOOLS_WORKBENCHES\.(?:length|map)\(/g) ?? []).length;
		if (rawUses !== 0) {
			fail(`⑥ 工具页渲染仍直接用全表 TOOLS_WORKBENCHES（${rawUses} 处 ⇒ 计数/列表会露出下线项）`);
		}
		if (problems === before) { ok('⑥ 下线链路：标记与五处入口同步 ✓'); }
	}
}

// ── ⑦ 注册式内置工作台必须在主页有卡片（2026-11-05：SuperAgent 缺失）─────────────
// 为什么还要这一段：⑤-B 只保证"启动器能看到注册式工作台"，**主页卡片是另一条路**
//   （`WorkbenchCard` 从父窗口读宿主快照补卡片）。旧代码把 `vssaros/` 开头的内置工作台
//   整类排除 ⇒ SuperAgent 有页签、有启动器项，主页卡片里却没有（用户截图实证）✗。
//   ⇒ 钉住四件事：不一刀切 / 按固定入口去重 / 走宿主注册表打开 / 内置项不误标「第三方」。
{
	const before = problems;
	const dashboardApp = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'app', 'src', 'app.jsx'));
	if (/\.indexOf\(['"]vssaros\/['"]\)\s*!==\s*0/.test(dashboardApp)) {
		fail('⑦ 主页工作台卡片仍把 vssaros/ 开头的内置注册式工作台整类排除（⇒ SuperAgent 没有卡片）');
	}
	for (const [re, why] of [
		[/function fixedEntryCovers\(/, '缺 fixedEntryCovers()：内置注册式工作台会与已有固定入口重复出卡片'],
		[/__vssarosWorkbenchItems/, '没读父窗口的固定入口表（offline / hidden 项会借这条路复活）'],
		[/function registeredCardItems\(/, '缺 registeredCardItems()：注册式工作台补卡片的统一入口'],
		[/__vssarosOpenWorkbench/, '补出来的卡片必须经宿主注册表打开，不能走 IDE 模块页路由'],
		[/data-dash-wb-registered/, '内置注册式工作台没有可断言的锚点（真机无法取证）'],
		[/item\.thirdParty && !item\.builtin \? el\('i'/, '内置注册式工作台被标成「第三方」'],
		[/'wb:vssaros\/superagent': 'robot'/, 'SuperAgent 卡片没有单色图标映射（会回落 grid）'],
	]) {
		if (!re.test(dashboardApp)) { fail(`⑦ ${why}`); }
	}
	if (problems === before) { ok('⑦ 主页卡片：内置注册式工作台按「无固定入口」补卡片，且不重复 / 不误标第三方 ✓'); }
}

// ── ⑧ 工作台列表下线名单（2026-11-13：移除「循环任务」item）──────────────────
// 为什么单列一段、不复用 ⑥：「循环任务」是**注册式**工作台（`vssaros/loop`，`view.kind='none'`），
//   没有 `/x/loop/` 页面路由 ⇒ 套不上 ⑥ 那份 route 驱动的 `OFFLINE_WORKBENCH_ROUTES`；
//   硬造一条 `/x/loop/` 白名单只会得到一个点了 404 的假入口。
// 真源 = 阶段 2 `vssaros-workbenches/lib/client.js::WORKBENCH_MANIFEST` 生成的
//   `RETIRED_WORKBENCH_IDS`（按**身份 id**）。主页卡片的 registeredCardItems() 与启动器的
//   registeredExtras() 都读 getSnapshot().workbenches ⇒ 一处过滤、两处生效，不会「主页没了、启动器还在」。
// ⚠ 只摘列表：providers 仍在 ⇒ open() / has() / 深链 / 5 个工具 / Host 路由都不受影响；
//   恢复上线 = 调整 manifest 行即可，不必重新接插件 ⇒ 下面同步钉住「插件本体一件没少」。
{
	const before = problems;
	const hostSrc = read(path.join(HERE, 'vssaros-workbenches', 'lib', 'client.js'));
	const manifestMatch = /const WORKBENCH_MANIFEST = Object\.freeze\(\[([\s\S]*?)\n\t\t\]\);/.exec(hostSrc);
	const manifestBlock = manifestMatch ? manifestMatch[1] : '';
	const manifestRows = manifestBlock ? [...manifestBlock.matchAll(/Object\.freeze\(\{([\s\S]*?)\}\)/g)].map(m => m[1]) : [];
	const fieldOf = (row, name) => { const r = new RegExp(name + ":\\s*'([^']*)'").exec(row); return r ? r[1] : ''; };
	const retired = manifestRows.map(row => ({ state: fieldOf(row, 'state'), workbenchId: fieldOf(row, 'workbenchId') }))
		.filter(row => row.state === 'retired').map(row => row.workbenchId);
	const retiredDerived = /const RETIRED_WORKBENCH_IDS = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'retired'\)\.map\(row => row\.workbenchId\);/.test(hostSrc);
	if (!manifestBlock || !manifestRows.length || !retiredDerived) {
		fail('⑧ 宿主快照缺 WORKBENCH_MANIFEST 生成的 RETIRED_WORKBENCH_IDS（下线真源丢失 ⇒ 本段会空跑）');
	} else {
		ok(`⑧ 注册式工作台下线名单：${retired.length} 个（${retired.join('、') || '空 = 全部上线'}）`);
		if (!retired.includes('vssaros/loop')) {
			fail('⑧ 用户要求移除工作台中的「循环任务」item：vssaros/loop 必须在下线真源里');
		}
		// ① 名单必须真的用于快照出口（只定义不过滤 = 假下线，item 仍在）
		if (!/workbenches: \[\.\.\.this\.providers\.values\(\)\][\s\S]{0,220}\.filter\(e => !RETIRED_WORKBENCH_IDS\.includes\(e\.id\)\)/.test(hostSrc)) {
			fail('⑧ buildSnapshot 的 workbenches 出口没按名单过滤 ⇒ 两处 item 仍会渲染');
		}
		// ② 名单里的 id 必须真对应一个声明了工作台的包（写错 id / 插件已删 ⇒ 静默失效）
		const idOfRepository = (repo) => {
			if (typeof repo !== 'string') { return ''; }
			if (repo.startsWith('vssaros:')) { return 'vssaros/' + repo.slice('vssaros:'.length); }
			const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(repo);
			return m ? (m[1] + '/' + m[2]).toLowerCase() : '';
		};
		const declaredIds = new Set(wbPackages.map(p => idOfRepository(p.repository)).filter(Boolean));
		const orphan = retired.filter(id => !declaredIds.has(id));
		if (orphan.length) { fail(`⑧ 下线名单里有找不到对应包的 id（⇒ 静默失效）：${orphan.join('、')}`); }
		// ③ 两处消费点都必须读**同一份**宿主快照的 workbenches 字段：
		//   只查「有没有 getSnapshot()」不够 —— 换成别的字段（如 snap.all）照样绕过过滤 ⇒ 必须钉住字段本身。
		//   ⚠ 用「函数名往后的定长切片」取函数体，别用带缩进的正则：缩进层级一变（或制表符被
		//     转义吞掉）就会空跑 ⇒ 守卫假绿。切片只要覆盖函数体即可（这两个函数都很短）。
		const bodyFrom = (src, marker) => { const at = src.indexOf(marker); return at < 0 ? '' : src.slice(at, at + 420); };
		const dashboardApp = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'app', 'src', 'app.jsx'));
		const dashSnap = bodyFrom(dashboardApp, 'function parentWorkbenches(');
		if (!/__vssarosWorkbenchesSnapshot/.test(dashSnap) || !/snap\.workbenches/.test(dashSnap)) {
			fail('⑧ 主页工作台卡片不读宿主快照的 workbenches ⇒ 下线名单管不到它');
		}
		const navSnap = bodyFrom(navSrc, 'function registeredExtras(');
		if (!/getSnapshot\(\)/.test(navSnap) || !/snap\.workbenches/.test(navSnap)) {
			fail('⑧ 启动器的 registeredExtras 不读宿主快照的 workbenches ⇒ 下线名单管不到它');
		}
		// ④ 可逆性：loop 插件本体 / 工作台注册 / 工具 / 路由一件都没少
		//   （读文件失败要**报红**，不能让守卫自己抛异常 ⇒ 用 try/catch 收口）
		const readSafe = (rel) => { try { return read(path.join(HERE, rel)); } catch { return ''; } };
		const loopPkgSrc = readSafe('vssaros-loop/package.json');
		const loopClient = readSafe('vssaros-loop/lib/client.js');
		const loopHost = readSafe('vssaros-loop/lib/index.js');
		let loopRepository = '';
		try { loopRepository = JSON.parse(loopPkgSrc)?.vssaros?.workbench?.repository ?? ''; } catch { /* 下面报红 */ }
		const loopIntact = loopRepository === 'vssaros:loop'
			&& /desktopWorkbenches\.register\(/.test(loopClient)
			&& /loop_list/.test(loopHost)
			&& /\/x\/loop\/api\//.test(loopHost);
		if (!loopIntact) {
			fail('⑧ loop 插件本体被删了 ⇒ 这不是可逆下线（恢复得重接插件），且 ⑤-B 会静默跳过');
		} else {
			ok('⑧ 可逆性：工作台声明 / 客户端注册 / 工具 / Host 路由都还在 ✓');
		}
		if (problems === before) { ok('⑧ 「循环任务」item：快照出口下线 + 两处入口同源 + 插件本体保留 ✓'); }
	}
}

// ── ⑨ 阶段 2：单一目录清单生成四份视图（2026-11-19）────────────────
// 不替换其它包的字面量 fallback：dashboard/catalog.js 是 Node 侧 ESM，nav DEFAULT_ITEMS
// 又承担 route 白名单并被源码守卫逐字读取。这里只钉住 workbenches 客户端的单一真源。
{
	const before = problems;
	const hostSrc = read(path.join(HERE, 'vssaros-workbenches', 'lib', 'client.js'));
	const manifestMatch = /const WORKBENCH_MANIFEST = Object\.freeze\(\[([\s\S]*?)\n\t\t\]\);/.exec(hostSrc);
	const manifestBlock = manifestMatch ? manifestMatch[1] : '';
	const manifestRows = manifestBlock ? [...manifestBlock.matchAll(/Object\.freeze\(\{([\s\S]*?)\}\)/g)].map(m => m[1]) : [];
	const fieldOf = (row, name) => { const r = new RegExp(name + ":\\s*'([^']*)'").exec(row); return r ? r[1] : ''; };
	const keys = manifestRows.map(row => fieldOf(row, 'key'));
	const states = manifestRows.map(row => fieldOf(row, 'state'));
	if (!manifestBlock || manifestRows.length === 0) { fail('⑨ 缺 WORKBENCH_MANIFEST 冻结行'); }
	if (new Set(keys).size !== keys.length) { fail('⑨ WORKBENCH_MANIFEST 的 key 必须唯一'); }
	const allowedStates = new Set(['active', 'alias', 'deprecated', 'offline', 'retired', 'hidden', 'disabled']);
	if (states.some(state => !allowedStates.has(state))) { fail('⑨ WORKBENCH_MANIFEST 含未声明的 state'); }
	if (!/const HOME_HIDDEN_PAGE_KEYS = new Set\(hiddenRows\.map\(row => row\.key\)\);/.test(hostSrc)) {
		fail('⑨ HOME_HIDDEN_PAGE_KEYS 未从 WORKBENCH_MANIFEST 生成');
	}
	if (!/const HOME_HIDDEN_WORKBENCH_IDS = new Set\(hiddenRows\.map\(row => row\.workbenchId\)\);/.test(hostSrc)) {
		fail('⑨ HOME_HIDDEN_WORKBENCH_IDS 未从 WORKBENCH_MANIFEST 生成');
	}
	if (!/const RETIRED_WORKBENCH_IDS = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'retired'\)\.map\(row => row\.workbenchId\);/.test(hostSrc)) {
		fail('⑨ RETIRED_WORKBENCH_IDS 未从 WORKBENCH_MANIFEST 生成');
	}
	if (!/const OFFLINE_WORKBENCH_ROUTES = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'offline'\)\.map\(row => row\.route\);/.test(hostSrc)) {
		fail('⑨ OFFLINE_WORKBENCH_ROUTES 未从 WORKBENCH_MANIFEST 生成');
	}
	if (!/globalThis\.__vssarosWorkbenchManifest = \(\) => WORKBENCH_MANIFEST;/.test(hostSrc)) {
		fail('⑨ 缺只读 WORKBENCH_MANIFEST 探针');
	}
	if (!/module\.exports\.workbenchManifest = workbenchManifest;/.test(hostSrc)
		|| !/module\.exports\.manifestViewsOf = manifestViewsOf;/.test(hostSrc)) {
		fail('⑨ 缺 manifest / 生成视图导出');
	}
	if (problems === before) { ok('⑨ 阶段 2：单一清单生成隐藏/退役/离线视图 + 只读探针 ✓'); }
}

// ── ⑩ 阶段 3/4：策略消费方收敛 + legacy 桥硬退役（2026-11-19）────────
// workbenches 不再读 `window.__vssarosWorkbenchItems`；其它包字面量仍保留作为 route/SSR fallback。
{
	const before = problems;
	const hostSrc = read(path.join(HERE, 'vssaros-workbenches', 'lib', 'client.js'));
	const navPolicySrc = read(path.join(HERE, 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'));
	const marketPolicySrc = read(path.join(HERE, 'vssaros-chat-surface', 'lib', 'client.market.js'));
	const dashboardCatalogSrc = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'catalog.js'));
	if (!/globalThis\.__vssarosWorkbenchPolicy = \(\) => catalogPolicyProbeOf\(service\.getCatalogSnapshot\(\)\.pages\);/.test(hostSrc)) {
		fail('⑩ 缺统一目录策略探针 __vssarosWorkbenchPolicy');
	}
	if (!/globalThis\.__vssarosWorkbenchLegacyBridgeMode = \(\) => legacyBridgeModeOf\(globalThis\);/.test(hostSrc)) {
		fail('⑩ 缺 legacy 桥模式探针');
	}
	if (!/service\.registerManifestPages\(\)/.test(hostSrc)) {
		fail('⑩ 缺 manifest active route 页注册');
	}
	if (!/globalThis\.__vssarosWorkbenchManifestPagesRegistered = true/.test(hostSrc)) {
		fail('⑩ 缺 manifest 注册完成标记');
	}
	if (/vssaros-wb-tabs-change/.test(hostSrc)) {
		fail('⑩ 仍监听旧 tabs-change ⇒ workbenches 过渡桥未硬退役');
	}
	if (/legacy catalog bridge/.test(hostSrc)) {
		fail('⑩ 仍存在 legacy catalog bridge effect');
	}
	if (!/delete globalThis\.__vssarosWorkbenchPolicy/.test(hostSrc)
		|| !/delete globalThis\.__vssarosWorkbenchLegacyBridgeMode/.test(hostSrc)
		|| !/delete globalThis\.__vssarosWorkbenchManifestPagesRegistered/.test(hostSrc)) {
		fail('⑩ 卸载时未清理阶段 3/4 探针与注册标记');
	}
	if (!/module\.exports\.catalogPolicyProbeOf = catalogPolicyProbeOf;/.test(hostSrc)
		|| !/module\.exports\.legacyBridgeModeOf = legacyBridgeModeOf;/.test(hostSrc)
		|| !/module\.exports\.__registerManifestPages/.test(hostSrc)) {
		fail('⑩ 阶段 3/4 纯函数与 manifest 注册入口未导出');
	}
	if (!/__vssarosWorkbenchPolicy/.test(navPolicySrc) || !/policyHiddenIds\(\)/.test(navPolicySrc)) {
		fail('⑩ 启动器 registeredExtras 未收敛到统一策略');
	}
	if (!/__vssarosWorkbenchPolicy/.test(marketPolicySrc) || !/policyOfflineRoutes\(\)/.test(marketPolicySrc)) {
		fail('⑩ 商城 readLocalItems 未收敛到统一策略');
	}
	if (!/const DEFAULT_ITEMS = \[/.test(navPolicySrc)
		|| !/export const WORKBENCH_MODULES = \[/.test(dashboardCatalogSrc)
		|| !/ingestLegacyCatalog\(\) \{/.test(hostSrc)) {
		fail('⑩ 硬退役必须保留其它包 route 白名单 / SSR 清单与兼容 API');
	}
	if (problems === before) { ok('⑩ 阶段 3/4：策略消费方收敛 + workbenches legacy 桥硬退役，跨包 fallback 保留 ✓'); }
}

console.log(problems === 0
	? '\n[check-workbench-catalog] ✓ 工作台清单一致性守卫通过'
	: `\n[check-workbench-catalog] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
