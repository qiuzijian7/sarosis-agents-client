// 本地 Agent 设置页的**数据端点**（P2 · 2026-11-09）。
//
// 只提供可被 UI / 其它插件消费的纯数据与操作，不渲染任何界面：
// 真正的设置页与引擎徽标要改 `vssaros-chat-surface` 的既有 React chunk，
// 留到真机接入阶段（见设计文档 §6.2）。届时 UI 只需 `ctx.get('vssarosLocalAgents')`。
//
// ★ 不代管凭据：signIn() 只返回要复制的命令文本，永不执行、永不读写 CLI 配置。
// ★ 不泄露文件系统路径：list() 只给 installed / version，不给可执行文件绝对路径。
import { engineTable, validateCustom } from './engines.js';
import { findExecutable, probeVersion, searchDirs } from './discover.js';

/** 检测列表：每个引擎一条，同步（版本探测 10s 超时，失败为 undefined）。 */
export function listEngines({
	custom = [], dirs = searchDirs(), resolve = findExecutable, probe = probeVersion,
} = {}) {
	const table = engineTable(custom);
	return Object.entries(table).map(([route, spec]) => {
		const binary = resolve(spec.command, dirs);
		const installed = Boolean(binary);
		return {
			route,
			name: spec.name,
			kind: spec.kind,
			command: spec.command,
			installed,
			version: installed && probe ? probe(binary, spec.versionArgs) : undefined,
			signIn: String(spec.signIn ?? ''),
			custom: spec.custom === true,
			models: (spec.models ?? []).map((model) => ({ id: model.id, name: model.name })),
		};
	});
}

/** Sign in：只给要复制的命令，明确说明凭据归 CLI。 */
export function signInFor(engines, route) {
	const entry = (engines ?? []).find((engine) => engine.route === route);
	if (!entry) return { ok: false, error: `未知本地 Agent 路由 ${String(route)}` };
	if (!entry.signIn) return { ok: false, error: '该引擎没有配置登录命令（自定义 ACP agent 请自行按其文档登录）' };
	return {
		ok: true,
		route,
		command: entry.signIn,
		hint: '请在系统终端执行这条命令完成登录；凭据与套餐归 CLI 自己管理，本插件不代管 API key、不读写 CLI 配置。',
	};
}

/** 自定义 ACP agent 的校验结果（供设置页在提交前给出可读错误）。 */
export function validateCustomAgents(custom = []) {
	return (Array.isArray(custom) ? custom : []).map((agent, index) => {
		const problems = validateCustom(agent);
		return { index, id: String(agent?.id ?? ''), name: String(agent?.name ?? ''), valid: problems.length === 0, problems };
	});
}

/**
 * 供 `ctx.provide('vssarosLocalAgents', service)` 的服务。
 * @param refreshRoutes () => { routes: string[] } 由插件入口重扫并调用 registration.replace()
 */
export function createSettingsService({
	custom = [], initialRoutes = [], refreshRoutes, resolve = findExecutable, probe = probeVersion,
} = {}) {
	let routes = [...initialRoutes];
	let engines = listEngines({ custom, resolve, probe });

	const list = () => engines.map((entry) => ({ ...entry, models: entry.models.map((model) => ({ ...model })) }));
	return {
		/** 检测列表（含 installed / version / signIn / models）。 */
		list,
		/** 当前已注册的模型路由。 */
		routes: () => [...routes],
		/** 要复制的登录命令；不执行。 */
		signIn: (route) => signInFor(engines, route),
		/** 自定义 agent 校验。 */
		validateCustom: (agents) => validateCustomAgents(agents),
		/** 重扫 CLI + 原子热换路由，返回最新快照。 */
		refresh() {
			let next;
			try {
				next = typeof refreshRoutes === 'function' ? refreshRoutes() : undefined;
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error), routes: [...routes], engines: list() };
			}
			routes = Array.isArray(next?.routes) ? [...next.routes] : routes;
			engines = listEngines({ custom, resolve, probe });
			return { ok: true, routes: [...routes], engines: list() };
		},
	};
}
