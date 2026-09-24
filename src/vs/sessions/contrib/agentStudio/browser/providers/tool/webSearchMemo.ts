/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `web_search` 的**结果备忘**（内存、TTL、单飞）—— 对齐 Hermes-Agent 的 search memo
 * （`tools/web_result_cache.py:91-109`），补上我们此前完全缺失的一层：我们只做了 `web_extract`
 * 的页面缓存（`webPageCache.ts`），**搜索结果零缓存**，同一轮里模型把同一个查询发三次就是三次打网。
 *
 * ## 三个刻意的最小设计（每个都对应一类已知坑）
 *
 *   ① **键含 provider**：不同后端的同一查询是**不同的结果**（DDG / Tavily / 垂直域差异很大），
 *      不共用条目。这同时替掉了 Hermes 那条"被 rescue 的响应不入缓存"的规则 —— 在我们的
 *      链式短路里，降级到 DDG 的那次会以 `ddg` 为键缓存，下一轮链路仍会**先试主后端**，
 *      所以"降级结果粘住主路径"这件事从键的构造上就不可能发生。
 *   ② **limit 分桶**（`bucketLimit` 向上取整）：`max_results: 3` 与 `5` 共享同一份结果，
 *      命中率显著提高。注意是**按桶去取**（向 provider 要桶大小的条数）、渲染时再切到用户要的条数，
 *      所以"取了 10 条只显示 3 条"是刻意的 —— 换来的是一份能服务整个桶的结果。
 *   ③ **单飞**：同一 key 的并发调用只发一次网络请求（模型一轮里并行发同样查询是常见行为）。
 *
 * ## 不做的事
 *
 *   · 不落盘：搜索结果是**时效性**内容，跨进程/跨会话复用会把过期信息当新的给（与页面缓存的
 *     24 小时语义不同，那条缓存有 `refresh` 逃生舱且会标注捕获时间）。
 *   · 不缓存失败：抛错不入库（只有成功解析出的输出才进）。
 *   · 不缓存**被显式指定 provider 的查询**之外的额外语义 —— 没有"救援身份"的概念，见 ①。
 */

import type { IWebSearchProviderOutput } from './webSearchProviders.js';

/** 默认 TTL：20 分钟（与 Hermes 的 `web.cache_ttl_minutes` 默认值一致）。 */
export const SEARCH_MEMO_TTL_MS = 20 * 60 * 1000;

/**
 * limit 分桶边界（向上取整到最接近的档）。
 *
 * 我们的 `max_results` 被工具限制在 1..10，所以两档就够：1–5 → 5，6–10 → 10。
 * 桶值同时也是"向 provider 要多少条"——所以桶必须 ≥ 用户请求的条数（向上取整保证这点）。
 */
const LIMIT_BUCKETS: readonly number[] = [5, 10];

/** 把请求条数向上取整到桶（超出最大桶时用请求值本身，保证不会取少于用户要的）。 */
export function bucketLimit(limit: number): number {
	for (const bucket of LIMIT_BUCKETS) {
		if (limit <= bucket) { return bucket; }
	}
	return limit;
}

/**
 * 查询归一化：折叠空白 + 转小写。
 *
 * 只做这两件事 —— "去掉标点"之类的激进归一化会让语义不同的查询撞在一起（`C++` vs `C`、
 * `node.js` vs `nodejs`），而缓存串味比不命中坏得多。
 */
export function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 备忘键：(provider, 归一化查询, 分桶 limit)。 */
export function searchMemoKey(provider: string, query: string, limit: number): string {
	return `${provider}\u0000${normalizeQuery(query)}\u0000${bucketLimit(limit)}`;
}

interface IEntry {
	readonly at: number;
	readonly value: IWebSearchProviderOutput;
}

/**
 * TTL + 单飞的输出备忘。
 *
 * 时钟与 TTL 都可注入，所以"过期"与"单飞"能在单测里被确定性地验证（不靠 sleep）。
 */
export class WebSearchMemo {

	private readonly _entries = new Map<string, IEntry>();
	private readonly _inFlight = new Map<string, Promise<IWebSearchProviderOutput>>();

	constructor(
		private readonly _ttlMs: number = SEARCH_MEMO_TTL_MS,
		private readonly _now: () => number = () => Date.now(),
	) { }

	/** 命中且未过期则返回；否则 undefined（顺手清掉过期条目，避免无界增长）。 */
	get(key: string): IWebSearchProviderOutput | undefined {
		const entry = this._entries.get(key);
		if (!entry) { return undefined; }
		if (this._now() - entry.at >= this._ttlMs) {
			this._entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	/**
	 * 取缓存，未命中则用 `factory` 生成（同 key 并发只跑一次）。
	 *
	 * `factory` 抛错时**不写缓存**并把错误原样抛出 —— 失败必须让调用方看到（链路要据此决定
	 * 是否继续下一环 / 是否熔断），缓存失败还会把一次偶发故障固化整个 TTL。
	 */
	async getOrLoad(key: string, factory: () => Promise<IWebSearchProviderOutput>): Promise<IWebSearchProviderOutput> {
		const cached = this.get(key);
		if (cached) { return cached; }

		const pending = this._inFlight.get(key);
		if (pending) { return pending; }

		const loading = factory().then(
			value => {
				this._entries.set(key, { at: this._now(), value });
				return value;
			},
			err => { throw err; },
		).finally(() => {
			this._inFlight.delete(key);
		});
		this._inFlight.set(key, loading);
		return loading;
	}

	/** 当前条目数（诊断/测试用）。 */
	get size(): number {
		return this._entries.size;
	}
}
