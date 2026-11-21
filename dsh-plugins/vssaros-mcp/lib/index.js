// @vssaros/dsh-mcp — host half：把 `~/.vssaros/mcp.json`（上游 mcp.json 格式）里**实际会挂载什么、
// 哪些被跳过、为什么**显示出来（`view.kind=section`，寄居「工具」容器（原 Integration，2026-10-15 改名）的 skills 页）。
//
// 为什么需要它（不是"再做一个展示"）：MCP 的挂载**不在本插件里做**——`dsh-mcp-client` 是一台服务器
// 一个组合行、没有运行时注册服务，所以 VsSaros 走的是"启动时生成 `--patch` 覆盖层"
// （真源 `src/vs/.../common/dshMcpConfig.ts` 的 `renderMcpOverlay`）。那条路的结果目前**只在 Host 日志里**
// 可见：`.vssaros/mcp.json` 里写了 `sse` 或 `${workspaceFolder}` 的人，在界面上只会看到"服务器没挂上"。
// 本模块把同一份配置按**同一套归一化规则**解析成只读片段：挂载清单 + 跳过原因 + 工具计数。
//
// 本插件**不注册工具、不挂服务器**（那两件事分别是 dsh-mcp-client 的职责与覆盖层的职责）；
// 它只读文件。归一化逻辑见 `lib/core/mcpConfig.js`（与 src/vs 那份逐条对齐，由 p3-18 差分看守）。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { escapeHtml, parseMcpServers, renderSection, summarizeMcp } from './core/mcpConfig.js';
import {
	isMcpRuntimeMountEnabled, loadMcpClient, McpRuntime, readMountPlan, mtimeOf,
} from './core/mcpRuntime.js';
import { scanImportSources, toImportView, planImport } from './core/mcpImport.js';
import {
	isOsvEnabled, checkStdioEntriesAgainstOsv, buildOsvBlockedMessage,
} from './core/mcpOsv.js';
import { listCatalog, catalogEntryOf, planCatalogInstall } from './core/mcpCatalog.js';
import { isMcpGatewayEnabled, createMcpGateway, resolveSecretRefs } from './core/mcpGateway.js';
import {
	readSecrets, writeSecrets, readSecretsForMcpConfig, writeSecretsForMcpConfig,
	secretsPathForMcpConfig, secretsAsEnv, planSecretSet, planSecretDelete, secretView, secretEnvName,
} from './core/mcpSecrets.js';

export const name = 'vssaros-mcp';

/**
 * 静态 inject：页面两件（webServer / connection）+ `tools`（读"模型可见的 mcp__ 工具"计数）。
 * **必须声明才能访问**——实测未声明的服务连 `ctx.tools?.x?.()` 都会抛（memory/kb 的既有结论）；
 * 这里 `tools` 是**已证实存在**的服务（kanban/memory/kb 都这么声明），不会让插件 pending。
 */
// 只依赖 tools：工具在任何模板里都该可用。`webServer` / `connection` 只在 web 模板里存在，
// 写进静态 `inject` 会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效
//（2026-10-12 照 kanban / skills / workflow 的现成写法收窄 ✓，见 `doc/dsh-modules-conformance.html` §5-9）。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/mcp';

const WEB_ROUTE_OWNERS_KEY = Symbol.for('vssaros.webRouteOwners');
/** 双 plane 挂载时同一 prefix 只注册一次；effect 撤销时释放，HMR 仍可重新注册。 */
function registerPageRouteOnce(page, route) {
	const key = `${route.kind}:${route.path}`;
	let owners;
	try { owners = globalThis[WEB_ROUTE_OWNERS_KEY] ??= new Set(); } catch { return page.webServer.register(route); }
	if (!(owners instanceof Set) || owners.has(key)) {
		console.log(`[${name}] ${key} 已由另一层注册 ⇒ 跳过（避免 duplicate prefix route）`);
		return undefined;
	}
	owners.add(key);
	let dispose;
	try { dispose = page.webServer.register(route); } catch (error) { owners.delete(key); throw error; }
	return () => { try { dispose?.(); } finally { owners.delete(key); } };
}
/** 清单声明的片段路由（`view.kind=section`）。**精确匹配**：本插件只服务这一个片段，别的路径一律 404。 */
const SECTION_ROUTE = '/x/mcp/section';

/**
 * 默认真源路径：`<数据根>/mcp.json`（与 VsSaros 侧 `resolveSarosPath(..., SarosPath.mcpConfig)` 同址）。
 *
 * ⚠ 2026-10-12：这里原先**写死** `~/.vssaros/mcp.json`，完全忽略 `VSSAROS_DATA_ROOT` ✗ ——
 * 而 siblings（skills/kanban/kb/workflow/canvas/agents）全部按 `config.<key>` → `VSSAROS_DATA_ROOT`
 * → `~/.vssaros` 取值 ✓。后果是"开发数据根（`.vssaros-dev`）下这块仍读生产 mcp.json"，
 * 属于最难发现的一类不一致（`poc/dsh-p0/README.md` 记过同型事故）。
 * 由 `dsh-plugins/check-host-config.mjs` 的行为断言抓出；现在与 siblings 同口径 ✓。
 */
export function defaultMcpPath() {
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	if (fromEnv) {
		return join(fromEnv, 'mcp.json');
	}
	const home = process.env.USERPROFILE || process.env.HOME || homedir();
	return join(home, '.vssaros', 'mcp.json');
}

/**
 * 真源路径解析（与 siblings 同一优先级）：
 *   `config.path`（外壳精确指定，**最高**，保持既有兼容）→ `config.dataRoot` → `VSSAROS_DATA_ROOT`
 *   → `~/.vssaros`，最后统一拼 `mcp.json`。
 *
 * 2026-10-12 起**导出**：dsh 侧的 `bin/sync-rows.mjs` 与页面用**同一份**解析（否则"页面显示的路径"
 * 与"CLI 读的路径"会漂移 ✗）。
 */
export const mcpPathOf = config => {
	if (typeof config?.path === 'string' && config.path.trim()) {
		return config.path.trim();
	}
	const dataRoot = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	return dataRoot ? join(dataRoot, 'mcp.json') : defaultMcpPath();
};

/** 页面上的"当前路径"（相对用户主目录显示，便于核对）。 */
function displayPath(path) {
	const home = process.env.USERPROFILE || process.env.HOME || homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** 读 + 解析（不存在/读不了都返回**可渲染的状态**，不抛）。 */
async function readAndParse(path) {
	if (!existsSync(path)) {
		return { exists: false, parsed: { servers: [], skipped: [] } };
	}
	try {
		const text = await readFile(path, 'utf8');
		return { exists: true, parsed: parseMcpServers(text, process.env) };
	} catch (e) {
		return { exists: true, readError: String(e?.message ?? e), parsed: { servers: [], skipped: [] } };
	}
}

/**
 * 模型可见的 MCP 工具（`mcp__<server>__<tool>`）：数得出来就说明服务器**真的挂上了**。
 *
 * 返回**全表**（`tools`）＋ 一个短摘要（`names` 前 8 个，给 `diag` 行用 ✓）：原先只给"计数 + 前 8 个名字" ✗，
 * 于是"到底挂了哪些工具、各自干什么"只能靠猜 ✓。截断只留 `names`（**展示**需要短 ✓），
 * 全表原样带走（**数据**不该被展示需求截断 ✗）。
 */
function mcpToolNames(ctx) {
	try {
		const schemas = ctx.tools.schemas();
		const list = Array.isArray(schemas) ? schemas : (schemas && typeof schemas === 'object' ? Object.values(schemas) : []);
		const tools = list
			.map(item => (typeof item === 'string'
				? { name: item }
				: { name: item?.name, description: typeof item?.description === 'string' ? item.description : undefined }))
			.filter(tool => typeof tool.name === 'string' && tool.name.startsWith('mcp__'));
		return { count: tools.length, tools, names: tools.slice(0, 8).map(tool => tool.name) };
	} catch (e) {
		// 数不出来不算故障（比如 tools 服务在这一层不可见）——如实说明，不假装 0 个。
		return { count: 0, tools: [], names: [], error: String(e?.message ?? e) };
	}
}

/**
 * `mcp_install` 的纯写盘计划（抽成纯函数，守卫可以直接做**行为断言**，不必靠正则猜源码形态）。
 *
 * ★ 2026-11-10 修「装了不生效」：以前写的是顶层 `mcpServers`，而 `parseMcpServers()` 只读
 *   `servers`（`lib/core/mcpConfig.js:46`）⇒ 工具回「安装成功」，重启 Host 后服务器根本不挂载。
 *   现在统一写 `servers`，并把历史 `mcpServers` 一次性合并迁移（`servers` 优先，不覆盖既有条目）。
 * ★ 迁移**不补 `approved`**：stdio 会在本机起任意进程，静默授权等于绕过 R1 授权缺口；
 *   旧条目照常落 `needs-approval`，由用户显式在 mcp.json 里写 `true`。
 * ★ `type` 必须写全：旧 `mcpServers` 条目常缺 type，而解析侧对无 type 的 http 条目会判
 *   「未识别的 type」⇒ 迁移时按 command / url 补 `stdio` / `http`（不改其它字段）。
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function migrateLegacyEntry(entry) {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type === 'string') { return entry; }
	if (typeof entry.command === 'string') { return { ...entry, type: 'stdio' }; }
	if (typeof entry.url === 'string') { return { ...entry, type: 'http' }; }
	return entry;
}

/**
 * 删除一台 MCP 服务器的纯写盘计划（与 planMcpInstall 同口径：写 servers、清旧键、保留其它顶层键）。
 * 不存在时抛错而不是「无操作也写一次盘」——避免 mtime 白白变化触发运行时重新 reconcile。
 */
export function planMcpRemove(raw, params = {}) {
	const name = String(params?.name ?? params ?? '').trim();
	if (!MCP_SERVER_NAME_RE.test(name)) {
		throw new Error(`name 不合法：${name} —— 只允许字母/数字/连字符/下划线且 ≤32 字符。`);
	}
	const legacy = raw?.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {};
	const current = raw?.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers) ? raw.servers : {};
	const servers = { ...legacy, ...current };
	if (!servers[name]) { throw new Error(`mcp.json 里没有「${name}」（不做无操作写盘）。`); }
	const removed = servers[name];
	delete servers[name];
	const next = { ...raw, servers };
	delete next.mcpServers;
	return { name, removed, next };
}

export function planMcpInstall(raw, params = {}) {
	const name = String(params?.name ?? '').trim();
	if (!MCP_SERVER_NAME_RE.test(name)) {
		throw new Error(`name 不合法：${name} —— 只允许字母/数字/连字符/下划线且 ≤32 字符（与 dsh 的 serverName 约束一致）。`);
	}
	const transport = String(params?.transport ?? '').trim();
	if (!['stdio', 'http'].includes(transport)) {
		throw new Error(`transport 必须是 stdio / http 之一（收到 ${transport || '(空)'}）；dsh-mcp-client 不支持 sse。`);
	}
	const legacy = raw?.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {};
	const current = raw?.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers) ? raw.servers : {};
	const servers = {};
	for (const [key, value] of Object.entries(legacy)) { servers[key] = migrateLegacyEntry(value); }
	for (const [key, value] of Object.entries(current)) { servers[key] = value; }
	if (servers[name]) { throw new Error(`MCP 服务器 ${name} 已存在（不会覆盖；要改先删掉再装）。`); }
	const env = params?.env && typeof params.env === 'object' && !Array.isArray(params.env) ? params.env : null;
	let entry;
	if (transport === 'stdio') {
		const command = String(params?.command ?? '').trim();
		if (!command) { throw new Error('stdio 需要 command（启动命令，如 "npx"）。'); }
		entry = {
			type: 'stdio',
			// 与商城安装写口（vssaros-marketplace/lib/mcpInstall.js）同口径：显式等批准。
			approved: false,
			command,
			args: Array.isArray(params?.args) ? params.args.map(String) : [],
			...(env ? { env } : {}),
		};
	} else {
		const url = String(params?.url ?? '').trim();
		if (!url) { throw new Error('http 需要 url（端点 URL）。'); }
		// 解析侧读的是 `headers`（`mcpConfig.js:166`），不是 `env` ⇒ 远程条目必须写到 headers。
		entry = { type: 'http', url, ...(env ? { headers: env } : {}) };
	}
	servers[name] = entry;
	const next = { ...raw, servers };
	delete next.mcpServers;
	return { name, entry, next };
}

export function apply(ctx, config = {}) {
	// 对外提供 OSV 供应链预检服务：商城装 MCP 时可选消费，避免复制第二份实现。
	// ⚠⚠ **必须幂等**（2026-11-11 真机「新建会话失败：agent-preset/invalid: vssaros-mcp …
	//   service "vssarosMcpOsv" has been registered at <vssaros-mcp>」）：
	//   本包同时挂在两个 plane —— host plane（`cordis.patch.yml` 的 `vssaros-dsh-mcp` 行，启动即装）
	//   与 preset plane（`vssaros-agents/preset-vssaros.rows.yml` 的 `vssaros-mcp` 行 ⇒ 生成物
	//   `cordis.presets.yml`）；会话选中 preset 时会**再 apply 一次**，第二次 provide 让 cordis 抛
	//   `has been registered` ⇒ 整个 preset 判 invalid ⇒ `session.start` 直接失败，用户连会话都建不了 ✗✗。
	//   同型先例：`vssaros-workflow` 的 vssarosWorkflowEngine、`vssaros-media` 的 vssarosMediaStore。
	// ⇒ 先"不经 inject 要求地读"探一次（`ctx.reflect.get(name, false)` 在服务不存在时返回
	//   undefined 而**不抛** ✓）；已存在就复用 host 层那一份，不重复注册 ✓。
	const existingOsv = ctx.reflect && typeof ctx.reflect.get === 'function'
		? ctx.reflect.get('vssarosMcpOsv', false)
		: undefined;
	if (!existingOsv) {
		// 可选调用保留：离线探针的精简 ctx 没有 provide（不影响本插件其余能力）。
		ctx.provide?.('vssarosMcpOsv', {
			isOsvEnabled, checkStdioEntriesAgainstOsv, buildOsvBlockedMessage,
		});
	}
	// 运行时挂载缺省启用（P3-110 boot 9/9 + P3-111 真 Host 7/7 已验证）；
	// VSSAROS_MCP_RUNTIME_MOUNT=0 回退到 IDE 启动期 --patch 覆盖层（旧行为逐字不变）。
	installRuntimeMount(ctx, config);
	// 重构 4（2026-10-17）：state + 桥的可选注入（mcp_market_list 要经桥回 IDE 拉远端清单 ✓；
	// vssarosBridge 不在 ⇒ 市场工具如实报"桥不在" ✓，其余照常 ✓）。
	const state = { bridge: null };
	ctx.inject(['vssarosBridge'], scope => {
		let svc = null;
		try { svc = scope.vssarosBridge ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (svc && typeof svc.callIDE === 'function') {
			state.bridge = svc;
			return () => { state.bridge = null; };
		}
		return undefined;
	});
	// 审批闸（与 kanban/kb/memory 同一把 ✓）：mcp_install / mcp_import 都会写 mcp.json，
	// stdio 的 command 是任意可执行文件 ⇒ 挂闸 ✓。⚠ `mcp_import` 的 scan 分支虽然只读，但
	// `tools/pre-execute` 的 payload 形态随 dsh 版本而异，读不到 action 时**一律挂闸**（fail-closed，
	// 宁可多问一次，不能让 apply 绕过审批）。官方契约：ask 只有审批服务返回 allowed-once 才执行 ✓；
	// 没有审批支持的部署（headless）⇒ deny ✓。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && (exec.name === 'mcp_install' || exec.name === 'mcp_import'
			|| exec.name === 'mcp_catalog' || exec.name === 'mcp_remove' || exec.name === 'mcp_secret')) {
			const label = exec.name;
			const tail = isMcpRuntimeMountEnabled()
				? '（运行时挂载会立即启动新服务器 ⇒ 能跑任意命令）'
				: '（重启 Host 后挂载新服务器 ⇒ 能跑任意命令）';
			return {
				kind: 'ask',
				reason: `${label} 会写入 mcp.json${tail}`,
				displayReason: { en: `Allow ${label} to write mcp.json?`, zh: `允许 ${label} 写入 mcp.json？` },
			};
		}
		return next();
	}));
	// 重构 4（2026-10-16）：`mcp_install` 工具——写 `mcp.json` 的 `servers` 段（方案 2.x：
	// "写 mcp.json 后由 sync-rows 重新生成 bundle"——sync-rows 是宿主启动链的事，本工具只写配置 ✓）。
	// ★ 2026-11-10：顶层键从 `mcpServers` 改成 `servers`（解析侧只读 servers，原写口装了不挂载）；
	//   transport 去掉 dsh 不支持的 sse；写盘计划抽成 planMcpInstall（见上），由 ⑥ 守卫做行为断言。
	// 写类 ⇒ 挂审批闸 ✓。**供应链预检（OSV 恶意包）没做**：那是壳侧的远端调用（`mcpSupplyChain.ts`），
	// 本侧如实写明"没拦"（不假装拦了 ✗）——要拦那道，经桥回 IDE 做（留待）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_install',
		description: '安装一个 MCP 服务器：把它的配置写进 mcp.json 的 servers 段（stdio / http）。缺省由插件在运行时重挂，改完即时生效；VSSAROS_MCP_RUNTIME_MOUNT=0 回退到启动期覆盖层时需重启 Host。stdio 条目默认 approved:false，需用户在 mcp.json 里显式改成 true 才会启动本机进程。⚠ 本侧**不做供应链预检**（OSV 恶意包拦截是壳侧的远端调用，没迁过来）——装来路不明的包前自己掂量。',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: '服务器名（servers 的键；字母/数字/连字符/下划线，≤32 字符）' },
				transport: { type: 'string', enum: ['stdio', 'http'], description: '传输方式（dsh-mcp-client 只支持 stdio 与 http，不支持 sse）' },
				command: { type: 'string', description: 'stdio 的启动命令（如 "npx"）' },
				args: { type: 'array', items: { type: 'string' }, description: 'stdio 的命令参数（如 ["-y", "pkg"]）' },
				url: { type: 'string', description: 'http 的端点 URL' },
				env: { type: 'object', description: 'stdio 的环境变量 / http 的静态 headers（可选）' },
			},
			required: ['name', 'transport'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					name: { type: 'string' },
					path: { type: 'string' },
					restartNeeded: { type: 'boolean' },
					osv: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已写入 ${value.name}（${value.path}）——${value.restartNeeded ? '需重启 Host 后生效' : '运行时挂载会自动生效'}。${String(value.osv ?? '').startsWith('unknown') ? '⚠ 供应链预检未完成（fail-open），请自行确认包来源。' : ''}`
					: `安装失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		execute: async (params) => {
			const path = mcpPathOf(config);
			// ⚠ 读**原始文件**（不是 readAndParse 的摘要——那是 {servers, skipped} 的展示形状 ✗，
			//   把它铺进写回的对象会把摘要写进 mcp.json ✗，p3-109 实测抓到 ✓）。
			const { readFile } = await import('node:fs/promises');
			let raw = {};
			try {
				const text = await readFile(path, 'utf8');
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { raw = parsed; }
			} catch { /* 文件不存在/坏 JSON ⇒ 从空写起（如实的空 ✓） */ }
			// 校验 / 迁移 / 组装全在纯函数里（守卫 ⑥ 直接跑行为断言）。
			const { name, next } = planMcpInstall(raw, params);
			const osv = await precheckOsv([next.servers[name]]);
			const { writeFile, mkdir } = await import('node:fs/promises');
			const { dirname } = await import('node:path');
			await mkdir(dirname(path), { recursive: true });
			// 只改 servers 段并清掉历史 mcpServers，其余键（inputs 等）原样保留 ✓。
			await writeFile(path, JSON.stringify(next, null, 2));
			return { ok: true, name, path, restartNeeded: !isMcpRuntimeMountEnabled(), osv };
		},
	}));

	// 重构 4（2026-10-17）：`mcp_market_list`——浏览 MCP 市场（只读：经桥回 IDE 拉远端清单，
	// 远端服务在壳侧的 marketplaceService ✓）。安装入口是 mcp_install（写 mcp.json ✓——本工具
	// 只浏览 ✓，不安装 ✗）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_market_list',
		description: '浏览 MCP 市场：列出远端可装的 MCP 服务器（名称 / 描述 / 版本 / 作者）。只读（不安装——安装用 mcp_install，写 mcp.json 后由运行时挂载生效）。远端服务要登录（经 IDE 侧的 marketplaceService）。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '搜索关键词（可选）' },
				limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, author: { type: 'string' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.error
					? `市场不可用：${value.error}`
					: (value.count ? `${value.count} 个 MCP 服务器：\n${value.items.map(i => `  • ${i.name}@${i.version ?? '?'} — ${i.description ?? ''}`).join('\n')}` : '没有匹配的 MCP 服务器'),
			}],
		},
		isConcurrencySafe: () => true,  // 只读 ✓
		execute: async (params) => {
			// 经桥回 IDE（远端清单要认证——壳侧的 marketplaceService 有 token ✓）
			if (!state.bridge || typeof state.bridge.callIDE !== 'function') {
				return { count: 0, items: [], error: '市场要经桥回 IDE（远端清单的认证在壳侧），但 vssarosBridge 不在（bridge 插件没装/没连）' };
			}
			const reply = await state.bridge.callIDE('ide.request', {
				capability: 'mcp',
				pluginId: 'vssaros-mcp',
				params: { op: 'marketList', query: String(params?.query ?? '').trim() || undefined, limit: Number.isFinite(params?.limit) ? Math.min(100, Math.max(1, Math.floor(params.limit))) : 20 },
			}, { timeoutMs: 30 * 1000 });
			const items = Array.isArray(reply?.items) ? reply.items : [];
			return { count: items.length, items, ...(reply?.error ? { error: String(reply.error) } : {}) };
		},
	}));
	// 2026-11-10：`mcp_import`——从 Claude Desktop / Cursor / VS Code 迁移已有 MCP 配置。
	// 缺省 `action:'scan'` 只读，且扫描结果经 toImportView 脱敏（只给键名，不给 env/header 值）；
	// 只有 `action:'apply'` 才写盘，条目形状与 planMcpInstall 一致（servers / type / approved:false）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_import',
		description: '从 Claude Desktop / Cursor / VS Code 迁移已有 MCP 配置：只读扫描（缺省 action=scan，只给 env/headers 的键名、不给值），或显式 apply 写入 mcp.json 的 servers 段。apply 会把 env/headers 的值按原文写进 mcp.json（注意该文件权限）；stdio 条目写 approved:false，需用户显式批准才会启动本机进程；sse、残留 ${...} 占位符、同名条目一律跳过。源文件一个字节都不改。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['scan', 'apply'], description: 'scan = 只列可导入项（缺省）；apply = 写入 mcp.json' },
				sources: { type: 'array', items: { type: 'string' }, description: '只看这几个来源：claude / cursor / vscode（可选）' },
				picked: { type: 'array', items: { type: 'string' }, description: 'apply 时只导入这些 "source:name"（可选，缺省全选）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string' }, count: { type: 'number' }, items: { type: 'array' },
					added: { type: 'array' }, skipped: { type: 'array' },
					changed: { type: 'boolean' }, restartNeeded: { type: 'boolean' }, osv: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.action === 'scan'
					? (value.count
						? `发现 ${value.count} 个可导入的 MCP 服务器：\n${(value.items ?? []).map(i => `  • ${i.key} [${i.transport}] ${i.target}${i.envKeys?.length ? ` · env: ${i.envKeys.join(',')}` : ''}${i.headerKeys?.length ? ` · headers: ${i.headerKeys.join(',')}` : ''}`).join('\n')}`
						: '没有在 Claude Desktop / Cursor / VS Code 里找到 MCP 配置')
					: (value.changed
						? `已导入 ${value.added.length} 台：${value.added.join(', ')}${value.skipped?.length ? `；跳过 ${value.skipped.length} 项` : ''}${value.restartNeeded ? '（需重启 Host）' : '（运行时挂载会自动生效）'}${String(value.osv ?? '').startsWith('unknown') ? '⚠ 供应链预检未完成（fail-open），请自行确认包来源。' : ''}`
						: `没有写入：${value.skipped?.length ?? 0} 项被跳过`),
			}],
		},
		// 不声明 isConcurrencySafe：apply 写盘 ⇒ 默认独占 ✓。
		execute: async (params) => {
			const action = String(params?.action ?? 'scan').trim();
			if (!['scan', 'apply'].includes(action)) {
				throw new Error(`action 必须是 scan / apply 之一（收到 ${action || '(空)'}）。`);
			}
			const sources = Array.isArray(params?.sources) ? params.sources.map(String) : undefined;
			const items = await scanImportSources({ sources });
			if (action === 'scan') {
				return { action: 'scan', count: items.length, items: toImportView(items) };
			}
			const path = mcpPathOf(config);
			let raw = {};
			try {
				const parsed = JSON.parse(await readFile(path, 'utf8'));
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { raw = parsed; }
			} catch { /* 文件不存在/坏 JSON ⇒ 从空写起 */ }
			const picked = Array.isArray(params?.picked) ? params.picked.map(String) : undefined;
			const { next, added, skipped } = planImport({ items, picked, raw });
			if (added.length === 0) {
				return { action: 'apply', changed: false, added: [], skipped, restartNeeded: false, osv: 'skipped' };
			}
			const osv = await precheckOsv(added.map(name => next.servers[name]));
			const { writeFile, mkdir } = await import('node:fs/promises');
			const { dirname } = await import('node:path');
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(next, null, 2));
			return { action: 'apply', changed: true, added, skipped, restartNeeded: !isMcpRuntimeMountEnabled(), osv };
		},
	}));

	// 2026-11-10：`mcp_catalog`——远程 MCP 服务目录。缺省 list 只读；显式 install 只装
	// auth=none 的 https 服务（凭据型明确拒绝，不制造「装好了永远连不上」的条目）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_catalog',
		description: '浏览远程 MCP 服务目录（缺省 action=list，只读）或按目录 id 一键安装免登录服务（action=install）。需要 OAuth / API-key 的服务会明确拒绝：dsh 侧凭据隔离网关尚未落地，写入也连不上。只接受 https 端点；运行时挂载下改完即时生效。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'install'], description: 'list = 浏览（缺省）；install = 按 id 写入 mcp.json' },
				id: { type: 'string', description: 'install 时的目录 id（如 context7）' },
				query: { type: 'string', description: 'list 时按 id / 名称 / 描述 / 分类过滤' },
				category: { type: 'string', description: 'list 时按分类过滤（search / docs / data / dev / work / design / commerce）' },
				installableOnly: { type: 'boolean', description: 'list 时只列免登录可直接安装的项' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string' }, count: { type: 'number' }, items: { type: 'array' },
					id: { type: 'string' }, name: { type: 'string' }, ok: { type: 'boolean' },
					restartNeeded: { type: 'boolean' }, osv: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.action === 'list'
					? (value.count
						? `目录共 ${value.count} 项：\n${(value.items ?? []).map(i => `  • ${i.id} ${i.name} [${i.category}/${i.auth}]${i.installable ? ' 可安装' : ' 需凭据'} — ${i.about}`).join('\n')}`
						: '没有匹配的远程 MCP 服务')
					: `已安装 ${value.id}（${value.name}）${value.restartNeeded ? '（需重启 Host）' : '（运行时挂载会自动连接）'}`,
			}],
		},
		// 不声明 isConcurrencySafe：install 写盘 ⇒ 默认独占 ✓。
		execute: async (params) => {
			const action = String(params?.action ?? 'list').trim();
			if (!['list', 'install'].includes(action)) {
				throw new Error(`action 必须是 list / install 之一（收到 ${action || '(空)'}）。`);
			}
			if (action === 'list') {
				const items = listCatalog({
					query: params?.query,
					category: params?.category,
					installableOnly: params?.installableOnly === true,
				});
				return { action: 'list', count: items.length, items };
			}
			const path = mcpPathOf(config);
			let raw = {};
			try {
				const parsed = JSON.parse(await readFile(path, 'utf8'));
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { raw = parsed; }
			} catch { /* 文件不存在/坏 JSON ⇒ 从空写起 */ }
			// key 型目录项要求凭据仓库里已有对应引用（真值不进 mcp.json）。
			const secrets = await readSecretsForMcpConfig(path);
			const { next, entry, name } = planCatalogInstall({
				id: params?.id, raw, env: secretsAsEnv(secrets, process.env),
			});
			// http 条目不触网（checkStdioEntriesAgainstOsv 会跳过非 stdio），只是走同一套预检口径。
			const osv = await precheckOsv([next.servers[name]]);
			const { writeFile, mkdir } = await import('node:fs/promises');
			const { dirname } = await import('node:path');
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(next, null, 2));
			return { action: 'install', ok: true, id: name, name: entry.name, restartNeeded: !isMcpRuntimeMountEnabled(), osv };
		},
	}));

	// 2026-11-10：`mcp_remove`——配置管理闭环的最后一块（此前只能手工改 mcp.json）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_remove',
		description: '从 mcp.json 的 servers 段删除一台 MCP 服务器（写操作，带审批）。运行时挂载下会自动卸载该服务器；VSSAROS_MCP_RUNTIME_MOUNT=0 回退到启动期覆盖层时需重启 Host。不存在时明确报错，不做无操作写盘。',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'servers 里那台服务器的名字' },
			},
			required: ['name'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, name: { type: 'string' },
					path: { type: 'string' }, restartNeeded: { type: 'boolean' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已删除 ${value.name}（${value.path}）——${value.restartNeeded ? '需重启 Host 后卸载' : '运行时挂载会自动卸载'}。`
					: `删除失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写盘 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		execute: async (params) => {
			const path = mcpPathOf(config);
			let raw = {};
			try {
				const parsed = JSON.parse(await readFile(path, 'utf8'));
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { raw = parsed; }
			} catch { /* 文件不存在/坏 JSON ⇒ 从空写起（随后会因「不存在」明确报错） */ }
			const { name, next } = planMcpRemove(raw, params);
			const { writeFile, mkdir } = await import('node:fs/promises');
			const { dirname } = await import('node:path');
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(next, null, 2));
			return { ok: true, name, path, restartNeeded: !isMcpRuntimeMountEnabled() };
		},
	}));

	// 2026-11-10：`mcp_secret`——凭据仓库读写。缺省 list 只读且**脱敏**（只给字段名与引用名）。
	// 真值只落 <数据根>/mcp-secrets.json（mode 600），mcp.json 里只写 ${env:MCP_<ID>_<FIELD>}。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_secret',
		description: '管理远程 MCP 的凭据仓库（<数据根>/mcp-secrets.json）。缺省 action=list 只读且脱敏，只返回 id、字段名和该填进 mcp.json 的 ${env:...} 引用名，不返回任何真值；action=set 写入/合并字段（value 传空串删除该字段）；action=delete 删除一条。改凭据后运行时挂载会自动重新解析，无需重启 Host。⚠ set 的字段值会经过模型上下文：生产环境更安全的做法是直接编辑 mcp-secrets.json，再由 list 确认引用名。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'set', 'delete'], description: 'list = 脱敏浏览（缺省）；set = 写入；delete = 删除' },
				id: { type: 'string', description: '凭据条目的 id（与 mcp.json 的 serverName 对应，字母/数字/连字符/下划线 ≤32）' },
				fields: { type: 'object', description: 'set 时要写入的字段，如 {"token":"..."}；值必须是字符串' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string' }, count: { type: 'number' }, items: { type: 'array' },
					id: { type: 'string' }, ok: { type: 'boolean' }, refs: { type: 'array' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.action === 'list'
					? (value.count
						? `凭据条目 ${value.count} 条（不含真值）：\n${(value.items ?? []).map(i => `  • ${i.id} — 字段 ${i.fields.join(', ') || '(空)'}；mcp.json 里写 ${i.refs.join(' / ') || '(无)'}`).join('\n')}`
						: '凭据仓库为空。')
					: (value.ok
						? `已写入 ${value.id} 的凭据（真值不回显）；mcp.json 里可用 ${(value.refs ?? []).join(' / ') || '(该条目已删除)'} 引用。`
						: '凭据操作失败。'),
			}],
		},
		// 不声明 isConcurrencySafe：set/delete 写盘 ⇒ 默认独占 ✓。
		execute: async (params) => {
			const action = String(params?.action ?? 'list').trim();
			if (!['list', 'set', 'delete'].includes(action)) {
				throw new Error(`action 必须是 list / set / delete 之一（收到 ${action || '(空)'}）。`);
			}
			const path = mcpPathOf(config);
			const raw = await readSecretsForMcpConfig(path);
			if (action === 'list') {
				const items = secretView(raw);
				return { action: 'list', count: items.length, items };
			}
			const plan = action === 'set' ? planSecretSet(raw, params) : planSecretDelete(raw, params);
			await writeSecretsForMcpConfig(path, plan.next);
			const refs = secretView(plan.next).find(item => item.id === plan.id)?.refs ?? [];
			return { action, ok: true, id: plan.id, refs };
		},
	}));

	// 片段路由：与 memory 的区块同法——Host 自己的鉴权栅栏 + 客户端请求带的 Cookie。
	// 片段路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有片段** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => registerPageRouteOnce(page, {
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
				if (pathname !== SECTION_ROUTE) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(`不是本插件的片段路由：${pathname}`);
					return;
				}
				const path = mcpPathOf(config);
				const { exists, readError, parsed } = await readAndParse(path);
				const tools = mcpToolNames(ctx);
				// 渲染放在 writeHead 之前：渲染抛错时还能干净地回 500（顺序反了会变成 socket 被切断，实测吃过）。
				const html = renderSection({
					path: displayPath(path),
					exists,
					readError,
					parsed,
					toolCount: String(tools.count),
					// 短摘要（diag 行用 ✓）与**全表**（结构化区块用 ✓）分开传：展示要短，数据不该被截 ✓
					toolNote: tools.names.length ? tools.names.join(', ') : tools.error,
					toolList: tools.tools,
					// 生效提示必须跟着挂载模型走：运行时挂载已不需要重启，写死「需重启 Host」会变成假文案。
					runtimeMount: isMcpRuntimeMountEnabled(),
					runtimeStatus: activeMcpRuntime?.statusView() ?? null,
					});
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}

/**
 * 运行时挂载（缺省启用，VSSAROS_MCP_RUNTIME_MOUNT=0 回退）。
 *
 * 用 mtime 轮询而不是 `fs.watch`：Windows 上编辑器「先写临时文件再 rename」会漏 watch 事件，
 * mtime 轮询更钝但可靠；2s 间隔只做一次 stat，配置没动立即返回，不产生额外开销。
 * 配置里的每台服务器在 `McpRuntime` 里按指纹 reconcile：新增即挂、改配置先 dispose 再挂、
 * 删掉即卸 ⇒ 不再需要重启 Host。
 */
/**
 * 两个安装写口共用的供应链预检（dsh 侧真源，不再是 IDE 残留）。
 * blocked ⇒ 抛错阻断；unknown ⇒ fail-open 继续，但把原因随结果回报，不假装"已验证"；
 * `VSSAROS_MCP_OSV=0` 关闭（离线/内网环境）。
 */
async function precheckOsv(entries) {
	if (!isOsvEnabled()) { return 'skipped'; }
	const verdict = await checkStdioEntriesAgainstOsv(entries, {
		envEndpoint: process.env.VS_SAROS_OSV_ENDPOINT,
		warn: message => { try { console.warn(message); } catch { /* 日志不致命 */ } },
	});
	if (verdict.status === 'blocked') { throw new Error(buildOsvBlockedMessage(verdict)); }
	return verdict.status === 'unknown' ? `unknown:${verdict.reason ?? ''}` : verdict.status;
}

/** 运行期挂载器句柄（只读片段要显示「真的连上没连上」）。插件卸载时清空。 */
let activeMcpRuntime = null;

function installRuntimeMount(ctx, config) {
	const existing = ctx.reflect && typeof ctx.reflect.get === 'function'
		? ctx.reflect.get('vssarosMcpSources', false)
		: undefined;
	if (existing) { return existing; }
	const enabled = isMcpRuntimeMountEnabled();
	const path = mcpPathOf(config);
	let loader = null;
	try { loader = typeof ctx.get === 'function' ? ctx.get('loader') : null; } catch { /* 可选服务 */ }
	const warn = message => { try { ctx.logger?.()?.warn?.(message); } catch { /* 日志不致命 */ } };
	const warnFailure = () => warn('mcp runtime: connection or reconciliation failed (details withheld)');
	const unavailable = () => new Error('MCP source service unavailable: runtime is disabled, not ready or stopped');
	let runtime = null;
	let gateway = null;
	let sources = new Map();
	let skipped = new Map();
	const gatewayEnv = {};
	let stopped = false;
	let initialized = false;
	let lastSignature = null;
	let timer = null;
	let queue = Promise.resolve();
	let stopPromise = null;
	const available = () => enabled && initialized && !stopped && runtime && !runtime.stopped;
	const enqueue = operation => {
		const pending = queue.then(operation);
		queue = pending.catch(() => {});
		return pending;
	};
	const ensureAvailable = () => { if (!available()) { throw unavailable(); } };
	const snapshot = owner => {
		const source = sources.get(owner);
		const actual = runtime?.statusView({ includeReady: true }) ?? {};
		return {
			owner, available: !!available(), registered: !!source,
			servers: Object.keys(source?.servers ?? {}).map(name => {
				if (!available()) { return { name, state: 'unavailable' }; }
				if (skipped.has(name)) { return { name, ...skipped.get(name) }; }
				if (Object.hasOwn(actual, name)) { return { name, ...actual[name] }; }
				return { name, state: runtime.mounts.get(name)?.fiber ? 'connecting' : 'unavailable' };
			}),
		};
	};
	const sourceOf = request => {
		const owner = request?.owner;
		if (typeof owner !== 'string' || !owner.trim()) { throw new Error('MCP source owner must be a nonempty string'); }
		const raw = request?.servers;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new Error('MCP source servers must be an object'); }
		const servers = Object.create(null);
		for (const [name, entry] of Object.entries(raw)) {
			if (!MCP_SERVER_NAME_RE.test(name)) { throw new Error('MCP source server name is invalid'); }
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { throw new Error('MCP source server config must be an object'); }
			try { servers[name] = JSON.parse(JSON.stringify(entry)); }
			catch { throw new Error('MCP source server config must be JSON serializable'); }
			servers[name].approved = entry.approved === true;
		}
		return { owner, servers };
	};
	const reconcileSources = async next => {
		if (!enabled || stopped) { throw unavailable(); }
		const overlay = Object.create(null);
		for (const source of next.values()) {
			for (const [name, entry] of Object.entries(source.servers)) {
				if (Object.hasOwn(overlay, name)) { throw new Error(`MCP server name conflict: ${name}`); }
				overlay[name] = entry;
			}
		}
		const signature = `${await mtimeOf(path)}|${await mtimeOf(secretsPathForMcpConfig(path))}`;
		const secrets = await readSecretsForMcpConfig(path);
		const mergedEnv = secretsAsEnv(secrets, process.env);
		const parsed = await readMountPlan(path, mergedEnv, overlay);
		if (stopped) { throw unavailable(); }
		if (!runtime) {
			let client;
			try { client = await loadMcpClient({ loader, mcpClientUrl: config.mcpClientUrl }); }
			catch { throw unavailable(); }
			if (stopped) { throw unavailable(); }
			runtime = new McpRuntime({ ctx, client, warn: warnFailure });
			activeMcpRuntime = runtime;
		}
		const nextSkipped = new Map(parsed.skipped.map(entry => [entry.name, {
			state: entry.state ?? 'error',
			reason: entry.state === 'needs-approval' ? 'stdio requires explicit approved:true' : 'MCP configuration was skipped',
		}]));
		let servers = parsed.servers;
		const rawServers = parsed.rawConfig?.servers ?? {};
		servers = servers.filter(server => {
			const query = rawServers[server.serverName]?.query;
			if (!Object.hasOwn(overlay, server.serverName) || query === undefined) { return true; }
			const valid = query && typeof query === 'object' && !Array.isArray(query)
				&& Object.values(query).every(value => {
					if (typeof value !== 'string') { return false; }
					const resolved = resolveSecretRefs(value, mergedEnv);
					return !resolved.error && !resolved.value.includes('${');
				});
			if (!valid) { nextSkipped.set(server.serverName, { state: 'error', reason: 'MCP query credential is invalid or unavailable' }); }
			return !!valid;
		});
		const requiresGateway = server => server.transport === 'streamable-http' && (
			(server.headers && Object.keys(server.headers).length > 0)
			|| (rawServers[server.serverName]?.query && Object.keys(rawServers[server.serverName].query).length > 0)
			|| (Object.hasOwn(overlay, server.serverName) && (
				rawServers[server.serverName]?.url?.includes('${') || server.url.includes('?')
			))
		);
		// 工作台资源不因关闭网关而把凭据交给 mcp-client；用户既有全局回退开关不变。
		if (!isMcpGatewayEnabled()) {
			servers = servers.filter(server => {
				if (!Object.hasOwn(overlay, server.serverName) || !requiresGateway(server)) { return true; }
				nextSkipped.set(server.serverName, { state: 'unavailable', reason: 'MCP credential gateway unavailable' });
				return false;
			});
		}
		const secured = isMcpGatewayEnabled() ? servers.filter(requiresGateway) : [];
		if (secured.length) {
			for (const key of Object.keys(gatewayEnv)) { delete gatewayEnv[key]; }
			Object.assign(gatewayEnv, mergedEnv);
			if (!gateway) {
				gateway = createMcpGateway({ env: gatewayEnv, warn: warnFailure });
				await gateway.listen();
				if (stopped) { await gateway.close(); gateway = null; throw unavailable(); }
			}
			for (const server of secured) {
				gateway.register(server.serverName, {
					url: server.url,
					headers: rawServers[server.serverName]?.headers ?? server.headers,
					query: rawServers[server.serverName]?.query,
				});
			}
			gateway.prune(secured.map(server => server.serverName));
			const byName = new Set(secured.map(server => server.serverName));
			servers = servers.map(server => byName.has(server.serverName)
				? { ...server, url: gateway.urlFor(server.serverName), headers: gateway.headers() }
				: server);
		} else if (gateway) {
			gateway.prune([]);
		}
		if (stopped) { throw unavailable(); }
		sources = next;
		skipped = nextSkipped;
		await runtime.sync(servers);
		if (stopped) { throw unavailable(); }
		if (!secured.length && gateway) { await gateway.close(); gateway = null; }
		initialized = true;
		service.ready = Promise.resolve();
		lastSignature = signature;
		if (nextSkipped.size) { warn(`mcp runtime: ${nextSkipped.size} configuration entries skipped`); }
	};
	const remove = (owner, token) => enqueue(async () => {
		ensureAvailable();
		const source = sources.get(owner);
		if (!source || (token && source.token !== token)) { return false; }
		const next = new Map(sources);
		next.delete(owner);
		await reconcileSources(next);
		return true;
	});
	const service = {
		ready: null,
		status: snapshot,
		async registerSource(request) {
			ensureAvailable();
			const source = sourceOf(request);
			const token = Symbol();
			await enqueue(async () => {
				ensureAvailable();
				if (sources.has(source.owner)) { throw new Error('MCP source owner already registered'); }
				const next = new Map(sources);
				next.set(source.owner, { servers: source.servers, token });
				await reconcileSources(next);
			});
			return () => remove(source.owner, token);
		},
		async reloadSource(request) {
			ensureAvailable();
			const source = sourceOf(request);
			return enqueue(async () => {
				ensureAvailable();
				const current = sources.get(source.owner);
				if (!current) { throw new Error('MCP source owner is not registered'); }
				const next = new Map(sources);
				next.set(source.owner, { servers: source.servers, token: current.token });
				await reconcileSources(next);
				return snapshot(source.owner);
			});
		},
		unregisterSource: owner => remove(owner),
		reconcile: () => enqueue(() => reconcileSources(new Map(sources))),
		stop() {
			if (stopPromise) { return stopPromise; }
			stopped = true;
			if (timer) { clearInterval(timer); }
			if (activeMcpRuntime === runtime) { activeMcpRuntime = null; }
			const stopping = runtime?.stop();
			stopPromise = enqueue(async () => {
				await stopping;
				await runtime?.stop();
				await gateway?.close();
				gateway = null;
				sources.clear();
				skipped.clear();
				for (const key of Object.keys(gatewayEnv)) { delete gatewayEnv[key]; }
			});
			return stopPromise;
		},
	};
	service.ready = service.reconcile();
	service.ready.catch(warnFailure);
	try {
		ctx.provide?.('vssarosMcpSources', service);
	} catch (error) {
		// 双 plane 再 apply：host 层已经提供同名服务 ⇒ 复用它，本地这份运行时要停掉避免重复挂载。
		console.log(`[vssaros-mcp] vssarosMcpSources 已由另一层提供 ⇒ 复用：${String(error?.message ?? error)}`);
		void service.stop().catch(() => undefined);
	}
	if (enabled) {
		ctx.effect(() => {
			let polling = false;
			timer = setInterval(() => {
				if (polling || stopped) { return; }
				polling = true;
				void enqueue(async () => {
					if (stopped) { return; }
					const signature = `${await mtimeOf(path)}|${await mtimeOf(secretsPathForMcpConfig(path))}`;
					if (signature !== lastSignature || !initialized) { await reconcileSources(new Map(sources)); }
				}).catch(warnFailure).finally(() => { polling = false; });
			}, 2000);
			timer?.unref?.();
			return () => service.stop();
		});
	}
	return service;
}

// 探针/测试用：把纯逻辑再导出一次（浏览器侧没人读这些）。
export const __test = {
	parseMcpServers, summarizeMcp, renderSection, escapeHtml, defaultMcpPath, planMcpInstall, planMcpRemove,
	isMcpRuntimeMountEnabled, loadMcpClient, McpRuntime, readMountPlan, mtimeOf,
	scanImportSources, toImportView, planImport,
	isOsvEnabled, checkStdioEntriesAgainstOsv, buildOsvBlockedMessage,
	listCatalog, catalogEntryOf, planCatalogInstall,
	isMcpGatewayEnabled, createMcpGateway, resolveSecretRefs,
	readSecrets, writeSecrets, secretsAsEnv, planSecretSet, planSecretDelete, secretView, secretEnvName,
	SECTION_ROUTE, ROUTE_PREFIX,
};
