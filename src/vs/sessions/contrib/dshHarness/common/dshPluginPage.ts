/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件自托管页面（方案 6.3 `view.kind=page`）的路由校验与 URL 解析。
 *
 * 为什么需要它：dsh Host 用**同一个 origin** 既服务官方 Web Client 也服务插件页面
 * （插件注册前缀路由，经 `ctx.connection` 鉴权）。视图池必须把请求落到
 * `<origin><route>`，同时保留 dsh 的 token 认证交换（`authUrl` 形如
 * `http://127.0.0.1:PORT/?token=...`）——即"把 authUrl 的 pathname 换成路由"。
 *
 * 纯逻辑、无 I/O；`dshViewHost` 调用 {@link resolveViewUrl}，通道侧调用 {@link validatePluginRoute}。
 */

/** 路由长度上限（与清单 schema 的 route 同口径）。 */
export const DSH_PLUGIN_ROUTE_MAX = 200;

/** 单段路径允许的字符（与清单 schema `view.route` 一致）。 */
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * 校验插件页面路由：站内绝对路径。
 * 拒绝：非 `/` 开头、`//` 前缀（协议相对地址）、空段、`..`、查询串 / 井号 / 反斜杠 / 空白。
 */
export function validatePluginRoute(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const route = raw.trim();
	if (!route || route.length > DSH_PLUGIN_ROUTE_MAX) {
		return undefined;
	}
	if (!route.startsWith('/') || route.startsWith('//')) {
		return undefined;
	}
	const segments = route.slice(1).split('/');
	// 末尾的 '/' 会产生一个空段：允许（`/x/y/` 与 `/x/y` 等价），其余空段一律拒绝。
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (!seg) {
			if (i === segments.length - 1) {
				continue;
			}
			return undefined;
		}
		if (seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
			return undefined;
		}
	}
	return route;
}

export interface IResolveViewUrlArgs {
	/** dsh Host 的源（`http://127.0.0.1:<port>`）。 */
	readonly origin: string;
	/** 带 token 的认证 URL（`<origin>/?token=...`）；仅在尚无有效 Cookie 时使用。 */
	readonly authUrl: string;
	/** 视图要加载的路由；`/` 表示官方 Web Client（与既有行为一致）。 */
	readonly route: string;
	/** 该分区里已有 dsh-auth Cookie（true 时直接打 origin）。 */
	readonly hasAuth: boolean;
	/**
	 * 插件页的承载表面（`sideview` / `editor`）⇒ 追加 `?surface=<值>`，让插件决定渲染哪一版。
	 * ⚠ 只对**插件页**（`route !== '/'`）生效：官方 Web Client 那条路径的 URL 必须逐字符不变 ✓。
	 */
	readonly surface?: string;
}

/** 追加查询参数（保留既有查询串，例如 authUrl 上的 `?token=`）✓。 */
function withSurface(base: string, surface: string | undefined): string {
	if (!surface) {
		return base;
	}
	return `${base}${base.includes('?') ? '&' : '?'}surface=${encodeURIComponent(surface)}`;
}

/**
 * 解析视图最终加载的 URL：
 * - 已有 Cookie：`<origin><route>`（不再走 token 交换）；
 * - 否则：`authUrl` 的 pathname 换成 route（保留 `?token=` 与 hash，认证交换照旧）。
 *
 * `route='/'` 且无 Cookie 时**原样返回 authUrl**（回归保护：既有行为逐字符不变）。
 *
 * 2026-10-13：`args.surface` 给出时，为**插件页**（route 非 `/`）追加 `?surface=<值>` ——
 * 侧栏与编辑区承载同一个页面，靠它区分渲染版本（回归：不传 surface 时输出与改造前逐字符相同 ✓）。
 */
export function resolveViewUrl(args: IResolveViewUrlArgs): string {
	const route = args.route && args.route.startsWith('/') ? args.route : '/';
	// ⚠ `route='/'` 是官方 Web Client 的回归保护路径 ⇒ 不加任何查询参数 ✓
	const surface = route !== '/' ? args.surface : undefined;
	if (args.hasAuth) {
		return withSurface(`${args.origin}${route}`, surface);
	}
	if (route === '/') {
		return args.authUrl;
	}
	try {
		const url = new URL(args.authUrl);
		url.pathname = route;
		if (surface) {
			url.searchParams.set('surface', surface);
		}
		return url.href;
	} catch {
		// authUrl 不可解析（理论上不会发生）：退回源 + 路由，至少不打错站点。
		return withSurface(`${args.origin}${route}`, surface);
	}
}
