/*---------------------------------------------------------------------------------------------
 *  kvMigrations.test.mjs — KV 结构版本与迁移回归（2026-11-02）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/kvMigrations.test.mjs
 *
 *  锁死三件事：
 *   ① strength 刻度迁移的**语义**（0–1 → 0–10、0 不动、>1 不动、非 memories scope 不动）；
 *   ② **幂等**：同一份数据跑两遍结果相同（迁移会在每次版本落后时重跑）；
 *   ③ 调用点：`host.mjs` 必须**先**迁移**再**建索引（否则索引建在旧数据上）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	KV_SCHEMA_VERSION,
	KV_SCHEMA_SCOPE,
	KV_SCHEMA_KEY,
	KV_MIGRATIONS,
	readSchemaVersion,
	runKvMigrations,
	buildSchemaRow,
} from '../host/kvMigrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 造一行 memories。 */
const row = (content, strength, key = 'mem_1', scope = 'mem:memories:a') => ({
	scope, key, value: { id: key, content, strength, isLatest: true },
});

test('版本常量与迁移表自洽', () => {
	assert.equal(KV_SCHEMA_VERSION, 1);
	const versions = KV_MIGRATIONS.map(m => m.version);
	assert.deepEqual(versions, [...versions].sort((a, b) => a - b), '迁移必须按版本升序');
	assert.equal(versions.at(-1), KV_SCHEMA_VERSION, '最大迁移版本必须等于 KV_SCHEMA_VERSION');
	assert.ok(KV_SCHEMA_SCOPE && KV_SCHEMA_KEY);
});

test('readSchemaVersion：缺失/坏 JSON/负数 ⇒ 0', () => {
	assert.equal(readSchemaVersion(null), 0);
	assert.equal(readSchemaVersion(''), 0);
	assert.equal(readSchemaVersion('not-json'), 0);
	assert.equal(readSchemaVersion('{"version":-1}'), 0);
	assert.equal(readSchemaVersion('{"version":3}'), 3);
});

test('strength 刻度迁移：0–1 ×10，0 与 >1 不动', () => {
	const rows = [
		row('中文记忆', 0.1, 'a'),
		row('中文记忆', 0.75, 'b'),
		row('中文记忆', 1, 'c'),
		row('中文记忆', 0, 'd'),
		row('中文记忆', 7, 'e'),
		row('中文记忆', undefined, 'f'),
	];
	const result = runKvMigrations(rows, 0);
	assert.equal(result.version, 1);
	assert.equal(result.changed.length, 3, '只有 0.1 / 0.75 / 1 三行该变');

	const byKey = new Map(rows.map(r => [r.key, r.value.strength]));
	assert.equal(byKey.get('a'), 1);
	assert.equal(byKey.get('b'), 7.5);
	assert.equal(byKey.get('c'), 10);
	assert.equal(byKey.get('d'), 0, '0 = 从未评估，不能放大');
	assert.equal(byKey.get('e'), 7, '>1 已在 0–10 刻度');
});

test('非 memories scope / 非对象值 一律不动', () => {
	const rows = [
		{ scope: 'mem:core-memory:a', key: 'k', value: { strength: 0.5 } },
		{ scope: 'mem:memories:a', key: 'arr', value: [1, 2, 3] },
		{ scope: 'mem:memories:a', key: 'null', value: null },
	];
	const result = runKvMigrations(rows, 0);
	assert.equal(result.changed.length, 0);
	assert.equal(rows[0].value.strength, 0.5);
});

test('幂等：迁移后再从 v1 跑一遍 ⇒ 零改动', () => {
	const rows = [row('中文记忆', 0.5, 'a'), row('中文记忆', 7, 'b')];
	const first = runKvMigrations(rows, 0);
	assert.equal(first.changed.length, 1);
	const second = runKvMigrations(rows, 1);
	assert.equal(second.changed.length, 0, '已迁移的数据不得被再次放大');
	assert.equal(second.applied.length, 0);
	assert.equal(rows[0].value.strength, 5);
});

test('buildSchemaRow：记录版本与已应用迁移', () => {
	const meta = buildSchemaRow(1, [{ version: 1, id: 'strength-scale-unify', rows: 189 }]);
	assert.equal(meta.version, 1);
	assert.ok(typeof meta.migratedAt === 'string' && meta.migratedAt.length > 0);
	assert.deepEqual(meta.applied, ['1:strength-scale-unify(189)']);
});

test('★ 调用点：host.mjs 必须先迁移、再建索引', () => {
	const hostFile = path.join(__dirname, '..', 'host', 'host.mjs');
	const src = fs.readFileSync(hostFile, 'utf8');
	const initCall = src.indexOf('await initBackend(dataDir);');
	const migrateCall = src.indexOf('migrateKvSchema(dataDir);');
	assert.ok(initCall > 0, '找不到 initBackend 调用点，守卫需同步更新');
	assert.ok(migrateCall > 0, 'host.mjs 必须在启动流程里调用 migrateKvSchema(dataDir)');
	assert.ok(migrateCall > initCall, '迁移必须在打开了 KV 之后');
	// ⚠ 不能用 `rebuildBm25IndexesFromKV();` 的**首次**出现：文件更早处也有一个调用点
	//   （另一个重建入口）⇒ 必须钉住 main() 里那条"启动期建索引"的具体形态。
	const buildCall = src.indexOf('if (!indexCache.bm25) { rebuildBm25IndexesFromKV(); }');
	assert.ok(buildCall > 0, '找不到启动期建索引调用点，守卫需同步更新');
	assert.ok(migrateCall < buildCall, '迁移必须在建索引之前（索引是从 KV 重建的）');
});
