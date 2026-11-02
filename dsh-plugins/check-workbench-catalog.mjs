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
import { fileURLToPath } from 'node:url';

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
	&& /filter\(w => w && w\.id && !coveredByFixedEntry\(w\.id\)\)/.test(navSrc);
const launcherOldBlanket = /registeredExtras[\s\S]{0,400}!String\(w\.id\)\.startsWith\("vssaros\/"\)/.test(navSrc);
if (regWb.length > 0 && (!launcherUsesCoverage || launcherOldBlanket)) {
	bProblems.push('client.workbenchNav.js 的 registeredExtras 必须按 coveredByFixedEntry 过滤；'
		+ '退回「vssaros/ 开头一律排除」会让所有注册式内置工作台（如 loop）没有任何入口');
}
if (bProblems.length === 0) {
	ok(`⑤-B 注册式工作台（${regWb.length} 个：${regWb.map(p => p.module || p.dirName).join('、')}）：都会进宿主快照，启动器按「无固定入口」兜底 ✓`);
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

console.log(problems === 0
	? '\n[check-workbench-catalog] ✓ 工作台清单一致性守卫通过'
	: `\n[check-workbench-catalog] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
