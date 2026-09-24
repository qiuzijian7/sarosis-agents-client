/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * web_extract 的**本地持久化页面缓存**（P2，2026-09-24）。
 *
 * ## 只缓存 web_extract，**不**缓存 web_search —— 这是刻意的
 *
 * 两者的时效性完全不同：
 *   • 页面内容（web_extract）—— 变化慢，重复抓取纯浪费。一次失败/重试的成本是
 *     2–5 秒的 BrowserWindow 加载 + 一次跨网抓取；而模型在多变轮任务里**反复读同一个
 *     URL** 是常态（追问、子代理读同一篇文档）。
 *   • 搜索结果（web_search）—— 语义就是"最新"。缓存它会让"查最新版本/最新新闻"这类
 *     调用悄悄拿到陈旧结果，**恰好废掉这个工具存在的理由**。所以即使缓存很重要，
 *     也不该用在这里。
 *
 * ## 与主进程 `WebContentCache` 的关系（两层，不是重复）
 *
 * 主进程 `webContentCache.ts` 已有 24h / LRU 1000 的缓存，但它是**进程内内存**的：
 * 窗口一重启就没了。本模块是**持久化**层，坐在它前面，TTL 与成功态口径**对齐到同一个
 * 24h**（避免出现"外层比内层旧/新"造成的语义漂移）。因此：
 *   进程内重复抓取 → 外层命中（更快，且省掉一次 IPC + 主进程查找）；
 *   重启后重复抓取 → 外层命中（这是主进程缓存拿不到的那部分收益）。
 *
 * ## 不入缓存的三种情况
 *
 *   1. `blocked`（拦截页）—— 既不作为内容返回，也不入缓存：拦截是**瞬态**的
 *      （Cloudflare 放行后同一 URL 就能拿到正文），缓存它等于把一次偶发拦截固化 24 小时。
 *   2. 抓取失败 —— 失败不该被"记成内容"。
 *   3. 用户 `refresh: true` —— 显式要求重抓时同时**刷新**缓存。
 *
 * ## 碰撞安全
 *
 * key 是 URL 的 32-bit 哈希（只为把长 URL 压成短存储键）。因此读取时**必须**校验
 * `entry.url === url`：碰撞时宁可当 miss（并顺手清掉脏条目），也不能串页返回别的网页内容。
 *
 * 本模块不含 VS Code 依赖（只依赖注入的窄存储抽象 `IWebCacheStore`），可用 Map 替身单测。
 */

/** 缓存有效期。与主进程 `WebContentCache.SUCCESS_CACHE_DURATION` 保持一致。 */
export const WEB_PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 最多缓存多少页（LRU 裁剪）。40 页 × ≤20k 字符 ≈ 最多约 800KB 存储。 */
export const WEB_PAGE_CACHE_MAX_ENTRIES = 40;

/**
 * 极窄存储抽象 —— 只暴露本模块真正用到的三个动作。
 *
 * 好处：① 不把 `IStorageService` 的 scope/target 概念漏进缓存逻辑（由适配器固定为
 * APPLICATION + MACHINE：跨工作区共享、不随设置同步）；② 单测用 Map 替身即可。
 */
export interface IWebCacheStore {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
	delete(key: string): void;
}

export interface ICachedPage {
	/** 归一化后的 URL（见 `normalizeCacheUrl`）。 */
	readonly url: string;
	/** 页面标题（原始 HTML 路径抽自 `<title>`；reader-mode 路径由提取器给出）。 */
	readonly title: string;
	readonly description: string;
	/** 提取到的正文（未截断、未格式化 —— 格式化在命中时重新做，这样将来改文案不会**
	 *  **被缓存冻住）。 */
	readonly text: string;
	/** 产出这份正文的路径（'reader-mode' | 'raw-html'）——命中后据此复用同一套格式化。 */
	readonly source: string;
	readonly cachedAt: number;
}

interface ICacheIndexEntry {
	/** 短 key（URL 哈希）。 */
	readonly k: string;
	/** 归一化 URL —— 用于碰撞校验与诊断。 */
	readonly u: string;
	/** 写入时间（epoch ms）——用于 TTL 清扫。 */
	readonly t: number;
}

const INDEX_KEY = 'saros.webExtractCache.index';
const ENTRY_PREFIX = 'saros.webExtractCache.entry.';

/** 日志只需这两个方法（避免把 ILogService 拖进本模块）。 */
export interface IWebCacheLogger {
	info?(message: string): void;
	warn?(message: string): void;
}

/**
 * URL 归一化：去掉 fragment（页内锚点不改变页面内容），保留 query
 * （大量站点靠 query 决定内容，砍掉会串页）。
 */
export function normalizeCacheUrl(url: string): string {
	const hashIdx = url.indexOf('#');
	return (hashIdx >= 0 ? url.slice(0, hashIdx) : url).trim();
}

/** 32-bit FNV-1a：把 URL 压成短存储键。碰撞由读取时的 url 校验兜住（见文件头）。 */
export function cacheKeyFor(normalizedUrl: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < normalizedUrl.length; i++) {
		h ^= normalizedUrl.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** 某个 URL 的**存储键**（导出以便单测直接构造/破坏条目，验证碰撞与脏数据路径）。 */
export function webCacheEntryKey(url: string): string {
	return ENTRY_PREFIX + cacheKeyFor(normalizeCacheUrl(url));
}

/** 索引的存储键（导出理由同上）。 */
export function webCacheIndexKey(): string {
	return INDEX_KEY;
}

/** 把 age（毫秒）格式化成紧凑人读文本：`<1m` / `45m` / `3h 12m` / `2d`。 */
export function formatCacheAge(ageMs: number): string {
	const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
	if (minutes < 1) { return '<1m'; }
	if (minutes < 60) { return `${minutes}m`; }
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rem = minutes % 60;
		return rem ? `${hours}h ${rem}m` : `${hours}h`;
	}
	return `${Math.floor(hours / 24)}d`;
}

/**
 * 缓存命中时追加的**标注**（让模型知道这不是刚抓的）。
 *
 * 为什么必须标注：不标注的话模型会把 24 小时前的页面当成"实时抓取结果"，对时效性判断
 * 产生错误信心 —— 而这正是"缓存悄悄改变语义"最危险的形态。同时告诉它怎么重抓。
 */
export function webExtractCacheNotice(cachedAt: number, now: number): string {
	return `\n\n_Served from the local page cache (captured ${new Date(cachedAt).toISOString()}, ${formatCacheAge(now - cachedAt)} ago). Pass \`refresh: true\` to fetch it again from the network._`;
}

export class WebPageCache {
	constructor(
		private readonly _store: IWebCacheStore,
		private readonly _logger?: IWebCacheLogger,
		/** 可注入时钟（单测用）。 */
		private readonly _now: () => number = () => Date.now(),
	) { }

	/** 命中返回页面；未命中 / 过期 / 碰撞 / 脏数据一律返回 undefined。 */
	get(url: string): ICachedPage | undefined {
		const normalized = normalizeCacheUrl(url);
		const key = cacheKeyFor(normalized);

		let index = this._readIndex();
		const beforeSweep = index.length;
		index = this._sweep(index);
		const swept = index.length !== beforeSweep;

		const pos = index.findIndex(e => e.k === key);
		if (pos < 0) {
			if (swept) { this._writeIndex(index); }
			return undefined;
		}

		const entry = this._readEntry(key);
		// 碰撞或脏数据：当 miss 并清掉（绝不返回别的 URL 的内容）。
		if (!entry || normalizeCacheUrl(entry.url) !== normalized) {
			this._store.delete(ENTRY_PREFIX + key);
			index.splice(pos, 1);
			this._writeIndex(index);
			if (entry) { this._logger?.warn?.(`[WebPageCache] key collision for ${normalized} (cached ${entry.url}) — treated as miss`); }
			return undefined;
		}

		// LRU：命中即前移。
		if (pos > 0) {
			index.splice(pos, 1);
			index.unshift({ k: key, u: normalized, t: entry.cachedAt });
			this._writeIndex(index);
		} else if (swept) {
			this._writeIndex(index);
		}
		return entry;
	}

	/** 写入（覆盖同 URL 的旧条目并前移）。沿用 now() 作为 cachedAt。 */
	put(page: Omit<ICachedPage, 'cachedAt'>): void {
		const normalized = normalizeCacheUrl(page.url);
		const key = cacheKeyFor(normalized);
		const entry: ICachedPage = { ...page, url: normalized, cachedAt: this._now() };

		try {
			this._store.set(ENTRY_PREFIX + key, JSON.stringify(entry));
		} catch (err) {
			// 存储写失败不能让 web_extract 失败（缓存是加速器，不是依赖）。
			this._logger?.warn?.(`[WebPageCache] write failed for ${normalized}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		let index = this._sweep(this._readIndex()).filter(e => e.k !== key);
		index.unshift({ k: key, u: normalized, t: entry.cachedAt });
		const kept = index.slice(0, WEB_PAGE_CACHE_MAX_ENTRIES);
		for (const dropped of index.slice(WEB_PAGE_CACHE_MAX_ENTRIES)) {
			this._store.delete(ENTRY_PREFIX + dropped.k);
		}
		this._writeIndex(kept);
	}

	/** 清空（设置页「清空缓存」/排障用）。 */
	clear(): void {
		for (const e of this._readIndex()) {
			this._store.delete(ENTRY_PREFIX + e.k);
		}
		this._store.delete(INDEX_KEY);
	}

	private _readIndex(): ICacheIndexEntry[] {
		const raw = this._store.get(INDEX_KEY);
		if (!raw) { return []; }
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) { return []; }
			return parsed.filter((e): e is ICacheIndexEntry =>
				typeof e === 'object' && e !== null
				&& typeof (e as ICacheIndexEntry).k === 'string'
				&& typeof (e as ICacheIndexEntry).u === 'string'
				&& typeof (e as ICacheIndexEntry).t === 'number');
		} catch {
			return [];
		}
	}

	private _writeIndex(index: readonly ICacheIndexEntry[]): void {
		// 写索引同样不能让异常逃出去（缓存是加速器，不是依赖；调用点还有一层兜底）。
		try {
			this._store.set(INDEX_KEY, JSON.stringify(index));
		} catch (err) {
			this._logger?.warn?.(`[WebPageCache] index write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _readEntry(key: string): ICachedPage | undefined {
		const raw = this._store.get(ENTRY_PREFIX + key);
		if (!raw) { return undefined; }
		try {
			const parsed = JSON.parse(raw) as ICachedPage;
			return (parsed && typeof parsed.url === 'string' && typeof parsed.text === 'string') ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 懒清扫：丢掉超 TTL 的条目与超出上限的尾部。
	 *
	 * 为什么"懒"而不是定时器：本模块没有生命周期宿主，起定时器会引入"谁负责 dispose"
	 * 的问题；而缓存操作本身就是低频的（每次 web_extract），顺路清扫足够。
	 */
	private _sweep(index: ICacheIndexEntry[]): ICacheIndexEntry[] {
		const now = this._now();
		const fresh = index.filter(e => now - e.t < WEB_PAGE_CACHE_TTL_MS);
		const freshKeys = new Set(fresh.map(e => e.k));
		for (const e of index) {
			if (!freshKeys.has(e.k)) { this._store.delete(ENTRY_PREFIX + e.k); }
		}
		const kept = fresh.slice(0, WEB_PAGE_CACHE_MAX_ENTRIES);
		for (const e of fresh.slice(WEB_PAGE_CACHE_MAX_ENTRIES)) {
			this._store.delete(ENTRY_PREFIX + e.k);
		}
		return kept;
	}
}
