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
const HOST_EXEMPT = {
	scheduler: '定时任务是"自动化任务"不是工作台 ⇒ 主页不收（但侧栏有它 ⇒ 必须在 DEFAULT_ITEMS 里）',
};

const missingNav = [];
const missingHome = [];
for (const { module, route } of pageModules) {
	if (!navItems.has(route)) { missingNav.push(`${module}(${route})`); }
	if (!homeCards.has(route) && !HOST_EXEMPT[module]) { missingHome.push(`${module}(${route})`); }
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

console.log(problems === 0
	? '\n[check-workbench-catalog] ✓ 工作台清单一致性守卫通过'
	: `\n[check-workbench-catalog] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
