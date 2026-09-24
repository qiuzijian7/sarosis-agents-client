/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * web_extract 本地页面缓存的单测（P2，2026-09-24）。
 *
 * 用一个 Map 替身当存储，因此可以精确构造三件在真机上极难复现的事：
 *   ① **TTL 过期**（注入时钟）；
 *   ② **哈希碰撞 / 脏条目**（直接往存储键里塞错数据）；
 *   ③ **存储写失败**（替身抛异常）—— 验证"缓存故障不能让 web_extract 失败"。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	WEB_PAGE_CACHE_MAX_ENTRIES,
	WEB_PAGE_CACHE_TTL_MS,
	WebPageCache,
	cacheKeyFor,
	formatCacheAge,
	normalizeCacheUrl,
	webCacheEntryKey,
	webCacheIndexKey,
	webExtractCacheNotice,
} from '../../browser/providers/tool/webPageCache.js';
import type { IWebCacheStore } from '../../browser/providers/tool/webPageCache.js';

/** Map 替身：可开关"写入即抛"，用来模拟存储故障。 */
class FakeStore implements IWebCacheStore {
	readonly map = new Map<string, string>();
	failWrites = false;
	constructor(private readonly onSet?: (key: string) => void) { }
	get(key: string): string | undefined { return this.map.get(key); }
	set(key: string, value: string): void {
		if (this.failWrites) { throw new Error('quota exceeded'); }
		this.onSet?.(key);
		this.map.set(key, value);
	}
	delete(key: string): void { this.map.delete(key); }
}

function page(url: string, text = 'body text') {
	return { url, title: `Title of ${url}`, description: '', text, source: 'reader-mode' };
}

suite('webPageCache — URL 归一化与键', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizeCacheUrl strips the fragment but keeps the query', () => {
		assert.strictEqual(normalizeCacheUrl('https://a.example/p#section-2'), 'https://a.example/p');
		// query 决定内容，必须保留（砍掉会串页）
		assert.strictEqual(normalizeCacheUrl('https://a.example/p?id=7'), 'https://a.example/p?id=7');
		assert.strictEqual(normalizeCacheUrl('  https://a.example/p  '), 'https://a.example/p');
		assert.strictEqual(normalizeCacheUrl('https://a.example/p?q=1#top'), 'https://a.example/p?q=1');
	});

	test('cacheKeyFor is deterministic, short, and differs per URL', () => {
		assert.strictEqual(cacheKeyFor('https://a.example/x'), cacheKeyFor('https://a.example/x'));
		assert.notStrictEqual(cacheKeyFor('https://a.example/x'), cacheKeyFor('https://a.example/y'));
		assert.ok(cacheKeyFor('https://a.example/very/long/path?with=params').length <= 7);
	});

	test('webCacheEntryKey / webCacheIndexKey are namespaced and distinct', () => {
		const entry = webCacheEntryKey('https://a.example/x');
		assert.ok(entry.startsWith('saros.webExtractCache.entry.'), entry);
		assert.ok(webCacheIndexKey().startsWith('saros.webExtractCache.index'));
		assert.notStrictEqual(entry, webCacheIndexKey());
	});

	test('formatCacheAge renders compact human ages', () => {
		assert.strictEqual(formatCacheAge(30_000), '<1m');
		assert.strictEqual(formatCacheAge(45 * 60_000), '45m');
		assert.strictEqual(formatCacheAge(3 * 60 * 60_000), '3h');
		assert.strictEqual(formatCacheAge((3 * 60 + 12) * 60_000), '3h 12m');
		assert.strictEqual(formatCacheAge(2 * 24 * 60 * 60_000), '2d');
		assert.strictEqual(formatCacheAge(-5), '<1m', '负数不该出现 NaN/负值文案');
	});

});

suite('webPageCache — 读写 / LRU / TTL', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('put then get round-trips all fields and stamps cachedAt', () => {
		const store = new FakeStore();
		let now = 1_000_000;
		const cache = new WebPageCache(store, undefined, () => now);

		cache.put(page('https://a.example/p', 'hello body'));
		const hit = cache.get('https://a.example/p');

		assert.ok(hit);
		assert.strictEqual(hit.url, 'https://a.example/p');
		assert.strictEqual(hit.title, 'Title of https://a.example/p');
		assert.strictEqual(hit.text, 'hello body');
		assert.strictEqual(hit.source, 'reader-mode');
		assert.strictEqual(hit.cachedAt, now);
	});

	test('get with a different fragment still hits (归一化生效)', () => {
		const cache = new WebPageCache(new FakeStore());
		cache.put(page('https://a.example/p'));
		assert.ok(cache.get('https://a.example/p#anything'));
	});

	test('miss on unknown URL', () => {
		const cache = new WebPageCache(new FakeStore());
		assert.strictEqual(cache.get('https://nope.example/'), undefined);
	});

	test('entries expire after the TTL and the entry is dropped from storage', () => {
		const store = new FakeStore();
		let now = 0;
		const cache = new WebPageCache(store, undefined, () => now);

		cache.put(page('https://a.example/p'));
		const entryKey = webCacheEntryKey('https://a.example/p');
		assert.ok(store.map.has(entryKey), 'entry written');

		now = WEB_PAGE_CACHE_TTL_MS - 1;
		assert.ok(cache.get('https://a.example/p'), 'still fresh just before TTL');

		now = WEB_PAGE_CACHE_TTL_MS + 1;
		assert.strictEqual(cache.get('https://a.example/p'), undefined, 'expired');
		assert.ok(!store.map.has(entryKey), 'expired entry removed from storage');
	});

	test('re-putting the same URL replaces it and does not duplicate the index', () => {
		const store = new FakeStore();
		let now = 0;
		const cache = new WebPageCache(store, undefined, () => now);

		cache.put(page('https://a.example/p', 'v1'));
		now = 60_000;
		cache.put(page('https://a.example/p', 'v2'));

		const hit = cache.get('https://a.example/p');
		assert.strictEqual(hit?.text, 'v2');
		const index = JSON.parse(store.map.get(webCacheIndexKey()) ?? '[]') as unknown[];
		assert.strictEqual(index.length, 1, 'index must not accumulate duplicates');
	});

	test('LRU: the oldest entries are evicted beyond MAX_ENTRIES and their storage is freed', () => {
		const store = new FakeStore();
		const cache = new WebPageCache(store);

		for (let i = 0; i < WEB_PAGE_CACHE_MAX_ENTRIES + 3; i++) {
			cache.put(page(`https://a.example/p${i}`));
		}

		const index = JSON.parse(store.map.get(webCacheIndexKey()) ?? '[]') as Array<{ k: string }>;
		assert.strictEqual(index.length, WEB_PAGE_CACHE_MAX_ENTRIES);

		// 最早写入的 3 条被淘汰（连同存储条目）
		for (const i of [0, 1, 2]) {
			assert.strictEqual(cache.get(`https://a.example/p${i}`), undefined, `p${i} should be evicted`);
			assert.ok(!store.map.has(webCacheEntryKey(`https://a.example/p${i}`)), `p${i} entry should be freed`);
		}
		// 最新的仍在
		assert.ok(cache.get(`https://a.example/p${WEB_PAGE_CACHE_MAX_ENTRIES + 2}`));
	});

	test('clear removes the index and every entry', () => {
		const store = new FakeStore();
		const cache = new WebPageCache(store);
		cache.put(page('https://a.example/a'));
		cache.put(page('https://a.example/b'));

		cache.clear();

		assert.strictEqual(store.map.get(webCacheIndexKey()), undefined);
		assert.strictEqual(cache.get('https://a.example/a'), undefined);
		assert.strictEqual(cache.get('https://a.example/b'), undefined);
	});

});

suite('webPageCache — 脏数据 / 碰撞 / 存储故障（缓存绝不能弄坏调用方）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a key collision never serves the wrong page (url is verified on read)', () => {
		const store = new FakeStore();
		const cache = new WebPageCache(store);
		const url = 'https://a.example/p';
		cache.put(page(url, 'correct body'));

		// 模拟碰撞：同一个存储键下塞进**别的** URL 的条目。
		store.map.set(webCacheEntryKey(url), JSON.stringify({ ...page('https://other.example/x'), text: 'WRONG PAGE' }));

		assert.strictEqual(cache.get(url), undefined, 'collision must be a miss, not a wrong-page hit');
		assert.ok(!store.map.has(webCacheEntryKey(url)), 'dirty entry cleaned up');
	});

	test('corrupt index JSON is treated as empty instead of throwing', () => {
		const store = new FakeStore();
		store.map.set(webCacheIndexKey(), '{not json');
		const cache = new WebPageCache(store);

		assert.strictEqual(cache.get('https://a.example/p'), undefined);
		cache.put(page('https://a.example/p'));  // 仍可自愈
		assert.ok(cache.get('https://a.example/p'));
	});

	test('index entries with wrong shapes are filtered out', () => {
		const store = new FakeStore();
		store.map.set(webCacheIndexKey(), JSON.stringify([{ k: 'ok', u: 'https://a.example/x', t: 0 }, { nope: true }, null, 42]));
		const cache = new WebPageCache(store);
		// 不应抛错；不存在的条目一律 miss
		assert.strictEqual(cache.get('https://a.example/x'), undefined);
	});

	test('corrupt entry JSON → miss (no throw)', () => {
		const store = new FakeStore();
		const cache = new WebPageCache(store);
		const url = 'https://a.example/p';
		cache.put(page(url));
		store.map.set(webCacheEntryKey(url), '<html>not json');
		assert.strictEqual(cache.get(url), undefined);
	});

	test('store write failures are swallowed (cache is an accelerator, not a dependency)', () => {
		const store = new FakeStore();
		store.failWrites = true;
		const cache = new WebPageCache(store);

		// 不抛错即通过 —— 否则 web_extract 会因缓存写失败而整体失败。
		cache.put(page('https://a.example/p'));
		assert.strictEqual(cache.get('https://a.example/p'), undefined);
	});

	test('a stale index entry whose entry is gone is cleaned up on read', () => {
		const store = new FakeStore();
		const cache = new WebPageCache(store);
		const url = 'https://a.example/p';
		cache.put(page(url));

		// 只删条目、留索引（模拟外部清理 / 存储层裁掉大值）。
		store.map.delete(webCacheEntryKey(url));

		assert.strictEqual(cache.get(url), undefined);
		const index = JSON.parse(store.map.get(webCacheIndexKey()) ?? '[]') as unknown[];
		assert.strictEqual(index.length, 0, 'dangling index entry removed');
	});

});

suite('webPageCache — 缓存标注文案', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('notice includes capture time, age, and the refresh escape hatch', () => {
		const now = Date.UTC(2026, 8, 24, 12, 0, 0);
		const cachedAt = now - 3 * 60 * 60_000;
		const notice = webExtractCacheNotice(cachedAt, now);

		assert.ok(notice.includes(new Date(cachedAt).toISOString()), notice);
		assert.ok(notice.includes('3h ago'), notice);
		assert.ok(notice.includes('`refresh: true`'), notice);
	});

});
