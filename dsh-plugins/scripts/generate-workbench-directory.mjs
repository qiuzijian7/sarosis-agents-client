#!/usr/bin/env node
/**
 * 从 dsh-plugins/workbench-directory.mjs 生成所有包的工作台投影。
 * 浏览器 client.*.js 不能 import/require 相对模块，因此这里把同一份目录数据内联成带 hash 的 generated block。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS = path.resolve(HERE, '..');
const SOURCE = path.join(PLUGINS, 'workbench-directory.mjs');
let sourcePromise = null;

const read = file => fs.readFileSync(file, 'utf8');
const write = (file, text) => fs.writeFileSync(file, text, 'utf8');
const q = value => JSON.stringify(String(value ?? ''));
const sq = value => "'" + String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const bool = value => value ? 'true' : 'false';

async function sourceModule() {
	if (!sourcePromise) { sourcePromise = import(pathToFileURL(SOURCE).href); }
	return sourcePromise;
}
function sourceHash() {
	return crypto.createHash('sha256').update(read(SOURCE)).digest('hex').slice(0, 12);
}
function marker(name, content, hash) {
	return `/* @generated-workbench-directory:start ${name} hash=${hash} */\n${content}\n/* @generated-workbench-directory:end ${name} */`;
}
function fileHeader(hash) {
	return `/* @generated-workbench-directory:file hash=${hash} */`;
}

function emitRow(row, visibilityIdentifiers) {
	const visibility = visibilityIdentifiers[row.visibilityKey] || 'ROUTE_VISIBILITY';
	const aliases = row.aliases.map(q).join(', ');
	const fields = [
		['key', q(row.key)], ['workbenchId', q(row.workbenchId)], ['pageId', q(row.pageId)],
		['canonicalId', q(row.canonicalId)], ['state', q(row.state)], ['visibility', visibility],
		['aliases', `Object.freeze([${aliases}])`], ['replacedBy', q(row.replacedBy)],
		['route', q(row.route)], ['title', q(row.title)], ['description', q(row.description)],
		['icon', q(row.icon)], ['sourceKind', q(row.sourceKind)], ['sourcePackage', q(row.sourcePackage)],
		['component', q(row.component)], ['manifest', bool(row.manifest)],
		['nav', bool(row.nav)], ['dashboard', bool(row.dashboard)], ['tools', bool(row.tools)],
		['installed', bool(row.installed)], ['fixed', bool(row.fixed)],
		['hidden', bool(row.hidden)], ['offline', bool(row.offline)], ['alwaysPinned', bool(row.alwaysPinned)],
		['routeWhitelist', bool(row.routeWhitelist)], ['deepLink', bool(row.deepLink)],
		['start', bool(row.start)], ['launcher', bool(row.launcher)], ['nativeTab', bool(row.nativeTab)],
		['manifestOrder', String(row.manifestOrder)], ['directoryOrder', String(row.directoryOrder)],
		['navOrder', String(row.navOrder)], ['dashboardOrder', String(row.dashboardOrder)],
		['toolsOrder', String(row.toolsOrder)], ['installedOrder', String(row.installedOrder)],
		['fixedOrder', String(row.fixedOrder)], ['navId', q(row.navId)], ['navName', q(row.navName)],
		['navIcon', q(row.navIcon)], ['navHidden', bool(row.navHidden)], ['navOffline', bool(row.navOffline)],
		['navComp', q(row.navComp)], ['dashboardName', q(row.dashboardName)],
		['dashboardDesc', q(row.dashboardDesc)], ['dashboardIcon', q(row.dashboardIcon)],
		['dashboardOffline', bool(row.dashboardOffline)], ['dashboardAlwaysPinned', bool(row.dashboardAlwaysPinned)],
		['toolsName', q(row.toolsName)], ['toolsDesc', q(row.toolsDesc)],
		['toolsProvider', q(row.toolsProvider)], ['toolsOffline', bool(row.toolsOffline)],
	];
	return `\t\t\tObject.freeze({ ${fields.map(([k, v]) => `${k}: ${v}`).join(', ')} })`;
}

function renderWorkbenchesBlock(src) {
	const constants = [
		'\t\tconst HIDDEN_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: true, routeWhitelist: true, deepLink: true });',
		'\t\tconst OFFLINE_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: true, deepLink: true });',
		'\t\tconst RETIRED_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: false, deepLink: false });',
		'\t\tconst ACTIVE_VISIBILITY = Object.freeze({ start: true, launcher: true, nativeTab: true, routeWhitelist: true, deepLink: true });',
		'\t\tconst ROUTE_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: true, deepLink: true });',
	].join('\n');
	const manifest = src.manifestRowsOf().map(row => emitRow(row, src.VISIBILITY_IDENTIFIERS) + ',').join('\n');
	const rows = src.directoryRowsOf().map(row => emitRow(row, src.VISIBILITY_IDENTIFIERS) + ',').join('\n');
	return `${constants}\n\t\tconst WORKBENCH_MANIFEST = Object.freeze([\n${manifest}\n\t\t]);\n\t\tconst WORK_DIRECTORY_ROWS = Object.freeze([\n${rows}\n\t\t]);`;
}

function renderNavBlock(src) {
	const lines = src.navItemsOf().map(row => {
		let flags = '';
		if (row.navHidden) { flags += ', hidden: true'; }
		if (row.navOffline) { flags += ', offline: true'; }
		if (row.navComp) { flags += ', comp: ' + q(row.navComp); }
		return `\t\t\t{ id: ${q(row.navId)}, name: ${q(row.navName)}, ico: ${q(row.navIcon)}, route: ${q(row.route)}${flags} },`;
	});
	return `const DEFAULT_ITEMS = [\n${lines.join('\n')}\n\t\t];`;
}

function renderDashboardModules(src) {
	return src.dashboardModulesOf().map(row => {
		const extras = [];
		if (row.dashboardAlwaysPinned) { extras.push('alwaysPinned: true'); }
		if (row.dashboardOffline) { extras.push('offline: true'); }
		const suffix = extras.length ? ', ' + extras.join(', ') : '';
		return `\t{ route: ${sq(row.route)}, name: ${sq(row.dashboardName)}, desc: ${sq(row.dashboardDesc)}, icon: ${sq(row.dashboardIcon)}${suffix} },`;
	});
}

function renderDashboardGeneratedFile(src, hash) {
	const routes = src.offlineRoutesOf().map(sq).join(', ');
	const lines = renderDashboardModules(src);
	return `${fileHeader(hash)}\nexport const OFFLINE_WORKBENCH_ROUTES = [${routes}];\n\nexport const WORKBENCH_MODULES = [\n${lines.join('\n')}\n];\n\nexport const VISIBLE_WORKBENCH_MODULES = WORKBENCH_MODULES.filter(m => !m.offline);\n`;
}

function renderSkillsGeneratedFile(src, hash) {
	const lines = src.toolsWorkbenchesOf().map(row => {
		const suffix = row.toolsOffline ? ', offline: true' : '';
		return `\t{ name: ${sq(row.toolsName)}, desc: ${sq(row.toolsDesc)}, route: ${sq(row.route)}, provider: ${sq(row.toolsProvider)}${suffix} },`;
	});
	return `${fileHeader(hash)}\nexport const TOOLS_WORKBENCHES = [\n${lines.join('\n')}\n];\n\nexport const VISIBLE_TOOLS_WORKBENCHES = TOOLS_WORKBENCHES.filter(w => !w.offline);\n`;
}

function renderCatalogBlock() {
	return `export { WORKBENCH_MODULES, VISIBLE_WORKBENCH_MODULES, OFFLINE_WORKBENCH_ROUTES } from './workbench-directory.generated.js';`;
}

function renderSkillsBlock() {
	return [
		`import { TOOLS_WORKBENCHES as GENERATED_TOOLS_WORKBENCHES, VISIBLE_TOOLS_WORKBENCHES as GENERATED_VISIBLE_TOOLS_WORKBENCHES } from './workbench-directory.generated.js';`,
		`const TOOLS_WORKBENCHES = GENERATED_TOOLS_WORKBENCHES;`,
		`const VISIBLE_TOOLS_WORKBENCHES = GENERATED_VISIBLE_TOOLS_WORKBENCHES;`,
	].join('\n');
}

function renderMarketBlock(src) {
	const lines = src.installedItemsOf().map(row => {
		return `\t\t\t{ id: ${q(row.navId)}, name: ${q(row.navName)}, ico: ${q(row.navIcon)}, route: ${q(row.route)}, offline: ${bool(row.navOffline)} },`;
	});
	return [
		`const GENERATED_INSTALLED_ITEMS = [`,
		lines.join('\n'),
		`\t\t];`,
		`function readLocalItems() {`,
		`\treturn GENERATED_INSTALLED_ITEMS.filter(it => it && it.id && it.route && !it.offline).map(it => ({`,
		`\t\tid: String(it.id),`,
		`\t\tworkbenchId: String(it.id),`,
		`\t\tname: String(it.name || it.id),`,
		`\t\ticon: wbIconEmoji(it.ico),`,
		`\t\troute: String(it.route),`,
		`\t\tcategory: "local",`,
		`\t\tlocal: true,`,
		`\t\tlisted: false,`,
		`\t\tinstalled: true,`,
		`\t\tinstallable: false,`,
		`\t\tdescription: "本机随产品分发的工作台。",`,
		`\t\tauthor: "VsSaros（本机）",`,
		`\t\tscreenshots: [],`,
		`\t\towner: "",`,
		`\t\tversion: "",`,
		`\t}));`,
		`}`,
	].join('\n');
}

function renderAppBlock(src) {
	const lines = src.fixedEntriesOf().map(row => {
		return `\t{ id: ${q(row.navId)}, route: ${q(row.route)}, hidden: ${bool(row.navHidden)}, offline: ${bool(row.navOffline)} },`;
	});
	return [
		`const GENERATED_FIXED_ENTRIES = [`,
		lines.join('\n'),
		`];`,
		``,
		`function parentFixedEntries() {`,
		`\treturn GENERATED_FIXED_ENTRIES;`,
		`}`,
	].join('\n');
}

const TARGETS = [
	{
		name: 'workbenches-client',
		file: 'vssaros-workbenches/lib/client.js',
		render: renderWorkbenchesBlock,
		legacy: { start: 'const HIDDEN_VISIBILITY =', end: '\n\t\t]);' },
	},
	{
		name: 'chat-surface-nav',
		file: 'vssaros-chat-surface/lib/client.workbenchNav.js',
		render: renderNavBlock,
		legacy: { start: 'const DEFAULT_ITEMS = [', end: '\n\t\t\t];' },
	},
	{
		name: 'dashboard-catalog',
		file: 'vssaros-dashboard/lib/catalog.js',
		render: renderCatalogBlock,
		legacy: {
			start: 'export const OFFLINE_WORKBENCH_ROUTES = [',
			end: 'export const VISIBLE_WORKBENCH_MODULES = WORKBENCH_MODULES.filter(m => !m.offline);',
		},
	},
	{
		name: 'skills-mirror',
		file: 'vssaros-skills/lib/index.js',
		render: renderSkillsBlock,
		legacy: {
			start: 'const TOOLS_WORKBENCHES = [',
			end: 'const VISIBLE_TOOLS_WORKBENCHES = TOOLS_WORKBENCHES.filter(w => !w.offline);',
		},
	},
	{
		name: 'market-installed-items',
		file: 'vssaros-chat-surface/lib/client.market.js',
		render: renderMarketBlock,
		legacy: {
			start: '/** 阶段 3：统一目录策略里的离线 route；探针缺席时返回空数组，保留字面量 offline 过滤。 */',
			end: '\n\t\t\t/** 复制文本',
			keep: '\r\n\t\t\t/** 复制文本',
		},
	},
	{
		name: 'dashboard-app-fixed-entries',
		file: 'vssaros-dashboard/lib/app/src/app.jsx',
		render: renderAppBlock,
		legacy: {
			start: '/** 父窗口的侧栏固定入口表（含 hidden / offline 项 ⇒ 覆盖比「可见卡片」完整）。 */',
			end: '\r\n\r\n/**\r\n * 内置注册式工作台是否已有固定入口',
			keep: '\r\n\r\n/**\r\n * 内置注册式工作台是否已有固定入口',
		},
	},
];

const GENERATED_FILES = [
	{
		name: 'dashboard-generated',
		file: 'vssaros-dashboard/lib/workbench-directory.generated.js',
		render: renderDashboardGeneratedFile,
	},
	{
		name: 'skills-generated',
		file: 'vssaros-skills/lib/workbench-directory.generated.js',
		render: renderSkillsGeneratedFile,
	},
];

function startMarker(name) { return `/* @generated-workbench-directory:start ${name} `; }
function endMarker(name) { return `/* @generated-workbench-directory:end ${name} */`; }

function replaceMarkers(text, name, expected) {
	const start = text.indexOf(startMarker(name));
	if (start < 0) { return null; }
	const end = text.indexOf(endMarker(name), start);
	if (end < 0) { return null; }
	return text.slice(0, start) + expected + text.slice(end + endMarker(name).length);
}

function replaceLegacy(text, target, expected) {
	const { start, end, keep } = target.legacy;
	const s = text.indexOf(start);
	if (s < 0) { return null; }
	const e = text.indexOf(end, s + start.length);
	if (e < 0) { return null; }
	const tail = keep ? keep + text.slice(e + end.length) : text.slice(e + end.length);
	return text.slice(0, s) + expected + '\n' + tail;
}

export async function checkGenerated() {
	const problems = [];
	const src = await sourceModule();
	const hash = sourceHash();
	for (const target of TARGETS) {
		const file = path.join(PLUGINS, target.file);
		if (!fs.existsSync(file)) { problems.push(`${target.name}: 缺文件 ${target.file}`); continue; }
		const expected = marker(target.name, target.render(src, hash), hash);
		const text = read(file);
		const start = text.indexOf(startMarker(target.name));
		const end = text.indexOf(endMarker(target.name), start);
		if (start < 0 || end < 0) {
			problems.push(`${target.name}: 缺 generated 标记 ${target.file}`);
			continue;
		}
		const actual = text.slice(start, end + endMarker(target.name).length);
		if (actual !== expected) { problems.push(`${target.name}: generated 投影与单一目录真源不一致 ${target.file}`); }
	}
	for (const generated of GENERATED_FILES) {
		const file = path.join(PLUGINS, generated.file);
		if (!fs.existsSync(file)) { problems.push(`${generated.name}: 缺生成文件 ${generated.file}`); continue; }
		const expected = generated.render(src, hash);
		if (read(file) !== expected) { problems.push(`${generated.name}: 生成文件与单一目录真源不一致 ${generated.file}`); }
	}
	return problems;
}

export async function generate() {
	const src = await sourceModule();
	const hash = sourceHash();
	for (const target of TARGETS) {
		const file = path.join(PLUGINS, target.file);
		const expected = marker(target.name, target.render(src, hash), hash);
		let text = read(file);
		const replaced = replaceMarkers(text, target.name, expected);
		if (replaced === null) {
			const legacy = replaceLegacy(text, target, expected);
			if (legacy === null) { throw new Error(`找不到 ${target.name} 的 legacy 清单区块：${target.file}`); }
			text = legacy;
		} else {
			text = replaced;
		}
		write(file, text);
	}
	for (const generated of GENERATED_FILES) {
		write(path.join(PLUGINS, generated.file), generated.render(src, hash));
	}
	return { hash, targets: TARGETS.length, generatedFiles: GENERATED_FILES.length };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
	if (process.argv.includes('--check')) {
		const problems = await checkGenerated();
		if (problems.length) {
			for (const problem of problems) { console.log(`  ✗ ${problem}`); }
			console.log(`\n[generate-workbench-directory] ✗ ${problems.length} 项问题`);
			process.exit(1);
		} else {
			console.log(`[generate-workbench-directory] ✓ 单一目录投影一致（${TARGETS.length} 个区块 / ${GENERATED_FILES.length} 个生成文件）`);
		}
	} else {
		const result = await generate();
		console.log(`[generate-workbench-directory] ✓ 已生成 ${result.targets} 个区块 / ${result.generatedFiles} 个文件，hash=${result.hash}`);
	}
}
