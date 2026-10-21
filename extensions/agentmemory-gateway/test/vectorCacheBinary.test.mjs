/*---------------------------------------------------------------------------------------------
 *  向量制品二进制格式单测（2026-10-21）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/vectorCacheBinary.test.mjs
 *
 *  锁死三件事：① 往返逐位一致（float32 原值，不经十进制）；② 升级后第一次启动能读旧 `.json.gz`；
 *  ③ 任何截断/损坏都**抛错**（调用方转成重建），不得返回半份向量。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { decodeVectorCache, encodeVectorCache, isVectorBinary, VECTOR_BIN_MAGIC } from '../host/vectorCacheBinary.mjs';
import { INDEX_CACHE_VERSION, readVectorCacheFile, writeCacheFile, writeVectorCacheFile } from '../host/indexCache.mjs';

const META = { version: INDEX_CACHE_VERSION, fingerprint: { rows: 3, maxUpdatedAt: 1, sumLen: 9 }, builtAt: 5, docs: 3, mode: 'model', agentModes: { a: 'model', b: 'model' }, provider: { name: 'local' } };

function vec(dim, seed) {
	const v = new Float32Array(dim);
	for (let i = 0; i < dim; i++) { v[i] = Math.sin(seed * 31 + i) * 0.1234567; }
	return v;
}

test('encode/decode：元数据与向量逐位往返（含 number[] 输入、多 agent、不同维度）', () => {
	const a1 = vec(384, 1), a2 = vec(384, 2), b1 = vec(8, 3);
	const agents = {
		a: [{ id: 'm1', vector: Array.from(a1) }, { id: 'm2', vector: a2 }],
		b: [{ id: '中文-id', vector: b1 }],
	};
	const buf = encodeVectorCache(META, agents);
	assert.equal(isVectorBinary(buf), true);
	const out = decodeVectorCache(buf);
	assert.deepEqual({ ...out, agents: undefined }, { ...META, agents: undefined }, '元数据逐字段保真，blobBytes 不外泄');
	assert.deepEqual(out.agents.a.map(e => e.id), ['m1', 'm2']);
	assert.deepEqual(out.agents.b.map(e => e.id), ['中文-id']);
	for (const [got, want] of [[out.agents.a[0].vector, a1], [out.agents.a[1].vector, a2], [out.agents.b[0].vector, b1]]) {
		assert.equal(got.length, want.length);
		for (let i = 0; i < want.length; i++) { assert.equal(got[i], want[i], `第 ${i} 维不一致`); }
	}
});

test('encode：空分区 / 维度不一致的条目 / 重复 id 不写', () => {
	const out = decodeVectorCache(encodeVectorCache(META, {
		empty: [],
		mixed: [{ id: 'x', vector: vec(4, 1) }, { id: 'bad', vector: vec(3, 2) }, { id: 'x', vector: vec(4, 9) }, { id: 'y', vector: vec(4, 3) }],
	}));
	assert.equal('empty' in out.agents, false);
	assert.deepEqual(out.agents.mixed.map(e => e.id), ['x', 'y'], '混维度条目被丢，重复 id 只留第一条');
	assert.equal(out.agents.mixed[0].vector[0], vec(4, 1)[0]);
});

test('decode：坏魔数 / 截断 / 尾部多余 / header 篡改 ⇒ 一律抛错', () => {
	const good = encodeVectorCache(META, { a: [{ id: 'm1', vector: vec(16, 1) }, { id: 'm2', vector: vec(16, 2) }] });
	assert.throws(() => decodeVectorCache(Buffer.from('not a cache')), /too short|bad magic/);
	const badMagic = Buffer.from(good); badMagic[0] ^= 0xff;
	assert.throws(() => decodeVectorCache(badMagic), /bad magic/);
	assert.throws(() => decodeVectorCache(good.subarray(0, good.length - 4)), /blob length mismatch/, '少一个 float（写到一半断电）');
	assert.throws(() => decodeVectorCache(Buffer.concat([good, Buffer.alloc(4)])), /blob length mismatch/);
	assert.throws(() => decodeVectorCache(good.subarray(0, 20)), /truncated header|blob length/);
});

test('writeVectorCacheFile / readVectorCacheFile：优先二进制，缺失回退旧 JSON，原子写不留 tmp', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amvec-'));
	const bin = path.join(dir, 'index', 'vector-cache.bin');
	const legacy = path.join(dir, 'index', 'vector-cache.json.gz');
	assert.deepEqual(readVectorCacheFile(bin, legacy), { meta: null, format: null }, '两者都没有 ⇒ 未命中');

	// 升级前留下的旧制品（number[]）⇒ 回退读
	await writeCacheFile(legacy, { ...META, agents: { a: [{ id: 'old', vector: [0.5, 0.25] }] } });
	const r1 = readVectorCacheFile(bin, legacy);
	assert.equal(r1.format, 'json');
	assert.deepEqual(r1.meta.agents.a[0], { id: 'old', vector: [0.5, 0.25] });

	// 写二进制后优先读它（旧文件仍在，但不再用）
	const v = vec(32, 7);
	await writeVectorCacheFile(bin, { ...META, agents: { a: [{ id: 'new', vector: v }] } });
	const r2 = readVectorCacheFile(bin, legacy);
	assert.equal(r2.format, 'binary');
	assert.deepEqual(r2.meta.agents.a.map(e => e.id), ['new']);
	assert.equal(r2.meta.agents.a[0].vector[31], v[31]);

	// 同步版（shutdown）
	writeVectorCacheFile(bin, { ...META, agents: { a: [{ id: 'sync', vector: v }] } }, { sync: true });
	assert.deepEqual(readVectorCacheFile(bin, legacy).meta.agents.a.map(e => e.id), ['sync']);

	assert.deepEqual(fs.readdirSync(path.dirname(bin)).filter(n => n.includes('.tmp-')), [], '不应残留临时文件');

	// 二进制损坏 ⇒ 抛错，**不**静默回退到更旧的 JSON
	fs.writeFileSync(bin, Buffer.concat([VECTOR_BIN_MAGIC, Buffer.from([1, 0, 0, 0])]));
	assert.throws(() => readVectorCacheFile(bin, legacy));
	fs.writeFileSync(bin, Buffer.from('garbage-garbage'));
	assert.throws(() => readVectorCacheFile(bin, legacy), /bad magic/);

	fs.rmSync(dir, { recursive: true, force: true });
});

test('sync 模式写失败 ⇒ **同步抛出**（shutdown 的 try/catch 才接得住；async 版会变成无人处理的 rejection）', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amvec-syncerr-'));
	// 目标路径的"父目录"其实是个文件 ⇒ mkdir/写入必然失败
	const blocker = path.join(dir, 'blocker');
	fs.writeFileSync(blocker, 'x');
	const target = path.join(blocker, 'sub', 'out');
	assert.throws(() => writeVectorCacheFile(target, { ...META, agents: {} }, { sync: true }));
	assert.throws(() => writeCacheFile(target, { ...META, agents: {} }, { sync: true }));
	fs.rmSync(dir, { recursive: true, force: true });
});
