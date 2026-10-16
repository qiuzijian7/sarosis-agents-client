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
