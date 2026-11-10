// @vssaros/dsh-local-agents — 把本机已安装、已登录的编程 Agent CLI
// 注册成 dsh 的模型路由，让 Bot 能直接用 CLI 自带的登录与套餐。
//
// P0 范围：探测 CLI → ctx.llm.registerAdapter(routes, adapter) → 由 dsh 原有
// loop / Session / 工具 / 审批跑一次问答。不做 ACP 握手、不做工具桥、不做 UI。
//
// ★ 默认关闭（fail-closed）：cordis.patch.yml 的 config.enabled 要显式打开才有路由。
// ★ llm 用**动态 inject**：静态写进 inject 会让 headless / tui profile 永久 pending
//   （与 vssaros-agents 的既有结论一致）。
import { createLocalAgentAdapter } from './core/adapter.js';
import { createAcpSessionMap } from './core/sessionMap.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { engineTable, isLocalAgentRoute } from './core/engines.js';
import { findExecutable, searchDirs } from './core/discover.js';
import { createApprovalRequester, createApproveToolDefinition } from './core/approval.js';
import { createSettingsService } from './core/settings.js';
import { ROUTE_PREFIX, apiResponse } from './core/page.js';

export const name = 'vssaros-local-agents';
export const inject = [];

export const DEFAULTS = { enabled: false, custom: [] };

/** 只对本机真的装了的 CLI 注册路由；返回 route 列表（供测试与设置页复用）。 */
export function scanRoutes(custom = [], dirs = searchDirs(), resolve = findExecutable) {
	const table = engineTable(custom);
	return Object.keys(table).filter((route) => {
		const spec = table[route];
		return !spec.custom && Boolean(resolve(spec.command, dirs));
	});
}

export function apply(ctx, config = {}) {
	// 守卫的假 ctx / headless bundle 可能没有 inject：直接降级，不抛。
	if (!ctx || typeof ctx.inject !== 'function') return;
	const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
	if (!cfg.enabled) return;

	const table = engineTable(cfg.custom);
	const dirs = searchDirs();
	const routes = scanRoutes(cfg.custom, dirs);

	let registration;
	// P2：settings 提到 apply 闭包，供 HTTP 页面与 llm inject **共用**。
	// client chunk 是另一个进程，拿不到 child scope 的 provide —— 所以页面直接引用这份实例。
	const settings = createSettingsService({
		custom: cfg.custom,
		initialRoutes: routes,
		refreshRoutes: () => {
			const next = scanRoutes(cfg.custom, searchDirs());
			registration?.replace?.(next);
			return { routes: next };
		},
	});

	// ① SSR 设置页（可选依赖）：不在 web 模板 / headless profile 时只是没有页面，能力照常。
	ctx.inject(['webServer', 'connection'], (page) => {
		if (!page?.webServer?.register || !page?.connection?.requestRejection || typeof page.effect !== 'function') return;
		page.effect(() => page.webServer.register({
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
					// POST 只做重扫 / 纯校验，但仍要求同源，避免跨站表单触发。
					if (req.method === 'POST' && req.headers?.origin) {
						const originHost = new URL(req.headers.origin).host;
						if (originHost !== req.headers?.host) {
							res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
							res.end('cross-origin POST refused');
							return;
						}
					}
					const url = new URL(req.url ?? '/', 'http://127.0.0.1');
					const query = Object.fromEntries(url.searchParams);
					let body = '';
					if (req.method === 'POST') {
						for await (const chunk of req) {
							body += String(chunk);
							if (body.length > 64 * 1024) throw new Error('请求体过大');
						}
					}
					const answer = apiResponse({ method: req.method, pathname: url.pathname, query, body, settings });
					res.writeHead(answer.status, answer.headers);
					res.end(answer.body);
				} catch (error) {
					if (res.headersSent) { res.end(); return; }
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(String(error?.message ?? error));
				}
			},
		}));
	});

	// ② LLM adapter：本机一个 CLI 都没装时不注册路由，但设置页仍可打开显示"未检测到"。
	ctx.inject(['llm', 'tools'], (child) => {
		const llm = child?.llm;
		// 老 runtime 没有 registerAdapter：明确不注册，不假装支持。
		if (!llm || typeof llm.registerAdapter !== 'function' || routes.length === 0) return;
		// P1：CLI 通过 ACP 请求权限时，由这个工具把请求送进官方审批卡。
		// 工具对全部会话可见，但只有本地 Agent 的 adapter 会调用它；P2 再按 scope 收窄。
		let offApproveTool;
		if (typeof child.tools?.register === 'function') {
			offApproveTool = child.tools.register(createApproveToolDefinition({
				requestApproval: createApprovalRequester(child),
			}));
		}
		// P2：图片字节走官方附件服务；没有服务时不注入，resolveModel 也就不会宣称支持图片。
		const attachments = (() => {
			try { return child.get?.('attachments'); } catch { return undefined; }
		})();
		const readImage = typeof attachments?.readImage === 'function'
			? (ref) => attachments.readImage(ref)
			: undefined;
		// P1-5（2026-11-10）：ACP 会话的 cwd 与附加根来自 foundation 的**运行期**根集，不再落到
		// Host 进程目录（`process.cwd()` 会把 CLI 会话开在 dsh 的安装目录 ✗）。
		// 懒取：假 ctx / 老 Host 没有该服务 ⇒ 回落旧行为，不抛、不谎报 ✓。
		const foundationOf = () => {
			try { return ctx.reflect?.get?.('vssarosFoundation', false) ?? ctx.get?.('vssarosFoundation'); }
			catch { return undefined; }
		};
		const rootsOf = () => {
			try { return foundationOf()?.workspaceRoots?.() ?? []; } catch { return []; }
		};
		const cwdFor = () => rootsOf()[0]?.path ?? process.cwd();
		const rootsFor = () => rootsOf().map(root => root?.path).filter(path => typeof path === 'string' && path.trim());
		// P1-9：dsh sessionId ↔ cliSessionId 的持久映射（Host 重启后 resume）。
		// ★ 懒 IO：第一次 ensureLive 才读盘；写用 tmp + rename 原子替换，失败不拖垮会话 ✓。
		// ★ 只存 id：根集 / cwd / mcpServers 仍由 resume 请求显式重传，不隐式复活旧作用域 ✓。
		const dataRoot = (() => {
			try {
				const foundation = foundationOf();
				return typeof foundation?.dataRootOf === 'function'
					? foundation.dataRootOf({}) : join(homedir(), '.vssaros');
			} catch { return join(homedir(), '.vssaros'); }
		})();
		const mapPath = join(dataRoot, 'acp-sessions.json');
		const sessionMap = createAcpSessionMap({
			readText: () => readFile(mapPath, 'utf8'),
			writeText: async (text) => {
				await mkdir(dirname(mapPath), { recursive: true });
				const tmp = `${mapPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
				await writeFile(tmp, text, 'utf8');
				await rename(tmp, mapPath);
			},
		});
		const adapter = createLocalAgentAdapter({
			engineTable: table,
			findExecutable: (command) => findExecutable(command, dirs),
			readImage,
			cwdFor,
			rootsFor,
			sessionMap,
		});
		registration = llm.registerAdapter(routes, adapter);
		// 同进程消费者仍可 ctx.get；HTTP 页面走 apply 闭包里的同一份 settings 实例。
		child.provide?.('vssarosLocalAgents', settings);
		child.effect?.(() => () => {
			adapter.dispose();
			registration?.();
			try { typeof offApproveTool === 'function' ? offApproveTool() : offApproveTool?.dispose?.(); } catch { /* gone */ }
		}, 'vssaros: local agents');
	});
}

export { isLocalAgentRoute };
