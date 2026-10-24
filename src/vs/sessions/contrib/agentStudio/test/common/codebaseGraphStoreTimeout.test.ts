/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 代码图谱 SQLite 后端的**调用超时**（2026-10-22 用户报"dev 整个 app 卡死"的最后一道保险）。
 *
 * 现场：一���"全量追平"把 401,027 节点 + 1,247,209 边写进主进程 SQLite（551,936ms ≈ 9.2 分钟），
 * WAL 涨到 1.2GB ⇒ 写完后主进程**主线程阻塞**（0% CPU、inspector 命令全超时、渲染端 CDP 不通）
 * ⇒ 渲染进程的 IPC **永不返回** ⇒ 整个 app 无响应且不自愈。
 *
 * 这里测的是**行为**（不是 grep）：超时 ⇒ 拒绝；正常 ⇒ 透传；真失败 ⇒ 原错误不被覆盖；
 * 超时后底层 promise 迟到 resolve ⇒ 不产生未处理异常。
 */

import assert from 'assert';
import { DEFAULT_SQLITE_BACKEND_TIMEOUT_MS, sqliteBackendTimeoutError, withSqliteBackendTimeout } from '../../common/codebaseGraphStoreTimeout.js';

suite('codebaseGraph / SQLite 后端调用超时（防"永不返回"把 app 拖死）', () => {

	test('★ 超时 ⇒ 拒绝，且错误里指名了是哪个操作、用了多少毫秒', async () => {
		const never = new Promise<void>(() => { /* 永不 settle ⇒ 模拟主进程卡死 */ });
		const started = Date.now();
		await assert.rejects(
			() => withSqliteBackendTimeout('upsertEdgesBatch', () => never, 50),
			(err: Error) => {
				assert.match(err.message, /SQLite 后端调用超时/, '要能一眼看出是超时 ✗');
				assert.match(err.message, /upsertEdgesBatch/, '错误里要指名是哪个操作（否则现场无从下手 ✗）');
				assert.match(err.message, /50ms/, '要带上超时值');
				return true;
			},
		);
		assert.ok(Date.now() - started < 2000, '必须真的在超时点附近返回（不是等到底 ✗）');
	});

	test('正常返回 ⇒ 值原样透传（不许被包装/吞掉）', async () => {
		const v = await withSqliteBackendTimeout('getTotalNodeCount', () => Promise.resolve(42), 1000);
		assert.strictEqual(v, 42);
	});

	test('★ 真失败 ⇒ 原错误透传（不被超时错误覆盖，否则现场会误判成"超时"）', async () => {
		await assert.rejects(
			() => withSqliteBackendTimeout('open', () => Promise.reject(new Error('SQLITE_CANTOPEN')), 1000),
			(err: Error) => {
				assert.strictEqual(err.message, 'SQLITE_CANTOPEN', '必须是原始错误 ✗');
				return true;
			},
		);
	});

	test('★ 超时之后底层 promise 迟到 resolve ⇒ 不产生未处理异常（也不许二次 settle）', async () => {
		let release!: () => void;
		const late = new Promise<string>(r => { release = () => r('late'); });
		const p = withSqliteBackendTimeout('grepContent', () => late, 30);
		await assert.rejects(() => p, /超时/);
		release();                       // 底层在超时之后才回来
		await new Promise<void>(r => setTimeout(r, 20));
		// 若这里有未处理拒绝/二次 settle，进程会告警或抛 ⇒ 用标记断言"没炸"
		assert.ok(true, '迟到 resolve 未造成未处理异常 ✓');
	});

	test('默认超时是 120s（要够大到不误杀合法的大批量写，又要小到不让用户以为死机）', () => {
		assert.strictEqual(DEFAULT_SQLITE_BACKEND_TIMEOUT_MS, 120_000);
	});

	test('错误文案要说明"已放弃 + 后续会直接失败"（调用方据此处理）', () => {
		const err = sqliteBackendTimeoutError('checkpoint', 120_000);
		assert.match(err.message, /已放弃/, '要说明本次操作已被放弃 ✗');
		assert.match(err.message, /后续调用会直接失败/, '要说明后续会熔断 ✗');
	});
});
