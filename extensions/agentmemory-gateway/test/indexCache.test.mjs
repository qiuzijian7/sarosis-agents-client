/*---------------------------------------------------------------------------------------------
 *  indexCache.mjs 单测（P0-2，2026-09-19）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/
 *
 *  这里锁死的是「什么样的情况下允许用磁盘上的索引制品」——这是本模块唯一的高危判据：
 *  判错（本该重建却用了旧制品）= 检索到过时/不存在的记忆；判松（缓存永远不用）= 白做。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';

import {
	INDEX_CACHE_VERSION,
	fingerprintEqual,
	validateCache,
	nextSaveDelayMs,
	readCacheFile,
	writeCacheFile,
} from '../host/indexCache.mjs';

const FP = { rows: 100, maxUpdatedAt: 1700000000000, sumLen: 12345 };

test('fingerprintEqual：三项全同才相等', () => {
	assert.equal(fingerprintEqual(FP, { ...FP }), true);
	// 行数变（删除）→ 不等
	assert.equal(fingerprintEqual(FP, { ...FP, rows: 99 }), false);
	// 写入时间变（更新）→ 不等
	assert.equal(fingerprintEqual(FP, { ...FP, maxUpdatedAt: FP.maxUpdatedAt + 1 }), false);
	// 同毫秒改写同长度值 → 只有 sumLen 能发现
	assert.equal(fingerprintEqual(FP, { ...FP, sumLen: FP.sumLen + 1 }), false);
	// null / undefined 任一侧 → 不等（宁重建）
	assert.equal(fingerprintEqual(null, FP), false);
	assert.equal(fingerprintEqual(FP, undefined), false);
});

test('validateCache：版本 / 结构 / 指纹三道闸', () => {
	assert.equal(validateCache(null, FP).ok, false, 'null 制品必须判不可用');
	assert.equal(validateCache({}, FP).reason, 'version mismatch (cache=undefined, code=1)');
	assert.equal(validateCache({ version: 99, agents: {}, fingerprint: FP }, FP).ok, false, '版本不符');
	assert.equal(validateCache({ version: INDEX_CACHE_VERSION, fingerprint: FP }, FP).reason, 'no agents section');
	assert.equal(validateCache({ version: INDEX_CACHE_VERSION, agents: {}, fingerprint: { ...FP, rows: 1 } }, FP).ok, false, '指纹不符');
	assert.equal(validateCache({ version: INDEX_CACHE_VERSION, agents: {}, fingerprint: FP }, FP).ok, true);
	// 指纹取不到（KV 查询失败）→ 必须判不可用，而不是"乐观通过"
	assert.equal(validateCache({ version: INDEX_CACHE_VERSION, agents: {}, fingerprint: FP }, null).ok, false);
});

test('nextSaveDelayMs：节流而非防抖（首个变更排定后不被后续变更重置）', () => {
	const opts = { debounceMs: 30_000, maxDelayMs: 300_000 };
	// 首次 → 满额 30s
	assert.equal(nextSaveDelayMs(1_000, 1_000, opts), 30_000);
	// 已等 10s → 仍是 30s（**不因新变更而延长** —— 若按剩余时间缩短就成了防抖的反面）
	assert.equal(nextSaveDelayMs(1_000, 11_000, opts), 30_000);
	// 已等 290s → 只剩 10s 到最长延迟（300_000 - 290_000）
	assert.equal(nextSaveDelayMs(1_000, 291_000, opts), 10_000);
	// 超过最长延迟 → 立即落盘
	assert.equal(nextSaveDelayMs(1_000, 400_000, opts), 0);
	// dirtySince 为 0（未 dirty）→ 按满额处理（调用方不该在未 dirty 时调用）
	assert.equal(nextSaveDelayMs(0, 5_000, opts), 30_000);
});

test('writeCacheFile / readCacheFile：往返保真 + 原子替换不留 tmp', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcache-'));
	const file = path.join(dir, 'nested', 'bm25-cache.json.gz');
	const payload = { version: INDEX_CACHE_VERSION, fingerprint: FP, agents: { 'saros-claw': { v: 2, entries: [['a', { id: 'a', termCount: 3 }]] } } };

	assert.equal(readCacheFile(file), null, '不存在的制品返回 null（调用方按"未命中"处理）');

	await writeCacheFile(file, payload);
	assert.deepEqual(readCacheFile(file), payload, '往返必须逐字段保真');

	// 覆盖写（第二次保存）也必须成功
	const payload2 = { ...payload, agents: {} };
	await writeCacheFile(file, payload2);
	assert.deepEqual(readCacheFile(file), payload2);

	// 原子性：目录里只应有最终文件，不能残留 tmp
	const leftovers = fs.readdirSync(path.dirname(file)).filter(n => n.includes('.tmp-'));
	assert.deepEqual(leftovers, [], `不应残留临时文件，实际=${JSON.stringify(leftovers)}`);

	fs.rmSync(dir, { recursive: true, force: true });
});

test('writeCacheFile(sync)：shutdown 路径可用且同步完成', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcache-sync-'));
	const file = path.join(dir, 'vector-cache.json.gz');
	const payload = { version: INDEX_CACHE_VERSION, fingerprint: FP, docs: 3, mode: 'trigram', agents: {} };

	writeCacheFile(file, payload, { sync: true });
	// 不 await 任何东西就应该已经写完 —— shutdown 时没有下一个 tick
	assert.deepEqual(readCacheFile(file), payload);

	fs.rmSync(dir, { recursive: true, force: true });
});

test('readCacheFile：损坏制品必须抛错（由调用方转成"重建"），不得静默返回空', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcache-bad-'));
	const file = path.join(dir, 'bm25-cache.json.gz');

	// ① 不是 gzip
	fs.writeFileSync(file, Buffer.from('not a gzip stream', 'utf8'));
	assert.throws(() => readCacheFile(file), '非 gzip 必须抛错');

	// ② 是合法 gzip 但内容不是 JSON
	fs.writeFileSync(file, zlib.gzipSync(Buffer.from('{ broken json', 'utf8')));
	assert.throws(() => readCacheFile(file), '内容非 JSON 必须抛错');

	// ③ 合法 gzip + 合法 JSON，但形状不对 → 这里不抛，交给 validateCache 判（职责分离）
	fs.writeFileSync(file, zlib.gzipSync(Buffer.from('{"version":1}', 'utf8')));
	assert.deepEqual(readCacheFile(file), { version: 1 });

	fs.rmSync(dir, { recursive: true, force: true });
});
