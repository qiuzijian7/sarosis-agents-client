/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **社区插件目录**（dsh-market 的那份目录）。
 *
 * 背景：`dsh-market`（npm 包名 `dshmarket`，插件 id `dsh-market`）是 DSH 里的可视化插件市场，
 * 它**自己不维护目录**——目录来自策展注册表 **`awesome-dsh-plugin.com/plugins.json`**（`dsh-market`
 * 每次打开实时拉取，可用 `DSHM_REGISTRY_URL` 换镜像）。我们在「插件商城」里展示的内容就是这一份。
 *
 * 为什么直接抓这份 JSON 而不是去读那个插件的接口：① 该站点带 `access-control-allow-origin: *`
 * ⇒ 渲染进程可直接取（无需主进程代理）；② 插件自身的 HTTP 路由只有 `status` / 同源安装 / 重启，
 * **没有**"把目录转发出来"的路由；③ 这样我们的商城**不依赖那个插件是否已装**（它只是同一份数据的另一个前端）。
 *
 * 字段口径照站点的真源（2026-10-13 实测 `count: 4579`）：
 * `{ name, owner, url（GitHub）, page, category, description: { en, zh }, npm, version, stars, downloads,
 *    capabilities[], install（"dsh plugin --profile web add …"） , added }`。
 * 安装 spec 的优先级照 `dsh-market` 自己的策略：**npm 包名优先**，没有 npm 时才回落到仓库地址（git）。
 */

/** 目录地址（`dsh-market` 同源；带 10 分钟缓存，见站点 `cache-control: max-age=600`）。 */
export const DSH_MARKET_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json';

/** 一条社区插件（只取我们商城要展示/安装的字段）。 */
export interface IDshMarketEntry {
	readonly name: string;
	readonly owner: string;
	/** GitHub 仓库地址（兜底安装源）。 */
	readonly url: string;
	/** 目录页（点开看详情）。 */
	readonly page?: string;
	/** npm 包名（**首选安装源**；缺省时用 `url` 走 git）。 */
	readonly npm?: string;
	readonly version?: string;
	readonly stars?: number;
	readonly downloads?: number;
	readonly category?: string;
	/** 中文描述优先，缺省回落到英文。 */
	readonly description: string;
	/** 声明的能力（`fs-read` / `fs-write` / `env` …）——装之前该让用户看见。 */
	readonly capabilities: readonly string[];
}

/** `installBundle` / `inspectBundle` 用的 spec：npm 优先，否则 git 地址。 */
export function dshMarketInstallSpec(entry: IDshMarketEntry): string {
	return entry.npm ? entry.npm : entry.url;
}

const CACHE_TTL_MS = 10 * 60_000;

let cache: { at: number; entries: readonly IDshMarketEntry[] } | undefined;

/** 清缓存（探针/测试用）。 */
export function resetDshMarketCatalogCache(): void {
	cache = undefined;
}

/**
 * 取社区目录。
 *
 * 失败时**抛错**（由调用方渲染成一行错误 + 重试入口）——刻意不做"内置快照兜底"：对一个每天增长的目录，
 * 过时的答案不是降级而是错误（`dsh-market` 的 README 也是这个口径）。
 */
export async function fetchDshMarketCatalog(options?: { readonly force?: boolean; readonly signal?: AbortSignal }): Promise<readonly IDshMarketEntry[]> {
	if (!options?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.entries;
	}
	const res = await fetch(DSH_MARKET_CATALOG_URL, { signal: options?.signal, headers: { accept: 'application/json' } });
	if (!res.ok) {
		throw new Error(`目录站返回 ${res.status}`);
	}
	const raw: unknown = await res.json();
	const entries = parseDshMarketCatalog(raw);
	cache = { at: Date.now(), entries };
	return entries;
}

/** 解析（导出以便单测/守卫直接验形状）。 */
export function parseDshMarketCatalog(raw: unknown): readonly IDshMarketEntry[] {
	const plugins = (raw as { plugins?: unknown })?.plugins;
	if (!Array.isArray(plugins)) {
		throw new Error('目录格式不认识（缺 plugins 数组）');
	}
	const out: IDshMarketEntry[] = [];
	for (const item of plugins) {
		const p = item as Record<string, unknown>;
		const name = typeof p.name === 'string' ? p.name : undefined;
		const url = typeof p.url === 'string' ? p.url : undefined;
		if (!name || !url) {
			continue;
		}
		const desc = p.description as { zh?: unknown; en?: unknown } | undefined;
		out.push({
			name,
			owner: typeof p.owner === 'string' ? p.owner : '',
			url,
			page: typeof p.page === 'string' ? p.page : undefined,
			npm: typeof p.npm === 'string' ? p.npm : undefined,
			version: typeof p.version === 'string' ? p.version : undefined,
			stars: typeof p.stars === 'number' ? p.stars : undefined,
			downloads: typeof p.downloads === 'number' ? p.downloads : undefined,
			category: typeof p.category === 'string' ? p.category : undefined,
			description: (typeof desc?.zh === 'string' && desc.zh) || (typeof desc?.en === 'string' ? desc.en : ''),
			capabilities: Array.isArray(p.capabilities) ? p.capabilities.filter((c): c is string => typeof c === 'string') : [],
		});
	}
	return out;
}
