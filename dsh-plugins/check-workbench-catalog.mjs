#!/usr/bin/env node
// check-workbench-catalog.mjs ★ 单一工作台目录 + 投影一致性守卫
//
// 旧版守卫逐字钉住三份手维护清单（DSH_MODULE_PAGES / WORKBENCH_MODULES / DEFAULT_ITEMS）。
// 现在唯一真源是 dsh-plugins/workbench-directory.mjs；浏览器 chunk 与 Host ESM 消费方都由
// scripts/generate-workbench-directory.mjs 生成投影。此守卫校验：
//   ① 生成区块 / 生成文件与真源 hash 一致；
//   ② 源码里不再出现跨包字面量 fallback 或旧全局清单；
//   ③ workbenches 发布 entries / subscribe / catalog-change 事件并完成硬退役；
//   ④ 单一目录自身的 hidden/offline/retired/active/routeWhitelist 投影合法。
//
// 跑法：node dsh-plugins/check-workbench-catalog.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = p => fs.readFileSync(p, 'utf8');
const readJson = p => JSON.parse(read(p));
const has = (text, pattern) => typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

let problems = 0;
const fail = msg => { problems++; console.log(`  ✗ ${msg}`); };
const ok = msg => console.log(`  ✔ ${msg}`);

const sourcePath = path.join(HERE, 'workbench-directory.mjs');
const generatorPath = path.join(HERE, 'scripts', 'generate-workbench-directory.mjs');
if (!fs.existsSync(sourcePath)) { fail('缺单一目录真源 dsh-plugins/workbench-directory.mjs'); }
if (!fs.existsSync(generatorPath)) { fail('缺生成器 dsh-plugins/scripts/generate-workbench-directory.mjs'); }

const source = await import(pathToFileURL(sourcePath).href);
const generator = await import(pathToFileURL(generatorPath).href);
const generatedProblems = await generator.checkGenerated();
for (const problem of generatedProblems) { fail(`生成投影：${problem}`); }
if (generatedProblems.length === 0) {
	ok(`单一目录投影：6 个生成区块 / 2 个生成文件均与真源一致（版本 ${source.WORK_DIRECTORY_VERSION}）`);
}

const hostSrc = read(path.join(HERE, 'vssaros-workbenches', 'lib', 'client.js'));
const navSrc = read(path.join(HERE, 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'));
const marketSrc = read(path.join(HERE, 'vssaros-chat-surface', 'lib', 'client.market.js'));
const catalogSrc = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'catalog.js'));
const skillsSrc = read(path.join(HERE, 'vssaros-skills', 'lib', 'index.js'));
const appSrc = read(path.join(HERE, 'vssaros-dashboard', 'lib', 'app', 'src', 'app.jsx'));

// ── ① 跨包字面量 fallback 与旧全局清单必须消失 ─────────────────────────
for (const [name, text, forbidden] of [
	['workbenches/client.js', hostSrc, ['__vssarosWorkbenchItems', 'ingestLegacyCatalog', 'legacyCatalogDisposers', 'legacy catalog bridge', 'vssaros-wb-tabs-change']],
	['client.workbenchNav.js', navSrc, ['__vssarosWorkbenchItems']],
	['client.market.js', marketSrc, ['__vssarosWorkbenchItems']],
	['dashboard/catalog.js', catalogSrc, ['export const WORKBENCH_MODULES = [', 'export const OFFLINE_WORKBENCH_ROUTES = [']],
	['skills/index.js', skillsSrc, ['const TOOLS_WORKBENCHES = [', '__vssarosWorkbenchItems']],
	['dashboard/app.jsx', appSrc, ['__vssarosWorkbenchItems']],
]) {
	const leaked = forbidden.filter(token => has(text, token));
	if (leaked.length) { fail(`${name} 仍含旧目录/字面量 fallback：${leaked.join('、')}`); }
}
if (!has(catalogSrc, "export { WORKBENCH_MODULES, VISIBLE_WORKBENCH_MODULES, OFFLINE_WORKBENCH_ROUTES } from './workbench-directory.generated.js';")) {
	fail('dashboard/catalog.js 未重导出单一目录生成文件');
}
if (!has(skillsSrc, "from './workbench-directory.generated.js'")) {
	fail('skills/index.js 未引用单一目录生成文件');
}
for (const [name, text, tokens] of [
	['workbenches/client.js', hostSrc, ['@generated-workbench-directory', 'function catalogEntriesOf(', 'module.exports.catalogEntriesOf']],
	['client.workbenchNav.js', navSrc, ['@generated-workbench-directory', 'const DEFAULT_ITEMS = [']],
	['client.market.js', marketSrc, ['@generated-workbench-directory', 'GENERATED_INSTALLED_ITEMS']],
	['dashboard/app.jsx', appSrc, ['@generated-workbench-directory', 'GENERATED_FIXED_ENTRIES', 'function parentFixedEntries(']],
]) {
	const missing = tokens.filter(token => !has(text, token));
	if (missing.length) { fail(`${name} 缺生成视图接线：${missing.join('、')}`); }
}
if (problems === 0) { ok('跨包 fallback 已删除：旧全局清单、三份手写清单与兼容 API 均不存在'); }

// ── ② 单一目录运行时出口：entries / subscribe / event / 硬退役 ───────────
for (const [token, why] of [
	['globalThis.__vssarosWorkbenchCatalogEntries = () => catalogEntriesOf(service.getCatalogSnapshot().pages);', '缺 entries 探针'],
	['globalThis.__vssarosWorkbenchCatalogSubscribe = listener => service.subscribeCatalog(listener);', '缺 catalog 订阅探针'],
	['globalThis.__vssarosWorkbenchPolicy = () => catalogPolicyProbeOf(service.getCatalogSnapshot().pages);', '缺策略探针'],
	['vssaros-wb-catalog-change', 'publishCatalog 未派发目录变更事件'],
	['delete globalThis.__vssarosWorkbenchCatalogEntries', '卸载未清理 entries 探针'],
	['delete globalThis.__vssarosWorkbenchCatalogSubscribe', '卸载未清理订阅探针'],
	['service.registerManifestPages()', '缺 manifest active route 页注册'],
	['globalThis.__vssarosWorkbenchManifestPagesRegistered = true', '缺 manifest 注册完成标记'],
	['module.exports.__registerManifestPages', '缺 manifest 注册测试入口'],
	['return policyReady && entriesReady ? \'retired\' : \'pending\';', 'legacy 桥模式未收敛为硬退役两态'],
]) {
	if (!has(hostSrc, token)) { fail(`workbenches/client.js ${why}`); }
}
if (!/publishCatalog\(\) \{[\s\S]{0,600}vssaros-wb-catalog-change/.test(hostSrc)) {
	fail('publishCatalog() 没有派发 vssaros-wb-catalog-change');
}
if (!/const HOME_HIDDEN_PAGE_KEYS = new Set\(hiddenRows\.map\(row => row\.key\)\);/.test(hostSrc)
	|| !/const HOME_HIDDEN_WORKBENCH_IDS = new Set\(hiddenRows\.map\(row => row\.workbenchId\)\);/.test(hostSrc)
	|| !/const RETIRED_WORKBENCH_IDS = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'retired'\)/.test(hostSrc)
	|| !/const OFFLINE_WORKBENCH_ROUTES = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'offline'\)/.test(hostSrc)) {
	fail('workbenches/client.js 的下线/退役/离线视图未由 WORKBENCH_MANIFEST 生成');
}
if (problems === 0) { ok('运行时出口：entries / subscribe / catalog-change / hard-retired 模式齐全'); }

// ── ③ 单一目录自身投影合法 ─────────────────────────────────────────────
const manifestRows = source.manifestRowsOf();
const keys = manifestRows.map(row => row.key);
const hiddenRows = manifestRows.filter(row => row.state === 'hidden');
const offlineRows = manifestRows.filter(row => row.state === 'offline');
const retiredRows = manifestRows.filter(row => row.state === 'retired');
const activeRows = manifestRows.filter(row => row.state === 'active' && row.sourceKind === 'manifest');
if (new Set(keys).size !== keys.length) { fail('WORKBENCH_MANIFEST key 重复'); }
// ★ 2026-11-21：把「必须 N 行」的硬编码计数换成从真源派生的结构性不变量。
//   增删目录行不再需要同步改守卫数字；生成区块与真源逐字一致已由 ① checkGenerated() 保证。
if (!manifestRows.length) { fail('WORKBENCH_MANIFEST 不能为空'); }
const states = new Set(['hidden', 'offline', 'retired', 'active']);
if (manifestRows.some(row => !states.has(row.state))) { fail('目录行出现未知 state'); }
const visibilityKeys = new Set(Object.keys(source.VISIBILITY_IDENTIFIERS || {}));
if (visibilityKeys.size && manifestRows.some(row => !visibilityKeys.has(row.visibilityKey))) {
	fail('目录行出现未登记的 visibilityKey');
}
if (hiddenRows.some(row => row.start !== false || !row.hidden)) {
	fail('hidden 行必须 start=false 且 hidden=true（避免与开始页卡重复）');
}
for (const row of hiddenRows) {
	if (!source.hiddenWorkbenchIdsOf().includes(row.workbenchId)) { fail(`hidden 身份视图缺 ${row.workbenchId}`); }
}
if (offlineRows.some(row => row.start !== false || !row.routeWhitelist)) {
	fail('offline 行必须 start=false 且保留 route 白名单');
}
if (retiredRows.length !== 1 || retiredRows[0]?.workbenchId !== 'vssaros/loop') { fail('retired 必须恰好保留 vssaros/loop'); }
if (activeRows.some(row => row.start !== true || !row.route)) {
	fail('active manifest route 页必须 start=true 且有 route');
}
for (const [name, rows] of [
	['nav', source.navItemsOf()], ['dashboard', source.dashboardModulesOf()],
	['tools', source.toolsWorkbenchesOf()], ['installed', source.installedItemsOf()],
	['fixed', source.fixedEntriesOf()],
]) {
	if (!rows.length) { fail(`${name} 投影为空`); }
	const rowKeys = rows.map(row => row.key);
	if (new Set(rowKeys).size !== rowKeys.length) { fail(`${name} 投影 key 重复`); }
	if (rows.some(row => !row.route)) { fail(`${name} 投影存在无 route 的条目`); }
}
const routeWhitelist = [...source.routeWhitelistOf()];
for (const row of source.directoryRowsOf()) {
	if (row.routeWhitelist && row.route && !routeWhitelist.includes(row.route)) {
		fail(`routeWhitelist 缺 ${row.route}`);
	}
}
for (const route of ['/x/dashboard/', '/x/sessions/', '/x/sessions/?view=tiles', '/x/kanban/', '/x/workflow/', '/x/kb/', '/x/memory/', '/x/codebase/', '/x/media/', '/x/imagegen/', '/x/skills/', '/x/scheduler/', '/x/marketplace/']) {
	if (!routeWhitelist.includes(route)) { fail(`routeWhitelist 缺深链 ${route}`); }
}
const startCards = source.startCardsOf();
if (!startCards.length) { fail('开始页 canonical 投影不能为空'); }
if (startCards.some(key => !keys.includes(key))) { fail('开始页卡片必须来自 WORKBENCH_MANIFEST'); }
const startTitles = manifestRows.filter(row => row.start).map(row => row.title);
if (new Set(startTitles).size !== startTitles.length) { fail('开始页 canonical 卡片标题重复'); }
const kbHiddenRow = manifestRows.find(row => row.key === 'vssaros/kb/default');
if (!kbHiddenRow || kbHiddenRow.state !== 'hidden' || kbHiddenRow.start !== false) {
	fail('注册式知识库默认页必须作为 hidden 行登记，避免与 manifest 路由卡重复');
}
if (!source.hiddenWorkbenchIdsOf().includes('vssaros/kb')) {
	fail('隐藏身份视图必须包含 vssaros/kb');
}
if (!source.startCardsOf().includes('manifest:/x/kb//vssaros-wb-kb')) {
	fail('开始页必须保留单一目录生成的知识库 manifest 卡');
}
if (!/description: row\.description \|\| ''/.test(hostSrc) || !/package: row\.sourcePackage \|\| ''/.test(hostSrc)) {
	fail('manifest 卡片必须使用目录行里的描述与来源，不能回退到空占位');
}
if (problems === 0) { ok(`目录投影：${manifestRows.length} 行 manifest / ${source.navItemsOf().length} 条 nav / ${routeWhitelist.length} 条 route whitelist 校验通过`); }

// ── ④ 生成文件必须进入包 files 白名单 ───────────────────────────────────
for (const [name, pkgPath, entry] of [
	['dashboard', path.join(HERE, 'vssaros-dashboard', 'package.json'), 'lib/workbench-directory.generated.js'],
	['skills', path.join(HERE, 'vssaros-skills', 'package.json'), 'lib/workbench-directory.generated.js'],
]) {
	const pkg = readJson(pkgPath);
	if (!Array.isArray(pkg.files) || !pkg.files.includes(entry)) { fail(`${name} package.json files 未包含 ${entry}`); }
}
const workbenchesPkg = readJson(path.join(HERE, 'vssaros-workbenches', 'package.json'));
if (!has(hostSrc, `globalThis.__vssarosWorkbenchBuild = '${workbenchesPkg.version}';`)) {
	fail('workbenches 构建标记与 package.json 版本不一致');
}
if (problems === 0) { ok('包清单 / 构建标记：生成文件已进入 files 白名单'); }

console.log(problems === 0
	? '\n[check-workbench-catalog] ✓ 单一目录 + 投影一致性守卫通过'
	: `\n[check-workbench-catalog] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
