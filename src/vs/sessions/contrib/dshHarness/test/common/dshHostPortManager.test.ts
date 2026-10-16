/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `electron-main/dshHostPortManager.ts` 的 I/O 闭环（真文件 + 真端口，纯 Node 可跑）。
 *
 * 为什么必须有这一层（不能只测纯逻辑）：本模块的三个动作**全是 I/O**
 * （读偏好、写偏好、探测端口占用），而"失败回落 0"这条纪律恰恰只在 I/O 出错时才生效
 * —— 纯逻辑测试永远碰不到它。真机上的代价很直接：Host 起不来（而 `--port 0` 从不冲突）。
 *
 * 覆盖的现场：
 *   · 没有偏好文件   → 0（首次启动，行为与历史一致）
 *   · 偏好端口空闲   → 复用它（**这就是修缓存的那条路**）
 *   · 偏好端口被占用 → 0（不能因为"想稳定"就让 Host 起不来）
 *   · 偏好文件是坏 JSON → 0（不抛、不影响启动）
 *   · rememberHostPort 只认带端口的 origin
 *
 * ⚠ 反向突变验证：把 `resolveHostPort` 里的 `isLoopbackPortFree` 判断去掉（无条件复用），
 * "被占用 ⇒ 0" 用例立刻变红；把 `writePreferredHostPort` 的 try/catch 去掉并传非法端口，
 * "坏数据不阻塞" 用例变红。
 */

import assert from 'assert';
import { promises as fsp } from 'fs';
import { createServer } from 'net';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { HOST_PORT_PREFERENCE_FILE } from '../../common/dshHostPortPreference.js';
import {
	isLoopbackPortFree,
	readPreferredHostPort,
	rememberHostPort,
	resolveHostPort,
	writePreferredHostPort,
} from '../../electron-main/dshHostPortManager.js';

/** 借 OS 分配一个"当下空闲"的回环端口，随即释放（供用例当作偏好值）。 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}

/** 占住某个端口，返回释放函数。 */
async function occupyPort(port: number): Promise<() => Promise<void>> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
	return () => new Promise<void>(resolve => server.close(() => resolve()));
}

suite('dshHarness / host port manager (I/O)', () => {

	let home: string;
	let counter = 0;

	setup(async () => {
		// 每个用例一个独立 home ⇒ 互不干扰，且不会碰到真机偏好
		home = join(tmpdir(), `dsh-port-io-${process.pid}-${Date.now()}-${counter++}`);
		await fsp.mkdir(home, { recursive: true });
	});

	test('没有偏好文件 ⇒ 0（首次启动，行为与历史 `--port 0` 一致）', async () => {
		assert.strictEqual(await readPreferredHostPort(home), undefined, '缺文件应读成 undefined 而不是抛错');
		assert.strictEqual(await resolveHostPort(home), 0, '没有偏好时必须回落 0');
	});

	test('偏好端口空闲 ⇒ 复用它（修缓存的那条路）', async () => {
		const port = await findFreePort();
		await writePreferredHostPort(home, port);

		assert.strictEqual(await readPreferredHostPort(home), port, '写进去的端口必须能读回来');
		assert.strictEqual(await resolveHostPort(home), port, '空闲端口必须被复用 —— 端口稳定才谈得上前缀缓存');
	});

	test('偏好端口被占用 ⇒ 0（稳定性是优化，不能因此让 Host 起不来）', async () => {
		const port = await findFreePort();
		await writePreferredHostPort(home, port);

		const release = await occupyPort(port);
		try {
			assert.strictEqual(await isLoopbackPortFree(port), false, '被占端口应探测为不可绑定');
			assert.strictEqual(await resolveHostPort(home), 0, '端口被占时必须回落 0（由 OS 分配）');
		} finally {
			await release();
		}
		assert.strictEqual(await resolveHostPort(home), port, '占用释放后又可以复用');
	});

	test('偏好文件是坏数据 ⇒ 0，且不抛（脏数据不能阻塞启动）', async () => {
		await fsp.writeFile(join(home, HOST_PORT_PREFERENCE_FILE), '{ not json', 'utf8');
		assert.strictEqual(await readPreferredHostPort(home), undefined);
		assert.strictEqual(await resolveHostPort(home), 0);
	});

	test('rememberHostPort 只认带端口的 origin（否则不写，免得记下一个猜出来的端口）', async () => {
		await rememberHostPort(home, 'http://127.0.0.1:1531');
		assert.strictEqual(await readPreferredHostPort(home), 1531, '有端口就记下来');

		// 无端口/畸形 ⇒ 保持原值不动（不是"写成 undefined"，那会丢掉已知的好值）
		await rememberHostPort(home, 'http://127.0.0.1');
		await rememberHostPort(home, undefined);
		assert.strictEqual(await readPreferredHostPort(home), 1531, '取不到端口时不得覆盖已有偏好');
	});

	test('非法端口不落盘、也不抛（写坏偏好比没有偏好更糟，但绝不能阻塞启动）', async () => {
		// 端口 0 代表"由 OS 分配"，不是可复用的值 ⇒ 序列化层拒绝它。
		// ⚠ `writePreferredHostPort` 必须**吞掉**这个错（它的契约是"写不进去就算了"）
		//   ⇒ 这里断言的是"不抛 + 不落盘"，而不是 rejects。
		await writePreferredHostPort(home, 0);
		assert.strictEqual(await readPreferredHostPort(home), undefined, '非法端口不得落盘');
	});
});
