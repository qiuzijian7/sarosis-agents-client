/**
 * 主页 React 应用的**构建脚本**（esbuild 预打包）。
 *
 * 为什么必须预打包：主页是独立文档，没有 `window.__ModuleLoader__`，而 dsh 客户端壳的
 * `require` 只解析平台种子词（react / react-dom / …）⇒ 第三方依赖与 JSX **只能自己打成单文件**。
 *
 * 用法（仓库根）：
 *   node dsh-plugins/vssaros-dashboard/vendor/build.mjs            # 构建 dist
 *   node dsh-plugins/vssaros-dashboard/vendor/build.mjs --preview  # 另外产出一个本地预览页（验视觉/交互）
 *
 * 产物（都要进 package.json 的 files 白名单）：
 *   lib/app/dist/dashboard-app.js    —— React + 应用的 IIFE 单文件
 *   lib/app/dist/dashboard-app.css   —— 应用样式（原样拷贝；注释里可以有反引号，不必内联进页面）
 *
 * ⚠ 为什么 React 不额外 vendor：本仓根 `node_modules` 已有 react/react-dom 18.3.1（构建期依赖），
 *   esbuild 直接打进去 ⇒ 插件目录里没有 node_modules，`files` 只有两个产物 ✓。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const srcDir = resolve(pluginRoot, 'lib/app/src');
const outDir = resolve(pluginRoot, 'lib/app/dist');

mkdirSync(outDir, { recursive: true });

const result = await build({
	entryPoints: [resolve(srcDir, 'app.jsx')],
	outfile: resolve(outDir, 'dashboard-app.js'),
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['chrome110'],
	minify: true,
	sourcemap: false,
	legalComments: 'none',
	jsx: 'transform',
	loader: { '.jsx': 'jsx' },
	logLevel: 'info',
	metafile: true,
});

const css = readFileSync(resolve(srcDir, 'app.css'), 'utf8');
writeFileSync(resolve(outDir, 'dashboard-app.css'), css, 'utf8');

const jsSize = statSync(resolve(outDir, 'dashboard-app.js')).size;
console.log(`\n产物：`);
console.log(`  lib/app/dist/dashboard-app.js   ${(jsSize / 1024).toFixed(1)} KB`);
console.log(`  lib/app/dist/dashboard-app.css  ${(css.length / 1024).toFixed(1)} KB`);
const inputs = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs ?? {});
console.log(`  inputs: ${inputs.length} 个（react 是否进来：${inputs.some(i => i.includes('node_modules/react/')) ? '是' : '否'}）`);

/* ── 可选：本地预览页（把宿主将要渲染的壳 + 假数据写成一个文件）─────────────────
   为什么要有它：真机验证需要重装插件 + 重启 Host；这个预览页用**同一份产物 + 同一份壳**，
   在浏览器里就能验视觉与交互（拖拽/缩放/增删/存盘被桩掉）。 */
if (process.argv.includes('--preview')) {
	const scope = resolve(pluginRoot, '../../poc/dashboard-react-build');
	mkdirSync(scope, { recursive: true });

	const now = Date.now();
	// ⚠ 预览用的假数据必须与**宿主真实产出的数据岛同形**（否则预览绿、真机红）：
	//   `sessions` 是 `catalog.sessionRowModel()` 的产物（纯文本行），`workspaces` 是 `groupByCwd()`
	//   的产物，`usage` 是 `usageBuckets()` 的产物，`workbench` 是 `WORKBENCH_MODULES`。
	const mkSession = (i, title, agent, turns, steps, llmMs, toolMs, tokens, flags = {}) => ({
		id: `session-demo-${i}`,
		title,
		cold: !flags.active,
		lines: [
			`……/sarosis-agents-client · ${agent} · 2026-10-22 1${i}:0${i} · 来源 cache`,
			`turn ${turns} · step ${steps} · LLM ${(llmMs / 60000).toFixed(1)}m · 工具 ${(toolMs / 1000).toFixed(0)}s`,
			`token：输入 ${(tokens.uncachedInput / 1000).toFixed(0)}k · 输出 ${(tokens.output / 1000).toFixed(0)}k · 读缓存 ${(tokens.cacheRead / 1000).toFixed(0)}k · 表面 0`,
			...(flags.active ? ['运行中：⏳ 回合进行中'] : []),
		],
	});
	const sessions = [
		mkSession(1, '重构聊天框布局', 'frontend', 18, 96, 620_000, 180_000, { uncachedInput: 182_000, output: 24_000, cacheRead: 410_000, cacheWrite: 12_000 }),
		mkSession(2, 'dsh 插件安装排查', 'researcher', 9, 54, 380_000, 92_000, { uncachedInput: 96_000, output: 11_000, cacheRead: 210_000, cacheWrite: 8_000 }, { active: true }),
		mkSession(3, '知识库索引重建', 'backend', 31, 210, 1_240_000, 380_000, { uncachedInput: 310_000, output: 42_000, cacheRead: 980_000, cacheWrite: 31_000 }, { active: true }),
		mkSession(4, '市场安装流程 e2e', 'qa', 6, 33, 210_000, 61_000, { uncachedInput: 41_000, output: 6_000, cacheRead: 88_000, cacheWrite: 3_000 }),
		mkSession(5, '首页 React 选型', 'planner', 5, 22, 160_000, 30_000, { uncachedInput: 58_000, output: 7_000, cacheRead: 120_000, cacheWrite: 2_000 }),
	];
	const model = {
		range: 'today',
		toolsRegistered: 'dashboard_sessions,dashboard_session',
		liveServices: 'sessions,sessionProjections',
		data: { dir: '<数据根>/storages/session_projcache/sessions', live: 3, remaining: 0 },
		tokenLine: '输入 1.02M · 输出 128.4k · 读缓存 3.41M · 写缓存 96.2k',
		summary: {
			sessions: 37, active: 2, turns: 214, steps: 1287, llmMs: 4_120_000, toolMs: 962_000,
			tokens: { uncachedInput: 1_024_000, output: 128_400, cacheRead: 3_410_000, cacheWrite: 96_200 },
		},
		sessions,
		tally: { inProgress: 3, todoSessions: 2, waiting: 5, running: 2, queued: 0, subagentChildren: 1, subagentRunning: 1 },
		workspaces: [
			{ cwd: 'g:/SarosWorkspace/sarosis-agents-client', sessions: 31, turns: 186, steps: 1120, llmMs: 3_600_000, output: 112_000 },
			{ cwd: 'g:/SarosWorkspace/Saros-agents-pocket', sessions: 4, turns: 21, steps: 130, llmMs: 420_000, output: 12_400 },
			{ cwd: 'g:/SarosWorkspace/saros-marketplace', sessions: 1, turns: 5, steps: 30, llmMs: 80_000, output: 3_000 },
			{ cwd: 'g:/SarosWorkspace/vssaros-homepage', sessions: 1, turns: 2, steps: 7, llmMs: 20_000, output: 1_000 },
		],
		workbench: [
			{ route: '/x/dashboard/', name: '主页', desc: '会话遥测 / 用量与编排', top: true },
			{ route: '/x/kanban/', name: '看板', desc: '看板存储与卡片工具' },
			{ route: '/x/kb/', name: '知识库', desc: '笔记与双链' },
			{ route: '/x/memory/', name: '记忆库', desc: '长期记忆' },
			{ route: '/x/codebase/', name: '代码库', desc: '符号与图谱' },
			{ route: '/x/media/', name: '媒体库', desc: '图片与视频' },
			{ route: '/x/imagegen/', name: '生图', desc: '文生图 / 画布' },
			{ route: '/x/skills/', name: '技能', desc: '技能与 MCP' },
			{ route: '/x/mcp/', name: 'MCP', desc: '外部工具接入口' },
			{ route: '/x/workflow/', name: '流程', desc: '工作流编排' },
			{ route: '/x/agents/', name: 'Agent', desc: '名册与人设' },
			{ route: '/x/sessions/', name: '历史会话', desc: '会话池' },
		],
		usage: {
			total: 4_658_600,
			parts: [
				{ key: '输入', value: 1_024_000, color: '#4C9AFF' },
				{ key: '输出', value: 128_400, color: '#89D185' },
				{ key: '读缓存', value: 3_410_000, color: '#4EC9B0' },
				{ key: '写缓存', value: 96_200, color: '#DCDCAA' },
			],
			byModel: [
				{ key: 'deepseek-v4（deepseek）', sessions: 21, output: 96_400 },
				{ key: 'deepseek-r1（deepseek）', sessions: 9, output: 24_000 },
				{ key: '未知（缓存里没有该单元）', sessions: 7, output: undefined },
			],
		},
	};
	const catalog = [
		{ kind: 'kpi', name: '关键指标', description: '会话 / turn / step / 耗时清点', w: 12, h: 1, added: true },
		{ kind: 'diag', name: '诊断行', description: 'token 明细 / 数据目录 / live 通道', w: 12, h: 1, added: true },
		{ kind: 'sessions', name: '会话明细', description: '按创建时间倒序的会话列表', w: 12, h: 3, added: true },
		{ kind: 'workbench', name: '工作台', description: 'dsh 模块页入口', w: 12, h: 3, added: false },
		{ kind: 'workspaces', name: '工作区', description: '工作区与会话分布', w: 6, h: 3, added: false },
		{ kind: 'usage', name: '用量分布', description: '输入/输出/缓存', w: 6, h: 3, added: false },
		{ kind: 'clock', name: '时钟', description: '当前时间', w: 3, h: 2, added: false },
		{ kind: 'pomodoro', name: '番茄时钟', description: '专注 25 分钟', w: 3, h: 2, added: false },
	];
	const layout = {
		version: 1, updatedAt: 1_792_600_000_000, settings: { rowHeight: 24, gap: 8, maxWidth: 0 },
		items: [
			{ id: 'w-kpi', kind: 'kpi', w: 12, h: 1, config: {} },
			{ id: 'w-diag', kind: 'diag', w: 12, h: 1, config: {} },
			{ id: 'w-sessions', kind: 'sessions', w: 7, h: 3, config: { limit: 50 } },
			{ id: 'w-usage', kind: 'usage', w: 5, h: 3, config: {} },
			{ id: 'w-workbench', kind: 'workbench', w: 12, h: 3, config: { order: [] } },
			{ id: 'w-workspaces', kind: 'workspaces', w: 5, h: 2, config: {} },
			{ id: 'w-clock', kind: 'clock', w: 3, h: 2, config: {} },
			{ id: 'w-pomodoro', kind: 'pomodoro', w: 4, h: 2, config: {} },
		],
	};
	const island = v => JSON.stringify(v).replace(/</g, '\\u003c');
	const vendorDir = resolve(pluginRoot, 'vendor/dsw-theme');
	const themeLinks = ['base.css', 'design-platform.css', 'gradient-shadow-text.css', 'scrollbar.css']
		.map(f => `<link rel="stylesheet" href="${resolve(vendorDir, f).replace(/\\/g, '/')}">`).join('\n');

	const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>主页（React）本地预览</title>
${themeLinks}
<link rel="stylesheet" href="${resolve(outDir, 'dashboard-app.css').replace(/\\/g, '/')}">
<style>
	/* 与宿主页面同一套壳样式（只搬必要的：页面底色/内边距/页头/口径行） */
	body { margin: 0; padding: 16px; font: 13px/1.6 system-ui, "Segoe UI", sans-serif;
		color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
	h1 { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
	h1 small { color: var(--dash-muted); font-weight: 400; }
	.diag { color: var(--dash-muted); font-size: 12px; margin: 4px 0; }
	.diag a { color: var(--dsw-alias-brand-primary); }
	code { font-family: ui-monospace, Consolas, monospace; }
	:root { --dash-gap: 8px; }
</style>
</head>
<body>
<h1>主页 <small>dsh 会话遥测 / 用量（只读）</small></h1>
<p class="diag">口径：本页读 dsh 自己的<b>会话投影缓存</b>（checkpoint 落盘，可能比实时略落后）。</p>
<p class="diag">范围：<b>今天</b> · <a href="#">7 天</a> · <a href="#">30 天</a></p>
<div data-dash-app-root="1">
	<div class="dash-bar"><span class="dash-status">（React 应用未挂载：脚本加载失败）</span></div>
</div>
<div class="dash-grid" data-dash-grid="1" data-dash-count="${layout.items.length}" data-dash-api="/x/dashboard/api/layout"></div>
<script type="application/json" data-dash-layout-json>${island(layout)}</script>
<script type="application/json" data-dash-model-json>${island(model)}</script>
<script type="application/json" data-dash-catalog-json>${island(catalog)}</script>
<script>
	/* 预览页把写口桩掉（真实页面打 /x/dashboard/api/layout）。
	   ⚠ 必须**回显提交上来的 items** —— 真实写口也会回传"归一化后的那份"，前端据此对齐；
	   桩若固定返回空数组，页面会以为"卡片全被删了"（第一次写预览就是这么把自己坑了 ✓）。 */
	window.fetch = function (_url, init) {
		var body = {};
		try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
		return Promise.resolve({
			ok: true, status: 200,
			json: function () {
				return Promise.resolve({ ok: true, updatedAt: Date.now(), items: body.items || [], count: (body.items || []).length, repaired: [] });
			},
		});
	};
</script>
<script src="${resolve(outDir, 'dashboard-app.js').replace(/\\/g, '/')}"></script>
</body>
</html>`;
	const previewPath = resolve(scope, 'preview.html');
	writeFileSync(previewPath, html, 'utf8');
	console.log(`  preview: ${previewPath.replace(/\\/g, '/')}`);
}
