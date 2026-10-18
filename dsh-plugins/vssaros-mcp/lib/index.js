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

export function apply(ctx, config = {}) {
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
	// 审批闸（与 kanban/kb/memory 同一把 ✓）：mcp_install 写 mcp.json ⇒ 重启后新服务器挂载 ⇒ 能跑
	// 任意命令（stdio 的 command 是任意可执行文件 ✗）⇒ 写类挂闸 ✓。官方契约：ask 只有审批服务返回
	// allowed-once 才执行 ✓；没有审批支持的部署（headless）⇒ deny ✓（fail-closed ✓）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && exec.name === 'mcp_install') {
			return {
				kind: 'ask',
				reason: `mcp_install 会写入 mcp.json（重启 Host 后挂载新服务器 ⇒ 能跑任意命令）`,
				displayReason: { en: 'Allow mcp_install to write mcp.json (new server mounts on restart)?', zh: '允许 mcp_install 写入 mcp.json（重启后挂载新服务器）？' },
			};
		}
		return next();
	}));
	// 重构 4（2026-10-16）：`mcp_install` 工具——写 `mcp.json` 的 `mcpServers` 段（方案 2.x：
	// "写 mcp.json 后由 sync-rows 重新生成 bundle"——sync-rows 是宿主启动链的事，本工具只写配置 ✓）。
	// 写类 ⇒ 挂审批闸 ✓。**供应链预检（OSV 恶意包）没做**：那是壳侧的远端调用（`mcpSupplyChain.ts`），
	// 本侧如实写明"没拦"（不假装拦了 ✗）——要拦那道，经桥回 IDE 做（留待）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_install',
		description: '安装一个 MCP 服务器：把它的配置写进 mcp.json 的 mcpServers 段（stdio/sse/http）。写完要重启 Host 才生效（sync-rows 在启动链里重新生成 bundle——这是固有约束 ✓）。⚠ 本侧**不做供应链预检**（OSV 恶意包拦截是壳侧的远端调用，没迁过来）——装来路不明的包前自己掂量。',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: '服务器名（mcpServers 的键；小写字母/数字/连字符/下划线）' },
				transport: { type: 'string', enum: ['stdio', 'sse', 'http'], description: '传输方式' },
				command: { type: 'string', description: 'stdio 的启动命令（如 "npx"）' },
				args: { type: 'array', items: { type: 'string' }, description: 'stdio 的命令参数（如 ["-y", "pkg"]）' },
				url: { type: 'string', description: 'sse/http 的端点 URL' },
				env: { type: 'object', description: '环境变量（可选）' },
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
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已写入 ${value.name}（${value.path}）——重启 Host 后生效（sync-rows 会重新生成 bundle）。`
					: `安装失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		execute: async (params) => {
			const name = String(params?.name ?? '').trim();
			if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
				throw new Error(`name 不合法：${name} —— 只允许小写字母/数字/连字符/下划线（如 my-server）。`);
			}
			const transport = String(params?.transport ?? '').trim();
			if (!['stdio', 'sse', 'http'].includes(transport)) {
				throw new Error(`transport 必须是 stdio / sse / http 之一（收到 ${transport || '(空)'}）。`);
			}
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
			const servers = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? { ...raw.mcpServers } : {};
			if (servers[name]) { throw new Error(`MCP 服务器 ${name} 已存在（不会覆盖 ✓；要改先删掉再装）。`); }
			// 按传输方式组装条目（与 mcp.json 的上游格式一致 ✓）。
			const entry = transport === 'stdio'
				? { command: String(params?.command ?? '').trim(), args: Array.isArray(params?.args) ? params.args.map(String) : [], ...(params?.env && typeof params.env === 'object' ? { env: params.env } : {}) }
				: { url: String(params?.url ?? '').trim(), ...(params?.env && typeof params.env === 'object' ? { env: params.env } : {}) };
			if (transport === 'stdio' && !entry.command) { throw new Error('stdio 需要 command（启动命令，如 "npx"）。'); }
			if (transport !== 'stdio' && !entry.url) { throw new Error(`${transport} 需要 url（端点 URL）。`); }
			servers[name] = entry;
			const { writeFile, mkdir } = await import('node:fs/promises');
			const { dirname } = await import('node:path');
			await mkdir(dirname(path), { recursive: true });
			// 只改 mcpServers 段，其余键原样保留（raw 是原始文件的形状 ✓）。
			await writeFile(path, JSON.stringify({ ...raw, mcpServers: servers }, null, 2));
			return { ok: true, name, path, restartNeeded: true };
		},
	}));

	// 重构 4（2026-10-17）：`mcp_market_list`——浏览 MCP 市场（只读：经桥回 IDE 拉远端清单，
	// 远端服务在壳侧的 marketplaceService ✓）。安装入口是 mcp_install（写 mcp.json ✓——本工具
	// 只浏览 ✓，不安装 ✗）。
	ctx.effect(() => ctx.tools.register({
		name: 'mcp_market_list',
		description: '浏览 MCP 市场：列出远端可装的 MCP 服务器（名称 / 描述 / 版本 / 作者）。只读（不安装——安装用 mcp_install，写 mcp.json 后重启生效）。远端服务要登录（经 IDE 侧的 marketplaceService）。',
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
	// 片段路由：与 memory 的区块同法——Host 自己的鉴权栅栏 + 客户端请求带的 Cookie。
	// 片段路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有片段** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
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

// 探针/测试用：把纯逻辑再导出一次（浏览器侧没人读这些）。
export const __test = { parseMcpServers, summarizeMcp, renderSection, escapeHtml, defaultMcpPath, SECTION_ROUTE, ROUTE_PREFIX };
