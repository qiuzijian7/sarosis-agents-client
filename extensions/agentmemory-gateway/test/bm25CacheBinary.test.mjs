/*---------------------------------------------------------------------------------------------
 *  BM25 制品二进制格式单测（2026-10-21）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/bm25CacheBinary.test.mjs
 *
 *  锁死四件事：
 *  ① 往返**逐项保真**（entries / inverted / docTerms 的顺序与内容都要一致 —— BM25 打分依赖
 *     倒排表的 posting 顺序与 docTerms 的词频表，丢一项就等于换了一个索引）；
 *  ② 升级后第一次启动能读旧 `.json.gz`；
 *  ③ 任何截断/损坏都**抛错**（调用方转成重建），不得返回半份索引；
 *  ④ sync 模式写失败**同步抛出**（shutdown 的 try/catch 才接得住）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BM25_BIN_MAGIC, decodeBm25Cache, encodeBm25Cache, isBm25Binary } from '../host/bm25CacheBinary.mjs';
import { INDEX_CACHE_VERSION, readBm25CacheFile, writeBm25CacheFile, writeCacheFile } from '../host/indexCache.mjs';

const META = { version: INDEX_CACHE_VERSION, fingerprint: { rows: 3, maxUpdatedAt: 1, sumLen: 9 }, builtAt: 5, docs: 3 };

/** 造一个与 BM25Index.serializePayload() 同形的 payload */
function payload(opts = {}) {
	const {
		entries = [['m1', { id: 'm1', termCount: 2 }], ['m2', { id: 'm2', termCount: 0 }]],
		inverted = [['foo', ['m1']], ['bar', ['m1', 'm2']], ['中文', ['m2']]],
		docTerms = [['m1', [['foo', 1], ['bar', 1]]], ['m2', [['bar', 0]]]],
		totalDocLength = 2,
	} = opts;
	return { v: 2, entries, inverted, docTerms, totalDocLength };
}

test('encode/decode：payload 逐项保真（含顺序、空 posting、空 docTerms、中文词条）', () => {
	const p = payload();
	const buf = encodeBm25Cache(META, { a: p });
	assert.equal(isBm25Binary(buf), true);
	const out = decodeBm25Cache(buf);
	assert.deepEqual({ ...out, agents: undefined }, { ...META, agents: undefined }, '元数据逐字段保真，bodyBytes 不外泄');
	assert.deepEqual(out.agents.a, p, 'payload 与原对象完全一致（含数组顺序）');
});

test('encode/decode：多 agent 隔离 + 空 agent 不写 + 无 posting 的词条保留', () => {
	const a = payload();
	const b = payload({
		entries: [['x1', { id: 'x1', termCount: 1 }]],
		inverted: [['solo', []], ['t', ['x1']]],
		docTerms: [['x1', [['t', 1]]], ['x2', []]],
		totalDocLength: 1,
	});
	const out = decodeBm25Cache(encodeBm25Cache(META, { a, b, empty: null }));
	assert.deepEqual(Object.keys(out.agents), ['a', 'b'], 'null agent 不写，顺序保留');
	assert.deepEqual(out.agents.b.inverted, b.inverted, '空 posting 的词条保留（否则查询时该词被判为不存在）');
	assert.deepEqual(out.agents.b.docTerms, b.docTerms);
	assert.deepEqual(out.agents.a, a);
});

test('encode/decode：entry 的内层 id 与 key 不同也能保真', () => {
	const p = payload({ entries: [['k1', { id: 'inner-id', termCount: 5 }]] });
	const out = decodeBm25Cache(encodeBm25Cache(META, { a: p }));
	assert.deepEqual(out.agents.a.entries, [['k1', { id: 'inner-id', termCount: 5 }]]);
});

test('decode：坏魔数 / 截断 / 尾部多余 / 长度不符 ⇒ 一律抛错', () => {
	const good = encodeBm25Cache(META, { a: payload() });
	assert.throws(() => decodeBm25Cache(Buffer.from('not a cache')), /too short|bad magic/);
	const badMagic = Buffer.from(good); badMagic[0] ^= 0xff;
	assert.throws(() => decodeBm25Cache(badMagic), /bad magic/);
	assert.throws(() => decodeBm25Cache(good.subarray(0, good.length - 4)), /body length mismatch|truncated/, '写到一半断电');
	assert.throws(() => decodeBm25Cache(Buffer.concat([good, Buffer.alloc(4)])), /body length mismatch/);
	assert.throws(() => decodeBm25Cache(good.subarray(0, 20)), /truncated header|body length/);
});

test('writeBm25CacheFile / readBm25CacheFile：优先二进制，缺失回退旧 JSON，原子写不留 tmp', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambm25-'));
	const bin = path.join(dir, 'index', 'bm25-cache.bin');
	const legacy = path.join(dir, 'index', 'bm25-cache.json.gz');
	assert.deepEqual(readBm25CacheFile(bin, legacy), { meta: null, format: null }, '两者都没有 ⇒ 未命中');

	// 升级前留下的旧制品 ⇒ 回退读
	await writeCacheFile(legacy, { ...META, agents: { a: payload() } });
	const r1 = readBm25CacheFile(bin, legacy);
	assert.equal(r1.format, 'json');
	assert.deepEqual(r1.meta.agents.a, payload());

	// 写二进制后优先读它（旧文件仍在，但不再用）
	await writeBm25CacheFile(bin, { ...META, agents: { a: payload() } });
	const r2 = readBm25CacheFile(bin, legacy);
	assert.equal(r2.format, 'binary');
	assert.deepEqual(r2.meta.agents.a, payload());
	assert.deepEqual(fs.readdirSync(path.dirname(bin)).filter(n => n.includes('.tmp-')), [], '不应残留临时文件');

	// 同步版（shutdown）
	writeBm25CacheFile(bin, { ...META, agents: { a: payload() } }, { sync: true });
	assert.deepEqual(readBm25CacheFile(bin, legacy).meta.agents.a, payload());

	// 二进制损坏 ⇒ 抛错，**不**静默回退到更旧的 JSON
	fs.writeFileSync(bin, Buffer.concat([BM25_BIN_MAGIC, Buffer.from([1, 0, 0, 0])]));
	assert.throws(() => readBm25CacheFile(bin, legacy));
	fs.writeFileSync(bin, Buffer.from('garbage-garbage'));
	assert.throws(() => readBm25CacheFile(bin, legacy), /bad magic/);

	fs.rmSync(dir, { recursive: true, force: true });
});

test('sync 模式写失败 ⇒ **同步抛出**（shutdown 的 try/catch 才接得住）', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambm25-syncerr-'));
	const blocker = path.join(dir, 'blocker');
	fs.writeFileSync(blocker, 'x');
	const target = path.join(blocker, 'sub', 'out');
	assert.throws(() => writeBm25CacheFile(target, { ...META, agents: {} }, { sync: true }));
	fs.rmSync(dir, { recursive: true, force: true });
});
